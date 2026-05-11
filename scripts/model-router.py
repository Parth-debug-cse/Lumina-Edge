#!/usr/bin/env python3
"""
Model Router & Dispatcher
Manages parallel loading of multiple models and routes inference requests
between them based on configuration.
"""

import os
import sys
import json
import logging
import subprocess
import tempfile
import platform
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


def get_context_size():
    """Read context_size from config.json, fallback to 4096"""
    config_path = os.path.join(os.path.dirname(__file__), '..', 'config.json')
    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
        return int(config.get('ctx_size', 4096))
    except Exception:
        return 4096


class ModelStatus(Enum):
    IDLE = "idle"
    LOADING = "loading"
    READY = "ready"
    UNLOADING = "unloading"
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
    context_size: int = get_context_size()
    gpu_layers: Optional[int] = None
    priority: int = 1
    weight: int = 1
    
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
        self.routing_policy = "round-robin"
        self.model_lock = threading.Lock()
        self._rr_index = 0
        self.health_check_interval = 10
        self.health_check_timeout = 5
        self.health_check_active = False
        self._health_thread = None
        self.is_macos = is_apple_silicon()
        self.multi_model_config = {}
        self.load_config()
    
    def start_health_checks(self):
        """Start background health check thread"""
        if self.health_check_active:
            return
        self.health_check_active = True
        self._health_thread = threading.Thread(target=self._health_check_loop, daemon=True)
        self._health_thread.start()
        logger.info(f"✓ Started health checks (interval: {self.health_check_interval}s)")
    
    def stop_health_checks(self):
        """Stop background health check thread"""
        self.health_check_active = False
        if self._health_thread:
            self._health_thread.join(timeout=5)
            logger.info("✓ Stopped health checks")
    
    def _health_check_loop(self):
        """Background health check loop"""
        while self.health_check_active:
            self._run_health_checks()
            time.sleep(self.health_check_interval)
    
    def _run_health_checks(self):
        """Run health check on all models"""
        with self.model_lock:
            model_list = list(self.models.values())
        
        for model in model_list:
            is_healthy = self._check_model_health(model)
            if is_healthy and model.status == ModelStatus.IDLE:
                logger.info(f"✓ Model {model.id} recovered, marking ready")
                with self.model_lock:
                    self.models[model.id].status = ModelStatus.READY
            elif not is_healthy and model.status == ModelStatus.READY:
                logger.warning(f"⚠ Model {model.id} unhealthy, marking idle")
                with self.model_lock:
                    self.models[model.id].status = ModelStatus.IDLE
    
    def _check_model_health(self, model: ModelInstance) -> bool:
        """Check if model endpoint is healthy"""
        # AUDIT FIX: use /health for LLama server (Linux/Windows), /v1/models for MLX (macOS)
        endpoint = "/health" if not self.is_macos else "/v1/models"
        url = f"http://127.0.0.1:{model.port}{endpoint}"
        
        try:
            req = urllib.request.Request(url, method='GET')
            with urllib.request.urlopen(req, timeout=self.health_check_timeout) as response:
                return response.status == 200
        except Exception:
            return False
    
    def load_config(self):
        """Load configuration"""
        if self.config_path.exists():
            try:
                with open(self.config_path, 'r') as f:
                    config = json.load(f)
                    self.routing_policy = config.get('routing_policy', 'round-robin')
                    self.n_gpu_layers = config.get('n_gpu_layers', 'auto')
                    self.split_mode = config.get('split_mode', 'row')
                    self.numa_mode = config.get('numa_mode', 'distribute')
                    self.cont_batching = config.get('cont_batching', True)
                    self.parallel_slots = config.get('parallel_slots', 2)
                    self.batch_size = config.get('batch_size', 512)
                    self.ubatch_size = config.get('ubatch_size', 512)
                    self.defrag_thold = config.get('defrag_thold', 0.1)
                    self.use_mlock = config.get('use_mlock', True)
                    self.flash_attn = config.get('flash_attn', True)
                    self.kv_cache_quant = config.get('kv_cache_quant', 'q8_0')
                    self.ctx_size = config.get('ctx_size', 4096)
                    # AUDIT FIX: read health check interval from config.json
                    multi_model = config.get('multi_model', {})
                    self.multi_model_config = multi_model
                    self.health_check_interval = multi_model.get('health_check_interval', 10)
                    self.health_check_timeout = multi_model.get('health_check_timeout', 5)
                    logger.info(f"✓ Loaded routing policy: {self.routing_policy}")
                    logger.info(f"✓ Loaded GPU layers: {self.n_gpu_layers}")
                    logger.info(f"✓ Loaded context size: {self.ctx_size}")
                    logger.info(f"✓ Loaded health check interval: {self.health_check_interval}s, timeout: {self.health_check_timeout}s")
            except Exception as e:
                logger.warning(f"Could not load config: {e}")
                # Set defaults if config loading fails
                self.n_gpu_layers = 'auto'
                self.split_mode = 'row'
                self.numa_mode = 'distribute'
                self.cont_batching = True
                self.parallel_slots = 2
                self.batch_size = 512
                self.ubatch_size = 512
                self.defrag_thold = 0.1
                self.use_mlock = True
                self.flash_attn = True
                self.kv_cache_quant = 'q8_0'
                self.ctx_size = 4096
                self.health_check_interval = 10
                self.health_check_timeout = 5
        else:
            # Set defaults if no config file
            self.n_gpu_layers = 'auto'
            self.split_mode = 'row'
            self.numa_mode = 'distribute'
            self.cont_batching = True
            self.parallel_slots = 2
            self.batch_size = 512
            self.ubatch_size = 512
            self.defrag_thold = 0.1
            self.use_mlock = True
            self.flash_attn = True
            self.kv_cache_quant = 'q8_0'
            self.ctx_size = 4096
            self.health_check_interval = 10
            self.health_check_timeout = 5
    
    def load_instances_from_config(self):
        """Load model instances from config.json"""
        if not self.config_path.exists():
            return
        
        try:
            with open(self.config_path, 'r') as f:
                config = json.load(f)
            
            multi_model = config.get('multi_model', {})
            instances = multi_model.get('instances', [])
            
            for inst in instances:
                host = inst.get('host', '127.0.0.1')
                port = inst.get('port', 9001)
                priority = inst.get('priority', 1)
                weight = inst.get('weight', 1)
                
                # Register an instance on this port (model path and process ID will be set when actually started)
                model_id = str(uuid.uuid4())[:8]
                
                instance = ModelInstance(
                    id=model_id,
                    name=f"model_{port}",
                    model_path="",
                    port=port,
                    priority=priority,
                    weight=weight,
                    status=ModelStatus.IDLE
                )
                
                with self.model_lock:
                    self.models[model_id] = instance
                
                logger.info(f"✓ Loaded instance from config: {host}:{port}, priority={priority}, weight={weight}")
            
            # AUDIT FIX: start health checks after loading instances
            self.start_health_checks()
            
        except Exception as e:
            logger.warning(f"Could not load instances from config: {e}")
    
    def register_model(self, model_path: str, port: int, quantization: str = "Q4_K_M", priority: int = 1, weight: int = 1) -> ModelInstance:
        """Register a new model instance"""
        model_id = str(uuid.uuid4())[:8]
        model_name = Path(model_path).stem

        instance = ModelInstance(
            id=model_id,
            name=model_name,
            model_path=model_path,
            port=port,
            quantization=quantization,
            status=ModelStatus.IDLE,
            context_size=self.ctx_size,
            priority=priority,
            weight=weight
        )
        
        with self.model_lock:
            self.models[model_id] = instance
        
        logger.info(f"✓ Registered model: {model_name} (ID: {model_id}) on port {port}, priority={priority}, weight={weight}")
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
            # AUDIT FIX: lock protects read+increment to prevent race condition between two concurrent requests
            with self.model_lock:
                index = self._rr_index % len(ready_models)
                self._rr_index += 1
                return ready_models[index]
        
        elif self.routing_policy == "priority":
            # AUDIT FIX: priority-based routing - higher priority first, fallback to lower priority if unhealthy
            # Sort by priority descending, then use round-robin within same priority level
            by_priority = sorted(ready_models, key=lambda m: (-m.priority, m.inference_count))
            highest_priority = by_priority[0].priority
            top_group = [m for m in by_priority if m.priority == highest_priority]
            # Round-robin within same priority group
            with self.model_lock:
                index = self._rr_index % len(top_group)
                self._rr_index += 1
                return top_group[index]
        
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
    
    def mark_error(self, model_id: str, message: str):
        """Mark model as error with message"""
        with self.model_lock:
            if model_id in self.models:
                self.models[model_id].status = ModelStatus.ERROR
                self.models[model_id].error_message = message
                logger.info(f"✗ Model {model_id} error: {message}")
    
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
    
    def stop_model(self, model_id: str, timeout: float = 5.0) -> bool:
        """Stop a running model with SIGTERM -> SIGKILL escalation"""
        with self.model_lock:
            instance = self.models.get(model_id)
            if not instance:
                return False

            if instance.process_id:
                try:
                    os.kill(instance.process_id, 15)  # SIGTERM
                    # Wait for process to exit
                    waited = 0.0
                    interval = 0.2
                    while waited < timeout:
                        try:
                            os.kill(instance.process_id, 0)
                            time.sleep(interval)
                            waited += interval
                        except ProcessLookupError:
                            break
                    else:
                        # Process still alive after timeout -> SIGKILL
                        try:
                            os.kill(instance.process_id, 9)  # SIGKILL
                            logger.warning(f"⚠ SIGKILL sent to PID {instance.process_id} after {timeout}s timeout")
                        except ProcessLookupError:
                            pass

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


