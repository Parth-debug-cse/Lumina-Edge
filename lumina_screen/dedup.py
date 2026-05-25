import os
import json
import hashlib
import tempfile


PROCESSED_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "processed.json"
)


def _load():
    """Load processed dict from disk. Returns empty dict if no state file yet."""
    if not os.path.exists(PROCESSED_FILE):
        return {}
    # BUG-LS3 FIX: Corrupt processed.json (e.g. from a power-loss mid-write) previously
    # propagated a JSONDecodeError that crashed the polling loop permanently.
    # Now we detect corruption, warn, reset to empty, and continue gracefully.
    try:
        with open(PROCESSED_FILE, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(
            f"[Lumina Screen] WARNING: {PROCESSED_FILE} is corrupt ({e}). "
            "Resetting to empty — all resumes will be re-evaluated on next scan."
        )
        _save({})
        return {}


def _save(data):
    """Persist processed dict to disk atomically (write-then-rename).

    BUG-LS6 FIX: The previous implementation wrote directly to processed.json.
    A concurrent UI rescan (which deletes the file) could race with a Python write,
    restoring stale data over the deleted file.  Using a temp-file + os.replace()
    makes the write atomic on POSIX (best-effort on Windows) and eliminates the race.
    """
    dir_ = os.path.dirname(PROCESSED_FILE) or "."
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", dir=dir_, suffix=".tmp", delete=False
        ) as tf:
            json.dump(data, tf, indent=2)
            tmp_path = tf.name
        os.replace(tmp_path, PROCESSED_FILE)  # atomic on POSIX
    except Exception as e:
        print(f"[Lumina Screen] ERROR: Failed to save {PROCESSED_FILE}: {e}")
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
        raise


def processed_count() -> int:
    """Return the number of hashes in processed.json (for startup diagnostics).

    BUG-LS1 FIX: Exposes the dedup state size so main.py can log it at startup,
    giving operators a signal when all resumes are already processed.
    """
    return len(_load())


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


def reset_processed():
    """
    DEV/TEST HELPER: Reset processed.json to empty dict without deleting the file.
    Allows re-processing of all existing resumes for testing without restarting backend.
    """
    _save({})
    print(f"[Lumina Screen] Reset processed.json — all resumes marked as unprocessed")
