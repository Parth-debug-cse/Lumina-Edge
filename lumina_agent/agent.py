"""Lumina Agent core loop."""

import json
import re
import threading
import requests
from lumina_agent.tools import execute_tool
from lumina_agent.prompts import SYSTEM_PROMPT
from lumina_agent.config import LUMINA_API_BASE, LUMINA_MODEL, MAX_ITERATIONS, REQUEST_TIMEOUT

VALID_TOOLS = {"run_shell", "read_file", "write_file", "http_get", "report"}
# Map of run_id -> threading.Event for stopping agents in parallel
_stop_flags: dict[str, threading.Event] = {}


# Calls the API with temperature=0 (deterministic) and 1024 max_tokens; non-streaming
def call_llm(messages: list) -> str:
    url = f"{LUMINA_API_BASE}/chat/completions"
    payload = {
        "model": LUMINA_MODEL,
        "messages": messages,
        "temperature": 0,
        "max_tokens": 1024,  # bumped for 3B model
        "stream": False,
    }
    try:
        response = requests.post(url, json=payload, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"]
    except requests.exceptions.Timeout:
        raise RuntimeError("LLM call timed out")
    except requests.exceptions.ConnectionError:
        raise RuntimeError("Cannot connect to Lumina Edge API. Is the server running?")
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"Unexpected API response: {str(e)}")


def parse_tool_call(raw: str) -> dict:
    if not raw or not raw.strip():
        raise ValueError("Empty response from model")

    cleaned = raw.strip()

    # Strip ALL variants of markdown code fences, including ```json = and ```json=
    cleaned = re.sub(r'```[a-zA-Z]*\s*=?\s*', '', cleaned)
    cleaned = re.sub(r'```', '', cleaned).strip()

    # Strip any leading garbage before the first { (e.g. "= {", "Output: {", "json {")
    first_brace = cleaned.find('{')
    if first_brace == -1:
        raise ValueError(f"No JSON object found in response | Raw: {raw[:200]}")
    if first_brace > 0:
        cleaned = cleaned[first_brace:]

    # Brace-matching to extract exactly the outermost JSON object.
    # Handles nested objects correctly and ignores trailing text after the closing brace.
    depth = 0
    start = None
    end = None
    for i, ch in enumerate(cleaned):
        if ch == '{':
            if start is None:
                start = i
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0 and start is not None:
                end = i + 1
                break

    if start is None or end is None:
        raise ValueError(f"No complete JSON object found | Raw: {raw[:200]}")
    cleaned = cleaned[start:end]

    # LLMs often add trailing commas before } or ] — strip them so json.loads doesn't choke
    cleaned = re.sub(r',\s*([}\]])', r'\1', cleaned)

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON: {str(e)} | Raw: {raw[:200]}")

    if "tool" not in parsed:
        raise ValueError(f"Missing 'tool' field | Parsed: {parsed}")

    if "args" not in parsed:
        parsed["args"] = {}

    # Remap 13+ hallucinated/legacy tool names to valid ones (e.g. netstat->run_shell, done->report)
    tool_remaps = {
        "netstat":       ("run_shell",  {"command": "ss -tlnp"}),
        "port_status":   ("run_shell",  {"command": "ss -tlnp"}),
        "shell":         ("run_shell",  parsed.get("args", {})),
        "bash":          ("run_shell",  parsed.get("args", {})),
        "exec":          ("run_shell",  parsed.get("args", {})),
        "command":       ("run_shell",  parsed.get("args", {})),
        "get_url":       ("http_get",   parsed.get("args", {})),
        "fetch":         ("http_get",   parsed.get("args", {})),
        "get":           ("http_get",   parsed.get("args", {})),
        "write":         ("write_file", parsed.get("args", {})),
        "read":          ("read_file",  parsed.get("args", {})),
        "done":          ("report",     parsed.get("args", {})),
        "finish":        ("report",     parsed.get("args", {})),
        "final_report":  ("report",     parsed.get("args", {})),
        "complete":      ("report",     parsed.get("args", {})),
    }
    if parsed["tool"] in tool_remaps:
        new_tool, new_args = tool_remaps[parsed["tool"]]
        parsed["tool"] = new_tool
        parsed["args"] = new_args

    return parsed


def _build_messages(goal: str, steps: list, extra_hint: str = "") -> list:
    """Build the message list for the LLM with structured step history."""
    history_text = "\n".join(steps) if steps else "(none yet — this is your first step)"

    user_content = (
        f"Goal: {goal}\n\n"
        f"Steps so far:\n{history_text}\n\n"
    )

    if extra_hint:
        user_content += f"IMPORTANT: {extra_hint}\n\n"

    user_content += "Next JSON tool call:"

    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]