def is_mlx_model(model_path: Path) -> bool:
    """Check if model is an MLX model (directory with safetensors or .mlx extension)."""
    if not model_path.exists():
        return False

    # MLX models are directories with .mlx in name or containing safetensors
    if model_path.is_dir():
        if '.mlx' in model_path.name.lower():
            return True
        # Check for safetensors files (common MLX format)
        if any(model_path.glob('*.safetensors')):
            return True
        # Check for config.json indicating MLX structure
        if (model_path / 'config.json').exists() and not (model_path / '*.gguf').exists():
            return True

    return False


def is_apple_silicon() -> bool:
    """Check if running on Apple Silicon."""
    return platform.system() == 'Darwin' and 'arm' in platform.machine().lower()


class MultiModelServer:
    """Manages multiple parallel llama-server or MLX backend instances"""

    def __init__(self, bin_path: str, scripts_path: str, models_dir: str):
        self.bin_path = Path(bin_path)
        self.scripts_path = Path(scripts_path)
        self.models_dir = Path(models_dir)
        self.router = ModelRouter()
        # AUDIT FIX: Use base_port from config (default 9000), not 8000 which conflicts with pipeline API
        self.start_port = self.router.multi_model_config.get('base_port', 9000)
        self.server_processes = {}
        self.is_macos = is_apple_silicon()

        # On macOS with MLX, we don't need llama-server binaries
        if not self.is_macos:
            if not self.bin_path.exists():
                raise FileNotFoundError(f"Binary path not found: {bin_path}")
        else:
            logger.info("🍎 Running on Apple Silicon - MLX backend enabled")
    
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
            
            # Determine GPU layers (handle auto detection)
            gpu_layers = instance.gpu_layers
            if gpu_layers is None:
                if self.router.n_gpu_layers == "auto":
                    gpu_layers = 99  # Default to max for auto
                else:
                    gpu_layers = self.router.n_gpu_layers
            
            # Check if this is an MLX model on Apple Silicon
            use_mlx = self.is_macos and is_mlx_model(model_path)

            if use_mlx:
                # Use MLX backend
                mlx_backend = self.scripts_path / "mlx_backend.py"
                if not mlx_backend.exists():
                    logger.error(f"MLX backend not found: {mlx_backend}")
                    self.router.mark_error(instance.id, "MLX backend not found")
                    return None

                cmd = [
                    sys.executable, str(mlx_backend),
                    "--model", str(model_path),
                    "--port", str(port),
                    "--host", "127.0.0.1"
                ]

                logger.info(f"🚀 Starting MLX backend on port {port}: {model_path.name}")

            else:
                # Use llama-server
                llama_server = self.bin_path / "llama-server"
                if sys.platform == 'win32':
                    llama_server = self.bin_path / "llama-server.exe"

                cmd = [
                    str(llama_server),
                    "-m", str(model_path),
                    "--host", "127.0.0.1",
                    "--port", str(port),
                    "--ctx-size", str(instance.context_size),
                    "--n-gpu-layers", str(gpu_layers),
                    "--batch-size", str(self.router.batch_size),
                    "--ubatch-size", str(self.router.ubatch_size),
                    "--cache-type-k", self.router.kv_cache_quant,
                    "--cache-type-v", self.router.kv_cache_quant,
                    "--jinja"
                ]

                # Add flash attention if enabled
                if self.router.flash_attn:
                    cmd.append("--flash-attn")

                # Add memory lock if enabled (not on macOS with unified memory)
                if self.router.use_mlock and not self.is_macos:
                    cmd.append("--mlock")

                # Add performance optimization flags
                cmd.extend([
                    "--defrag-thold", str(self.router.defrag_thold),
                    "--ctx-shift"
                ])

                # Add continuous batching if enabled
                if self.router.cont_batching:
                    cmd.extend(["--cont-batching", "--parallel", str(self.router.parallel_slots)])

                # Add GPU-specific split mode (not for MLX)
                cmd.extend(["--split-mode", self.router.split_mode])

                # Add NUMA configuration (skip on macOS)
                if platform.system() != 'Darwin':
                    if self.router.numa_mode != "none":
                        cmd.extend(["--numa", self.router.numa_mode])

                # Add Vulkan-specific optimizations
                if self.router.split_mode == "row":
                    cmd.append("--no-kv-offload")

                logger.info(f"🚀 Starting llama-server: {' '.join(cmd)}")

            # Redirect stdout/stderr to log file
            log_file = os.path.join(tempfile.gettempdir(), f"lumina_model_{port}.log")
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
        """Unload a model with SIGTERM -> SIGKILL escalation"""
        if model_id in self.server_processes:
            process = self.server_processes[model_id]
            try:
                process.terminate()  # SIGTERM
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    logger.warning(f"⚠ Process for {model_id} did not exit in 5s, sending SIGKILL")
                    process.kill()  # SIGKILL
                    process.wait(timeout=3)
                del self.server_processes[model_id]
                return self.router.unregister_model(model_id)
            except Exception as e:
                logger.error(f"Error unloading model: {e}")
                # Force kill as last resort
                try:
                    process.kill()
                except Exception:
                    pass
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
        """Shutdown all model servers with SIGTERM -> SIGKILL escalation"""
        logger.info("Shutting down all models...")
        for model_id, process in list(self.server_processes.items()):
            try:
                process.terminate()  # SIGTERM
            except Exception:
                pass

        # Wait up to 5s for each, then SIGKILL stragglers
        for model_id, process in list(self.server_processes.items()):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                logger.warning(f"⚠ Process {model_id} did not exit in 5s, sending SIGKILL")
                try:
                    process.kill()
                    process.wait(timeout=3)
                except Exception:
                    pass

        self.server_processes.clear()
        logger.info("✓ All models shut down")


