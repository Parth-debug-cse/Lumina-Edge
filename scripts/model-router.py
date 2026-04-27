#!/usr/bin/env python3
"""
Model Router & Dispatcher
Manages parallel loading of multiple models and routes inference requests
between them based on configuration.
"""

import os
import json
import logging
import subprocess
import threading
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict
from enum import Enum
import time
import uuid
import urllib.request
import urllib.error
import concurrent.futures

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)


class ModelStatus(Enum):
    IDLE = "idle"
    LOADING = "loading"
    READY = "ready"
    ERROR = "error"
    STOPPED = "stopped"


@dataclass
class ModelInstance:
    """Represents a loaded model instance"""
    id: str
    name: str
    model_path: str
    port: int
    process_id: Optional[int] = None
    status: ModelStatus = ModelStatus.IDLE
    loaded_at: Optional[float] = None
    inference_count: int = 0
    error_message: Optional[str] = None
    quantization: str = "Q4_K_M"
    context_size: int = 4096
    gpu_layers: Optional[int] = None
    
    def to_dict(self) -> Dict:
        """Convert to dictionary"""
        data = asdict(self)
        data['status'] = self.status.value
        return data
    
    def is_ready(self) -> bool:
        """Check if model is ready"""
        return self.status == ModelStatus.READY


