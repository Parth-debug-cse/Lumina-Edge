"""Lumina Agent configuration."""

import os
import sys
import requests as _requests


def _detect_model(base: str) -> str:
    """Ask the API gateway which model is currently loaded."""
    try:
        r = _requests.get(f"{base}/models", timeout=3)
        data = r.json()
        # API gateway returns {data: [{id: ...}]} or {models: [...]}
        models = data.get("data") or data.get("models", [])
        if models:
            return models[0].get("id") or models[0].get("name") or "local-model"
    except Exception:
        pass
    # Silent fallback: if API isn't up yet, return placeholder — caller will fail later
    print(
        f"[LuminaAgent] WARNING: Could not detect model from {base}/models. "
        "Is Lumina Edge running and is a model loaded in the Models tab? "
        "Falling back to 'local-model' — LLM calls will fail until a model is loaded.",
        file=sys.stderr,
        flush=True,
    )
    return "local-model"


# Point at the API GATEWAY (port 8090), NOT the raw backend (8091).
# The gateway routes to whatever model is currently loaded via the UI.
# This is the key fix (bug LA-1) — previously pointing at 8091 bypassed model switching.
LUMINA_API_BASE = os.environ.get("LUMINA_API_BASE", "http://localhost:8090/v1")

# Autodetect model name, or fall back to "local-model" if API isn't loaded yet
LUMINA_MODEL = os.environ.get("LUMINA_MODEL") or _detect_model(LUMINA_API_BASE)
# Hard limit on agent loop iterations to prevent runaway calls
MAX_ITERATIONS = int(os.environ.get("LUMINA_MAX_ITERATIONS", "12"))
# Per-LLM-request timeout — needs to be generous for slow edge hardware
REQUEST_TIMEOUT = int(os.environ.get("LUMINA_REQUEST_TIMEOUT", "300"))