class RouterProxy:
    """HTTP proxy that routes requests to model instances with retry logic"""
    
    def __init__(self, router: ModelRouter, host: str = "127.0.0.1", port: int = 9000):
        self.router = router
        self.host = host
        self.port = port
        self.max_retries = 3
        self.request_timeout = 300
    
    def proxy_request(self, method: str, path: str, headers: Dict, body: Optional[bytes] = None) -> Tuple[int, Dict, bytes]:
        """
        Proxy request to backend model with retry on failure.
        
        Returns: (status_code, response_headers, response_body)
        """
        last_error = None
        
        for attempt in range(self.max_retries):
            model = self.router.select_model()
            if not model:
                return (503, {}, b'{"error": "No models available"}')
            
            backend_url = f"http://{self.router.models[model.id].port if hasattr(self.router.models[model.id], 'port') and self.router.models[model.id].port else 9001}"
            
            try:
                url = f"http://127.0.0.1:{model.port}{path}"
                
                req = urllib.request.Request(
                    url,
                    data=body,
                    headers=headers,
                    method=method
                )
                
                with urllib.request.urlopen(req, timeout=self.request_timeout) as response:
                    response_headers = dict(response.headers)
                    response_body = response.read()
                    
                    if response.status == 200:
                        return (response.status, response_headers, response_body)
                    else:
                        # AUDIT FIX: retry on non-200 status, try next instance
                        logger.warning(f"Model {model.id} returned {response.status}, retrying...")
                        last_error = (response.status, response_body)
                        continue
                        
            except Exception as e:
                logger.warning(f"Request to model {model.id} failed: {e}, attempt {attempt + 1}/{self.max_retries}")
                last_error = (500, str(e).encode())
                continue
        
        # All retries exhausted
        status, body = last_error if last_error else (503, b'{"error": "All retries failed"}')
        return (status, {}, body)
    
    def handle_request(self, method: str, path: str, headers: Dict, body: Optional[bytes] = None) -> Tuple[int, Dict, bytes]:
        """Handle incoming request with retry logic"""
        return self.proxy_request(method, path, headers, body)


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
            with urllib.request.urlopen(req, timeout=300) as response:
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
    
    def load_with_index(idx_model_path):
        idx, model_path = idx_model_path
        instance = server.load_model(model_path, idx)
        if instance:
            logger.info(f"  [{idx+1}/{len(models_list)}] ✓ {Path(model_path).name}\n")
        else:
            logger.error(f"  [{idx+1}/{len(models_list)}] ✗ {Path(model_path).name}\n")
        return instance
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(models_list), 4)) as executor:
        list(executor.map(load_with_index, enumerate(models_list)))
    
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
        script_dir = Path(__file__).parent.resolve()
        project_root = script_dir.parent
        server = MultiModelServer(
            str(project_root / "bin"),
            str(project_root / "scripts"),
            str(project_root / "models")
        )
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
        script_dir = Path(__file__).parent.resolve()
        project_root = script_dir.parent
        server = MultiModelServer(
            str(project_root / "bin"),
            str(project_root / "scripts"),
            str(project_root / "models")
        )
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
