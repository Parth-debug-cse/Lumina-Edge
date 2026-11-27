"""Lumina Agent tool implementations."""

import math
import os
import signal
import subprocess
import threading
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


_MAX_TOOL_OUTPUT_CHARS = 1500


def _shell_enabled():
    return os.environ.get('LUMINA_AGENT_ALLOW_SHELL', '').strip().lower() in {'1', 'true', 'yes'}


def _tool_timeout_seconds():
    try:
        timeout = float(os.environ.get('LUMINA_TOOL_TIMEOUT', '30'))
        if not math.isfinite(timeout):
            raise ValueError('timeout must be finite')
        return min(300.0, max(1.0, timeout))
    except (TypeError, ValueError):
        return 30.0


def _kill_process_tree(proc):
    if os.name == 'nt':
        try:
            subprocess.run(
                ['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
            return
        except Exception:
            proc.kill()
            return

    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except Exception:
        proc.kill()
        return

    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except Exception:
        proc.kill()


def run_shell(cmd):
    if not _shell_enabled():
        return "ERROR: run_shell is disabled. Set LUMINA_AGENT_ALLOW_SHELL=1 to explicitly enable host command execution."
    if not isinstance(cmd, str) or not cmd.strip():
        return "ERROR: command must be a non-empty string"

    timeout = _tool_timeout_seconds()
    options = {
        'shell': True,
        'stdout': subprocess.PIPE,
        'stderr': subprocess.STDOUT,
        'text': True,
        'encoding': 'utf-8',
        'errors': 'replace',
        'bufsize': 1,
    }
    if os.name == 'nt':
        options['creationflags'] = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
    else:
        options['start_new_session'] = True

    try:
        proc = subprocess.Popen(cmd, **options)
        output_stream = proc.stdout
        if output_stream is None:
            _kill_process_tree(proc)
            return "ERROR: could not capture command output"
        output_chunks = []
        output_size = 0
        truncated = False

        def collect_output():
            nonlocal output_size, truncated
            while True:
                chunk = output_stream.read(4096)
                if not chunk:
                    break
                remaining = _MAX_TOOL_OUTPUT_CHARS - output_size
                if remaining > 0:
                    kept = chunk[:remaining]
                    output_chunks.append(kept)
                    output_size += len(kept)
                if len(chunk) > max(remaining, 0):
                    truncated = True

        reader = threading.Thread(target=collect_output, daemon=True)
        reader.start()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_process_tree(proc)
            proc.wait()
            reader.join(timeout=3)
            output_stream.close()
            if reader.is_alive():
                reader.join(timeout=1)
            return f"ERROR: command timed out after {timeout:g}s"

        reader.join(timeout=1)
        if reader.is_alive():
            _kill_process_tree(proc)
            reader.join(timeout=3)
        output_stream.close()
        if reader.is_alive():
            reader.join(timeout=1)

        output = ''.join(output_chunks).strip()
        if truncated:
            output += "\n...[truncated]"
        return output or "OK (no output)"
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
def _is_safe_write_path(abs_path):
    for directory in _SAFE_WRITE_DIRS:
        try:
            if os.path.commonpath((abs_path, directory)) == directory:
                return True
        except ValueError:
            continue
    return False


def write_file(path, content):
    # BUG-LA1 FIX: Prevent the LLM from writing to arbitrary filesystem paths.
    # Without this, a goal like "fix system config" could write to ~/.ssh/authorized_keys,
    # .bashrc, or any other user-accessible sensitive file.
    try:
        abs_path = os.path.realpath(os.path.abspath(path))
        if not _is_safe_write_path(abs_path):
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