class ModelRouter:
    """Routes requests to multiple loaded models"""
    
    def __init__(self, config_path: str = "config.json"):
        self.config_path = Path(config_path)
        self.models: Dict[str, ModelInstance] = {}
        self.routing_policy = "round-robin"  # round-robin, load-balanced, first-available
        self.model_lock = threading.Lock()
        self._rr_index = 0  # For true round-robin
        self.load_config()
    
    def load_config(self):
        """Load configuration"""
        if self.config_path.exists():
            try:
                with open(self.config_path, 'r') as f:
                    config = json.load(f)
                    self.routing_policy = config.get('routing_policy', 'round-robin')
                    logger.info(f"✓ Loaded routing policy: {self.routing_policy}")
            except Exception as e:
                logger.warning(f"Could not load config: {e}")
    
    def register_model(self, model_path: str, port: int, quantization: str = "Q4_K_M") -> ModelInstance:
        """Register a new model instance"""
        model_id = str(uuid.uuid4())[:8]
        model_name = Path(model_path).stem
        
        instance = ModelInstance(
            id=model_id,
            name=model_name,
            model_path=model_path,
            port=port,
            quantization=quantization,
            status=ModelStatus.IDLE
        )
        
        with self.model_lock:
            self.models[model_id] = instance
        
        logger.info(f"✓ Registered model: {model_name} (ID: {model_id}) on port {port}")
        return instance
    
    def get_model_status(self, model_id: str) -> Optional[ModelInstance]:
        """Get status of a specific model"""
        with self.model_lock:
            return self.models.get(model_id)
    
    def get_all_models(self) -> List[ModelInstance]:
        """Get all registered models"""
        with self.model_lock:
            return list(self.models.values())
    
    def get_ready_models(self) -> List[ModelInstance]:
        """Get all ready models"""
        with self.model_lock:
            return [m for m in self.models.values() if m.is_ready()]
    
    def select_model(self, prefer_fast: bool = False) -> Optional[ModelInstance]:
        """
        Select a model based on routing policy
        
        Args:
            prefer_fast: If True, prefer model with fewer inference calls
        
        Returns:
            Selected ModelInstance or None if no models available
        """
        ready_models = self.get_ready_models()
        
        if not ready_models:
            logger.warning("No ready models available")
            return None
        
        if len(ready_models) == 1:
            return ready_models[0]
        
        if self.routing_policy == "round-robin":
            # True round-robin: cycle through all ready models
            with self.model_lock:
                selected = ready_models[self._rr_index % len(ready_models)]
                self._rr_index += 1
            return selected
        
        elif self.routing_policy == "load-balanced":
            # Balance by inference count, skip dead processes
            alive_models = [m for m in ready_models if self._is_process_alive(m)]
            if not alive_models:
                return None
            return min(alive_models, key=lambda m: m.inference_count)
        
        elif self.routing_policy == "first-available":
            # Return first ready model
            return ready_models[0]
        
        else:
            return ready_models[0]
    
    def mark_loading(self, model_id: str):
        """Mark model as loading"""
        with self.model_lock:
            if model_id in self.models:
                self.models[model_id].status = ModelStatus.LOADING
                logger.info(f"⏳ Model {model_id} loading...")
    
    def mark_ready(self, model_id: str, process_id: Optional[int] = None):
        """Mark model as ready"""
        with self.model_lock:
            if model_id in self.models:
                self.models[model_id].status = ModelStatus.READY
                self.models[model_id].process_id = process_id
                self.models[model_id].loaded_at = time.time()
                logger.info(f"✓ Model {model_id} is ready (PID: {process_id})")
    
    def _is_process_alive(self, model: ModelInstance) -> bool:
        """Check if model's process is still alive"""
        if not model.process_id:
            return False
        try:
            os.kill(model.process_id, 0)  # Signal 0 just checks if process exists
            return True
        except ProcessLookupError:
            return False
    
    def record_inference(self, model_id: str):
        """Record an inference call"""
        with self.model_lock:
            if model_id in self.models:
                self.models[model_id].inference_count += 1
    
    def stop_model(self, model_id: str) -> bool:
        """Stop a running model"""
        with self.model_lock:
            instance = self.models.get(model_id)
            if not instance:
                return False
            
            if instance.process_id:
                try:
                    os.kill(instance.process_id, 15)  # SIGTERM
                    instance.status = ModelStatus.STOPPED
                    logger.info(f"✓ Stopped model {model_id} (PID: {instance.process_id})")
                    return True
                except ProcessLookupError:
                    logger.warning(f"Process {instance.process_id} not found")
                    instance.status = ModelStatus.STOPPED
                    return True
                except Exception as e:
                    logger.error(f"Failed to stop model {model_id}: {e}")
                    return False
        
        return False
    
    def unregister_model(self, model_id: str) -> bool:
        """Unregister a model"""
        self.stop_model(model_id)
        
        with self.model_lock:
            if model_id in self.models:
                del self.models[model_id]
                logger.info(f"✓ Unregistered model {model_id}")
                return True
        
        return False
    
    def get_stats(self) -> Dict:
        """Get overall router statistics"""
        models = self.get_all_models()
        ready = self.get_ready_models()
        
        total_inferences = sum(m.inference_count for m in models)
        
        return {
            'total_models': len(models),
            'ready_models': len(ready),
            'routing_policy': self.routing_policy,
            'total_inferences': total_inferences,
            'models': [m.to_dict() for m in models]
        }
    
    def export_state(self, filepath: str = "router_state.json"):
        """Export router state for persistence"""
        state = {
            'timestamp': time.time(),
            'routing_policy': self.routing_policy,
            'models': [m.to_dict() for m in self.get_all_models()]
        }
        
        with open(filepath, 'w') as f:
            json.dump(state, f, indent=2)
        
        logger.info(f"✓ Exported router state to {filepath}")
        return filepath


