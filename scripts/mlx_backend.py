#!/usr/bin/env python3
# ==============================================================================
# LUMINA EDGE :: MLX Apple Silicon Backend
# Handles API server, interactive chat, and benchmark modes natively using MLX
# ==============================================================================

import os
import sys
import json
import argparse
import time
import subprocess
import platform
import gc

# ==============================================================================
# PRE-IMPORT SETUP: Metal env vars and memory limit (must be before mlx import)
# ==============================================================================

def _load_config_early():
    """Load config early for pre-import settings (Metal env, memory limit)."""
    config_path = os.path.join(os.path.dirname(__file__), "..", "config.json")
    try:
        with open(config_path, "r") as f:
            return json.load(f)
    except Exception:
        return {}

_early_config = _load_config_early()

# C: Metal environment variables - set BEFORE mlx import if enabled
# These disable Metal validation layers and enable pre-warming for faster first inference
if _early_config.get('mlx_metal_optimizations', True):
    os.environ.setdefault('MLX_METAL_PREWARM', '1')
    os.environ.setdefault('MTL_HUD_ENABLED', '0')
    os.environ.setdefault('MTL_DEBUG_LAYER', '0')
    os.environ.setdefault('MTL_SHADER_VALIDATION', '0')
    os.environ.setdefault('METAL_DEVICE_WRAPPER_TYPE', '0')

try:
    import mlx.core as mx
    import mlx_lm
except ImportError:
    print("❌ ERROR: MLX packages not found. Please install: pip install --break-system-packages -r scripts/requirements-macos.txt")
    sys.exit(1)

# D: Memory limit - set after MLX import if configured
# Prevents MLX from using all unified memory, leaving room for the OS
_mlx_memory_fraction = _early_config.get('mlx_memory_limit_fraction')
if _mlx_memory_fraction is not None:
    try:
        import psutil
        total_ram = psutil.virtual_memory().total
    except Exception:
        total_ram = 16 * (1024**3)  # fallback to 16GB
    memory_limit = int(total_ram * float(_mlx_memory_fraction))
    if hasattr(mx.metal, 'set_memory_limit'):
        mx.metal.set_memory_limit(memory_limit)
        print(f'[MLX] Memory limit set to {memory_limit / (1024**3):.2f} GB ({_mlx_memory_fraction * 100:.0f}% of RAM)', flush=True)

# Module-level flags for model load state (used by HTTP handlers)
MODEL_LOADED = False
MODEL_LOAD_ERROR = None
# BUG MLX-1 FIX: _server_start_time_global is updated at the start of
# launch_api_direct() so the /health endpoint always has a valid timestamp
_server_start_time_global = time.time()


def _set_offline_env(model_path=None):
    """
    Set environment variables to prevent HuggingFace Hub network access.
    Only sets OFFLINE mode if all required tokenizer files exist locally.
    """
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'

    if model_path:
        required = ['config.json', 'tokenizer_config.json']
        all_present = all(os.path.exists(os.path.join(model_path, f)) for f in required)
        if all_present:
            os.environ['HF_HUB_OFFLINE'] = '1'
            os.environ['TRANSFORMERS_OFFLINE'] = '1'
        else:
            print(f'[MLX] Warning: tokenizer files incomplete, allowing HF Hub access', flush=True)
    else:
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'


# Detect API support at module level — KV quantization and max_kv_size parameter
try:
    import inspect as _inspect
    _gen_sig = _inspect.signature(mlx_lm.stream_generate)
    _supports_kv_asym = 'key_bits' in _gen_sig.parameters
    _supports_kv_sym = 'kv_bits' in _gen_sig.parameters
    _supports_max_kv = 'max_kv_size' in _gen_sig.parameters
    if _supports_kv_asym:
        print('[MLX] Asymmetric KV quantization supported: K=8bit, V=4bit', flush=True)
    elif _supports_kv_sym:
        print('[MLX] Symmetric KV quantization supported: 8-bit', flush=True)
    else:
        print('[MLX] KV quantization not available in this mlx_lm version', flush=True)
    if _supports_max_kv:
        print('[MLX] max_kv_size parameter supported', flush=True)
except Exception:
    _supports_kv_asym = False
    _supports_kv_sym = False
    _supports_max_kv = False
    print('[MLX] API detection failed, using defaults', flush=True)

# B: Detect sampler API support (make_sampler vs bare kwargs)
_supports_sampler = False
try:
    from mlx_lm import sample_utils
    if hasattr(sample_utils, 'make_sampler'):
        _supports_sampler = True
        print('[MLX] make_sampler API supported (mlx_lm >= 0.28)', flush=True)
except Exception:
    pass

if not _supports_sampler:
    print('[MLX] Using bare kwargs for sampling (mlx_lm < 0.28)', flush=True)


def _get_kv_kwargs(mlx_kv_quant_config=None, mlx_kv_quant_native=None, mlx_max_kv_size=None, kv_bits=None, kv_group_size=None):
    """
    Get KV quantization and cache kwargs based on mlx_lm support and config.
    Priority: mlx_kv_quant_native (if enabled) > top-level kv_bits/kv_group_size > built-in default.
    Default: kv_bits=4 (4-bit KV cache quantization for both K and V).
    """
    kwargs = {'kv_bits': 4}

    # F: Native KV quantization takes precedence if enabled
    if mlx_kv_quant_native and mlx_kv_quant_native.get('enabled', False):
        if _supports_kv_sym:
            kwargs['kv_bits'] = mlx_kv_quant_native.get('kv_bits', 4)
            kwargs['kv_group_size'] = mlx_kv_quant_native.get('kv_group_size', 64)
            kwargs['quantized_kv_start'] = mlx_kv_quant_native.get('quantized_kv_start', 0)
    elif mlx_kv_quant_config is not None and isinstance(mlx_kv_quant_config, dict):
        # Asymmetric KV quantization: K and V at different bit widths
        if _supports_kv_asym:
            kwargs.pop('kv_bits', None)
            kwargs['key_bits'] = mlx_kv_quant_config.get('key_bits', 8)
            kwargs['value_bits'] = mlx_kv_quant_config.get('value_bits', 4)
    elif kv_bits is not None:
        kwargs['kv_bits'] = kv_bits
        if kv_group_size is not None:
            kwargs['kv_group_size'] = kv_group_size

    # A: max_kv_size - only pass if configured and supported by mlx_lm version
    if mlx_max_kv_size is not None and _supports_max_kv:
        kwargs['max_kv_size'] = mlx_max_kv_size

    return kwargs


