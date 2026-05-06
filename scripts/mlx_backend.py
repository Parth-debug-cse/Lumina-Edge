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

try:
    import mlx.core as mx
    import mlx_lm
except ImportError:
    print("❌ ERROR: MLX packages not found. Please install requirements-mac.txt")
    sys.exit(1)

# Module-level flags for model load state (used by HTTP handlers)
MODEL_LOADED = False
MODEL_LOAD_ERROR = None


def _set_offline_env(model_path=None):
    """
    Set environment variables to prevent HuggingFace Hub network access.
    Only sets OFFLINE mode if all required tokenizer files exist locally.
    Always disables telemetry.
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

# Detect asymmetric KV support at module level
try:
    import inspect as _inspect
    _gen_sig = _inspect.signature(mlx_lm.stream_generate)
    _supports_kv_asym = 'key_bits' in _gen_sig.parameters
    _supports_kv_sym = 'kv_bits' in _gen_sig.parameters
    if _supports_kv_asym:
        print('[MLX] Asymmetric KV quantization supported: K=8bit, V=4bit', flush=True)
    elif _supports_kv_sym:
        print('[MLX] Symmetric KV quantization supported: 8-bit', flush=True)
    else:
        print('[MLX] KV quantization not available in this mlx_lm version', flush=True)
except Exception:
    _supports_kv_asym = False
    _supports_kv_sym = False
    print('[MLX] KV quantization detection failed, using defaults', flush=True)

def _get_kv_kwargs():
    """Get KV quantization kwargs based on mlx_lm support."""
    if _supports_kv_asym:
        return {'key_bits': 8, 'value_bits': 4}
    elif _supports_kv_sym:
        return {'kv_bits': 8}
    return {}

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
        
        # Detect generation
        for gen, name in [(5,'m5'),(4,'m4'),(3,'m3'),(2,'m2'),(1,'m1')]:
            if name in brand:
                info['generation'] = gen
                break
        
        # Detect tier from GPU core count (most reliable method)
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
        "api_port": 1234,
        "temperature": 0.7,
        "top_p": 0.9,
        "repeat_penalty": 1.1,
        "mlx_max_tokens": 2048,
        "mlx_seed": None,
        "mlx_stop_tokens": [],
        "mlx_model_cache": "~/.cache/lumina-mlx/",
        "trust_remote_code": False,
    }
    try:
        with open(config_path, "r") as f:
            config = json.load(f)
            # Merge with defaults
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
    # Parse comma-separated string, strip whitespace
    return [t.strip() for t in stop_tokens_str.split(',') if t.strip()]

def run_benchmark(model_path):
    print("\n[MLX BENCHMARK]")

    abs_path = os.path.abspath(model_path)
    config = load_config()
    _set_offline_env(abs_path)
    _set_metal_env()

    # Set model cache directory
    cache_dir = config.get("mlx_model_cache", "~/.cache/lumina-mlx/")
    if cache_dir:
        os.environ["HF_HOME"] = os.path.expanduser(cache_dir)
        os.environ["TRANSFORMERS_CACHE"] = os.path.expanduser(cache_dir)

    # Pre-warm Metal and load model
    mx.eval(mx.zeros((1,)))
    load_start = time.time()
    trust_remote = config.get("trust_remote_code", False)
    model, tokenizer = mlx_lm.load(model_path, trust_remote_code=trust_remote)
    load_time = time.time() - load_start
    print(f"✓ Model loaded in {load_time:.2f}s")

    # Pre-warm shaders with single token generation
    warmup_prompt = tokenizer.apply_chat_template(
        [{"role": "user", "content": "hi"}],
        tokenize=False, add_generation_prompt=True
    )
    next(mlx_lm.stream_generate(model, tokenizer, prompt=warmup_prompt, max_tokens=1, temp=0.0, **_get_kv_kwargs()))
    print("✓ Shaders pre-warmed")

    # Benchmark with realistic prompt
    bench_prompt = tokenizer.apply_chat_template(
        [{"role": "user", "content": "Write a short poem about a fast computer."}],
        tokenize=False, add_generation_prompt=True
    )

    token_count = 0
    gen_start = time.time()

    for result in mlx_lm.stream_generate(
        model, tokenizer,
        prompt=bench_prompt,
        max_tokens=100,
        temp=0.0,
        **_get_kv_kwargs(),
    ):
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
    Tokens go: Metal → Python → stdout → Node pipe → UI.
    No uvicorn, no FastAPI, no second HTTP stack.
    """
    import http.server
    import socketserver
    
    abs_model_path = os.path.abspath(model_path)
    chip = _detect_apple_silicon_tier()
    
    print(f'[MLX Direct] {chip["chip_name"]} | {chip["memory_gb"]:.0f}GB unified memory', flush=True)
    
    # Validate model directory (set error flags for early returns)
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
    
    # Run system optimizer and set up environment
    if platform.system() == 'Darwin':
        optimizer_path = os.path.join(os.path.dirname(__file__), 'mlx_optimize_system.py')
        if os.path.exists(optimizer_path):
            try:
                subprocess.run([sys.executable, optimizer_path, 'optimize'], timeout=15, cwd=os.path.dirname(optimizer_path))
            except Exception as e:
                print(f'[MLX] System optimizer warning (non-fatal): {e}', flush=True)
    
    # Load config
    config = load_config()

    # Set model cache directory
    cache_dir = config.get("mlx_model_cache", "~/.cache/lumina-mlx/")
    if cache_dir:
        os.environ["HF_HOME"] = os.path.expanduser(cache_dir)
        os.environ["TRANSFORMERS_CACHE"] = os.path.expanduser(cache_dir)

    _set_offline_env(abs_model_path)
    _set_metal_env()

    # Pre-warm Metal and load model
    print('[MLX Direct] Pre-warming Metal device...', flush=True)
    mx.eval(mx.zeros((1,)))

    print(f'[MLX Direct] Loading model: {os.path.basename(abs_model_path)}', flush=True)
    load_start = time.time()
    trust_remote = config.get("trust_remote_code", False)
    
    try:
        # Check for GGUF format (not supported on macOS/MLX)
        if abs_model_path.endswith('.gguf') or abs_model_path.endswith('.GGUF'):
            raise ValueError(f"GGUF models are not supported on macOS. Use safetensors or MLX format.")
        
        # Check for LoRA adapter path (optional)
        adapter_path = config.get('mlx_adapter_path', '').strip()
        adapter_warning = None
        
        if adapter_path:
            adapter_full_path = os.path.expanduser(adapter_path)
            if not os.path.exists(adapter_full_path):
                adapter_warning = f"LoRA adapter path not found: {adapter_path}"
                print(f'[MLX Direct] Warning: {adapter_warning}', flush=True)
                adapter_path = None  # Don't pass to mlx_lm if not found
            else:
                print(f'[MLX Direct] Loading LoRA adapter: {adapter_path}', flush=True)
        
        # Load model with optional adapter
        load_kwargs = {'trust_remote_code': trust_remote}
        if adapter_path and os.path.exists(os.path.expanduser(adapter_path)):
            load_kwargs['adapter_path'] = os.path.expanduser(adapter_path)
        
        model, tokenizer = mlx_lm.load(abs_model_path, **load_kwargs)
        load_time = time.time() - load_start
        MODEL_LOADED = True
        print(f'[MLX Direct] Model loaded in {load_time:.1f}s', flush=True)
        if adapter_path:
            print(f'[MLX Direct] LoRA adapter active: {adapter_path}', flush=True)
    except Exception as e:
        MODEL_LOADED = False
        MODEL_LOAD_ERROR = str(e)
        print(f'[MLX Direct] ERROR: Model loading failed: {e}', flush=True)
        # Continue with server running - health endpoint will report not ready
    
    # Pre-warm shaders efficiently (only if model loaded)
    if MODEL_LOADED:
        try:
            warmup_prompt = tokenizer.apply_chat_template(
                [{"role": "user", "content": "hi"}], 
                tokenize=False, add_generation_prompt=True
            )
            next(mlx_lm.stream_generate(model, tokenizer, prompt=warmup_prompt, max_tokens=1, temp=0.0, **_get_kv_kwargs()))
            print('[MLX Direct] Shaders compiled and warm', flush=True)
        except Exception as e:
            print(f'[MLX Direct] Warmup warning (non-fatal): {e}', flush=True)
    else:
        print('[MLX Direct] Skipping warmup - model not loaded', flush=True)
    
    kv_kwargs = _get_kv_kwargs()

    # Get MLX-specific config values
    mlx_config = {
        'top_p': float(config.get('top_p', 0.9)),
        'repetition_penalty': float(config.get('repeat_penalty', 1.1)),
        'max_tokens': int(config.get('mlx_max_tokens', 2048)),
        'seed': config.get('mlx_seed') if config.get('mlx_seed') else None,
        'stop_tokens': _parse_stop_tokens(config.get('mlx_stop_tokens', [])),
    }

    class MLXHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            # Suppress default HTTP request logging — too noisy
            pass
        
        def do_GET(self):
            if self.path == '/v1/models' or self.path.startswith('/v1/models'):
                # Check if model is loaded
                if not MODEL_LOADED:
                    error_msg = MODEL_LOAD_ERROR or "Model not loaded"
                    response = json.dumps({
                        "error": "Model not loaded",
                        "detail": error_msg,
                        "object": "list",
                        "data": []
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
                    "model_loaded": MODEL_LOADED
                }
                if MODEL_LOAD_ERROR:
                    health_status["error"] = MODEL_LOAD_ERROR
                self._send_json(200 if MODEL_LOADED else 503, json.dumps(health_status))
            else:
                self._send_json(404, json.dumps({"error": "not found"}))
        
        def do_POST(self):
            if '/chat/completions' not in self.path:
                self._send_json(404, json.dumps({"error": "not found"}))
                return
            
            # Check if model is loaded before processing request
            if not MODEL_LOADED:
                error_msg = MODEL_LOAD_ERROR or "Model not loaded"
                self._send_json(503, json.dumps({
                    "error": "Model not loaded",
                    "detail": error_msg
                }))
                return
            
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length)
                request = json.loads(body)
            except Exception as e:
                self._send_json(400, json.dumps({"error": f"Invalid request: {e}"}))
                return
            
            messages = request.get('messages', [])
            temperature = float(request.get('temperature', config.get('temperature', 0.7)))
            max_tokens = int(request.get('max_tokens', mlx_config['max_tokens']))
            stream = request.get('stream', True)
            top_p = float(request.get('top_p', mlx_config['top_p']))
            repetition_penalty = float(request.get('repetition_penalty', mlx_config['repetition_penalty']))
            
            # Format prompt using chat template
            try:
                prompt = tokenizer.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True
                )
            except Exception as e:
                self._send_json(500, json.dumps({"error": f"Template error: {e}"}))
                return
            
            if stream:
                self._stream_response(prompt, temperature, max_tokens, top_p, repetition_penalty, kv_kwargs)
            else:
                self._blocking_response(prompt, temperature, max_tokens, top_p, repetition_penalty, kv_kwargs)
        
        def _stream_response(self, prompt, temperature, max_tokens, top_p, repetition_penalty, kv_kwargs):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            try:
                chunk_base = {
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": os.path.basename(abs_model_path),
                }

                # Build generate kwargs
                gen_kwargs = {
                    'model': model,
                    'tokenizer': tokenizer,
                    'prompt': prompt,
                    'max_tokens': max_tokens,
                    'temp': temperature,
                    'top_p': top_p,
                    **kv_kwargs,
                }
                # Add repetition_penalty if mlx_lm supports it
                try:
                    import inspect
                    sig = inspect.signature(mlx_lm.stream_generate)
                    if 'repetition_penalty' in sig.parameters:
                        gen_kwargs['repetition_penalty'] = repetition_penalty
                except Exception:
                    pass
                # Add seed if set
                if mlx_config['seed']:
                    try:
                        gen_kwargs['seed'] = int(mlx_config['seed'])
                    except Exception:
                        pass
                # Add stop tokens if set
                if mlx_config['stop_tokens']:
                    gen_kwargs['stop'] = mlx_config['stop_tokens']

                for result in mlx_lm.stream_generate(**gen_kwargs):
                    token_text = result.text if hasattr(result, 'text') else str(result)
                    if not token_text:
                        continue
                    
                    chunk = {
                        **chunk_base,
                        "id": f"chatcmpl-{int(time.time()*1000)}",
                        "choices": [{
                            "index": 0,
                            "delta": {"content": token_text},
                            "finish_reason": None
                        }]
                    }
                    
                    try:
                        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode('utf-8'))
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        break
                
                # Send final chunk with finish_reason for OpenAI compatibility
                try:
                    final_chunk = {
                        **chunk_base,
                        "id": f"chatcmpl-{int(time.time()*1000)}",
                        "choices": [{
                            "index": 0,
                            "delta": {},
                            "finish_reason": "stop"
                        }]
                    }
                    self.wfile.write(f"data: {json.dumps(final_chunk)}\n\n".encode('utf-8'))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except Exception:
                    pass
                    
            except Exception as e:
                error_chunk = {"error": str(e)}
                try:
                    self.wfile.write(f"data: {json.dumps(error_chunk)}\n\n".encode())
                    self.wfile.flush()
                except Exception:
                    pass
        
        def _blocking_response(self, prompt, temperature, max_tokens, top_p, repetition_penalty, kv_kwargs):
            full_text = ""
            try:
                # Build generate kwargs (same as streaming)
                gen_kwargs = {
                    'model': model,
                    'tokenizer': tokenizer,
                    'prompt': prompt,
                    'max_tokens': max_tokens,
                    'temp': temperature,
                    'top_p': top_p,
                    **kv_kwargs,
                }
                try:
                    import inspect
                    sig = inspect.signature(mlx_lm.stream_generate)
                    if 'repetition_penalty' in sig.parameters:
                        gen_kwargs['repetition_penalty'] = repetition_penalty
                except Exception:
                    pass
                if mlx_config['seed']:
                    try:
                        gen_kwargs['seed'] = int(mlx_config['seed'])
                    except Exception:
                        pass
                if mlx_config['stop_tokens']:
                    gen_kwargs['stop'] = mlx_config['stop_tokens']

                for result in mlx_lm.stream_generate(**gen_kwargs):
                    full_text += result.text if hasattr(result, 'text') else str(result)
                
                # Count tokens using actual tokenizer (P0-3 fix)
                try:
                    prompt_tokens = len(tokenizer.encode(prompt)) if tokenizer else 0
                    completion_tokens = len(tokenizer.encode(full_text)) if tokenizer else 0
                    total_tokens = prompt_tokens + completion_tokens
                except Exception as e:
                    # Fallback: use character count / 4 as rough estimate
                    print(f'[MLX Direct] Tokenizer error, using estimate: {e}', flush=True)
                    prompt_tokens = len(prompt) // 4
                    completion_tokens = len(full_text) // 4
                    total_tokens = prompt_tokens + completion_tokens
                
                response = {
                    "id": f"chatcmpl-{int(time.time()*1000)}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": os.path.basename(abs_model_path),
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": full_text},
                        "finish_reason": "stop"
                    }],
                    "usage": {
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": total_tokens
                    }
                }
                self._send_json(200, json.dumps(response))
            except Exception as e:
                self._send_json(500, json.dumps({"error": str(e)}))
        
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
    
    # Start the server
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(('127.0.0.1', port), MLXHandler) as httpd:
            print(f'[MLX Direct] Server ready on port {port}', flush=True)
            print(f'[MLX Direct] Model: {os.path.basename(abs_model_path)}', flush=True)
            print(f'Application startup complete.', flush=True)  # Node watches for this line
            sys.stdout.flush()

            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print('[MLX Direct] Shutting down...', flush=True)
    except OSError as e:
        if e.errno == 98 or 'Address already in use' in str(e):  # errno 98 = EADDRINUSE on Linux
            print(f'Error: Port {port} is already in use. Change api_port in config.json or stop the process using that port.', file=sys.stderr)
            sys.exit(1)
        raise

