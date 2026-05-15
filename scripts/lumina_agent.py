#!/usr/bin/env python3
"""
Lumina Aider agent — calls the local Lumina Edge API with a tool-use prompt.

Usage: python3 scripts/lumina_agent.py [prompt text]
"""
import json
import os
import shlex
import subprocess
import sys

try:
    import requests
except ImportError:
    print("ERROR: 'requests' is not installed. Run: pip install requests")
    sys.exit(1)

# ── Config ─────────────────────────────────────────────────────────────────────
_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
_CONFIG_PATH = os.path.normpath(os.path.join(_ROOT, "config.json"))


def _load_config():
    try:
        with open(_CONFIG_PATH) as f:
            return json.load(f)
    except Exception as e:
        print(f"WARNING: Could not read config.json: {e}")
        return {}


def _get_api_url(config):
    port = config.get("api_port", 8090)
    return f"http://127.0.0.1:{port}/v1/chat/completions"


def _get_model_name(config, api_url):
    """
    BUG LA-1 FIX: Do not hardcode the model name. Query /v1/models to discover
    what the running server actually has loaded, then use that name.
    Falls back to the 'model' key in config.json, then to a sensible default.
    """
    models_url = api_url.replace("/v1/chat/completions", "/v1/models")
    try:
        resp = requests.get(models_url, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            models = data.get("data", [])
            if models:
                model_id = models[0].get("id", "")
                if model_id:
                    return model_id
    except Exception as e:
        print(f"WARNING: Could not query /v1/models: {e}")

    # Fall back to config.json 'model' key
    config_model = config.get("model", "").strip()
    if config_model:
        return config_model

    # Last-resort default
    return "lumina-model"


# ── Main ───────────────────────────────────────────────────────────────────────
config = _load_config()
API = _get_api_url(config)
user_input = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "run git status"

print(f">>> Prompt: {user_input}")

# BUG LA-1 FIX: Discover the model name dynamically rather than hardcoding.
MODEL = _get_model_name(config, API)
print(f">>> Model: {MODEL}")

try:
    resp = requests.post(
        API,
        json={
            "model": MODEL,
            "messages": [{"role": "user", "content": user_input}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "shell",
                        "parameters": {
                            "type": "object",
                            "properties": {"command": {"type": "string"}},
                            "required": ["command"],
                        },
                    },
                }
            ],
            "max_tokens": 200,
            "stream": False,
        },
        timeout=60,
    )
except requests.exceptions.ConnectionError:
    print(f"ERROR: Cannot connect to Lumina Edge API at {API}")
    print("Make sure the server is running: ./start_lumina.sh  or  ./start_api.sh")
    sys.exit(1)
except requests.exceptions.Timeout:
    print("ERROR: Request timed out after 60 seconds.")
    sys.exit(1)

# BUG LA-2 FIX: Check HTTP status and validate JSON structure before indexing.
if resp.status_code != 200:
    print(f"ERROR: API returned HTTP {resp.status_code}: {resp.text[:300]}")
    sys.exit(1)

try:
    data = resp.json()
except Exception as e:
    print(f"ERROR: API response is not valid JSON: {e}")
    sys.exit(1)

if "error" in data:
    print(f"ERROR: API error: {data['error']}")
    sys.exit(1)

choices = data.get("choices")
if not choices:
    print("ERROR: API response has no 'choices' field.")
    sys.exit(1)

choice = choices[0]

if choice.get("finish_reason") != "tool_calls":
    print("Model response:", choice.get("message", {}).get("content", "No tool call"))
    sys.exit(0)

# BUG LA-2 FIX: Guard access to tool_calls list.
tool_calls = choice.get("message", {}).get("tool_calls")
if not tool_calls:
    print("ERROR: finish_reason is 'tool_calls' but no tool_calls in message.")
    sys.exit(1)

tc = tool_calls[0]
print(f">>> Model called: {tc['function']['name']}")

try:
    args = json.loads(tc["function"]["arguments"])
except Exception as e:
    print(f"ERROR: Could not parse tool arguments as JSON: {e}")
    sys.exit(1)

cmd = args.get("command", "")
if not cmd:
    print("ERROR: Tool call has no 'command' argument.")
    sys.exit(1)

print(f">>> Executing: {cmd}")
print("---")

# BUG LA-3 FIX: Wrap shlex.split in try/except — it raises ValueError on
# unmatched quotes, which would otherwise crash with a confusing traceback.
try:
    cmd_args = shlex.split(cmd)
except ValueError as e:
    print(f"ERROR: Could not parse command {cmd!r}: {e}")
    sys.exit(1)

result = subprocess.run(cmd_args, shell=False, capture_output=True, text=True)
if result.stdout:
    print(result.stdout.strip())
if result.stderr:
    print(result.stderr.strip(), file=sys.stderr)
print("---")
print(">>> Agentic task complete.")