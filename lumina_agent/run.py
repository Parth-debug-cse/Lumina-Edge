#!/usr/bin/env python3
"""
Lumina Agent runner — execute an agent goal from command line or direct call.
Used for testing and by the API server.
"""

import sys
import os
import json
import uuid

# Always ensure the root directory is on the path, regardless of arguments
root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

from lumina_agent.agent import run_agent, stop_agent
from lumina_agent.config import LUMINA_API_BASE


def check_lumina_running():
    import requests
    try:
        r = requests.get(f"{LUMINA_API_BASE.replace('/v1','')}/health", timeout=3)
        return True
    except Exception:
        try:
            r = requests.get(f"{LUMINA_API_BASE}/models", timeout=3)
            return True
        except Exception:
            return False


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Goal required as first argument"}), file=sys.stderr)
        sys.exit(1)

    if not check_lumina_running():
        print(f"ERROR: Lumina Edge is not running at {LUMINA_API_BASE}", file=sys.stderr)
        print("Start it first with mac.sh (or the appropriate startup script)", file=sys.stderr)
        sys.exit(1)

    goal = sys.argv[1]
    run_id = "cli-" + uuid.uuid4().hex[:8]

    def on_update(step):
        print(json.dumps(step), flush=True)

    result = run_agent(goal, run_id=run_id, on_update=on_update)
    print(json.dumps({"final": result}), flush=True)