class MultiModelServer:
    """Manages multiple parallel llama-server instances"""
    
    def __init__(self, bin_path: str, scripts_path: str, models_dir: str):
        self.bin_path = Path(bin_path)
        self.scripts_path = Path(scripts_path)
        self.models_dir = Path(models_dir)
        self.router = ModelRouter()
        self.start_port = 8000  # Base port for models
        self.server_processes = {}
        
        if not self.bin_path.exists():
            raise FileNotFoundError(f"Binary path not found: {bin_path}")
    
    def load_model(self, model_path: str, model_index: int = 0) -> Optional[ModelInstance]:
        """
        Load a model on a new port
        
        Args:
            model_path: Path to model file
            model_index: Index for port allocation
        
        Returns:
            ModelInstance if successful, None otherwise
        """
        model_path = Path(model_path)
        if not model_path.exists():
            logger.error(f"Model file not found: {model_path}")
            return None
        
        port = self.start_port + model_index
        
        # Register model
        instance = self.router.register_model(str(model_path), port)
        self.router.mark_loading(instance.id)
        
        try:
            # Prepare command
            llama_server = self.bin_path / "llama-server"
            cmd = [
                str(llama_server),
                "-m", str(model_path),
                "--host", "127.0.0.1",
                "--port", str(port),
                "--ctx-size", str(instance.context_size),
                "--n-gpu-layers", str(instance.gpu_layers or 99),
                "--flash-attn",
                "--mlock"
            ]
            
            logger.info(f"🚀 Starting model server: {' '.join(cmd)}")
            
            # Redirect stdout/stderr to log file
            log_file = f"/tmp/lumina_model_{port}.log"
            with open(log_file, 'w') as log_f:
                process = subprocess.Popen(
                    cmd,
                    stdout=log_f,
                    stderr=subprocess.STDOUT,
                    text=True
                )
            
            self.server_processes[instance.id] = process
            logger.info(f"✓ Model server started (PID: {process.pid}), logs: {log_file}")
            
            # Wait for server to be ready (poll /health endpoint)
            start_time = time.time()
            timeout = 60  # 60 seconds total
            
            while time.time() - start_time < timeout:
                if process.poll() is not None:
                    # Process died
                    self.router.mark_error(instance.id, f"Process exited early (rc={process.returncode})")
                    return None
                
                try:
                    req = urllib.request.Request(f"http://127.0.0.1:{port}/health", method='GET')
                    with urllib.request.urlopen(req, timeout=2) as response:
                        if response.status == 200:
                            self.router.mark_ready(instance.id, process.pid)
                            logger.info(f"✓ Model server ready on port {port}")
                            return instance
                except urllib.error.URLError:
                    pass
                
                time.sleep(1)
            
            logger.warning(f"Server did not respond after {timeout} seconds")
            self.router.mark_error(instance.id, "Server startup timeout")
            return None
        
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            self.router.mark_error(instance.id, str(e))
            return None
    
    def unload_model(self, model_id: str) -> bool:
        """Unload a model"""
        if model_id in self.server_processes:
            process = self.server_processes[model_id]
            try:
                process.terminate()
                process.wait(timeout=5)
                del self.server_processes[model_id]
                return self.router.unregister_model(model_id)
            except Exception as e:
                logger.error(f"Error unloading model: {e}")
                return False
        
        return False
    
    def get_model_routes(self) -> List[Dict]:
        """Get routes for all loaded models"""
        routes = []
        for model in self.router.get_ready_models():
            routes.append({
                'model_id': model.id,
                'name': model.name,
                'endpoint': f"http://127.0.0.1:{model.port}/v1",
                'status': model.status.value,
                'inferences': model.inference_count
            })
        return routes
    
    def shutdown_all(self):
        """Shutdown all model servers"""
        logger.info("Shutting down all models...")
        for process in self.server_processes.values():
            try:
                process.terminate()
            except:
                pass
        
        self.server_processes.clear()
        logger.info("✓ All models shut down")


