"""
Pipeline Orchestrator for Multi-Agent Workflows
Manages sequential, parallel, and hybrid agent execution pipelines.
"""

import asyncio
import json
import logging
import os
import sys
import time
from typing import Dict, List, Optional, Any

try:
    import aiohttp
except ImportError:
    aiohttp = None

try:
    import psutil
    PSUTIL_AVAILABLE = True
except ImportError:
    PSUTIL_AVAILABLE = False

# Configure logging
logging.basicConfig(level=logging.INFO, format='[Lumina Pipeline] %(levelname)s: %(message)s')
logger = logging.getLogger(__name__)


class Agent:
    """Represents a single agent in the pipeline."""
    
    def __init__(self, name: str, port: int, model_path: str = "", **kwargs):
        self.name = name
        self.port = port
        self.model_path = model_path
        self.config = kwargs
        self.status = "idle"
        self.last_activity = None
    
    async def start(self):
        """Start the agent."""
        self.status = "starting"
        logger.info(f"Starting agent {self.name} on port {self.port}")
        # Agent startup logic here
        self.status = "running"
        self.last_activity = time.time()
    
    async def stop(self):
        """Stop the agent."""
        self.status = "stopping"
        logger.info(f"Stopping agent {self.name}")
        # Agent shutdown logic here
        self.status = "stopped"
    
    async def execute(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a task on this agent."""
        self.status = "executing"
        self.last_activity = time.time()
        
        # Task execution logic here
        result = {
            "agent": self.name,
            "task": task,
            "status": "completed",
            "timestamp": time.time()
        }
        
        self.status = "idle"
        return result


class PipelineOrchestrator:
    """Orchestrates multiple agents in various pipeline configurations."""
    
    def __init__(self, agents: List[Agent]):
        self.agents = agents
        self.agent_map = {agent.name: agent for agent in agents}
        self.pipeline_config = {}
        self.is_running = False
    
    async def start_all_agents(self):
        """Start all agents in the pipeline."""
        logger.info(f"Starting {len(self.agents)} agents...")
        await asyncio.gather(*[agent.start() for agent in self.agents])
        self.is_running = True
        logger.info("All agents started successfully")
    
    async def stop_all_agents(self):
        """Stop all agents in the pipeline."""
        logger.info("Stopping all agents...")
        await asyncio.gather(*[agent.stop() for agent in self.agents])
        self.is_running = False
        logger.info("All agents stopped")
    
    async def execute_sequential(self, tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Execute tasks sequentially across agents."""
        results = []
        for i, task in enumerate(tasks):
            agent_name = task.get("agent", self.agents[i % len(self.agents)].name)
            agent = self.agent_map[agent_name]
            result = await agent.execute(task)
            results.append(result)
        return results
    
    async def execute_parallel(self, tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Execute tasks in parallel across available agents."""
        # Assign tasks to agents round-robin
        agent_tasks = []
        for i, task in enumerate(tasks):
            agent = self.agents[i % len(self.agents)]
            agent_tasks.append(agent.execute(task))
        
        # Execute all tasks in parallel
        results = await asyncio.gather(*agent_tasks)
        return results
    
    def get_agent_status(self) -> Dict[str, Dict[str, Any]]:
        """Get status of all agents."""
        return {
            name: {
                "status": agent.status,
                "port": agent.port,
                "model_path": agent.model_path,
                "last_activity": agent.last_activity
            }
            for name, agent in self.agent_map.items()
        }


def check_memory_warning(total_model_memory: int, total_ram: int, warning_threshold: float = 0.8) -> Optional[str]:
    """Check if model memory usage exceeds warning threshold."""
    if not PSUTIL_AVAILABLE:
        return None
    
    usage_ratio = total_model_memory / total_ram
    if usage_ratio > warning_threshold:
        return f"High memory usage: {usage_ratio:.1%} of RAM"
    return None


def estimate_model_memory(model_paths: List[str]) -> int:
    """Estimate total memory required for models."""
    total = 0
    for path in model_paths:
        if os.path.exists(path):
            # Rough estimation: file size * 2 (for loading overhead)
            total += os.path.getsize(path) * 2
    return total


def format_bytes(bytes_val: int) -> str:
    """Format bytes into human readable string."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if bytes_val < 1024.0:
            return f"{bytes_val:.2f} {unit}"
        bytes_val /= 1024.0
    return f"{bytes_val:.2f} PB"


def create_orchestrator_from_config(config: Dict[str, Any]) -> PipelineOrchestrator:
    """Create orchestrator from configuration dictionary."""
    pipeline_config = config.get("pipeline", {})
    agents_config = config.get("agents", {})
    
    agents = []
    for agent_data in agents_config.values():
        agent = Agent(
            name=agent_data.get("name", "unnamed"),
            port=agent_data.get("port", 8000),
            model_path=agent_data.get("model_path", ""),
            **agent_data
        )
        agents.append(agent)
    
    # Check memory usage
    model_paths = []
    for agent_data in agents_config.values():
        model_path = agent_data.get("model_path", "")
        if model_path:
            model_paths.append(model_path)
    
    if model_paths:
        total_memory = estimate_model_memory(model_paths)
        warning = check_memory_warning(total_memory, psutil.virtual_memory().total if PSUTIL_AVAILABLE else 0)
        if warning:
            logger.warning(f"WARNING: {warning}")
    
    return PipelineOrchestrator(agents)


def load_config(config_path: str) -> Optional[Dict[str, Any]]:
    """Load configuration from JSON file."""
    try:
        with open(config_path, 'r') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load config: {e}")
        return None


if __name__ == "__main__":
    # Example usage
    config = load_config("config.json")
    if config:
        orchestrator = create_orchestrator_from_config(config)
        print(f"Created orchestrator with {len(orchestrator.agents)} agents")
        for name, agent in orchestrator.agent_map.items():
            print(f"  {name}: port {agent.port}")
    else:
        print("No config found, using default settings")
        # Create default orchestrator
        agents = [Agent("default", 8000)]
        orchestrator = PipelineOrchestrator(agents)
