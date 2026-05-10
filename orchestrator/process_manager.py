"""
Process Manager for Pipeline Agents
Manages lifecycle of llama-server subprocesses for each agent.
"""

import json
import logging
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, Optional, List

# Configure logging
logging.basicConfig(level=logging.INFO, format='[Lumina Pipeline] %(levelname)s: %(message)s')
logger = logging.getLogger(__name__)


class AgentProcessManager:
    """Manages llama-server processes for multiple agents."""
    
    def __init__(self, config_path: str = "config.json"):
        self.config_path = config_path
        self.processes: Dict[str, subprocess.Popen] = {}
        self.config = self._load_config()
    
    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from file."""
        try:
            with open(self.config_path, 'r') as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to load config from {self.config_path}: {e}")
            return {}
    
    def start_agent(self, agent_name: str, agent_config: Dict[str, Any]) -> bool:
        """Start a single agent process."""
        if agent_name in self.processes:
            logger.warning(f"Agent {agent_name} is already running")
            return False
        
        try:
            # Build command for llama-server
            cmd = [
                "llama-server",
                "--model", agent_config.get("model_path", ""),
                "--host", "localhost",
                "--port", str(agent_config.get("port", 8080)),
                "--ctx-size", str(agent_config.get("ctx_size", 2048))
            ]
            
            # Add optional parameters
            if agent_config.get("gpu_layers"):
                cmd.extend(["--gpu-layers", str(agent_config["gpu_layers"])])
            
            if agent_config.get("threads"):
                cmd.extend(["--threads", str(agent_config["threads"])])
            
            logger.info(f"Starting agent {agent_name} with command: {' '.join(cmd)}")
            
            # Start the process
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            
            self.processes[agent_name] = process
            logger.info(f"Agent {agent_name} started with PID {process.pid}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to start agent {agent_name}: {e}")
            return False
    
    def stop_agent(self, agent_name: str) -> bool:
        """Stop a single agent process."""
        if agent_name not in self.processes:
            logger.warning(f"Agent {agent_name} is not running")
            return False
        
        try:
            process = self.processes[agent_name]
            logger.info(f"Stopping agent {agent_name} (PID: {process.pid})")
            
            # Try graceful shutdown first
            process.terminate()
            
            # Wait for process to terminate
            try:
                process.wait(timeout=10)
                logger.info(f"Agent {agent_name} stopped gracefully")
            except subprocess.TimeoutExpired:
                # Force kill if graceful shutdown fails
                process.kill()
                logger.warning(f"Agent {agent_name} was force killed")
            
            del self.processes[agent_name]
            return True
            
        except Exception as e:
            logger.error(f"Failed to stop agent {agent_name}: {e}")
            return False
    
    def restart_agent(self, agent_name: str) -> bool:
        """Restart a single agent process."""
        if agent_name in self.processes:
            self.stop_agent(agent_name)
            time.sleep(2)  # Give it time to fully stop
        
        agents_config = self.config.get("agents", {})
        if agent_name in agents_config:
            return self.start_agent(agent_name, agents_config[agent_name])
        else:
            logger.error(f"Agent {agent_name} not found in config")
            return False
    
    def get_agent_status(self, agent_name: str) -> Optional[Dict[str, Any]]:
        """Get status of a specific agent."""
        if agent_name not in self.processes:
            return None
        
        process = self.processes[agent_name]
        return {
            "name": agent_name,
            "pid": process.pid,
            "status": "running" if process.poll() is None else "stopped",
            "return_code": process.poll()
        }
    
    def get_all_status(self) -> Dict[str, Dict[str, Any]]:
        """Get status of all agents."""
        status = {}
        for agent_name in self.processes:
            status[agent_name] = self.get_agent_status(agent_name)
        return status
    
    def start_all(self) -> Dict[str, bool]:
        """Start all agents from config."""
        results = {}
        agents_config = self.config.get("agents", {})
        
        for agent_name, agent_config in agents_config.items():
            success = self.start_agent(agent_name, agent_config)
            results[agent_name] = success
            time.sleep(1)  # Small delay between starts
        
        return results
    
    def stop_all(self) -> Dict[str, bool]:
        """Stop all running agents."""
        results = {}
        agent_names = list(self.processes.keys())
        
        for agent_name in agent_names:
            success = self.stop_agent(agent_name)
            results[agent_name] = success
        
        return results
    
    def restart_all(self) -> Dict[str, bool]:
        """Restart all agents."""
        self.stop_all()
        time.sleep(3)  # Give processes time to stop
        return self.start_all()
    
    def cleanup(self):
        """Clean up all processes on exit."""
        logger.info("Cleaning up all agent processes...")
        self.stop_all()


def main():
    """Command line interface for process manager."""
    parser = argparse.ArgumentParser(description="Lumina Pipeline Process Manager")
    parser.add_argument("--config", default="config.json", help="Configuration file path")
    
    subparsers = parser.add_subparsers(dest="command", help="Available commands")
    
    # Start command
    start_parser = subparsers.add_parser("start", help="Start agents")
    start_parser.add_argument("agent", nargs="?", help="Specific agent to start (optional)")
    
    # Stop command
    stop_parser = subparsers.add_parser("stop", help="Stop agents")
    stop_parser.add_argument("agent", nargs="?", help="Specific agent to stop (optional)")
    
    # Restart command
    restart_parser = subparsers.add_parser("restart", help="Restart agents")
    restart_parser.add_argument("agent", nargs="?", help="Specific agent to restart (optional)")
    
    # Status command
    status_parser = subparsers.add_parser("status", help="Show agent status")
    status_parser.add_argument("agent", nargs="?", help="Specific agent to check (optional)")
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return
    
    manager = AgentProcessManager(args.config)
    
    try:
        if args.command == "start":
            if args.agent:
                # Start specific agent
                agents_config = manager.config.get("agents", {})
                if args.agent in agents_config:
                    success = manager.start_agent(args.agent, agents_config[args.agent])
                    print(f"Agent {args.agent} {'started' if success else 'failed to start'}")
                else:
                    print(f"Agent {args.agent} not found in config")
            else:
                # Start all agents
                results = manager.start_all()
                print("Start results:")
                for name, success in results.items():
                    print(f"  {name}: {'✓' if success else '✗'}")
        
        elif args.command == "stop":
            if args.agent:
                success = manager.stop_agent(args.agent)
                print(f"Agent {args.agent} {'stopped' if success else 'failed to stop'}")
            else:
                results = manager.stop_all()
                print("Stop results:")
                for name, success in results.items():
                    print(f"  {name}: {'✓' if success else '✗'}")
        
        elif args.command == "restart":
            if args.agent:
                success = manager.restart_agent(args.agent)
                print(f"Agent {args.agent} {'restarted' if success else 'failed to restart'}")
            else:
                results = manager.restart_all()
                print("Restart results:")
                for name, success in results.items():
                    print(f"  {name}: {'✓' if success else '✗'}")
        
        elif args.command == "status":
            if args.agent:
                status = manager.get_agent_status(args.agent)
                if status:
                    print(f"Agent {args.agent}:")
                    for key, value in status.items():
                        print(f"  {key}: {value}")
                else:
                    print(f"Agent {args.agent} not running")
            else:
                status = manager.get_all_status()
                if status:
                    print("Agent Status:")
                    for name, info in status.items():
                        print(f"  {name}:")
                        for key, value in info.items():
                            print(f"    {key}: {value}")
                else:
                    print("No agents running")
    
    except KeyboardInterrupt:
        logger.info("Received interrupt signal")
        manager.cleanup()
    except Exception as e:
        logger.error(f"Error: {e}")
        manager.cleanup()


if __name__ == "__main__":
    main()