def get_mlx_generation_kwargs(config, prompt=None, override_temp=None, override_top_p=None, override_max_tokens=None):
    """
    Build complete generation kwargs from config.

    Central place for all generation parameters:
    - Sampling (temperature, top_p, min_p, repetition_penalty)
    - KV quantization (asymmetric or native)
    - KV cache size limit
    - Seed, stop tokens
    """
    # Read from top-level config first, fall back to mlx_sampling sub-object
    # (top-level keys are consistent with Linux/llama.cpp config;
    #  mlx_sampling sub-object overrides for macOS-only tuning)
    sampling = config.get('mlx_sampling', {})
    temperature = override_temp if override_temp is not None else config.get('temperature', sampling.get('temperature', 0.7))
    top_p = override_top_p if override_top_p is not None else config.get('top_p', sampling.get('top_p', 1.0))
    min_p = config.get('min_p', sampling.get('min_p', 0.0))
    repetition_penalty = config.get('repeat_penalty', sampling.get('repetition_penalty', 1.0))
    repetition_context_size = sampling.get('repetition_context_size', 20)
    max_tokens = override_max_tokens if override_max_tokens is not None else config.get('mlx_max_tokens', sampling.get('max_tokens', 512))

    seed = config.get('mlx_seed')
    stop_tokens = _parse_stop_tokens(config.get('mlx_stop_tokens', []))

    kv_kwargs = _get_kv_kwargs(
        config.get('mlx_kv_quant'),
        config.get('mlx_kv_quant_native'),
        config.get('mlx_max_kv_size'),
        config.get('kv_bits'),
        config.get('kv_group_size')
    )

    kwargs = {
        'max_tokens': max_tokens,
        **kv_kwargs,
    }

    # B: Use make_sampler API if available (mlx_lm >= 0.28), otherwise bare kwargs
    if _supports_sampler:
        try:
            from mlx_lm.sample_utils import make_sampler
            sampler = make_sampler(
                temperature=temperature,
                top_p=top_p,
                min_p=min_p if min_p > 0 else None,
                repetition_penalty=repetition_penalty if repetition_penalty != 1.0 else None,
                repetition_context_size=repetition_context_size if repetition_context_size != 20 else None,
            )
            kwargs['sampler'] = sampler
        except Exception as e:
            # BUG MLX-4 FIX: Log the failure so we know sampling fell back to defaults
            print(f'[MLX] Sampler creation failed, using defaults: {e}', flush=True)
    else:
        # BUG MLX-7 FIX: When sampler API is not supported (mlx_lm < 0.28),
        # pass bare kwargs so the user's config values are actually respected
        kwargs['temperature'] = temperature
        kwargs['top_p'] = top_p
        if min_p and min_p > 0:
            kwargs['min_p'] = min_p
        if repetition_penalty and repetition_penalty != 1.0:
            kwargs['repetition_penalty'] = repetition_penalty

    if seed:
        try:
            kwargs['seed'] = int(seed)
        except Exception:
            pass

    if stop_tokens:
        kwargs['stop'] = stop_tokens

    if prompt is not None:
        kwargs['prompt'] = prompt

    return kwargs


def _set_metal_env():
    """Set Metal performance environment variables."""
    metal_vars = {
        'MTL_HUD_ENABLED': '0',
        'MTL_DEBUG_LAYER': '0',
        'MTL_SHADER_VALIDATION': '0',
        'METAL_DEVICE_WRAPPER_TYPE': '0',
        'MLX_METAL_PREWARM': '1'
    }
    for key, val in metal_vars.items():
        os.environ[key] = val


def _get_system_memory_gb():
    """Get total system memory in GB via sysctl."""
    try:
        result = subprocess.run(
            ['sysctl', '-n', 'hw.memsize'],
            capture_output=True, text=True, timeout=2
        )
        if result.returncode == 0:
            return int(result.stdout.strip()) / (1024**3)
    except Exception:
        pass
    return 8.0  # safe fallback


def _detect_apple_silicon_tier():
    """
    Detect Apple Silicon chip tier.
    Returns dict with chip_name, gpu_cores, memory_gb, tier (base/pro/max/ultra)
    """
    info = {
        'chip_name': 'unknown',
        'gpu_cores': 7,
        'memory_gb': _get_system_memory_gb(),
        'tier': 'base',
        'generation': 1,
    }

    try:
        result = subprocess.run(
            ['sysctl', '-n', 'machdep.cpu.brand_string'],
            capture_output=True, text=True, timeout=2
        )
        brand = result.stdout.strip().lower()

        for gen, name in [(5,'m5'),(4,'m4'),(3,'m3'),(2,'m2'),(1,'m1')]:
            if name in brand:
                info['generation'] = gen
                break

        try:
            gpu_result = subprocess.run(
                ['system_profiler', 'SPDisplaysDataType', '-json'],
                capture_output=True, text=True, timeout=5
            )
            if gpu_result.returncode == 0:
                gpu_data = json.loads(gpu_result.stdout)
                displays = gpu_data.get('SPDisplaysDataType', [])
                for d in displays:
                    cores = d.get('sppci_cores', '')
                    if cores:
                        info['gpu_cores'] = int(str(cores).replace(' ', ''))
                        break
        except Exception:
            pass

        # Classify tier from memory (good proxy for chip tier)
        mem = info['memory_gb']
        if mem >= 192:
            info['tier'] = 'ultra'
        elif mem >= 64:
            info['tier'] = 'max'
        elif mem >= 32:
            info['tier'] = 'pro'
        else:
            info['tier'] = 'base'

        info['chip_name'] = f"Apple M{info['generation']} {info['tier'].capitalize()}"

    except Exception:
        pass

    return info


