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
    config_path = os.path.join(os.path.dirname(__file__), "..", "config.json")
    try:
        with open(config_path, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def run_benchmark(model_path):
    print("\n[MLX BENCHMARK]")
    
    abs_path = os.path.abspath(model_path)
    _set_offline_env(abs_path)
    _set_metal_env()
    
    # Pre-warm Metal and load model
    mx.eval(mx.zeros((1,)))
    load_start = time.time()
    model, tokenizer = mlx_lm.load(model_path)
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
    
    # Validate model directory
    if not os.path.exists(abs_model_path):
        print(f'[MLX Direct] ERROR: Model path does not exist: {abs_model_path}', flush=True)
        sys.exit(1)
    
    if not os.path.exists(os.path.join(abs_model_path, 'config.json')):
        print(f'[MLX Direct] ERROR: Not a valid MLX model directory: {abs_model_path}', flush=True)
        sys.exit(1)
    
    # Run system optimizer and set up environment
    if platform.system() == 'Darwin':
        optimizer_path = os.path.join(os.path.dirname(__file__), 'mlx_optimize_system.py')
        if os.path.exists(optimizer_path):
            try:
                subprocess.run([sys.executable, optimizer_path, 'optimize'], timeout=15, cwd=os.path.dirname(optimizer_path))
            except Exception as e:
                print(f'[MLX] System optimizer warning (non-fatal): {e}', flush=True)
    
    _set_offline_env(abs_model_path)
    _set_metal_env()
    
    # Pre-warm Metal and load model
    print('[MLX Direct] Pre-warming Metal device...', flush=True)
    mx.eval(mx.zeros((1,)))
    
    print(f'[MLX Direct] Loading model: {os.path.basename(abs_model_path)}', flush=True)
    load_start = time.time()
    model, tokenizer = mlx_lm.load(abs_model_path)
    load_time = time.time() - load_start
    print(f'[MLX Direct] Model loaded in {load_time:.1f}s', flush=True)
    
    # Pre-warm shaders efficiently
    try:
        warmup_prompt = tokenizer.apply_chat_template(
            [{"role": "user", "content": "hi"}], 
            tokenize=False, add_generation_prompt=True
        )
        next(mlx_lm.stream_generate(model, tokenizer, prompt=warmup_prompt, max_tokens=1, temp=0.0, **_get_kv_kwargs()))
        print('[MLX Direct] Shaders compiled and warm', flush=True)
    except Exception as e:
        print(f'[MLX Direct] Warmup warning (non-fatal): {e}', flush=True)
    
    config = load_config()
    kv_kwargs = _get_kv_kwargs()
    
    class MLXHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            # Suppress default HTTP request logging — too noisy
            pass
        
        def do_GET(self):
            if self.path == '/v1/models' or self.path.startswith('/v1/models'):
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
                self._send_json(200, json.dumps({"status": "ok"}))
            else:
                self._send_json(404, json.dumps({"error": "not found"}))
        
        def do_POST(self):
            if '/chat/completions' not in self.path:
                self._send_json(404, json.dumps({"error": "not found"}))
                return
            
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length)
                request = json.loads(body)
            except Exception as e:
                self._send_json(400, json.dumps({"error": f"Invalid request: {e}"}))
                return
            
            messages = request.get('messages', [])
            temperature = float(request.get('temperature', 0.7))
            max_tokens = int(request.get('max_tokens', config.get('default_max_tokens', 2048)))
            stream = request.get('stream', True)
            top_p = float(request.get('top_p', 1.0))
            
            # Format prompt using chat template
            try:
                prompt = tokenizer.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True
                )
            except Exception as e:
                self._send_json(500, json.dumps({"error": f"Template error: {e}"}))
                return
            
            if stream:
                self._stream_response(prompt, temperature, max_tokens, top_p, kv_kwargs)
            else:
                self._blocking_response(prompt, temperature, max_tokens, top_p, kv_kwargs)
        
        def _stream_response(self, prompt, temperature, max_tokens, top_p, kv_kwargs):
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
                
                for result in mlx_lm.stream_generate(
                    model, tokenizer,
                    prompt=prompt,
                    max_tokens=max_tokens,
                    temp=temperature,
                    top_p=top_p,
                    **kv_kwargs,
                ):
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
                
                # Send done signal
                try:
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
        
        def _blocking_response(self, prompt, temperature, max_tokens, top_p, kv_kwargs):
            full_text = ""
            try:
                for result in mlx_lm.stream_generate(
                    model, tokenizer,
                    prompt=prompt,
                    max_tokens=max_tokens,
                    temp=temperature,
                    top_p=top_p,
                    **kv_kwargs,
                ):
                    full_text += result.text if hasattr(result, 'text') else str(result)
                
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
                    "usage": {"prompt_tokens": 0, "completion_tokens": len(full_text.split()), "total_tokens": 0}
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
    with socketserver.TCPServer(('127.0.0.1', port), MLXHandler) as httpd:
        print(f'[MLX Direct] Server ready on port {port}', flush=True)
        print(f'[MLX Direct] Model: {os.path.basename(abs_model_path)}', flush=True)
        print(f'Application startup complete.', flush=True)  # Node watches for this line
        sys.stdout.flush()
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('[MLX Direct] Shutting down...', flush=True)


def launch_api(model_path, port):
    abs_model_path = os.path.abspath(model_path)
    print(f'[MLX] Starting direct inference server on port {port}', flush=True)
    print(f'[MLX] Model: {abs_model_path}', flush=True)
    launch_api_direct(abs_model_path, port)

def launch_core(model_path, json_output=False):
    config = load_config()
    temp = config.get("temperature", 0.7)
    abs_model_path = os.path.abspath(model_path)
    
    _set_offline_env(abs_model_path)
    _set_metal_env()
    
    if json_output:
        print(f'{{"status": "core_ready", "model": "{model_path}"}}')
    
    print("Loading model for chat...")
    model, tokenizer = mlx_lm.load(model_path)
    print("\nLumina Edge MLX Chat (type /exit to quit)\n")
    
    history = []
    kv_kwargs = _get_kv_kwargs()
    
    while True:
        try:
            user_input = input("You: ")
            if user_input.strip() == "/exit":
                break
            
            history.append({"role": "user", "content": user_input})
            prompt = tokenizer.apply_chat_template(history, tokenize=False, add_generation_prompt=True)
            
            print("AI: ", end="", flush=True)
            resp = ""
            for result in mlx_lm.stream_generate(
                model, tokenizer,
                prompt=prompt,
                max_tokens=2048,
                temp=temp,
                **kv_kwargs,
            ):
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
    parser.add_argument("--port", type=int, default=1234)
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
