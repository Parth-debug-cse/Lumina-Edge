import requests, json, sys, subprocess

API = "http://localhost:8090/v1/chat/completions"
MODEL = "Qwen2.5-1.5B-Instruct-4bit"

user_input = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "run git status"

print(f">>> Prompt: {user_input}")

resp = requests.post(API, json={
    "model": MODEL,
    "messages": [{"role": "user", "content": user_input}],
    "tools": [{
        "type": "function",
        "function": {
            "name": "shell",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"]
            }
        }
    }],
    "max_tokens": 200,
    "stream": False
}, timeout=60)

data = resp.json()
choice = data["choices"][0]

if choice.get("finish_reason") != "tool_calls":
    print("Model response:", choice.get("message", {}).get("content", "No tool call"))
    sys.exit(0)

tc = choice["message"]["tool_calls"][0]
print(f">>> Model called: {tc['function']['name']}")
args = json.loads(tc["function"]["arguments"])
cmd = args.get("command", "")
print(f">>> Executing: {cmd}")
print("---")
result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
if result.stdout:
    print(result.stdout.strip())
if result.stderr:
    print(result.stderr.strip(), file=sys.stderr)
print("---")
print(">>> Agentic task complete.")