def load_config():
    """Load configuration from config.json with comprehensive defaults."""
    config_path = os.path.join(os.path.dirname(__file__), "..", "config.json")
    defaults = {
        "api_port": 8090,
        "temperature": 0.7,
        "top_p": 0.9,
        "repeat_penalty": 1.1,
        "mlx_max_tokens": 2048,
        "mlx_seed": None,
        "mlx_stop_tokens": [],
        "trust_remote_code": False,
        "mlx_kv_quant": {"key_bits": 8, "value_bits": 4},
        "mlx_max_kv_size": 8192,
        "mlx_sampling": {
            "temperature": 0.7, "top_p": 1.0, "min_p": 0.0,
            "repetition_penalty": 1.0, "repetition_context_size": 20, "max_tokens": 512
        },
        "mlx_metal_optimizations": True,
        "mlx_memory_limit_fraction": 0.65,
        "kv_bits": 4, "kv_group_size": 64,
        "mlx_kv_quant_native": {"enabled": False, "kv_bits": 4, "kv_group_size": 64, "quantized_kv_start": 0},
    }
    try:
        with open(config_path, "r") as f:
            config = json.load(f)
            for key, val in defaults.items():
                if key not in config:
                    config[key] = val
            return config
    except Exception:
        return defaults


def _parse_stop_tokens(stop_tokens_str):
    """Parse comma-separated stop tokens string into list."""
    if not stop_tokens_str:
        return []
    if isinstance(stop_tokens_str, list):
        return stop_tokens_str
    return [t.strip() for t in stop_tokens_str.split(',') if t.strip()]


def run_benchmark(model_path):
    """Benchmark MLX model: load time, tokens/sec, peak memory."""
    print("\n[MLX BENCHMARK]")

    abs_path = os.path.abspath(model_path)
    config = load_config()
    _set_offline_env(abs_path)
    _set_metal_env()

    cache_dir = config.get("mlx_model_cache", "~/.cache/lumina-mlx/")
    if cache_dir:
        os.environ["HF_HOME"] = os.path.expanduser(cache_dir)
        os.environ["TRANSFORMERS_CACHE"] = os.path.expanduser(cache_dir)

    mx.eval(mx.zeros((1,)))
    load_start = time.time()
    model, tokenizer = mlx_lm.load(model_path)
    load_time = time.time() - load_start
    print(f"✓ Model loaded in {load_time:.2f}s")

    bench_prompt = tokenizer.apply_chat_template(
        [{"role": "user", "content": "Write a short poem about a fast computer."}],
        tokenize=False, add_generation_prompt=True
    )

    token_count = 0
    gen_start = time.time()

    gen_kwargs = get_mlx_generation_kwargs(config, prompt=bench_prompt, override_temp=0.0, override_max_tokens=100)
    gen_kwargs['model'] = model
    gen_kwargs['tokenizer'] = tokenizer

    for result in mlx_lm.stream_generate(**gen_kwargs):
        token_count += 1

    gen_time = time.time() - gen_start
    tps = token_count / gen_time if gen_time > 0 else 0

    try:
        if hasattr(mx, 'metal') and hasattr(mx.metal, 'get_peak_memory'):
            mem_usage = mx.metal.get_peak_memory() / (1024**3)
        elif hasattr(mx, 'metal') and hasattr(mx.metal, 'get_active_memory'):
            mem_usage = mx.metal.get_active_memory() / (1024**3)
        else:
            mem_usage = 0
    except Exception:
        mem_usage = 0

    print(f"✓ Peak memory: {mem_usage:.2f} GB")
    print(f"✓ Tokens generated: {token_count}")
    print(f"✓ Generation time: {gen_time:.2f}s")
    print(f"✓ Tokens/sec: {tps:.2f}\n")