# Main agent loop: tracks parse_failures (max 3), invalid_tool_strikes (max 3), duplicate_count (max 3)
def run_agent(goal: str, run_id: str, on_update=None) -> str:
    stop_event = threading.Event()
    _stop_flags[run_id] = stop_event
    steps = []
    parse_failures = 0      # consecutive JSON parse errors
    invalid_tool_strikes = 0  # consecutive unknown tool calls
    last_call = None
    duplicate_count = 0     # consecutive identical tool calls

    try:
        for iteration in range(1, MAX_ITERATIONS + 1):
            if stop_event.is_set():
                return "AGENT STOPPED: Interrupted by user."

            messages = _build_messages(goal, steps)

            try:
                raw = call_llm(messages)
            except RuntimeError as e:
                return f"AGENT ERROR: {str(e)}"

            # Parse the model output
            try:
                tool_call = parse_tool_call(raw)
                parse_failures = 0
            except ValueError as e:
                parse_failures += 1
                steps.append(f"Step {iteration}: PARSE_ERROR -> {str(e)}")
                if on_update:
                    on_update({
                        "iteration": iteration,
                        "thought": "",
                        "tool": "PARSE_ERROR",
                        "args": {},
                        "result": str(e),
                        "done": False,
                    })
                if parse_failures >= 3:
                    return f"AGENT ERROR: Model failed to produce valid JSON 3 times in a row. Last error: {str(e)}"
                continue

            tool_name = tool_call["tool"]
            tool_args = tool_call["args"]
            thought = tool_call.get("thought", "")

            # Validate tool name
            if tool_name not in VALID_TOOLS:
                invalid_tool_strikes += 1
                steps.append(
                    f"Step {iteration}: INVALID_TOOL '{tool_name}' — "
                    f"valid tools are: {', '.join(sorted(VALID_TOOLS))}"
                )
                if on_update:
                    on_update({
                        "iteration": iteration,
                        "thought": thought,
                        "tool": tool_name,
                        "args": tool_args,
                        "result": f"Invalid tool: {tool_name}",
                        "done": False,
                    })
                if invalid_tool_strikes >= 3:
                    return f"AGENT ERROR: Model called invalid tools 3 times. Last: {tool_name}"
                continue

            invalid_tool_strikes = 0

            # Duplicate detection: if the LLM calls the same tool+args, re-prompt with a hint
            this_call = (tool_name, json.dumps(tool_args, sort_keys=True))
            if this_call == last_call:
                duplicate_count += 1
                if duplicate_count >= 3:
                    return "AGENT ERROR: Model stuck repeating the same call 3 times."
                hint = (
                    f"You already called {tool_name}({json.dumps(tool_args)}) and got a result. "
                    "Do NOT repeat it. Use what you learned and call a different tool to make progress."
                )
                steps.append(f"Step {iteration}: DUPLICATE_SKIPPED — same as previous step")
                messages = _build_messages(goal, steps, hint)
                try:
                    raw = call_llm(messages)
                    tool_call = parse_tool_call(raw)
                    tool_name = tool_call["tool"]
                    tool_args = tool_call["args"]
                    thought = tool_call.get("thought", "")
                    this_call = (tool_name, json.dumps(tool_args, sort_keys=True))
                except (RuntimeError, ValueError):
                    continue

            last_call = this_call
            duplicate_count = 0

            # Execute the tool
            tool_result = execute_tool(tool_name, tool_args)

            # Truncate results to 800 chars per step to keep context small for edge LLMs
            display_result = tool_result
            if len(display_result) > 800:
                display_result = display_result[:800] + "\n...[truncated]"

            steps.append(f"Step {iteration}: {tool_name}({json.dumps(tool_args)}) => {display_result}")

            if on_update:
                on_update({
                    "iteration": iteration,
                    "thought": thought,
                    "tool": tool_name,
                    "args": tool_args,
                    "result": tool_result,
                    "done": tool_name == "report",
                })

            if tool_name == "report":
                return tool_result

        return f"AGENT STOPPED: Reached {MAX_ITERATIONS} iterations without completing. Last tool: {last_call}"

    finally:
        _stop_flags.pop(run_id, None)


# Signal a running agent to stop — checked each iteration via stop_event.is_set()
def stop_agent(run_id: str):
    if run_id in _stop_flags:
        _stop_flags[run_id].set()
