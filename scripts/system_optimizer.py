#!/usr/bin/env python3
# ==============================================================================
# LUMINA EDGE :: System Optimizer
# Fully dynamic system detection and optimization for best execution
# ==============================================================================

import os
import sys
import json
import platform
import subprocess
import psutil

class SystemOptimizer:
    def __init__(self):
        self.system_info = {}
        self.optimized_config = {}
        self.detect_system()
        
    def detect_system(self):
        """Comprehensive system detection"""
        self.system_info = {
            'platform': platform.system(),
            'architecture': platform.machine(),
            'processor': platform.processor(),
            'python_version': platform.python_version(),
        }
        
        # CPU Detection
        self.detect_cpu()
        
        # Memory Detection
        self.detect_memory()
        
        # GPU Detection
        self.detect_gpu()
        
        # Storage Detection
        self.detect_storage()
        
        # Network Detection
        self.detect_network()
        
    def detect_cpu(self):
        """Advanced CPU detection"""
        system = platform.system()
        cpu_info = {
            "Linux": self._detect_linux_cpu,
            "Darwin": self._detect_macos_cpu,
            "Windows": self._detect_windows_cpu
        }.get(system, self._detect_generic_cpu)()
        
        self.system_info['cpu'] = cpu_info
        
    def _detect_linux_cpu(self):
        """Linux CPU detection"""
        cpu_info = {}
        
        try:
            # Get detailed CPU info
            with open('/proc/cpuinfo', 'r') as f:
                cpuinfo = f.read()
                
            # Physical cores
            physical_cores = 0
            logical_cores = 0
            
            for line in cpuinfo.split('\n'):
                if line.startswith('processor'):
                    logical_cores += 1
                elif line.startswith('physical id'):
                    pass
                elif line.startswith('cpu cores'):
                    cores = int(line.split(':')[1].strip())
                    if physical_cores == 0:
                        physical_cores = cores
                        
            # Use lscpu for more accurate info
            try:
                lscpu_output = subprocess.check_output(['lscpu'], text=True)
                for line in lscpu_output.split('\n'):
                    if 'Core(s) per socket:' in line:
                        cores_per_socket = int(line.split(':')[1].strip())
                    elif 'Socket(s):' in line:
                        sockets = int(line.split(':')[1].strip())
                        physical_cores = cores_per_socket * sockets
                    elif 'Thread(s) per core:' in line:
                        threads_per_core = int(line.split(':')[1].strip())
                        logical_cores = physical_cores * threads_per_core
            except Exception:
                pass
                
            cpu_info = {
                'physical_cores': physical_cores,
                'logical_cores': logical_cores,
                'threads_per_core': logical_cores // physical_cores if physical_cores > 0 else 1,
                'frequency': self._get_cpu_frequency(),
                'cache_sizes': self._get_cache_sizes(),
                'features': self._get_cpu_features(),
                'governor': self._get_cpu_governor()
            }
            
        except Exception as e:
            print(f"Linux CPU detection error: {e}")
            return self._detect_generic_cpu()
            
        return cpu_info
        
    def _detect_macos_cpu(self):
        """macOS CPU detection"""
        cpu_info = {}
        
        try:
            # Use sysctl for accurate detection
            physical_cores = int(subprocess.check_output(['sysctl', '-n', 'hw.physicalcpu'], text=True).strip())
            logical_cores = int(subprocess.check_output(['sysctl', '-n', 'hw.logicalcpu'], text=True).strip())
            
            # Get CPU frequency
            try:
                freq = int(subprocess.check_output(['sysctl', '-n', 'hw.cpufrequency'], text=True).strip())
                frequency_mhz = freq // 1000000  # Convert to MHz
            except Exception:
                frequency_mhz = 0
                
            # Get cache sizes
            cache_sizes = {}
            for cache in ['L1', 'L2', 'L3']:
                try:
                    size = subprocess.check_output(['sysctl', '-n', f'hw.{cache.lower()}cachesize'], text=True).strip()
                    cache_sizes[cache] = int(size)
                except Exception:
                    pass
                    
            cpu_info = {
                'physical_cores': physical_cores,
                'logical_cores': logical_cores,
                'threads_per_core': logical_cores // physical_cores,
                'frequency_mhz': frequency_mhz,
                'cache_sizes': cache_sizes,
                'architecture': platform.machine(),
                'apple_silicon': 'arm' in platform.machine().lower()
            }
            
        except Exception as e:
            print(f"macOS CPU detection error: {e}")
            return self._detect_generic_cpu()
            
        return cpu_info
        
    def _detect_windows_cpu(self):
        """Windows CPU detection"""
        cpu_info = {}
        
        try:
            import wmi  # May not be available
            
            c = wmi.WMI()
            processor = c.Win32_Processor()[0]
            
            cpu_info = {
                'physical_cores': processor.NumberOfCores,
                'logical_cores': processor.NumberOfLogicalProcessors,
                'threads_per_core': processor.NumberOfLogicalProcessors // processor.NumberOfCores,
                'frequency_mhz': processor.MaxClockSpeed,
                'name': processor.Name,
                'manufacturer': processor.Manufacturer
            }
            
        except Exception:
            # Fallback to psutil
            cpu_info = {
                'physical_cores': psutil.cpu_count(logical=False),
                'logical_cores': psutil.cpu_count(logical=True),
                'threads_per_core': psutil.cpu_count(logical=True) // psutil.cpu_count(logical=False),
                'frequency_mhz': psutil.cpu_freq().current if psutil.cpu_freq() else 0
            }
            
        return cpu_info
        
    def _detect_generic_cpu(self):
        """Generic CPU detection fallback"""
        return {
            'physical_cores': psutil.cpu_count(logical=False) or 1,
            'logical_cores': psutil.cpu_count(logical=True) or 1,
            'threads_per_core': (psutil.cpu_count(logical=True) or 1) // (psutil.cpu_count(logical=False) or 1),
            'frequency_mhz': psutil.cpu_freq().current if psutil.cpu_freq() else 0
        }
        
    def _get_cpu_frequency(self):
        """Get CPU frequency information"""
        try:
            freq_info = psutil.cpu_freq()
            return {
                'current_mhz': freq_info.current,
                'min_mhz': freq_info.min,
                'max_mhz': freq_info.max
            }
        except Exception:
            return {}
            
    def _get_cache_sizes(self):
        """Get CPU cache sizes"""
        cache_sizes = {}
        try:
            if platform.system() == "Linux":
                for cache in ['L1', 'L2', 'L3']:
                    try:
                        size = subprocess.check_output(['lscpu'], text=True)
                        for line in size.split('\n'):
                            if f'{cache}d cache:' in line.lower():
                                cache_size = line.split(':')[1].strip().split()[0]
                                cache_sizes[cache] = cache_size
                    except Exception:
                        pass
        except Exception:
            pass
        return cache_sizes
        
    def _get_cpu_features(self):
        """Get CPU features"""
        features = []
        try:
            if platform.system() == "Linux":
                with open('/proc/cpuinfo', 'r') as f:
                    for line in f:
                        if line.startswith('flags'):
                            features = line.split(':')[1].strip().split()
                            break
        except Exception:
            pass
        return features
        
    def _get_cpu_governor(self):
        """Get CPU governor"""
        try:
            if platform.system() == "Linux":
                governor = subprocess.check_output(['cpupower', 'frequency-info', '-g'], text=True).strip()
                return governor
        except Exception:
            pass
        return "unknown"
        
    def detect_memory(self):
        """Memory detection"""
        memory = psutil.virtual_memory()
        
        self.system_info['memory'] = {
            'total_gb': memory.total / (1024**3),
            'available_gb': memory.available / (1024**3),
            'used_gb': memory.used / (1024**3),
            'percentage': memory.percent,
            'swap_total_gb': psutil.swap_memory().total / (1024**3),
            'swap_used_gb': psutil.swap_memory().used / (1024**3)
        }
        
    def detect_gpu(self):
        """GPU detection"""
        gpus = []
        
        # NVIDIA GPU detection
        try:
            nvidia_smi = subprocess.check_output(['nvidia-smi', '--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], text=True)
            for line in nvidia_smi.strip().split('\n'):
                parts = line.split(', ')
                if len(parts) >= 3:
                    gpus.append({
                        'type': 'nvidia',
                        'name': parts[0].strip(),
                        'memory_total_mb': int(parts[1].strip()),
                        'memory_free_mb': int(parts[2].strip()),
                        'cuda_available': True
                    })
        except Exception:
            pass
            
        # AMD GPU detection
        try:
            if platform.system() == "Linux":
                # Try to detect AMD GPUs
                result = subprocess.check_output(['lspci'], text=True)
                for line in result.split('\n'):
                    if 'AMD' in line and ('Radeon' in line or 'GPU' in line):
                        gpus.append({
                            'type': 'amd',
                            'name': line.strip(),
                            'memory_total_mb': 0,  # Would need additional detection
                            'vulkan_available': True
                        })
        except Exception:
            pass
            
        # Intel iGPU detection — shared memory, Vulkan-capable
        if platform.system() == "Linux":
            try:
                lspci_out = subprocess.check_output(['lspci'], text=True, stderr=subprocess.DEVNULL)
                for line in lspci_out.split('\n'):
                    if 'Intel' in line and any(x in line for x in ['Iris', 'UHD', 'HD Graphics']):
                        # Intel iGPU detected — estimate shared VRAM from system RAM
                        # Ice Lake Iris Plus typically gets 1-2GB shared depending on BIOS
                        total_mem_gb = psutil.virtual_memory().total / (1024**3)
                        # Conservative estimate: 1GB shared VRAM on 16GB system
                        estimated_vram_mb = min(1024, int(total_mem_gb * 64))
                        
                        gpus.append({
                            'type': 'intel_igpu',
                            'name': line.strip(),
                            'memory_total_mb': estimated_vram_mb,
                            'vulkan_available': True,
                            'shared_memory': True,
                        })
                        break
            except Exception:
                pass
            
        # Apple Silicon GPU
        if platform.system() == "Darwin" and 'arm' in platform.machine().lower():
            total_mem_mb = int(self.system_info.get('memory', {}).get('total_gb', 8) * 1024)
            
            # Detect chip details for accurate reporting
            chip_name = 'Apple Silicon'
            try:
                brand = subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip()
                chip_name = brand
            except Exception:
                pass
            
            gpus.append({
                'type': 'apple_silicon',
                'name': chip_name,
                'memory_total_mb': total_mem_mb,  # FULL unified memory, not 25%
                'metal_available': True,
                'unified_memory': True,
            })
            
        self.system_info['gpus'] = gpus
        
    def detect_storage(self):
        """Storage detection"""
        storage = {}
        
        try:
            disk_usage = psutil.disk_usage('/')
            storage = {
                'total_gb': disk_usage.total / (1024**3),
                'free_gb': disk_usage.free / (1024**3),
                'used_gb': disk_usage.used / (1024**3),
                'percentage': (disk_usage.used / disk_usage.total) * 100
            }
        except Exception:
            pass
            
        self.system_info['storage'] = storage
        
    def detect_network(self):
        """Network detection"""
        network = {}
        
        try:
            # Get network interfaces
            addrs = psutil.net_if_addrs()
            interfaces = list(addrs.keys())
            
            # Check for active connections
            connections = len(psutil.net_connections())
            
            network = {
                'interfaces': interfaces,
                'active_connections': connections
            }
        except Exception:
            pass
            
        self.system_info['network'] = network
        
    def optimize_config(self):
        """Generate optimized configuration based on system detection"""
        config_path = os.path.join(os.path.dirname(__file__), '..', 'config.json')
        try:
            with open(config_path, 'r') as f:
                existing_config = json.load(f)
        except Exception:
            existing_config = {}

        config = {}
        
        # CPU-based optimizations
        cpu = self.system_info.get('cpu', {})
        physical_cores = cpu.get('physical_cores', 1)
        logical_cores = cpu.get('logical_cores', 1)
        
        config['threads'] = physical_cores
        config['threads_batch'] = logical_cores
        
        # Memory-based optimizations
        memory = self.system_info.get('memory', {})
        total_memory_gb = memory.get('total_gb', 4)
        
        # Dynamic batch size based on memory
        if total_memory_gb >= 32:
            config['batch_size'] = 1024
            config['ubatch_size'] = 1024
        elif total_memory_gb >= 16:
            config['batch_size'] = 512
            config['ubatch_size'] = 512
            config['ctx_size'] = 8192
        else:
            config['batch_size'] = 256
            config['ubatch_size'] = 256
            config['ctx_size'] = 4096

        # GPU-based optimizations - MAXIMUM OFFLOADING
        gpus = self.system_info.get('gpus', [])
        if gpus:
            best_gpu = max(gpus, key=lambda x: x.get('memory_total_mb', 0))
            vram_mb = best_gpu.get('memory_total_mb', 0)
            gpu_type = best_gpu.get('type', 'unknown')

            # ALWAYS use maximum GPU layers for any detected GPU
            # Modern drivers handle memory management efficiently
            config['n_gpu_layers'] = 99  # Maximum offloading
            config['gpu_type'] = gpu_type

            # Log the aggressive optimization
            if gpu_type == 'apple_silicon':
                print(f'[Optimizer] Apple Silicon detected: Full Metal offloading enabled')
            elif gpu_type == 'intel':
                print(f'[Optimizer] Intel iGPU detected: Maximum layers on integrated graphics')
            elif gpu_type == 'nvidia':
                print(f'[Optimizer] NVIDIA GPU detected ({vram_mb}MB): Maximum CUDA offloading')
            elif gpu_type == 'amd':
                print(f'[Optimizer] AMD GPU detected: Maximum ROCm/Vulkan offloading')
            else:
                print(f'[Optimizer] GPU detected ({gpu_type}): Maximum offloading enabled')
                
            # Intel iGPU: conservative GPU layer count
            # Too many layers = shared memory pressure = slower than CPU-only
            # For Iris Plus G1 on 16GB: 10-20 layers is the sweet spot
            igpu_types = ['intel_igpu', 'intel']
            if config.get('gpu_type') in igpu_types:
                total_mem_gb = self.system_info.get('memory', {}).get('total_gb', 16)
                if total_mem_gb >= 16:
                    config['n_gpu_layers'] = 20  # safe for 16GB with 1GB shared VRAM
                elif total_mem_gb >= 12:
                    config['n_gpu_layers'] = 15
                elif total_mem_gb >= 8:
                    config['n_gpu_layers'] = 10
                else:
                    config['n_gpu_layers'] = 0  # too risky, CPU only

                # iGPU shares system RAM — never use mlock, it fights the iGPU
                config['use_mlock'] = False
                # Row split mode is correct for single GPU
                config['split_mode'] = 'row'
                print(f"[Optimizer] Intel iGPU: setting n_gpu_layers={config['n_gpu_layers']}")
            # Note: NVIDIA/AMD GPUs keep n_gpu_layers=99 set above, only iGPUs need special handling
            
        # Thread-based optimizations for server
        if physical_cores >= 16:
            config['http_threads'] = 8
        elif physical_cores >= 8:
            config['http_threads'] = 4
        else:
            config['http_threads'] = 2
        
        # Single user app — never auto-detect parallel slots
        # auto = 4 slots × full ctx each = 4x memory waste on constrained hardware
        config['parallel_slots'] = 1
        
        # Prompt cache — disabled by default on constrained hardware
        # The 8GB default limit is dangerous on 16GB machines with iGPU
        config['prompt_cache'] = False
        
        # Context size cap for constrained hardware
        # system_optimizer already sets ctx_size but add a hard cap
        total_mem_gb = self.system_info.get('memory', {}).get('total_gb', 16)
        if total_mem_gb < 20:
            config['ctx_size'] = min(config.get('ctx_size', 4096), 8192)
            print(f"[Optimizer] Context size capped to {config['ctx_size']} for {total_mem_gb:.0f}GB system")
            
        # Platform-specific optimizations
        if platform.system() == "Darwin" and 'arm' in platform.machine().lower():
            # Apple Silicon optimizations - MLX backend specific
            config['n_gpu_layers'] = 99  # MLX runs everything on Metal natively
            config['gpu_type'] = 'apple_silicon'
            config['use_mlock'] = False  # unified memory doesn't need mlock
            config['split_mode'] = 'row'
            
            # MLX-specific: scale batch size more aggressively on Apple Silicon
            # Metal can handle larger batches than the generic memory tiers above
            mem = self.system_info.get('memory', {}).get('total_gb', 8)
            if mem >= 64:
                config['batch_size'] = 2048
                config['ubatch_size'] = 2048
                config['ctx_size'] = 32768
            elif mem >= 32:
                config['batch_size'] = 1024
                config['ubatch_size'] = 1024
                config['ctx_size'] = 16384
            elif mem >= 16:
                config['batch_size'] = 512
                config['ubatch_size'] = 512
                config['ctx_size'] = 8192
            else:
                config['batch_size'] = 256
                config['ubatch_size'] = 256
                config['ctx_size'] = 4096
            
            # On Apple Silicon, use only performance cores for CPU thread work
            try:
                # sysctl hw.perflevel0.physicalcpu gives P-core count
                p_cores_result = subprocess.check_output(
                    ['sysctl', '-n', 'hw.perflevel0.physicalcpu'], 
                    text=True, stderr=subprocess.DEVNULL
                ).strip()
                p_cores = int(p_cores_result)
                config['threads'] = p_cores
                config['threads_batch'] = p_cores
                print(f'[Optimizer] Apple Silicon: using {p_cores} P-cores (ignoring E-cores)')
            except Exception:
                # Fallback: use half of physical cores as estimate for P-cores
                config['threads'] = max(1, physical_cores // 2)
                config['threads_batch'] = config['threads']
            
            # MLX model directory path
            config['mlx_model_dir'] = os.path.join(
                os.path.dirname(os.path.dirname(__file__)), 
                'models'
            )
        else:
            config['use_mlock'] = True
            config['split_mode'] = 'layer' if config['gpu_type'] == 'nvidia' else 'row'
            
        # Safety: don't mlock if available RAM < 1.5x model headroom estimate
        available_gb = self.system_info.get('memory', {}).get('available_gb', 0)
        if available_gb < 4:
            config['use_mlock'] = False
            print(f"[Optimizer] Low RAM ({available_gb:.1f}GB available): disabling mlock")
            
        # Performance optimizations
        config['flash_attn'] = True
        config['kv_cache_quant'] = 'q8_0'
        config['defrag_thold'] = 0.1
        config['cont_batching'] = True
        # Detect actual NUMA node count — don't assume Linux = multi-NUMA
        numa_node_count = 1
        try:
            with open('/sys/devices/system/node/online', 'r') as f:
                node_range = f.read().strip()
                # Format is "0" for single node or "0-N" for multiple
                if '-' in node_range:
                    numa_node_count = int(node_range.split('-')[1]) + 1
        except Exception:
            pass

        config['numa_mode'] = 'distribute' if numa_node_count > 1 else 'none'
        config['numa_nodes'] = numa_node_count
        
        # API configuration — only set if not already in existing config
        # (we don't override user-set api_port to avoid port conflicts)
        if 'api_port' not in existing_config:
            config['api_port'] = 8090
        if 'api_port_secondary' not in existing_config:
            config['api_port_secondary'] = 8081
        
        self.optimized_config = config
        return config
        
    def save_config(self, config_path=None):
        """Save optimized configuration"""
        if config_path is None:
            config_path = os.path.join(os.path.dirname(__file__), '..', 'config.json')
            
        try:
            if os.path.exists(config_path):
                with open(config_path, 'r') as f:
                    existing_config = json.load(f)
                    
            # Update with optimized values
            for key, value in self.optimized_config.items():
                old = existing_config.get(key, '<unset>')
                existing_config[key] = value
                print(f'[Optimizer]  {key}: {old} → {value}')
                    
            # Save updated config
            with open(config_path, 'w') as f:
                json.dump(existing_config, f, indent=2)
                
            return True
        except Exception as e:
            print(f"Error saving config: {e}")
            return False
            
    def print_system_info(self):
        """Print detailed system information"""
        print("=== LUMINA EDGE SYSTEM OPTIMIZER ===")
        print(f"Platform: {self.system_info['platform']} {self.system_info['architecture']}")
        print()
        
        # CPU Info
        cpu = self.system_info.get('cpu', {})
        print("CPU INFORMATION:")
        print(f"  Physical Cores: {cpu.get('physical_cores', 'N/A')}")
        print(f"  Logical Cores: {cpu.get('logical_cores', 'N/A')}")
        print(f"  Threads per Core: {cpu.get('threads_per_core', 'N/A')}")
        if cpu.get('frequency_mhz'):
            print(f"  Frequency: {cpu['frequency_mhz']} MHz")
        print()
        
        # Memory Info
        memory = self.system_info.get('memory', {})
        print("MEMORY INFORMATION:")
        print(f"  Total RAM: {memory.get('total_gb', 0):.1f} GB")
        print(f"  Available RAM: {memory.get('available_gb', 0):.1f} GB")
        print(f"  Usage: {memory.get('percentage', 0):.1f}%")
        print()
        
        # GPU Info
        gpus = self.system_info.get('gpus', [])
        print("GPU INFORMATION:")
        if gpus:
            for i, gpu in enumerate(gpus, 1):
                print(f"  GPU {i}: {gpu.get('name', 'Unknown')}")
                print(f"    Type: {gpu.get('type', 'Unknown')}")
                if gpu.get('memory_total_mb'):
                    print(f"    Memory: {gpu['memory_total_mb']} MB")
        else:
            print("  No GPU detected")
        print()
        
        # Optimized Config
        print("OPTIMIZED CONFIGURATION:")
        for key, value in self.optimized_config.items():
            print(f"  {key}: {value}")
        print()

def main():
    """Main function"""
    optimizer = SystemOptimizer()
    
    if len(sys.argv) > 1 and sys.argv[1] == '--print-info':
        optimizer.print_system_info()
    else:
        config = optimizer.optimize_config()
        if optimizer.save_config():
            print("✓ System optimized and configuration saved")
        else:
            print("✗ Failed to save configuration")

def check_context_memory_safety(ctx_size, n_gpu_layers, total_mem_gb, model_path=None):
    """
    Warn if ctx_size will cause excessive KV cache allocation.
    KV cache size ≈ 2 × n_layers × n_heads × head_dim × ctx_size × 2 bytes (fp16)
    For a typical 1B model at 4096 ctx: ~200MB KV cache — fine
    For a typical 1B model at 128K ctx: ~6GB KV cache — dangerous
    """
    # Rough estimate: 0.5MB per 1K context for small models
    estimated_kv_mb = (ctx_size / 1024) * 500
    if estimated_kv_mb > total_mem_gb * 1024 * 0.3:
        print(f"[Optimizer] ⚠ WARNING: ctx_size={ctx_size} may allocate "
              f"~{estimated_kv_mb/1024:.1f}GB KV cache on {total_mem_gb:.0f}GB system")
        print(f"[Optimizer] ⚠ Consider reducing ctx_size if you experience slowdowns")
    return estimated_kv_mb

if __name__ == "__main__":
    main()
