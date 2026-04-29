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

try:
    import mlx.core as mx
    import mlx_lm
except ImportError:
    print("❌ ERROR: MLX packages not found. Please install requirements-mac.txt")
    sys.exit(1)

def load_config():
    config_path = os.path.join(os.path.dirname(__file__), "..", "config.json")
    try:
        with open(config_path, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def run_benchmark(model_path):
    print("\n[MLX BENCHMARK]")
    
    # Set environment variables to disable HuggingFace access
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    
    start = time.time()
    model, tokenizer = mlx_lm.load(model_path)
    load_time = time.time() - start
    print(f"✓ Model loaded in {load_time:.2f}s")
    
    prompt = "Write a short poem about a fast computer."
    start = time.time()
    output = mlx_lm.generate(model, tokenizer, prompt=prompt, max_tokens=100, verbose=False)
    gen_time = time.time() - start
    tokens = len(tokenizer.encode(output))
    tps = tokens / gen_time if gen_time > 0 else 0
    
    # Try to get memory
    mem_usage = mx.metal.get_active_memory() / (1024**3) if hasattr(mx, 'metal') and hasattr(mx.metal, 'get_active_memory') else 0
    print(f"✓ Memory active: {mem_usage:.2f} GB")
    print(f"✓ Tokens/sec: {tps:.2f}\n")

def launch_api(model_path, port):
    # Ensure we have an absolute path for the model
    abs_model_path = os.path.abspath(model_path)
    print(f"Starting MLX-LM OpenAI compatible server on port {port}...")
    print(f"Model path: {abs_model_path}")
    
    # Set environment variables to disable HuggingFace access
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    
    # Check if model directory exists and has required files
    if not os.path.exists(abs_model_path):
        print(f"❌ ERROR: Model path does not exist: {abs_model_path}")
        sys.exit(1)
    
    config_path = os.path.join(abs_model_path, "config.json")
    if not os.path.exists(config_path):
        print(f"❌ ERROR: config.json not found in: {abs_model_path}")
        sys.exit(1)
    
    # For MLX-LM server, use the absolute path and ensure it's treated as a local path
    # Use the modern command format instead of deprecated `-m mlx_lm.server`
    # Set environment variables for subprocess to disable HuggingFace access
    env = os.environ.copy()
    env['HF_HUB_DISABLE_TELEMETRY'] = '1'
    env['HF_HUB_OFFLINE'] = '1'
    env['TRANSFORMERS_OFFLINE'] = '1'
    subprocess.run([sys.executable, "-m", "mlx_lm", "server", "--model", abs_model_path, "--port", str(port), "--trust-remote-code"], env=env)

def launch_core(model_path, json_output=False):
    config = load_config()
    temp = config.get("temperature", 0.7)
    
    # Set environment variables to disable HuggingFace access
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    
    if json_output:
        print(f'{{"status": "core_ready", "model": "{model_path}"}}')
    
    print("Loading model for chat. This may take a moment...")
    model, tokenizer = mlx_lm.load(model_path)
    print("\nLumina Edge MLX Chat (type /exit to quit)\n")
    
    # Maintain simple chat history
    history = []
    
    while True:
        try:
            user_input = input("You: ")
            if user_input.strip() == "/exit":
                break
            
            history.append({"role": "user", "content": user_input})
            
            # Use minimal chat template
            prompt = tokenizer.apply_chat_template(history, tokenize=False, add_generation_prompt=True)
            
            print("AI: ", end="", flush=True)
            resp = ""
            try:
                for token in mlx_lm.stream_generate(model, tokenizer, prompt, temperature=temp, max_tokens=2048):
                    print(token, end="", flush=True)
                    resp += token
            except TypeError:
                # Fallback for older mlx-lm versions that use 'temp' instead of 'temperature'
                for token in mlx_lm.stream_generate(model, tokenizer, prompt, temp=temp, max_tokens=2048):
                    print(token, end="", flush=True)
                    resp += token
            print("\n")
            
            history.append({"role": "assistant", "content": resp})

        except EOFError:
            break
        except KeyboardInterrupt:
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
