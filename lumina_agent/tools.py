"""Lumina Agent tool implementations."""

import os
import subprocess
import urllib.request


# 30s timeout to prevent hung processes; truncate output at 1500 chars for context budget
def run_shell(cmd):
    try:
        r = subprocess.run(
            cmd, shell=True, capture_output=True,
            text=True, timeout=30
        )
        output = (r.stdout + r.stderr).strip()
        if not output:
            return "OK (no output)"
        if len(output) > 1500:
            output = output[:1500] + "\n...[truncated]"
        return output
    except subprocess.TimeoutExpired:
        return "ERROR: command timed out after 30s"
    except Exception as e:
        return f"ERROR: {e}"


# Read first 4000 chars; errors="replace" prevents crash on binary data
def read_file(path):
    try:
        with open(path, "r", errors="replace") as f:
            content = f.read(4000)
        if not content.strip():
            return "WARNING: file exists but is empty"
        return content
    except FileNotFoundError:
        return f"ERROR: file not found: {path}"
    except Exception as e:
        return f"ERROR: {e}"


# Auto-create parent directories so the LLM doesn't need to mkdir separately
def write_file(path, content):
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w") as f:
            f.write(content)
        return f"OK: wrote {len(content)} chars to {path}"
    except Exception as e:
        return f"ERROR: {e}"


# Fetch up to 2000 bytes — enough for config files, API responses, not full downloads
def http_get(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return r.read(2000).decode(errors="replace")
    except Exception as e:
        return f"ERROR: {e}"


def report(summary):
    return f"DONE: {summary}"


# Dispatch table: lambdas normalize varying arg key names the LLM might hallucinate
# e.g. "command" vs "cmd", "path" vs "filename" vs "file"
TOOLS = {
    "run_shell": lambda args: run_shell(
        args.get("command", args.get("cmd", str(args)))
    ),
    "read_file": lambda args: read_file(
        args.get("path", args.get("filename", args.get("file", str(args))))
    ),
    "write_file": lambda args: write_file(
        args.get("path", args.get("filename", "")),
        args.get("content", args.get("text", ""))
    ),
    "http_get": lambda args: http_get(args.get("url", str(args))),
    "report": lambda args: report(
        args.get("summary", args.get("result", str(args)))
    ),
}


# Router: looks up tool in TOOLS dict, returns error string on failure (never throws)
def execute_tool(name, args):
    if name not in TOOLS:
        return f"ERROR: unknown tool '{name}'. Valid tools: {', '.join(sorted(TOOLS.keys()))}"
    try:
        return TOOLS[name](args)
    except Exception as e:
        return f"ERROR: tool '{name}' crashed: {e}"
