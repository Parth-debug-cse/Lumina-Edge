#!/usr/bin/env python3
"""
Lumina Screen — standalone resume screening pipeline.
Orchestrates: watch → dedup → parse → embed → match → notify
"""

import glob
import json
import os
import signal
import sys


CONFIG_DIR = os.path.dirname(os.path.abspath(__file__))

# BUG LS-4 FIX: Ensure lumina_screen/ is on sys.path so that bare module
# imports (watcher, dedup, etc.) work regardless of the CWD the caller uses.
if CONFIG_DIR not in sys.path:
    sys.path.insert(0, CONFIG_DIR)


def load_config():
    config_path = os.path.join(CONFIG_DIR, "config.json")
    if not os.path.exists(config_path):
        print(f"[Lumina Screen] ERROR: config.json not found at {config_path}")
        sys.exit(1)
    try:
        with open(config_path, "r") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        # BUG LS-1 FIX: give a clear error on malformed JSON rather than a cryptic traceback
        print(f"[Lumina Screen] ERROR: config.json is not valid JSON: {e}")
        sys.exit(1)


def resolve(path):
    """Resolve relative config paths against the script directory, not CWD."""
    if os.path.isabs(path):
        return path
    return os.path.normpath(os.path.join(CONFIG_DIR, path))


# SECURITY: Path validation to prevent directory traversal and invalid paths.
# Lumina Screen is designed for end-user resume screening, so we restrict
# paths to the user's home directory to prevent scanning arbitrary system paths.
SAFE_BASE = os.path.realpath(os.path.expanduser("~"))


def validate_resume_folder(path: str) -> tuple:
    """Returns (is_valid, error_message). Empty error = valid."""
    if not path or not path.strip():
        return False, "Resume folder path cannot be empty."

    try:
        resolved = os.path.realpath(os.path.abspath(path.strip()))
    except Exception as e:
        return False, f"Invalid path: {e}"

    if not os.path.exists(resolved):
        return False, f"Path does not exist: {resolved}"

    if not os.path.isdir(resolved):
        return False, f"Path is not a directory: {resolved}"

    if not os.access(resolved, os.R_OK):
        return False, f"Path is not readable: {resolved}"

    # Path traversal containment: must be within user's home directory
    if resolved != SAFE_BASE and not resolved.startswith(SAFE_BASE + os.sep):
        return False, "Path must be within your home directory."

    return True, ""


def process_file(filepath, embedder, matcher, page_hit_path,
                 compute_hash, is_processed, mark_processed,
                 parse, notify, log_hit):
    """Parse, embed, match, and log a single resume file. Respects dedup state."""
    filename = os.path.basename(filepath)
    file_hash = compute_hash(filepath)

    if is_processed(file_hash):
        return

    mark_processed(file_hash, filename)

    try:
        parsed = parse(filepath)
    except Exception as e:
        print(f"[Lumina Screen] Parse failed for {filename}: {e}")
        return

    # Guard: Skip resume if no text was extracted (empty PDF, image-only, corrupted, etc.)
    if not parsed["raw_text"].strip():
        print(f"[Lumina Screen] WARNING: {filename} — No text extracted (empty PDF?). Skipping.")
        return

    try:
        embedding = embedder.embed_resume(file_hash, parsed["raw_text"])
        score, shortlisted = matcher.evaluate(embedding)
    except Exception as e:
        print(f"[Lumina Screen] Embed/evaluate failed for {filename}: {e}")
        return

    try:
        # DIAGNOSTIC LOG: Show score, threshold, and pass/fail status for debugging
        threshold = matcher.threshold
        passed = "PASS" if shortlisted else "FAIL"
        print(f"[Lumina Screen] DIAG: {filename} | Score: {score:.4f} | Threshold: {threshold:.4f} | Status: {passed}")

        if shortlisted:
            entry = {
                "name": parsed["name"] or filename,
                "filename": filename,
                "score": score,
                "email": parsed["email"],
                "phone": parsed["phone"],
            }
            notify(entry)
            log_hit(entry, page_hit_path)
            print(f"[Lumina Screen] SHORTLISTED: {entry['name']} ({score:.4f})")
        else:
            print(f"[Lumina Screen] Skipped     : {filename} ({score:.4f})")
    except Exception as e:
        print(f"[Lumina Screen] Notify/log failed for {filename}: {e}")


