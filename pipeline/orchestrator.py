import json
import os
import sys
import asyncio
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel


CONFIG_PATH = Path(__file__).parent.parent / "config.json"


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


config = load_config()
agents_config = config.get("agents", {})
api_config = config.get("api", {})

CLEANER_PORT = agents_config.get("cleaner", {}).get("port", 8001)
CATEGORIZER_PORT = agents_config.get("categorizer", {}).get("port", 8002)
ORCHESTRATOR_PORT = api_config.get("port", 8000)
ORCHESTRATOR_HOST = api_config.get("host", "0.0.0.0")

app = FastAPI(title="Lumina Pipeline Orchestrator")


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = "lumina-pipeline"
    messages: list[ChatMessage]
    temperature: float | None = 0.7
    max_tokens: int | None = 2048


def extract_log_text(messages: list[dict]) -> str:
    for msg in reversed(messages):
        if msg.get("role") == "user":
            return msg.get("content", "")
    raise ValueError("No user message found in request")


async def call_agent(port: int, system_prompt: str, user_message: str, agent_name: str, temperature: float = 0.7, max_tokens: int = 2048):
    url = f"http://localhost:{port}/v1/chat/completions"
    payload = {
        "model": "model",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ],
        "temperature": temperature,
        "max_tokens": max_tokens
    }
    print(f"\n[{agent_name}] Calling http://localhost:{port}/v1/chat/completions")
    print(f"[{agent_name}] Payload: {json.dumps(payload, indent=2)}")

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(url, json=payload)
        print(f"[{agent_name}] Response status: {response.status_code}")

        if response.status_code != 200:
            raise HTTPException(status_code=502, detail=f"{agent_name} returned status {response.status_code}: {response.text}")

        result = response.json()
        print(f"[{agent_name}] Response: {json.dumps(result, indent=2)}")

        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        return content


CLEANER_SYSTEM_PROMPT = """You are a log cleaning agent. Your only job is to process raw server logs.
You must: normalize all timestamps to ISO 8601 format, remove exact duplicate lines, strip email addresses and replace with [EMAIL], strip IP addresses and replace with [IP], remove lines that are heartbeat pings or routine GC events, remove lines that are pure DEBUG noise with no operational significance.
Output ONLY the cleaned log text. No commentary. No explanations. No JSON. Just the cleaned lines, one per line."""

CATEGORIZER_SYSTEM_PROMPT = """You are a log categorization agent. You receive cleaned server log lines.
For each line, output a JSON object on its own line with these fields:
  timestamp, severity (INFO|WARN|ERROR|CRITICAL), category (auth|network|db|app|payment|system), message
Output ONLY a JSON array containing one object per log line.
No prose. No markdown. No code fences. Raw JSON array only."""


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    print(f"\n{'='*60}")
    print(f"[ORCHESTRATOR] Received request for model: {request.model}")
    print(f"[ORCHESTRATOR] Request messages: {json.dumps([m.model_dump() for m in request.messages], indent=2)}")

    try:
        raw_log_text = extract_log_text([m.model_dump() for m in request.messages])
        print(f"\n[ORCHESTRATOR] Extracted raw log text ({len(raw_log_text)} chars)")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        cleaned_log = await call_agent(
            port=CLEANER_PORT,
            system_prompt=CLEANER_SYSTEM_PROMPT,
            user_message=raw_log_text,
            agent_name="AGENT-1 (CLEANER)",
            temperature=request.temperature or 0.7,
            max_tokens=request.max_tokens or 2048
        )
        print(f"\n[ORCHESTRATOR] Agent 1 (Cleaner) returned: {cleaned_log[:500]}...")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Agent 1 (Cleaner) failed: {str(e)}")

    try:
        categorized_json = await call_agent(
            port=CATEGORIZER_PORT,
            system_prompt=CATEGORIZER_SYSTEM_PROMPT,
            user_message=cleaned_log,
            agent_name="AGENT-2 (CATEGORIZER)",
            temperature=request.temperature or 0.7,
            max_tokens=request.max_tokens or 2048
        )
        print(f"\n[ORCHESTRATOR] Agent 2 (Categorizer) returned: {categorized_json[:500]}...")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Agent 2 (Categorizer) failed: {str(e)}")

    response = {
        "model": request.model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": categorized_json
                },
                "finish_reason": "stop"
            }
        ],
        "usage": {
            "prompt_tokens": len(raw_log_text.split()),
            "completion_tokens": len(categorized_json.split()),
            "total_tokens": len(raw_log_text.split()) + len(categorized_json.split())
        }
    }

    print(f"\n[ORCHESTRATOR] Final response: {json.dumps(response, indent=2)}")
    print(f"{'='*60}\n")

    return JSONResponse(content=response)


@app.get("/health")
async def health():
    return {"status": "healthy", "service": "orchestrator"}


if __name__ == "__main__":
    import uvicorn
    print(f"Starting Lumina Pipeline Orchestrator on {ORCHESTRATOR_HOST}:{ORCHESTRATOR_PORT}")
    uvicorn.run(app, host=ORCHESTRATOR_HOST, port=ORCHESTRATOR_PORT)