class AgentDispatcher:
    """
    Sends inference tasks to models via HTTP and collects results.
    Supports: single dispatch, parallel ensemble, sequential pipeline.
    """

    def __init__(self, server: MultiModelServer):
        self.server = server

    def _call_model(self, model: ModelInstance, prompt: str, system: str = "",
                    max_tokens: int = 512, temperature: float = 0.7) -> dict:
        """
        POST to http://127.0.0.1:{port}/v1/chat/completions (OpenAI-compatible).
        Use urllib.request (no external deps).
        """
        payload = {
            "model": "local",
            "messages": [
                {"role": "system", "content": system} if system else None,
                {"role": "user", "content": prompt}
            ],
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": False
        }
        payload["messages"] = [m for m in payload["messages"] if m is not None]
        
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            f"http://127.0.0.1:{model.port}/v1/chat/completions",
            data=data,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode('utf-8'))
                content = result.get('choices', [{}])[0].get('message', {}).get('content', '')
                self.server.router.record_inference(model.id)
                return {
                    "model_id": model.id,
                    "model_name": model.name,
                    "content": content,
                    "error": None
                }
        except Exception as e:
            return {
                "model_id": model.id,
                "model_name": model.name,
                "content": None,
                "error": str(e)
            }

    def dispatch_single(self, prompt: str, system: str = "",
                        max_tokens: int = 512, temperature: float = 0.7,
                        policy: str = None) -> dict:
        """Send prompt to ONE model selected by routing policy."""
        model = self.server.router.select_model()
        if not model:
            return {"model_id": None, "model_name": None, "content": None, "error": "No models ready"}
        return self._call_model(model, prompt, system, max_tokens, temperature)

    def dispatch_ensemble(self, prompt: str, system: str = "",
                          max_tokens: int = 512, temperature: float = 0.7,
                          models: list = None) -> list:
        """Send SAME prompt to MULTIPLE models in parallel."""
        if models:
            model_instances = [self.server.router.get_model_status(mid) for mid in models if self.server.router.get_model_status(mid)]
        else:
            model_instances = self.server.router.get_ready_models()
        
        if not model_instances:
            return [{"model_id": None, "model_name": None, "content": None, "error": "No models ready"}]
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(model_instances)) as executor:
            futures = [executor.submit(self._call_model, m, prompt, system, max_tokens, temperature) for m in model_instances]
            return [f.result() for f in concurrent.futures.as_completed(futures)]

    def dispatch_pipeline(self, steps: list) -> list:
        """Sequential pipeline: output of step N becomes input of step N+1."""
        results = []
        prev_output = ""
        
        for step in steps:
            prompt = step['prompt'].replace('{prev_output}', prev_output)
            system = step.get('system', '')
            model_id = step.get('model_id')
            max_tokens = step.get('max_tokens', 512)
            temperature = step.get('temperature', 0.7)
            
            if model_id:
                model = self.server.router.get_model_status(model_id)
                if not model or not model.is_ready():
                    results.append({"step": len(results), "error": f"Model {model_id} not ready"})
                    break
                result = self._call_model(model, prompt, system, max_tokens, temperature)
            else:
                result = self.dispatch_single(prompt, system, max_tokens, temperature)
            
            results.append(result)
            if result.get('error') or result.get('content') is None:
                break
            prev_output = result['content']
        
        return results

    def dispatch_map_reduce(self, chunks: list, map_prompt: str,
                             reduce_prompt: str, system: str = "") -> dict:
        """MAP: send map_prompt + each chunk to different models in parallel. REDUCE: concatenate all map results, send with reduce_prompt."""
        # Map phase
        map_results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(chunks), 4)) as executor:
            futures = []
            for chunk in chunks:
                prompt = map_prompt.replace('{chunk}', chunk)
                future = executor.submit(self.dispatch_single, prompt, system)
                futures.append(future)
            map_results = [f.result() for f in concurrent.futures.as_completed(futures)]
        
        # Reduce phase
        combined = '\n'.join([r['content'] for r in map_results if r['content']])
        reduce_prompt_full = reduce_prompt.replace('{map_results}', combined)
        final = self.dispatch_single(reduce_prompt_full, system)
        
        return {"map_results": map_results, "final": final}


def parallel_load_models(bin_path: str, models_list: List[str], scripts_path: str, models_dir: str) -> MultiModelServer:
    """
    Utility function to parallel load multiple models
    
    Args:
        bin_path: Path to llama.cpp bin directory
        models_list: List of model file paths to load
        scripts_path: Path to scripts directory
        models_dir: Path to models directory
    
    Returns:
        MultiModelServer instance with all models loaded
    """
    server = MultiModelServer(bin_path, scripts_path, models_dir)
    
    logger.info(f"\n🔄 Starting parallel model loading ({len(models_list)} models)...\n")
    
    for idx, model_path in enumerate(models_list):
        instance = server.load_model(model_path, idx)
        if instance:
            logger.info(f"  [{idx+1}/{len(models_list)}] ✓ {Path(model_path).name}\n")
        else:
            logger.error(f"  [{idx+1}/{len(models_list)}] ✗ {Path(model_path).name}\n")
    
    logger.info("\n📊 Multi-Model Router Status:")
    stats = server.router.get_stats()
    print(f"  Total Models: {stats['total_models']}")
    print(f"  Ready Models: {stats['ready_models']}")
    print(f"  Routing Policy: {stats['routing_policy']}")
    print(f"\n  Available Endpoints:")
    for route in server.get_model_routes():
        print(f"    - {route['name']}: {route['endpoint']} (inferences: {route['inferences']})")
    
    return server


