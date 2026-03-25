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
            # Simple round-robin by selection count
            return min(ready_models, key=lambda m: m.inference_count)
        
        elif self.routing_policy == "load-balanced":
            # Balance by inference count and model size
            return min(ready_models, key=lambda m: m.inference_count)
        
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
    
    def mark_error(self, model_id: str, error_msg: str):
        """Mark model as errored"""
        with self.model_lock:
            if model_id in self.models:
                self.models[model_id].status = ModelStatus.ERROR
                self.models[model_id].error_message = error_msg
                logger.error(f"✗ Model {model_id} error: {error_msg}")
    
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
            
            # Start process
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            
            self.server_processes[instance.id] = process
            
            # Wait for server to be ready (poll endpoint)
            import requests
            max_retries = 30
            for attempt in range(max_retries):
                try:
                    resp = requests.get(f"http://127.0.0.1:{port}/v1/models", timeout=2)
                    if resp.status_code == 200:
                        self.router.mark_ready(instance.id, process.pid)
                        logger.info(f"✓ Model server ready on port {port}")
                        return instance
                except:
                    time.sleep(0.5)
            
            logger.warning(f"Server did not respond after {max_retries} attempts")
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
    
    # Config command
    config_parser = subparsers.add_parser('config', help='Set routing policy')
    config_parser.add_argument('--policy', choices=['round-robin', 'load-balanced', 'first-available'])
    config_parser.add_argument('--config-file', default='config.json')
    
    args = parser.parse_args()
    
    if args.command == 'load':
        server = parallel_load_models(args.bin_path, args.models, args.scripts, args.models_dir)
        server.router.export_state()
    
    elif args.command == 'status':
        router = ModelRouter()
        stats = router.get_stats()
        print(json.dumps(stats, indent=2))
    
    elif args.command == 'config':
        if args.policy:
            config = {'routing_policy': args.policy}
            with open(args.config_file, 'w') as f:
                json.dump(config, f, indent=2)
            print(f"✓ Set routing policy to: {args.policy}")
    
    else:
        parser.print_help()
