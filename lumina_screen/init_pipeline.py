#!/usr/bin/env python3
"""
Lumina Screen Pipeline Initialization
Verifies all dependencies are installed and the pipeline is ready to run.
Run this before starting main.py for the first time.
"""

import subprocess
import sys
import json
import os


def check_pip_package(package_name, import_name=None):
    """Check if a pip package is installed."""
    import_name = import_name or package_name
    try:
        __import__(import_name)
        return True
    except ImportError:
        return False


def install_requirements():
    """Install all dependencies from requirements.txt."""
    req_file = os.path.join(os.path.dirname(__file__), "requirements.txt")
    print(f"[Lumina Screen Init] Installing dependencies from {req_file}...")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", req_file, "-q"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"[Lumina Screen Init] ERROR: pip install failed")
        print(result.stderr)
        return False
    print("[Lumina Screen Init] ✓ Dependencies installed")
    return True


def verify_dependencies():
    """Verify all required packages are available."""
    required = {
        "pdfplumber": "pdfplumber",
        "sentence-transformers": "sentence_transformers",
        "chromadb": "chromadb",
        "numpy": "numpy",
        "torch": "torch",
    }

    missing = []
    for pip_name, import_name in required.items():
        if not check_pip_package(pip_name, import_name):
            missing.append(pip_name)

    if missing:
        print(f"[Lumina Screen Init] Missing dependencies: {', '.join(missing)}")
        return install_requirements()

    print("[Lumina Screen Init] ✓ All dependencies available")
    return True


def verify_config():
    """Verify config.json is valid."""
    config_path = os.path.join(os.path.dirname(__file__), "config.json")
    if not os.path.exists(config_path):
        print(f"[Lumina Screen Init] ERROR: config.json not found at {config_path}")
        return False

    try:
        with open(config_path, "r") as f:
            config = json.load(f)
        print("[Lumina Screen Init] ✓ config.json valid")
        return True
    except json.JSONDecodeError as e:
        print(f"[Lumina Screen Init] ERROR: config.json invalid: {e}")
        return False


def verify_jd():
    """Verify JD file exists and is non-empty."""
    config_path = os.path.join(os.path.dirname(__file__), "config.json")
    with open(config_path, "r") as f:
        config = json.load(f)

    jd_path = config.get("jd_path", "./jd.txt")
    if not os.path.isabs(jd_path):
        jd_path = os.path.join(os.path.dirname(__file__), jd_path)

    if not os.path.exists(jd_path):
        print(f"[Lumina Screen Init] ERROR: JD file not found at {jd_path}")
        return False

    with open(jd_path, "r") as f:
        jd_text = f.read()

    if not jd_text.strip():
        print(f"[Lumina Screen Init] ERROR: JD file is empty at {jd_path}")
        return False

    print(f"[Lumina Screen Init] ✓ JD file valid ({len(jd_text)} chars)")
    return True


def verify_resume_folder():
    """Verify resume folder exists and is readable."""
    config_path = os.path.join(os.path.dirname(__file__), "config.json")
    with open(config_path, "r") as f:
        config = json.load(f)

    resume_folder = config.get("resume_folder", "./resumes")
    if not os.path.isabs(resume_folder):
        resume_folder = os.path.join(os.path.dirname(__file__), resume_folder)

    if not os.path.exists(resume_folder):
        os.makedirs(resume_folder, exist_ok=True)
        print(f"[Lumina Screen Init] ✓ Created resume folder at {resume_folder}")
    else:
        print(f"[Lumina Screen Init] ✓ Resume folder exists at {resume_folder}")

    return True


def main():
    print("[Lumina Screen Init] Starting pipeline initialization...")
    print()

    checks = [
        ("Dependencies", verify_dependencies),
        ("Config", verify_config),
        ("JD file", verify_jd),
        ("Resume folder", verify_resume_folder),
    ]

    failed = []
    for name, check_func in checks:
        try:
            if not check_func():
                failed.append(name)
        except Exception as e:
            print(f"[Lumina Screen Init] ERROR in {name}: {e}")
            failed.append(name)

    print()
    if failed:
        print(f"[Lumina Screen Init] ✗ INITIALIZATION FAILED: {', '.join(failed)}")
        return False

    print("[Lumina Screen Init] ✓ PIPELINE READY")
    print("[Lumina Screen Init]   You can now run: python3 -m lumina_screen.main")
    return True


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