def launch_api_direct(model_path, port):
    """
    Direct generation mode — bypasses mlx_lm HTTP server entirely.
    Spawns a lightweight HTTP server using only Python stdlib + MLX.
    Tokens go: Metal -> Python -> stdout -> Node pipe -> UI.
    No uvicorn, no FastAPI, no second HTTP stack.
    """
    import http.server
    import socketserver

    abs_model_path = os.path.abspath(model_path)
    chip = _detect_apple_silicon_tier()

    print(f'[MLX Direct] {chip["chip_name"]} | {chip["memory_gb"]:.0f}GB unified memory', flush=True)

    # BUG MLX-1 FIX: Initialize _server_start_time immediately at function entry
    global _server_start_time_global
    _server_start_time_global = time.time()
    global MODEL_LOADED, MODEL_LOAD_ERROR
    MODEL_LOADED = False
    MODEL_LOAD_ERROR = None

    if not os.path.exists(abs_model_path):
        MODEL_LOAD_ERROR = f"Model path does not exist: {abs_model_path}"
        print(f'[MLX Direct] ERROR: {MODEL_LOAD_ERROR}', flush=True)
        return

    if not os.path.exists(os.path.join(abs_model_path, 'config.json')):
        MODEL_LOAD_ERROR = f"Not a valid MLX model directory (missing config.json): {abs_model_path}"
        print(f'[MLX Direct] ERROR: {MODEL_LOAD_ERROR}', flush=True)
        return

    if platform.system() == 'Darwin':
        optimizer_path = os.path.join(os.path.dirname(__file__), 'mlx_optimize_system.py')
        if os.path.exists(optimizer_path):
            try:
                subprocess.run([sys.executable, optimizer_path, 'optimize'], timeout=15, cwd=os.path.dirname(optimizer_path))
            except Exception as e:
                print(f'[MLX] System optimizer warning (non-fatal): {e}', flush=True)

    config = load_config()

    cache_dir = config.get("mlx_model_cache", "~/.cache/lumina-mlx/")
    if cache_dir:
        os.environ["HF_HOME"] = os.path.expanduser(cache_dir)
        os.environ["TRANSFORMERS_CACHE"] = os.path.expanduser(cache_dir)

    _set_offline_env(abs_model_path)
    _set_metal_env()

    print('[MLX Direct] Pre-warming Metal device...', flush=True)
    mx.eval(mx.zeros((1,)))

    print(f'[MLX Direct] Loading model: {os.path.basename(abs_model_path)}', flush=True)
    load_start = time.time()
    try:
        # BUG MLX-5 FIX: Use case-insensitive check for .gguf extension
        if abs_model_path.lower().endswith('.gguf'):
            raise ValueError(f"GGUF models are not supported on macOS. Use safetensors or MLX format.")

        adapter_path = config.get('mlx_adapter_path', '').strip()
        adapter_warning = None

        if adapter_path:
            adapter_full_path = os.path.expanduser(adapter_path)
            if not os.path.exists(adapter_full_path):
                adapter_warning = f"LoRA adapter path not found: {adapter_path}"
                print(f'[MLX Direct] Warning: {adapter_warning}', flush=True)
                adapter_path = None
            else:
                print(f'[MLX Direct] Loading LoRA adapter: {adapter_path}', flush=True)

        if adapter_path and os.path.exists(os.path.expanduser(adapter_path)):
            model, tokenizer = mlx_lm.load(abs_model_path, adapter_path=os.path.expanduser(adapter_path))
        else:
            model, tokenizer = mlx_lm.load(abs_model_path)
        load_time = time.time() - load_start
        MODEL_LOADED = True
        print(f'[MLX Direct] Model loaded in {load_time:.1f}s', flush=True)
        if adapter_path:
            print(f'[MLX Direct] LoRA adapter active: {adapter_path}', flush=True)
    except Exception as e:
        MODEL_LOADED = False
        MODEL_LOAD_ERROR = str(e)
        print(f'[MLX Direct] ERROR: Model loading failed: {e}', flush=True)

    _MAX_TOKENS_CEILING = 2048
    if MODEL_LOADED:
        try:
            if hasattr(mx, 'metal') and hasattr(mx.metal, 'get_active_memory'):
                mem_used = mx.metal.get_active_memory() / (1024**3)
            elif hasattr(mx, 'metal') and hasattr(mx.metal, 'get_peak_memory'):
                mem_used = mx.metal.get_peak_memory() / (1024**3)
            else:
                import psutil
                mem_used = psutil.Process().memory_info().rss / (1024**3)
            print(f'[MLX Direct] Memory used after load: {mem_used:.1f} GB', flush=True)
            if mem_used > 6.0:
                print('[MLX Direct] ⚠️ WARNING: Memory usage >6GB! Close other applications to avoid OOM.', flush=True)
        except Exception as e:
            print(f'[MLX Direct] Memory check skipped: {e}', flush=True)
            mem_used = 0.0
    else:
        mem_used = 0.0

    mlx_config = {
        'top_p': float(config.get('top_p', 0.9)),
        'repetition_penalty': float(config.get('repeat_penalty', 1.1)),
        'max_tokens': int(config.get('mlx_max_tokens', 2048)),
        'seed': config.get('mlx_seed') if config.get('mlx_seed') else None,
        'stop_tokens': _parse_stop_tokens(config.get('mlx_stop_tokens', [])),
    }

    # 1.5B-OPTIMIZATION: detect small model and tune defaults
    model_name_lower = os.path.basename(abs_model_path).lower()
    IS_1_5B = '1.5b' in model_name_lower
    if IS_1_5B:
        mlx_config['max_tokens'] = min(mlx_config['max_tokens'], 256)
        _MAX_TOKENS_CEILING = 256
        print('[MLX Direct] 1.5B model detected: max_tokens=256, temperature=0.1', flush=True)

    class MLXHandler(http.server.BaseHTTPRequestHandler):
        """HTTP request handler for MLX chat completions API.

        Handles /v1/chat/completions (streaming + non-streaming),
        /v1/models, /health, /health/memory, and CORS preflight.
        """
        protocol_version = 'HTTP/1.1'

        def handle_one_request(self):
            try:
                super().handle_one_request()
            except ConnectionResetError:
                pass
            except BrokenPipeError:
                pass
            except Exception as e:
                if 'Connection reset' in str(e) or 'broken pipe' in str(e).lower():
                    pass
                else:
                    raise

        def log_message(self, format, *args):
            pass

        def do_GET(self):
            if self.path == '/v1/models' or self.path.startswith('/v1/models'):
                if not MODEL_LOADED:
                    error_msg = MODEL_LOAD_ERROR or "Model not loaded"
                    response = json.dumps({
                        "error": "Model not loaded", "detail": error_msg,
                        "object": "list", "data": []
                    })
                    self._send_json(503, response)
                    return

                model_name = os.path.basename(abs_model_path)
                response = json.dumps({
                    "object": "list",
                    "data": [{
                        "id": model_name,
                        "object": "model",
                        "created": int(time.time()),
                        "owned_by": "lumina-edge"
                    }]
                })
                self._send_json(200, response)
            elif self.path == '/health':
                health_status = {
                    "status": "ok" if MODEL_LOADED else "error",
                    "model_loaded": MODEL_LOADED,
                    "model": os.path.basename(abs_model_path) if MODEL_LOADED else None,
                    "uptime": int(time.time() - _server_start_time_global)
                }
                if MODEL_LOAD_ERROR:
                    health_status["error"] = MODEL_LOAD_ERROR
                self._send_json(200 if MODEL_LOADED else 503, json.dumps(health_status))
            elif self.path == '/health/memory':
                try:
                    if hasattr(mx, 'metal') and hasattr(mx.metal, 'get_active_memory'):
                        current_mem = mx.metal.get_active_memory() / (1024**3)
                    elif hasattr(mx, 'metal') and hasattr(mx.metal, 'get_peak_memory'):
                        current_mem = mx.metal.get_peak_memory() / (1024**3)
                    else:
                        import psutil
                        current_mem = psutil.Process().memory_info().rss / (1024**3)
                except Exception:
                    current_mem = 0.0
                mem_status = {
                    "memory_used_gb": round(current_mem, 1),
                    "memory_total_gb": round(_get_system_memory_gb(), 1),
                    "model_loaded": MODEL_LOADED,
                    "model": os.path.basename(abs_model_path) if MODEL_LOADED else None
                }
                self._send_json(200, json.dumps(mem_status))
            else:
                self._send_json(404, json.dumps({"error": "not found"}))

        def do_POST(self):
            try:
                self._handle_post()
            except Exception as e:
                import traceback
                traceback.print_exc()
                print(f'[MLX] Unhandled error in do_POST: {e}', flush=True)
                try:
                    self._send_json(500, json.dumps({"error": f"Internal server error: {e}"}))
                except Exception:
                    pass
                gc.collect()

        def _handle_post(self):
            """Parse chat completion request, apply tool injection if needed, generate."""
            if not any(p in self.path for p in ['/chat/completions', '/v1']):
                self._send_json(404, json.dumps({"error": "not found"}))
                return

            if not MODEL_LOADED:
                error_msg = MODEL_LOAD_ERROR or "Model not loaded"
                self._send_json(503, json.dumps({"error": "Model not loaded", "detail": error_msg}))
                return

            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length)
                request = json.loads(body)
            except Exception as e:
                self._send_json(400, json.dumps({"error": f"Invalid request: {e}"}))
                return

            req_model = request.get('model', '?')
            req_msgs = len(request.get('messages', []))
            req_tools = len(request.get('tools', []))
            print(f'[MLX] Request: model={req_model} msgs={req_msgs} tools={req_tools}', flush=True)

            messages = request.get('messages', [])
            tools = request.get('tools', [])
            tool_choice = request.get('tool_choice', 'auto')

            # Store last user message for tool call fixing
            self._last_user_msg = ''
            for m in reversed(messages):
                if m.get('role') == 'user':
                    c = m.get('content', '')
                    self._last_user_msg = c if isinstance(c, str) else ' '.join(p.get('text','') if isinstance(p,dict) else str(p) for p in c) if isinstance(c, list) else str(c)
                    break

            if IS_1_5B:
                temperature = float(request.get('temperature', 0.1))
            else:
                temperature = float(request.get('temperature', config.get('temperature', 0.7)))

            max_tokens = int(request.get('max_tokens', mlx_config['max_tokens']))
            if max_tokens > _MAX_TOKENS_CEILING:
                print(f'[MLX Direct] Clamping max_tokens from {max_tokens} to {_MAX_TOKENS_CEILING} (memory safety)', flush=True)
                max_tokens = _MAX_TOKENS_CEILING
            stream = request.get('stream', True)
            top_p = float(request.get('top_p', mlx_config['top_p']))
            repetition_penalty = float(request.get('repetition_penalty', mlx_config['repetition_penalty']))

            # 1.5B-OPTIMIZATION: inject system pre-prompt for small models
            if IS_1_5B:
                small_pre = "You are a precise assistant. Keep responses short. When asked to run a command, use the shell tool immediately without explaining first."
                sys_idx = next((i for i, m in enumerate(messages) if m.get('role') == 'system'), None)
                if sys_idx is not None:
                    existing = messages[sys_idx]['content']
                    if isinstance(existing, list):
                        existing = ' '.join(p.get('text','') if isinstance(p,dict) else str(p) for p in existing)
                    elif not isinstance(existing, str):
                        existing = str(existing)
                    messages[sys_idx] = {'role': 'system', 'content': f"{small_pre}\n\n{existing}"}
                else:
                    messages.insert(0, {'role': 'system', 'content': small_pre})

            # If tools are provided, inject tool definitions into the system message
            if tools:
                if IS_1_5B:
                    tool_block_extra = (
                        "\n\nIMPORTANT: If the user asks you to run a command or execute something, you "
                        "MUST call the function immediately. Do NOT create a to-do list or plan. "
                        "Call the function NOW."
                        "\n\nCRITICAL: The only function available is 'shell' with a 'command' argument. "
                        "Never invent new function names. Use exactly 'shell'."
                    )
                else:
                    tool_block_extra = ""
                fn_lines = []
                for t in tools:
                    fn = t.get('function', t) if isinstance(t, dict) else t
                    if not isinstance(fn, dict):
                        continue
                    name = fn.get('name', 'unknown')
                    params = fn.get('parameters', {})
                    if 'description' in fn and isinstance(fn['description'], str) and len(fn['description']) > 300:
                        fn['description'] = fn['description'][:300] + '...'
                    fn_lines.append(f"{name}:\n  {json.dumps(params, indent=2)}")

                tool_block = (
                    "You are a helpful assistant with access to functions. Use them if required.\n\n"
                    "Available functions:\n"
                    f"<functions>\n{chr(10).join(fn_lines)}\n</functions>\n\n"
                    "To call a function, respond with a JSON object inside <tool_call> tags:\n"
                    "<tool_call>\n"
                    '{"name": "<function-name>", "arguments": <args-json-object>}\n'
                    "</tool_call>\n\n"
                    "If you decide to call a function, ONLY output the <tool_call> block and nothing\n"
                    "else. Do NOT output any other text before or after the tool call."
                    f"{tool_block_extra}"
                )

                sys_idx = next((i for i, m in enumerate(messages) if m.get('role') == 'system'), None)
                if sys_idx is not None:
                    existing = messages[sys_idx]['content']
                    if isinstance(existing, list):
                        existing = ' '.join(p.get('text', '') if isinstance(p, dict) else str(p) for p in existing)
                    elif not isinstance(existing, str):
                        existing = str(existing)
                    messages[sys_idx] = {'role': 'system', 'content': f"{tool_block}\n\n{existing}"}
                else:
                    messages.insert(0, {'role': 'system', 'content': tool_block})

                sys_msg = messages[sys_idx if sys_idx is not None else 0]['content']
                print(f'[MLX Tool Injection] System message:\n{sys_msg}\n---END TOOL SYSTEM---', flush=True)

            # Normalize all message content to strings (required by apply_chat_template)
            for m in messages:
                c = m.get('content')
                if isinstance(c, list):
                    parts = []
                    for p in c:
                        if isinstance(p, dict):
                            parts.append(p.get('text', json.dumps(p)))
                        else:
                            parts.append(str(p))
                    m['content'] = ' '.join(parts)
                elif c is None:
                    m['content'] = ''
                elif not isinstance(c, str):
                    m['content'] = str(c)

            try:
                prompt = tokenizer.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True
                )
            except Exception as e:
                self._send_json(500, json.dumps({"error": f"Template error: {e}"}))
                return

            if stream:
                self._stream_response(prompt, temperature, max_tokens, top_p, repetition_penalty, tools)
            else:
                self._blocking_response(prompt, temperature, max_tokens, top_p, repetition_penalty, tools)

        def _fix_tool_call(self, hallucinated_name, raw_args, user_msg, valid_tools):
            """Attempt to fix a hallucinated tool call into a valid one."""
            user_msg_lower = user_msg.lower() if user_msg else ''

            has_shell = any(
                (t.get('function', t) if isinstance(t, dict) else t).get('name') == 'shell'
                for t in (valid_tools or [])
            )

            fixed_name = None
            fixed_args = None

            # Rule 1: user message mentions git and hallucinated name contains git
            if ('git' in user_msg_lower or 'run git' in user_msg_lower) and 'git' in hallucinated_name.lower():
                import re as _re
                cmd = _re.sub(r'^.*?\bgit\b', '', user_msg, flags=_re.IGNORECASE | _re.DOTALL).strip()
                if not cmd:
                    cmd = 'status'
                fixed_name = 'shell'
                fixed_args = {"command": f"git {cmd}"}

            # Rule 2: user asks to "run" or "execute" and a shell tool exists
            if not fixed_name and has_shell:
                run_match = None
                import re as _re2
                for prefix in ['run ', 'execute ', 'run command ']:
                    if prefix in user_msg_lower:
                        cmd = user_msg[user_msg_lower.index(prefix) + len(prefix):].strip()
                        if cmd:
                            run_match = cmd
                            break
                if run_match:
                    fixed_name = 'shell'
                    fixed_args = {"command": run_match}

            # Rule 3: only one valid tool available, call it with user message
            if not fixed_name and valid_tools and len(valid_tools) == 1:
                only_tool = (valid_tools[0].get('function', valid_tools[0]) if isinstance(valid_tools[0], dict) else valid_tools[0])
                only_name = only_tool.get('name', '') if isinstance(only_tool, dict) else ''
                if only_name:
                    fixed_name = only_name
                    try:
                        params = only_tool.get('parameters', {}) if isinstance(only_tool, dict) else {}
                        first_prop = next(iter(params.get('properties', {}).keys()), 'command')
                        fixed_args = {first_prop: user_msg}
                    except Exception:
                        fixed_args = {"command": user_msg}

            if fixed_name and fixed_args:
                return {
                    "id": f"call_{int(time.time()*1000)}_fixed",
                    "type": "function",
                    "function": {"name": fixed_name, "arguments": json.dumps(fixed_args)}
                }
            return None

        def _parse_tool_calls(self, text, tools_list=None):
            """
            Parse tool calls from model output into OpenAI tool_calls format.
            Tries 5 strategies + checklist fallback + hallucination fixing.
            """
            import re
            text = text.rstrip()
            text = re.sub(r'(<\|im_end\|>\s*)+$', '', text)
            text = text.strip()

            if not text:
                return None

            valid_names = set()
            valid_tools_list = tools_list or []
            if valid_tools_list:
                for t in valid_tools_list:
                    fn = t.get('function', t) if isinstance(t, dict) else t
                    if isinstance(fn, dict):
                        n = fn.get('name')
                        if n:
                            valid_names.add(n)

            hallucinated_candidates = []

            def _validate_or_collect(candidate):
                """If valid, return formatted call. Otherwise collect for fixing."""
                if not isinstance(candidate, dict):
                    return None
                name = candidate.get('name', candidate.get('function'))
                if not isinstance(name, str) or not name:
                    return None
                args = candidate.get('arguments', {})
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except (json.JSONDecodeError, TypeError):
                        return None
                if not isinstance(args, dict):
                    return None
                formatted = {
                    "id": f"call_{int(time.time()*1000)}_{hash(name) % 10000}",
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)}
                }
                if valid_names and name not in valid_names:
                    hallucinated_candidates.append((name, args, formatted))
                    return None
                return formatted

            # Strategy 1: <tool_call>...</tool_call> tags
            m = re.search(r'<tool_call>\s*(\{.*?\})\s*</tool_call>', text, re.DOTALL)
            if m:
                try:
                    parsed = json.loads(m.group(1).strip())
                    result = _validate_or_collect(parsed)
                    if result:
                        return [result]
                except json.JSONDecodeError:
                    pass

            # Strategy 2-4: scan JSON objects in various ways
            brace_starts = [i for i, c in enumerate(text) if c == '{']
            for start_pos in brace_starts:
                depth = 0
                for i in range(start_pos, len(text)):
                    if text[i] == '{':
                        depth += 1
                    elif text[i] == '}':
                        depth -= 1
                        if depth == 0:
                            try:
                                candidate = json.loads(text[start_pos:i+1])
                                result = _validate_or_collect(candidate)
                                if result:
                                    return [result]
                            except (json.JSONDecodeError, TypeError):
                                pass
                            break

            if valid_names:
                for start_pos in brace_starts:
                    depth = 0
                    for i in range(start_pos, len(text)):
                        if text[i] == '{':
                            depth += 1
                        elif text[i] == '}':
                            depth -= 1
                            if depth == 0:
                                try:
                                    candidate = json.loads(text[start_pos:i+1])
                                    n = candidate.get('name', candidate.get('function'))
                                    if isinstance(n, str) and n in valid_names:
                                        result = _validate_or_collect(candidate)
                                        if result:
                                            return [result]
                                except (json.JSONDecodeError, TypeError):
                                    pass
                                break

            try:
                full = json.loads(text)
                result = _validate_or_collect(full)
                if result:
                    return [result]
            except (json.JSONDecodeError, TypeError):
                pass

            # Strategy 5: checklist fallback (numbered tasks, bullet points)
            lines = [l.strip() for l in text.split('\n') if l.strip()]
            for line in lines:
                task = None
                if re.match(r'^-\s*\[\s*[ xX]?\s*\]\s+', line):
                    task = re.sub(r'^-\s*\[\s*[ xX]?\s*\]\s+', '', line)
                elif re.match(r'^-\s+', line):
                    task = re.sub(r'^-\s+', '', line)
                elif re.match(r'^\d+[.)]\s+', line):
                    task = re.sub(r'^\d+[.)]\s+', '', line)
                if task and valid_tools_list:
                    for t in valid_tools_list:
                        fn = t.get('function', t) if isinstance(t, dict) else t
                        if not isinstance(fn, dict):
                            continue
                        fname = fn.get('name', '')
                        if fname and fname.lower() in task.lower():
                            return [{
                                "id": f"call_{int(time.time()*1000)}_checklist",
                                "type": "function",
                                "function": {"name": fname, "arguments": json.dumps({"task": task})}
                            }]

            # Hallucination fix: try to recover any collected hallucinated calls
            if hallucinated_candidates:
                for hall_name, hall_args, hall_formatted in hallucinated_candidates:
                    user_msg = getattr(self, '_last_user_msg', '')
                    fixed = self._fix_tool_call(hall_name, hall_args, user_msg, valid_tools_list)
                    if fixed:
                        return [fixed]

            return None

        def _build_tool_call_chunk(self, chunk_base, tool_calls):
            """Build a streaming chunk with tool_call delta for SSE."""
            return {
                **chunk_base,
                "id": f"chatcmpl-{int(time.time()*1000)}",
                "choices": [{
                    "index": 0,
                    "delta": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "index": i,
                            "id": tc["id"],
                            "type": "function",
                            "function": {"name": tc["function"]["name"], "arguments": tc["function"]["arguments"]}
                        } for i, tc in enumerate(tool_calls)]
                    },
                    "finish_reason": "tool_calls"
                }]
            }

        def _stream_response(self, prompt, temperature, max_tokens, top_p, repetition_penalty, has_tools=False):
            """Stream tokens via SSE as they are generated."""
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self.send_header('Access-Control-Allow-Origin', '*')
            # BUG MLX-3 FIX: Tell reverse proxies (nginx, OpenWebUI) not to buffer SSE
            self.send_header('X-Accel-Buffering', 'no')
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()

            try:
                chunk_base = {
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": os.path.basename(abs_model_path),
                }

                gen_kwargs = get_mlx_generation_kwargs(
                    config, prompt=prompt,
                    override_temp=temperature, override_top_p=top_p, override_max_tokens=max_tokens
                )
                gen_kwargs['model'] = model
                gen_kwargs['tokenizer'] = tokenizer

                full_text = ""
                gen_start = time.time()
                gen_timeout = 60
                for result in mlx_lm.stream_generate(**gen_kwargs):
                    if time.time() - gen_start > gen_timeout:
                        error_chunk = {**chunk_base, "id": f"chatcmpl-{int(time.time()*1000)}",
                            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
                        try:
                            self.wfile.write(f"data: {json.dumps(error_chunk)}\n\n".encode('utf-8'))
                            self.wfile.write(b"data: [DONE]\n\n")
                            self.wfile.flush()
                        except Exception:
                            pass
                        gc.collect()
                        return
                    token_text = result.text if hasattr(result, 'text') else str(result)
                    if not token_text:
                        continue
                    full_text += token_text

                    chunk = {
                        **chunk_base,
                        "id": f"chatcmpl-{int(time.time()*1000)}",
                        "choices": [{"index": 0, "delta": {"content": token_text}, "finish_reason": None}]
                    }

                    try:
                        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode('utf-8'))
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        break

                if not full_text or not full_text.strip():
                    err_chunk = {**chunk_base, "id": f"chatcmpl-{int(time.time()*1000)}",
                        "choices": [{"index": 0, "delta": {"content": "I encountered an error generating a response. Please try again."}, "finish_reason": "stop"}]}
                    try:
                        self.wfile.write(f"data: {json.dumps(err_chunk)}\n\n".encode('utf-8'))
                        self.wfile.write(b"data: [DONE]\n\n")
                        self.wfile.flush()
                    except Exception:
                        pass
                    gc.collect()
                    return

                tool_calls = self._parse_tool_calls(full_text, has_tools) if has_tools else None
                finish_reason = "tool_calls" if tool_calls else "stop"

                try:
                    if tool_calls:
                        final_chunk = self._build_tool_call_chunk(chunk_base, tool_calls)
                    else:
                        final_chunk = {
                            **chunk_base,
                            "id": f"chatcmpl-{int(time.time()*1000)}",
                            "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}]
                        }
                    self.wfile.write(f"data: {json.dumps(final_chunk)}\n\n".encode('utf-8'))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except Exception:
                    pass
                gc.collect()

            except Exception as e:
                error_chunk = {"error": str(e)}
                try:
                    self.wfile.write(f"data: {json.dumps(error_chunk)}\n\n".encode())
                    self.wfile.flush()
                except Exception:
                    pass
                gc.collect()

        def _blocking_response(self, prompt, temperature, max_tokens, top_p, repetition_penalty, has_tools=False):
            """Non-streaming response — accumulate all tokens then return."""
            full_text = ""
            try:
                gen_kwargs = get_mlx_generation_kwargs(
                    config, prompt=prompt,
                    override_temp=temperature, override_top_p=top_p, override_max_tokens=max_tokens
                )
                gen_kwargs['model'] = model
                gen_kwargs['tokenizer'] = tokenizer

                gen_start = time.time()
                gen_timeout = 60
                for result in mlx_lm.stream_generate(**gen_kwargs):
                    if time.time() - gen_start > gen_timeout:
                        response = {
                            "id": f"chatcmpl-{int(time.time()*1000)}",
                            "object": "chat.completion", "created": int(time.time()),
                            "model": os.path.basename(abs_model_path),
                            "choices": [{"index": 0, "message": {"role": "assistant", "content": "I encountered an error generating a response. Please try again."}, "finish_reason": "stop"}],
                            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                        }
                        self._send_json(200, json.dumps(response))
                        gc.collect()
                        return
                    full_text += result.text if hasattr(result, 'text') else str(result)

                if not full_text or not full_text.strip():
                    response = {
                        "id": f"chatcmpl-{int(time.time()*1000)}",
                        "object": "chat.completion", "created": int(time.time()),
                        "model": os.path.basename(abs_model_path),
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": "I encountered an error generating a response. Please try again."}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                    }
                    self._send_json(200, json.dumps(response))
                    gc.collect()
                    return

                tool_calls = self._parse_tool_calls(full_text, has_tools) if has_tools else None

                try:
                    prompt_tokens = len(tokenizer.encode(prompt)) if tokenizer else 0
                    completion_tokens = len(tokenizer.encode(full_text)) if tokenizer else 0
                    total_tokens = prompt_tokens + completion_tokens
                except Exception as e:
                    prompt_tokens = len(prompt) // 4
                    completion_tokens = len(full_text) // 4
                    total_tokens = prompt_tokens + completion_tokens

                if tool_calls:
                    response = {
                        "id": f"chatcmpl-{int(time.time()*1000)}",
                        "object": "chat.completion", "created": int(time.time()),
                        "model": os.path.basename(abs_model_path),
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": tool_calls}, "finish_reason": "tool_calls"}],
                        "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "total_tokens": total_tokens}
                    }
                else:
                    response = {
                        "id": f"chatcmpl-{int(time.time()*1000)}",
                        "object": "chat.completion", "created": int(time.time()),
                        "model": os.path.basename(abs_model_path),
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": full_text}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "total_tokens": total_tokens}
                    }
                self._send_json(200, json.dumps(response))
                gc.collect()
            except Exception as e:
                self._send_json(500, json.dumps({"error": str(e)}))
                gc.collect()

        def do_OPTIONS(self):
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            self.end_headers()

        def _send_json(self, code, body):
            encoded = body.encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(encoded)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(encoded)

    _server_start_time = time.time()

    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(('127.0.0.1', port), MLXHandler) as httpd:
            print(f'[MLX Direct] Server ready on port {port}', flush=True)
            print(f'[MLX Direct] Model: {os.path.basename(abs_model_path)}', flush=True)
            print(f'Application startup complete.', flush=True)
            sys.stdout.flush()

            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print('[MLX Direct] Shutting down...', flush=True)
    except OSError as e:
        import errno
        if e.errno in (errno.EADDRINUSE, 98, 48) or 'Address already in use' in str(e):
            print(f'Error: Port {port} is already in use. Change api_port in config.json or stop the process using that port.', file=sys.stderr)
            sys.exit(1)
        raise


def launch_api(model_path, port=None):
    """Launch the MLX direct inference API server."""
    abs_model_path = os.path.abspath(model_path)
    config = load_config()
    actual_port = port if port is not None else config.get('api_port', 8090)

    port_source = "CLI arg" if port is not None else ("config.json" if 'api_port' in config else "default")
    print(f'[MLX] Starting direct inference server on port {actual_port} (source: {port_source})', flush=True)
    print(f'[MLX] Model: {abs_model_path}', flush=True)
    launch_api_direct(abs_model_path, actual_port)


def launch_core(model_path, json_output=False):
    """Interactive chat mode — reads from stdin, writes to stdout."""
    config = load_config()

    cache_dir = config.get("mlx_model_cache", "~/.cache/lumina-mlx/")
    if cache_dir:
        os.environ["HF_HOME"] = os.path.expanduser(cache_dir)
        os.environ["TRANSFORMERS_CACHE"] = os.path.expanduser(cache_dir)

    temp = float(config.get("temperature", 0.7))
    top_p = float(config.get("top_p", 0.9))
    repetition_penalty = float(config.get("repeat_penalty", 1.1))
    max_tokens = int(config.get("mlx_max_tokens", 2048))
    seed = config.get("mlx_seed")
    stop_tokens = _parse_stop_tokens(config.get("mlx_stop_tokens", []))

    abs_model_path = os.path.abspath(model_path)

    _set_offline_env(abs_model_path)
    _set_metal_env()

    if json_output:
        print(f'{{"status": "core_ready", "model": "{model_path}"}}')

    print("Loading model for chat...")
    model, tokenizer = mlx_lm.load(model_path)
    print("\nLumina Edge MLX Chat (type /exit to quit)\n")

    history = []

    while True:
        try:
            user_input = input("You: ")
            if user_input.strip() == "/exit":
                break

            history.append({"role": "user", "content": user_input})
            prompt = tokenizer.apply_chat_template(history, tokenize=False, add_generation_prompt=True)

            print("AI: ", end="", flush=True)
            resp = ""

            gen_kwargs = get_mlx_generation_kwargs(
                config, prompt=prompt,
                override_temp=temp, override_top_p=top_p, override_max_tokens=max_tokens
            )
            gen_kwargs['model'] = model
            gen_kwargs['tokenizer'] = tokenizer

            for result in mlx_lm.stream_generate(**gen_kwargs):
                token_text = result.text if hasattr(result, 'text') else str(result)
                print(token_text, end="", flush=True)
                resp += token_text
            print("\n")

            history.append({"role": "assistant", "content": resp})

        except (EOFError, KeyboardInterrupt):
            break


def main():
    parser = argparse.ArgumentParser(description="Lumina Edge MLX Backend")
    parser.add_argument("--mode", required=True, choices=["api", "core"])
    parser.add_argument("--model", required=True, help="Path to MLX/Safetensors model")
    parser.add_argument("--port", type=int, default=None, help="Port for API server (default: read from config.json)")
    parser.add_argument("--benchmark", action="store_true")
    parser.add_argument("--json-output", action="store_true")
    args = parser.parse_args()

    if args.benchmark:
        run_benchmark(args.model)
        if args.mode != "api":
            return

    if args.mode == "api":
        launch_api(args.model, args.port)
    elif args.mode == "core":
        launch_core(args.model, args.json_output)


if __name__ == "__main__":
    main()