def main():
    config = load_config()

    # BUG LS-1 FIX: Use .get() with sensible defaults for every config key so
    # that a missing key raises a clear message instead of a bare KeyError crash.
    resume_folder_raw = config.get("resume_folder", "./resumes")
    resume_folder = resolve(resume_folder_raw)

    # SECURITY: Validate resume folder path before any file I/O.
    # Uses the resolved (absolute, canonical) path for all checks.
    valid, err = validate_resume_folder(resume_folder)
    if not valid:
        print(f"[Lumina Screen] ERROR: {err}")
        sys.exit(1)

    # Use the resolved canonical path from validation for all downstream operations
    resume_folder = os.path.realpath(os.path.abspath(resume_folder.strip()))

    poll_interval = config.get("poll_interval_ms", 300)
    threshold = config.get("match_threshold", 0.65)
    chroma_path = resolve(config.get("chroma_store_path", "./chroma_store"))
    jd_path = resolve(config.get("jd_path", "./jd.txt"))
    page_hit_path = resolve(config.get("page_hit_path", "./page_hit.txt"))

    os.makedirs(resume_folder, exist_ok=True)

    if not os.path.exists(jd_path):
        print(f"[Lumina Screen] ERROR: JD file not found at {jd_path}")
        sys.exit(1)

    with open(jd_path, "r") as f:
        jd_text = f.read()

    # Lazy imports so missing dependencies fail fast with a clear traceback
    from watcher import Watcher
    from dedup import compute_hash, is_processed, mark_processed
    from pdf_parser import parse
    from embedder import Embedder
    from matcher import Matcher
    from notifier import notify, log_hit

    embedder = Embedder(chroma_path, jd_text)

    print(f"[Lumina Screen] Resume folder : {resume_folder}")
    print(f"[Lumina Screen] JD loaded      : {jd_path}")
    print(f"[Lumina Screen] Match threshold: {threshold}")
    print(f"[Lumina Screen] Model loaded   : all-MiniLM-L6-v2")
    print(f"[Lumina Screen] ChromaDB path  : {chroma_path}")

    matcher = Matcher(embedder, threshold)

    # STARTUP SCAN: Process any PDFs already present in the folder that have
    # not yet been evaluated (i.e. not in processed.json).  This means files
    # dropped before the pipeline started — or files re-enabled after the user
    # clicks "Re-scan Existing" (which clears processed.json) — are picked up
    # immediately at launch without needing to re-drop them.
    existing_pdfs = sorted(
        f for f in glob.glob(os.path.join(resume_folder, "*.pdf"))
        if os.path.isfile(f)
    )
    if existing_pdfs:
        print(f"[Lumina Screen] Startup scan   : {len(existing_pdfs)} PDF(s) found")
        for filepath in existing_pdfs:
            process_file(
                filepath, embedder, matcher, page_hit_path,
                compute_hash, is_processed, mark_processed,
                parse, notify, log_hit,
            )
    else:
        print(f"[Lumina Screen] Startup scan   : folder empty, waiting for drops")

    print(f"[Lumina Screen] Watching for resumes... (Ctrl+C to stop)")

    watcher = Watcher(resume_folder, poll_interval)

    # BUG LS-D1 FIX: Track JD file modification time so we can detect when
    # the user updates the JD via the API and re-embed without restarting.
    jd_mtime = os.path.getmtime(jd_path)

    # Graceful shutdown on SIGINT (Ctrl+C) or SIGTERM (from API stop)
    def _handle_shutdown(sig, frame):
        print("\n[Lumina Screen] Shutting down...")
        sys.exit(0)

    signal.signal(signal.SIGINT, _handle_shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _handle_shutdown)

    while True:
        # BUG LS-D1 FIX: Check if jd.txt has been modified. If so, reload
        # and re-embed it without restarting the pipeline.
        try:
            current_jd_mtime = os.path.getmtime(jd_path)
            if current_jd_mtime != jd_mtime:
                with open(jd_path, "r") as f:
                    new_jd_text = f.read()
                embedder.reload_jd(new_jd_text)
                jd_mtime = current_jd_mtime
                print(f"[Lumina Screen] JD file updated — embeddings recomputed")
        except Exception as e:
            print(f"[Lumina Screen] Warning: Failed to check/reload JD: {e}")

        new_files = watcher.poll()
        for filepath in new_files:
            process_file(
                filepath, embedder, matcher, page_hit_path,
                compute_hash, is_processed, mark_processed,
                parse, notify, log_hit,
            )


if __name__ == "__main__":
    main()
