import os
import json
import hashlib


PROCESSED_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "processed.json"
)


def _load():
    if not os.path.exists(PROCESSED_FILE):
        return {}
    with open(PROCESSED_FILE, "r") as f:
        return json.load(f)


def _save(data):
    with open(PROCESSED_FILE, "w") as f:
        json.dump(data, f, indent=2)


def compute_hash(filepath):
    """
    Compute SHA-256 hex digest of a file's contents.
    Reads in 64 KB blocks to handle large files efficiently.
    """
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def is_processed(file_hash):
    """Check if a given hash already exists in processed.json."""
    data = _load()
    return file_hash in data


def mark_processed(file_hash, filename):
    """Persist a hash + filename to processed.json so restarts don't re-process."""
    data = _load()
    data[file_hash] = {"filename": filename}
    _save(data)