if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Multi-model router and dispatcher')
    subparsers = parser.add_subparsers(dest='command')
    
    # Status command
    status_parser = subparsers.add_parser('status', help='Show router status')
    status_parser.add_argument('--state-file', default='router_state.json')
    
    # Load command
    load_parser = subparsers.add_parser('load', help='Load models')
    load_parser.add_argument('models', nargs='+', help='Model paths')
    load_parser.add_argument('--bin-path', required=True, help='Path to bin directory')
    load_parser.add_argument('--scripts', required=True, help='Path to scripts')
    load_parser.add_argument('--models-dir', required=True, help='Path to models directory')
    
    # Dispatch commands
    dispatch_parser = subparsers.add_parser('dispatch', help='Dispatch inference tasks')
    dispatch_subparsers = dispatch_parser.add_subparsers(dest='dispatch_cmd')
    
    # dispatch single
    single_parser = dispatch_subparsers.add_parser('single', help='Send prompt to one model')
    single_parser.add_argument('prompt', help='Prompt text')
    single_parser.add_argument('--system', help='System message')
    single_parser.add_argument('--model', help='Specific model ID')
    single_parser.add_argument('--max-tokens', type=int, default=512)
    
    # dispatch ensemble
    ensemble_parser = dispatch_subparsers.add_parser('ensemble', help='Send prompt to multiple models')
    ensemble_parser.add_argument('prompt', help='Prompt text')
    ensemble_parser.add_argument('--system', help='System message')
    ensemble_parser.add_argument('--models', help='Comma-separated model IDs')
    ensemble_parser.add_argument('--max-tokens', type=int, default=512)
    
    # dispatch pipeline
    pipeline_parser = dispatch_subparsers.add_parser('pipeline', help='Run sequential pipeline')
    pipeline_parser.add_argument('pipeline_file', help='JSON file with pipeline steps')
    
    # dispatch map-reduce
    mapreduce_parser = dispatch_subparsers.add_parser('map-reduce', help='Map-reduce over chunks')
    mapreduce_parser.add_argument('chunks_file', help='File with chunks (one per line)')
    mapreduce_parser.add_argument('--map-prompt', required=True, help='Map prompt template')
    mapreduce_parser.add_argument('--reduce-prompt', required=True, help='Reduce prompt template')
    
    # Agent interactive
    agent_parser = subparsers.add_parser('agent', help='Interactive agent mode')
    agent_parser.add_argument('mode', choices=['interactive'], help='Agent mode')
    
    # Config command
    config_parser = subparsers.add_parser('config', help='Set routing policy')
    config_parser.add_argument('--policy', choices=['round-robin', 'load-balanced', 'first-available'])
    config_parser.add_argument('--config-file', default='config.json')
    
    args = parser.parse_args()
    
    if args.command == 'load':
        server = parallel_load_models(args.bin_path, args.models, args.scripts, args.models_dir)
        print(json.dumps(server.router.get_stats(), indent=2))
    
    elif args.command == 'status':
        router = ModelRouter()
        stats = router.get_stats()
        print(json.dumps(stats, indent=2))
    
    elif args.command == 'config':
        if args.policy:
            # Read existing config
            config = {}
            if Path(args.config_file).exists():
                with open(args.config_file, 'r') as f:
                    config = json.load(f)
            config['routing_policy'] = args.policy
            with open(args.config_file, 'w') as f:
                json.dump(config, f, indent=2)
            print(f"✓ Set routing policy to: {args.policy}")
    
    elif args.command == 'dispatch':
        # Load server from state or create new
        server = MultiModelServer("/tmp/bin", "/tmp/scripts", "/tmp/models")  # Placeholder paths
        dispatcher = AgentDispatcher(server)
        
        if args.dispatch_cmd == 'single':
            result = dispatcher.dispatch_single(args.prompt, args.system or "", args.max_tokens)
            print(json.dumps(result, indent=2))
        
        elif args.dispatch_cmd == 'ensemble':
            models = args.models.split(',') if args.models else None
            results = dispatcher.dispatch_ensemble(args.prompt, args.system or "", args.max_tokens, models=models)
            print(json.dumps(results, indent=2))
        
        elif args.dispatch_cmd == 'pipeline':
            with open(args.pipeline_file, 'r') as f:
                steps = json.load(f)
            results = dispatcher.dispatch_pipeline(steps)
            print(json.dumps(results, indent=2))
        
        elif args.dispatch_cmd == 'map-reduce':
            with open(args.chunks_file, 'r') as f:
                chunks = [line.strip() for line in f if line.strip()]
            result = dispatcher.dispatch_map_reduce(chunks, args.map_prompt, args.reduce_prompt)
            print(json.dumps(result, indent=2))
    
    elif args.command == 'agent' and args.mode == 'interactive':
        # Load server
        server = MultiModelServer("/tmp/bin", "/tmp/scripts", "/tmp/models")  # Placeholder
        dispatcher = AgentDispatcher(server)
        
        print("🤖 Lumina Edge Agent Mode")
        print("Commands: /models, /use <id>, /ensemble, /pipeline, /policy <name>, /stats, /quit")
        print()
        
        current_policy = "round-robin"
        ensemble_mode = False
        locked_model = None
        
        try:
            while True:
                prompt = input("agent> ").strip()
                if not prompt:
                    continue
                
                if prompt.startswith('/'):
                    cmd = prompt[1:].split()
                    if not cmd:
                        continue
                    
                    if cmd[0] == 'models':
                        models = server.router.get_ready_models()
                        for m in models:
                            print(f"  {m.id}: {m.name} (port {m.port})")
                    
                    elif cmd[0] == 'use' and len(cmd) > 1:
                        model = server.router.get_model_status(cmd[1])
                        if model and model.is_ready():
                            locked_model = cmd[1]
                            print(f"✓ Locked to model: {model.name}")
                        else:
                            print("✗ Model not found or not ready")
                    
                    elif cmd[0] == 'ensemble':
                        ensemble_mode = not ensemble_mode
                        print(f"✓ Ensemble mode: {'ON' if ensemble_mode else 'OFF'}")
                    
                    elif cmd[0] == 'pipeline':
                        print("Enter pipeline steps (JSON array):")
                        try:
                            steps_json = input("pipeline> ")
                            steps = json.loads(steps_json)
                            results = dispatcher.dispatch_pipeline(steps)
                            print(json.dumps(results, indent=2))
                        except Exception as e:
                            print(f"Error: {e}")
                    
                    elif cmd[0] == 'policy' and len(cmd) > 1:
                        current_policy = cmd[1]
                        print(f"✓ Policy: {current_policy}")
                    
                    elif cmd[0] == 'stats':
                        stats = server.router.get_stats()
                        print(json.dumps(stats, indent=2))
                    
                    elif cmd[0] == 'quit':
                        break
                    
                    else:
                        print("Unknown command")
                
                else:
                    # Send prompt
                    if ensemble_mode:
                        results = dispatcher.dispatch_ensemble(prompt)
                        for r in results:
                            print(f"[{r['model_name']}] {r['content'] or r['error']}")
                    elif locked_model:
                        model = server.router.get_model_status(locked_model)
                        if model:
                            result = dispatcher._call_model(model, prompt)
                            print(f"[{result['model_name']}] {result['content'] or result['error']}")
                        else:
                            print("Locked model no longer available")
                    else:
                        result = dispatcher.dispatch_single(prompt)
                        print(f"[{result['model_name']}] {result['content'] or result['error']}")
        
        except KeyboardInterrupt:
            print("\n👋 Goodbye!")
    
    else:
        parser.print_help()
