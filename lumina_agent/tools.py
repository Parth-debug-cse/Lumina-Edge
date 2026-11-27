"""Lumina Agent tool implementations."""

import os
import signal
import subprocess
import threading
import time
import urllib.request
import urllib.parse
import urllib.error
from typing import Callable, TypedDict, cast

from lumina_agent.config import get_tool_timeout


# BUG-LA1 FIX: Restrict write_file to these directories to prevent the LLM from
# writing to critical files (SSH keys, shell configs, system files, etc.).
# Resolved at import time so symlinks in the home path are canonicalized once.
_SAFE_WRITE_DIRS = tuple(
    os.path.realpath(d)
    for d in (os.path.expanduser("~/"), "/tmp/")
    if os.path.exists(d)
)


class ToolMetrics(TypedDict, total=False):
    duration_seconds: float
    error: bool
    timed_out: bool
    cancelled: bool
    budget_exhausted: bool
    status: str


ToolArguments = dict[str, object]

_MAX_TOOL_OUTPUT_CHARS = 1500
_HOME_DIR = os.path.realpath(os.path.expanduser("~"))
_SENSITIVE_HOME_DIRS = (
    (".ssh",),
    (".gnupg",),
    (".aws",),
    (".azure",),
    (".kube",),
    (".docker",),
    (".password-store",),
    (".pki",),
    (".npmrc",),
    (".pypirc",),
    (".git-credentials",),
    (".config", "gcloud"),
    (".config", "gh"),
    (".config", "1Password"),
    (".config", "containers"),
    (".config", "rclone"),
    (".config", "fish"),
    (".local", "share", "keyrings"),
    (".local", "share", "kwalletd"),
    ("Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
    ("Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
)
_SHELL_STARTUP_FILES = frozenset({
    ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile",
    ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout",
    ".cshrc", ".tcshrc", ".kshrc",
})


def _shell_enabled() -> bool:
    return os.environ.get('LUMINA_AGENT_ALLOW_SHELL', '').strip().lower() in {'1', 'true', 'yes'}


def _tool_timeout_seconds() -> float:
    return get_tool_timeout()


def _kill_process_tree(proc: subprocess.Popen[str]) -> None:
    """Terminate the subprocess group, including descendants that outlive its shell."""
    if os.name == 'nt':
        try:
            _ = subprocess.run(
                ['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        except Exception:
            if proc.poll() is None:
                proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
        return

    try:
        _ = os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except Exception:
        if proc.poll() is None:
            proc.terminate()

    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass

    # Kill the group even if its leader exited after SIGTERM; grandchildren may
    # still be alive and holding the captured stdout pipe open.
    try:
        _ = os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except Exception:
        if proc.poll() is None:
            proc.kill()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()


def run_shell(
    cmd: object,
    cancel_event: threading.Event | None = None,
    deadline: float | None = None,
    metrics: ToolMetrics | None = None,
) -> str:
    if not _shell_enabled():
        return "ERROR: run_shell is disabled. Set LUMINA_AGENT_ALLOW_SHELL=1 to explicitly enable host command execution."
    if not isinstance(cmd, str) or not cmd.strip():
        return "ERROR: command must be a non-empty string"
    if cancel_event is not None and cancel_event.is_set():
        if metrics is not None:
            metrics["cancelled"] = True
        return "ERROR: command cancelled by user"

    configured_timeout = _tool_timeout_seconds()
    timeout = configured_timeout
    budget_limited = False
    if deadline is not None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            if metrics is not None:
                metrics["budget_exhausted"] = True
            return "ERROR: cumulative tool wall-clock budget exhausted"
        timeout = min(timeout, remaining)
        budget_limited = remaining < configured_timeout

    try:
        started = time.monotonic()
        proc: subprocess.Popen[str]
        if os.name == 'nt':
            proc = subprocess.Popen(
                cmd,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='replace',
                bufsize=1,
                creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0),
            )
        else:
            proc = subprocess.Popen(
                cmd,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='replace',
                bufsize=1,
                start_new_session=True,
            )
        output_stream = proc.stdout
        if output_stream is None:
            _kill_process_tree(proc)
            return "ERROR: could not capture command output"
        output_chunks: list[str] = []
        output_size = 0
        truncated = False

        def collect_output():
            nonlocal output_size, truncated
            while True:
                chunk = output_stream.read(4096)
                if not chunk:
                    break
                remaining_chars = _MAX_TOOL_OUTPUT_CHARS - output_size
                if remaining_chars > 0:
                    kept = chunk[:remaining_chars]
                    output_chunks.append(kept)
                    output_size += len(kept)
                if len(chunk) > max(remaining_chars, 0):
                    truncated = True

        reader = threading.Thread(target=collect_output, daemon=True)
        reader.start()
        termination_reason: str | None = None
        while proc.poll() is None:
            if cancel_event is not None and cancel_event.is_set():
                termination_reason = "cancelled"
                break
            remaining_time = timeout - (time.monotonic() - started)
            if remaining_time <= 0:
                termination_reason = "timeout"
                break
            try:
                proc.wait(timeout=min(0.05, remaining_time))
            except subprocess.TimeoutExpired:
                pass

        if termination_reason:
            _kill_process_tree(proc)
            reader.join(timeout=3)
            output_stream.close()
            if reader.is_alive():
                reader.join(timeout=1)
            if termination_reason == "cancelled":
                if metrics is not None:
                    metrics["cancelled"] = True
                return "ERROR: command cancelled by user"
            if metrics is not None:
                metrics["timed_out"] = True
                metrics["budget_exhausted"] = budget_limited
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
def read_file(path: str) -> str:
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


def _is_sensitive_home_path(abs_path: str) -> bool:
    """Return true for credential stores and shell startup files under the home directory."""
    try:
        if os.path.commonpath((abs_path, _HOME_DIR)) != _HOME_DIR:
            return False
    except ValueError:
        return False

    relative_parts = tuple(os.path.relpath(abs_path, _HOME_DIR).split(os.sep))
    if relative_parts == (".",):
        return False
    if relative_parts[0] in _SHELL_STARTUP_FILES or relative_parts[0] == ".netrc":
        return True

    return any(relative_parts[:len(sensitive_dir)] == sensitive_dir
               for sensitive_dir in _SENSITIVE_HOME_DIRS)


# Auto-create parent directories so the LLM doesn't need to mkdir separately
def _is_safe_write_path(abs_path: str) -> bool:
    abs_path = os.path.realpath(os.path.abspath(abs_path))
    if _is_sensitive_home_path(abs_path):
        return False
    for directory in _SAFE_WRITE_DIRS:
        try:
            if os.path.commonpath((abs_path, directory)) == directory:
                return True
        except ValueError:
            continue
    return False


def write_file(path: str, content: str) -> str:
    # Keep ordinary home/workspace and /tmp writes available, but never modify
    # credential stores or shell startup configuration from an agent tool call.
    try:
        abs_path = os.path.realpath(os.path.abspath(path))
        if _is_sensitive_home_path(abs_path):
            return f"ERROR: write_file refused — '{abs_path}' is a protected sensitive home path."
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
def http_get(
    url: str,
    deadline: float | None = None,
    metrics: ToolMetrics | None = None,
) -> str:
    # BUG-LA2 FIX: Reject non-HTTP schemes. urllib.request.urlopen() accepts file://,
    # ftp://, and jar: URLs — a file:// URL reads local files, bypassing read_file's
    # 4 KB limit and leaking arbitrary local data through the agent's tool output.
    try:
        scheme = urllib.parse.urlparse(url).scheme.lower()
    except Exception:
        scheme = ""
    if scheme not in ("http", "https"):
        return f"ERROR: http_get only supports http/https URLs; got scheme '{scheme or '(empty)'}'."
    timeout = 10.0
    budget_limited = False
    if deadline is not None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            if metrics is not None:
                metrics["budget_exhausted"] = True
            return "ERROR: cumulative tool wall-clock budget exhausted"
        timeout = min(timeout, remaining)
        budget_limited = remaining < 10.0
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.read(2000).decode(errors="replace")
    except Exception as e:
        timed_out = isinstance(e, TimeoutError) or (
            isinstance(e, urllib.error.URLError) and isinstance(e.reason, TimeoutError)
        )
        if budget_limited and timed_out and metrics is not None:
            metrics["budget_exhausted"] = True
        return f"ERROR: {e}"


def report(summary: object) -> str:
    return f"DONE: {summary}"


# Dispatch table: lambdas normalize varying arg key names the LLM might hallucinate
# e.g. "command" vs "cmd", "path" vs "filename" vs "file"
TOOLS: dict[str, Callable[[ToolArguments], str]] = {
    "run_shell": lambda args: run_shell(
        cast(str, args.get("command", args.get("cmd", str(args))))
    ),
    "read_file": lambda args: read_file(
        cast(str, args.get("path", args.get("filename", args.get("file", str(args)))))
    ),
    "write_file": lambda args: write_file(
        cast(str, args.get("path", args.get("filename", ""))),
        cast(str, args.get("content", args.get("text", "")))
    ),
    "http_get": lambda args: http_get(cast(str, args.get("url", str(args)))),
    "report": lambda args: report(
        args.get("summary", args.get("result", str(args)))
    ),
}


# Router: looks up tool in TOOLS dict, returns error string on failure (never throws).
# Optional context/metrics preserve the string-returning API for existing callers.
def execute_tool(
    name: str,
    args: ToolArguments,
    *,
    cancel_event: threading.Event | None = None,
    deadline: float | None = None,
    metrics: ToolMetrics | None = None,
) -> str:
    call_metrics: ToolMetrics = metrics if metrics is not None else {}
    call_metrics.update({
        "duration_seconds": 0.0,
        "error": False,
        "timed_out": False,
        "cancelled": False,
        "budget_exhausted": False,
    })
    started = time.monotonic()
    try:
        if name not in TOOLS:
            result = f"ERROR: unknown tool '{name}'. Valid tools: {', '.join(sorted(TOOLS.keys()))}"
        elif name == "run_shell":
            command = cast(str, args.get("command", args.get("cmd", str(args))))
            result = run_shell(
                command,
                cancel_event=cancel_event,
                deadline=deadline,
                metrics=call_metrics,
            )
        elif name == "http_get":
            result = http_get(
                cast(str, args.get("url", str(args))),
                deadline=deadline,
                metrics=call_metrics,
            )
        else:
            result = TOOLS[name](args)
    except Exception as e:
        result = f"ERROR: tool '{name}' crashed: {e}"

    call_metrics["duration_seconds"] = round(time.monotonic() - started, 6)
    call_metrics["error"] = result.startswith("ERROR:")
    if call_metrics.get("cancelled", False):
        call_metrics["status"] = "cancelled"
    elif call_metrics.get("timed_out", False):
        call_metrics["status"] = "timeout"
    elif call_metrics.get("budget_exhausted", False):
        call_metrics["status"] = "budget_exhausted"
    elif call_metrics["error"]:
        call_metrics["status"] = "error"
    else:
        call_metrics["status"] = "ok"
    return result