def launch_api(model_path, port=None):
    abs_model_path = os.path.abspath(model_path)
    config = load_config()
    # Use provided port, or config api_port, or default 1234
    actual_port = port if port is not None else config.get('api_port', 1234)
    
    # Determine port source for logging
    port_source = "CLI arg" if port is not None else ("config.json" if 'api_port' in config else "default")
    print(f'[MLX] Starting direct inference server on port {actual_port} (source: {port_source})', flush=True)
    print(f'[MLX] Model: {abs_model_path}', flush=True)
    launch_api_direct(abs_model_path, actual_port)

def launch_core(model_path, json_output=False):
    config = load_config()

    # Set model cache directory
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
    trust_remote = config.get("trust_remote_code", False)
    model, tokenizer = mlx_lm.load(model_path, trust_remote_code=trust_remote)
    print("\nLumina Edge MLX Chat (type /exit to quit)\n")

    history = []
    kv_kwargs = _get_kv_kwargs()

    # Build base generation kwargs
    base_gen_kwargs = {
        'model': model,
        'tokenizer': tokenizer,
        'max_tokens': max_tokens,
        'temp': temp,
        'top_p': top_p,
        **kv_kwargs,
    }

    # Add repetition_penalty if supported
    try:
        import inspect
        sig = inspect.signature(mlx_lm.stream_generate)
        if 'repetition_penalty' in sig.parameters:
            base_gen_kwargs['repetition_penalty'] = repetition_penalty
    except Exception:
        pass

    # Add seed if set
    if seed:
        try:
            base_gen_kwargs['seed'] = int(seed)
        except Exception:
            pass

    # Add stop tokens if set
    if stop_tokens:
        base_gen_kwargs['stop'] = stop_tokens

    while True:
        try:
            user_input = input("You: ")
            if user_input.strip() == "/exit":
                break

            history.append({"role": "user", "content": user_input})
            prompt = tokenizer.apply_chat_template(history, tokenize=False, add_generation_prompt=True)

            print("AI: ", end="", flush=True)
            resp = ""

            # Clone base kwargs and add prompt
            gen_kwargs = {**base_gen_kwargs, 'prompt': prompt}

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

    if args.mode == "api":
        launch_api(args.model, args.port)
    elif args.mode == "core":
        launch_core(args.model, args.json_output)

if __name__ == "__main__":
    main()
