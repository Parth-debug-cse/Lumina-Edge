"""
lumina_scout/fetcher.py
Fetches text-generation models from HuggingFace Hub API.
Caches results to SCOUT_ROOT/cache/ with a 6-hour TTL.
Uses raw httpx calls only.
"""

import os
import json
import time
import logging
import httpx
from dataclasses import dataclass, field

logger = logging.getLogger("lumina_scout.fetcher")

SCOUT_ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(SCOUT_ROOT, "cache")
CACHE_TTL_S = 6 * 3600  # 6-hour cache window before re-fetch

os.makedirs(CACHE_DIR, exist_ok=True)

HF_API_URL = "https://huggingface.co/api/models"


@dataclass
class ModelInfo:
    """Metadata for a single model from HuggingFace, plus computed fields populated by ranker."""
    model_id: str
    downloads: int
    likes: int
    last_modified: str
    tags: list = field(default_factory=list)
    pipeline_tag: str = ""

    # Populated later by ranker.py — not from the API.
    score: float = 0.0
    quant: str = ""
    vram_required_gb: float = 0.0
    speed_tps: float = 0.0
    fit_type: str = ""


def fetch(profile: str = "general", refresh: bool = False) -> list:
    """Fetch models for a profile. Returns cached data if fresh enough, else hits HF API.

    Stale-cache fallback: if the API call fails and a cache file exists, serve it anyway.
    Better than returning an empty list.
    """
    cache_path = os.path.join(CACHE_DIR, f"models_{profile}.json")

    # Return cached data if within TTL and not forcing a refresh.
    if not refresh and os.path.exists(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if time.time() - data.get("timestamp", 0) < CACHE_TTL_S:
                return [ModelInfo(**m) for m in data["models"]]
        except Exception as e:
            logger.warning("Failed to read cache for profile '%s': %s", profile, e)

    # Fetch from HF, then persist to cache.
    try:
        models = _fetch_from_hf(profile)
        try:
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump({
                    "timestamp": time.time(),
                    "models": [m.__dict__ for m in models],
                }, f)
        except Exception as e:
            logger.warning("Failed to write cache for profile '%s': %s", profile, e)
        return models
    except Exception as e:
        logger.error("HuggingFace fetch failed for profile '%s': %s", profile, e)
        # Stale-cache fallback — use whatever we have rather than returning nothing.
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            logger.info("Falling back to stale cache for profile '%s'", profile)
            return [ModelInfo(**m) for m in data["models"]]
        except Exception:
            logger.error("No cache available for profile '%s' — returning empty list", profile)
            return []


def _fetch_from_hf(profile: str) -> list:
    """Hit the HF API with per-profile queries, deduplicate by model_id."""
    base = {"sort": "downloads", "direction": -1, "limit": 100}
    queries = _profile_to_queries(profile, base)
    seen = set()       # deduplicate across multiple search queries
    results = []

    with httpx.Client(timeout=15.0) as client:
        for params in queries:
            try:
                resp = client.get(HF_API_URL, params=params)
                resp.raise_for_status()
                items = resp.json()
                if not isinstance(items, list):
                    continue
                for item in items:
                    mid = item.get("modelId", "")
                    if not mid or mid in seen:
                        continue
                    seen.add(mid)
                    results.append(ModelInfo(
                        model_id=mid,
                        downloads=item.get("downloads", 0) or 0,
                        likes=item.get("likes", 0) or 0,
                        last_modified=item.get("lastModified", "") or "",
                        tags=item.get("tags", []) or [],
                        pipeline_tag=item.get("pipeline_tag", "") or "",
                    ))
            except Exception as e:
                logger.warning("HuggingFace API request failed for profile '%s': %s", profile, e)
                continue

    return results


def _profile_to_queries(profile: str, base: dict) -> list:
    """Map friendly profile names to HF API search params."""
    if profile == "coding":
        return [
            {**base, "filter": "text-generation", "search": "code"},
            {**base, "filter": "text-generation", "search": "coder"},
        ]
    if profile == "vision":
        return [
            {**base, "filter": "image-text-to-image"},
        ]
    if profile == "math":
        return [
            {**base, "filter": "text-generation", "search": "math"},
        ]
    # default "general" — broad text-gen plus GGUF models
    return [
        {**base, "filter": "text-generation"},
        {**base, "filter": "text-generation", "search": "gguf"},
    ]
    if profile == "vision":
        return [
            {**base, "filter": "image-text-to-text"},
        ]
    if profile == "math":
        return [
            {**base, "filter": "text-generation", "search": "math"},
        ]
    return [
        {**base, "filter": "text-generation"},
        {**base, "filter": "text-generation", "search": "gguf"},
    ]
