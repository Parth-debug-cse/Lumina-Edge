#!/usr/bin/env python3
# ==============================================================================
# LUMINA EDGE :: Real-time Performance Monitor
# Monitors tokens/sec, memory usage, and system metrics during inference
# ==============================================================================

import os
import sys
import time
import json
import threading
import subprocess
import psutil
from datetime import datetime

class PerformanceMonitor:
    def __init__(self, log_file=None, update_interval=1.0):
        self.log_file = log_file or "performance.log"
        self.update_interval = update_interval
        self.running = False
        self.start_time = None
        self.total_tokens = 0
        self.tokens_last_update = 0
        
    def start_monitoring(self):
        """Start the performance monitoring thread"""
        self.running = True
        self.start_time = time.time()
        self.monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self.monitor_thread.start()
        print(f"🔍 Performance monitoring started (logging to {self.log_file})")
        
    def stop_monitoring(self):
        """Stop performance monitoring and print summary"""
        self.running = False
        if hasattr(self, 'monitor_thread'):
            self.monitor_thread.join(timeout=2)
        
        if self.start_time:
            total_time = time.time() - self.start_time
            avg_tps = self.total_tokens / total_time if total_time > 0 else 0
            print(f"\n📊 Performance Summary:")
            print(f"   Total time: {total_time:.2f}s")
            print(f"   Total tokens: {self.total_tokens}")
            print(f"   Average tokens/sec: {avg_tps:.2f}")
            
    def update_tokens(self, token_count):
        """Update token count for TPS calculation"""
        self.total_tokens += token_count
        
    def _monitor_loop(self):
        """Main monitoring loop"""
        with open(self.log_file, 'w') as f:
            f.write("timestamp,cpu_percent,memory_percent,memory_gb,gpu_memory_gb,tokens_per_sec\n")
            
        while self.running:
            try:
                # Get system metrics
                cpu_percent = psutil.cpu_percent(interval=0.1)
                memory_info = psutil.virtual_memory()
                memory_gb = memory_info.used / (1024**3)
                
                # Get GPU memory if available
                gpu_memory_gb = 0
                try:
                    # Try nvidia-smi first
                    result = subprocess.run(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'], 
                                          capture_output=True, text=True, timeout=2)
                    if result.returncode == 0:
                        gpu_memory_gb = float(result.stdout.strip()) / 1024
                except Exception:
                    pass
                
                # Calculate tokens/sec
                current_time = time.time()
                if self.start_time:
                    elapsed = current_time - self.start_time
                    tokens_per_sec = self.total_tokens / elapsed if elapsed > 0 else 0
                else:
                    tokens_per_sec = 0
                
                # Log metrics
                timestamp = datetime.now().isoformat()
                log_entry = f"{timestamp},{cpu_percent},{memory_info.percent},{memory_gb:.2f},{gpu_memory_gb:.2f},{tokens_per_sec:.2f}\n"
                
                with open(self.log_file, 'a') as f:
                    f.write(log_entry)
                
                # Print live status
                if self.start_time is not None and elapsed > 0:
                    print(f"\r⚡ TPS: {tokens_per_sec:.1f} | CPU: {cpu_percent:.1f}% | RAM: {memory_gb:.1f}GB", end='', flush=True)
                
                time.sleep(self.update_interval)
                
            except Exception as e:
                print(f"\n⚠️ Monitoring error: {e}")
                time.sleep(self.update_interval)

def monitor_llama_server_process(server_process, log_file=None):
    """Monitor a running llama-server process"""
    monitor = PerformanceMonitor(log_file)
    monitor.start_monitoring()
    
    try:
        # Monitor the server process
        while server_process.poll() is None:
            time.sleep(0.5)
            
            # Try to extract token information from server logs
            # This is a simplified approach - in practice you'd parse server output
            pass
            
    except KeyboardInterrupt:
        pass
    finally:
        monitor.stop_monitoring()

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Lumina Edge Performance Monitor")
    parser.add_argument("--log-file", default="performance.log", help="Log file path")
    parser.add_argument("--update-interval", type=float, default=1.0, help="Update interval in seconds")
    parser.add_argument("--monitor-pid", type=int, help="Monitor specific process ID")
    args = parser.parse_args()
    
    if args.monitor_pid:
        try:
            process = psutil.Process(args.monitor_pid)
            print(f"Monitoring process {args.monitor_pid} ({process.name()})")
            monitor = PerformanceMonitor(args.log_file, args.update_interval)
            monitor.start_monitoring()
            
            while process.is_running():
                time.sleep(1)
                
            monitor.stop_monitoring()
        except psutil.NoSuchProcess:
            print(f"Process {args.monitor_pid} not found")
    else:
        print("Standalone monitoring mode - press Ctrl+C to stop")
        monitor = PerformanceMonitor(args.log_file, args.update_interval)
        monitor.start_monitoring()
        
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            monitor.stop_monitoring()

if __name__ == "__main__":
    main()
