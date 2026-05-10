"""
Pipeline API - FastAPI server for Multi-Agent Pipeline Orchestrator
Exposes OpenAI-compatible endpoints for OpenWebUI integration.
"""

import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from orchestrator.pipeline import Agent, PipelineOrchestrator, create_orchestrator_from_config, load_config

# Configure logging
logging.basicConfig(level=logging.INFO, format='[Lumina Pipeline] %(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# Get the directory of this file
__file__ = Path(__file__).resolve()
parent = __file__.parent

# Initialize FastAPI app
app = FastAPI(
    title="Lumina Pipeline API",
    description="Multi-Agent Pipeline Orchestrator API",
    version="1.0.0"
)

# Global variables
_config: Optional[Dict[str, Any]] = None
_orchestrator: Optional[PipelineOrchestrator] = None


def get_config(config_path: str = "config.json") -> Dict[str, Any]:
    """Get or load configuration."""
    global _config
    if _config is None:
        _config = load_config(config_path) or {}
    return _config


def get_orchestrator(config: Optional[Dict[str, Any]] = None) -> PipelineOrchestrator:
    """Get or create orchestrator instance."""
    global _orchestrator
    if _orchestrator is None:
        config = config or get_config()
        _orchestrator = create_orchestrator_from_config(config)
    return _orchestrator


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "message": "Lumina Pipeline API",
        "version": "1.0.0",
        "status": "running"
    }


@app.get("/v1/models")
async def list_models():
    """List available models (agents)."""
    config = get_config()
    pipeline_config = config.get("pipeline", {})
    agents = config.get("agents", {})
    
    model_ids = []
    models = []
    
    for idx, (name, agent) in enumerate(agents.items()):
        model_id = f"lumina-{name}"
        model_ids.append(model_id)
        
        models.append({
            "id": model_id,
            "object": "model",
            "created": int(time.time()),
            "owned_by": "lumina",
            "permission": [],
            "root": model_id,
            "parent": None
        })
    
    return {
        "object": "list",
        "data": models
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Dict[str, Any]):
    """OpenAI-compatible chat completions endpoint."""
    stream = request.get("stream", False)
    config = get_config()
    pipeline_config = config.get("pipeline", {})
    
    # Extract messages
    messages = request.get("messages", [])
    user_messages = [msg["content"] for msg in messages if msg.get("role") == "user"]
    
    if not user_messages:
        raise HTTPException(status_code=400, detail="No user messages found")
    
    input_text = user_messages[-1]  # Use the last user message
    
    # Get pipeline mode from request or config
    mode = request.get("mode", pipeline_config.get("default_mode", "sequential"))
    
    # Get available agents
    agents_config = config.get("agents", {})
    agent_names = list(agents_config.keys())
    
    if not agent_names:
        raise HTTPException(status_code=500, detail="No agents configured")
    
    # Create orchestrator and process request
    orchestrator = get_orchestrator(config)
    
    try:
        if mode == "sequential":
            # Sequential processing
            result = await orchestrator.execute_sequential([{
                "agent": agent_names[0],
                "task": {"input": input_text}
            }])
            final_output = result[0].get("result", input_text)
            
        elif mode == "parallel":
            # Parallel processing
            tasks = []
            for agent_name in agent_names:
                tasks.append({
                    "agent": agent_name,
                    "task": {"input": input_text}
                })
            
            results = await orchestrator.execute_parallel(tasks)
            parallel_outputs = [r.get("result", "") for r in results]
            final_output = " | ".join(parallel_outputs)
            
        elif mode == "hybrid":
            # Hybrid mode: sequential first, then parallel
            sequential_first = request.get("sequential_first", 1)
            then_parallel = request.get("then_parallel", len(agent_names) - 1)
            
            # Sequential part
            seq_tasks = []
            for i in range(min(sequential_first, len(agent_names))):
                seq_tasks.append({
                    "agent": agent_names[i],
                    "task": {"input": input_text}
                })
            
            seq_results = await orchestrator.execute_sequential(seq_tasks)
            seq_output = seq_results[-1].get("result", input_text) if seq_results else input_text
            
            # Parallel part
            if then_parallel > 0:
                parallel_tasks = []
                for i in range(sequential_first, min(sequential_first + then_parallel, len(agent_names))):
                    parallel_tasks.append({
                        "agent": agent_names[i],
                        "task": {"input": seq_output}
                    })
                
                parallel_results = await orchestrator.execute_parallel(parallel_tasks)
                parallel_outputs = [r.get("result", "") for r in parallel_results]
                final_output = f"{seq_output} | " + " | ".join(parallel_outputs)
            else:
                final_output = seq_output
        
        else:
            raise HTTPException(status_code=400, detail=f"Unknown mode: {mode}")
        
        # Format response like OpenAI
        response = {
            "id": f"chatcmpl-{int(time.time())}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": request.get("model", "lumina-default"),
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": final_output
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": len(input_text.split()),
                "completion_tokens": len(final_output.split()),
                "total_tokens": len(input_text.split()) + len(final_output.split())
            }
        }
        
        if stream:
            # For streaming, return a generator
            async def generate():
                yield f"data: {json.dumps(response)}\n\n"
                yield "data: [DONE]\n\n"
            
            return JSONResponse(
                content=generate(),
                media_type="text/plain"
            )
        else:
            return response
            
    except Exception as e:
        logger.error(f"Error processing request: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/pipeline/status")
async def pipeline_status():
    """Get pipeline status."""
    config = get_config()
    pipeline_config = config.get("pipeline", {})
    agents_config = config.get("agents", {})
    
    orchestrator = get_orchestrator(config)
    status = orchestrator.get_agent_status()
    
    return {
        "pipeline": pipeline_config,
        "agents": agents_config,
        "status": status,
        "is_running": orchestrator.is_running
    }


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": int(time.time()),
        "version": "1.0.0"
    }


if __name__ == "__main__":
    import uvicorn
    import platform
    
    # Get configuration
    config = get_config()
    api_config = config.get("api", {})
    
    host = api_config.get("host", "0.0.0.0")
    port = api_config.get("port", 8000)
    
    logger.info(f"Starting Lumina Pipeline API on {host}:{port}")
    logger.info(f"Platform: {platform.platform()}")
    logger.info(f"Python: {sys.version}")
    
    # Start the server
    uvicorn.run(app, host=host, port=port, log_level="info")
