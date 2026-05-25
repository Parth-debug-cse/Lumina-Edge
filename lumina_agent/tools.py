"""Lumina Agent tool implementations."""

import os
import subprocess
import urllib.request
import urllib.parse


# BUG-LA1 FIX: Restrict write_file to these directories to prevent the LLM from
# writing to critical files (SSH keys, shell configs, system files, etc.).
# Resolved at import time so symlinks in the home path are canonicalized once.
_SAFE_WRITE_DIRS = tuple(
    os.path.realpath(d)
    for d in (os.path.expanduser("~/"), "/tmp/")
    if os.path.exists(d)
)


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
    # BUG-LA1 FIX: Prevent the LLM from writing to arbitrary filesystem paths.
    # Without this, a goal like "fix system config" could write to ~/.ssh/authorized_keys,
    # .bashrc, or any other user-accessible sensitive file.
    try:
        abs_path = os.path.realpath(os.path.abspath(path))
        if not any(abs_path.startswith(d) for d in _SAFE_WRITE_DIRS):
            allowed = ", ".join(_SAFE_WRITE_DIRS)
            return (
                f"ERROR: write_file refused — '{abs_path}' is outside allowed directories "
                f"({allowed}). Only paths under your home directory and /tmp are permitted."
            )
        os.makedirs(os.path.dirname(abs_path) or ".", exist_ok=True)
        with open(abs_path, "w") as f:
            f.write(content)
        return f"OK: wrote {len(content)} chars to {abs_path}"
    except Exception as e:
        return f"ERROR: {e}"


# Fetch up to 2000 bytes — enough for config files, API responses, not full downloads
def http_get(url):
    # BUG-LA2 FIX: Reject non-HTTP schemes. urllib.request.urlopen() accepts file://,
    # ftp://, and jar: URLs — a file:// URL reads local files, bypassing read_file's
    # 4 KB limit and leaking arbitrary local data through the agent's tool output.
    try:
        scheme = urllib.parse.urlparse(url).scheme.lower()
    except Exception:
        scheme = ""
    if scheme not in ("http", "https"):
        return f"ERROR: http_get only supports http/https URLs; got scheme '{scheme or '(empty)'}'."
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
