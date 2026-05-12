#!/usr/bin/env python3
"""Complete pre-query validation for Lumina Edge"""

import json
import os
import sys
from pathlib import Path

def validate_all():
    errors = []
    warnings = []
    
    print("=" * 60)
    print("LUMINA EDGE STARTUP VALIDATION")
    print("=" * 60)
    
    # 1. Config exists
    if not Path('config.json').exists():
        errors.append("config.json not found")
    else:
        try:
            config = json.load(open('config.json'))
            print("✓ config.json found and valid")
            
            # 2. Model exists
            model_name = config.get('model', '')
            if not model_name:
                errors.append("'model' field is empty in config.json")
            else:
                model_path = Path('models') / model_name
                if model_path.exists():
                    size_gb = model_path.stat().st_size / (1024**3)
                    print(f"✓ Model exists: {model_path.name} ({size_gb:.2f} GB)")
                else:
                    errors.append(f"Model not found: {model_path}")
                    print(f"  ℹ Download models from: https://huggingface.co/TheBloke")
            
            # 3. API port
            api_port = config.get('api_port', 8090)
            print(f"✓ API port configured: {api_port}")
            
            # 4. llama-server binary
            if os.name == 'nt':  # Windows
                binary = Path('bin/llama-server.exe')
                alt_binary = Path('llama-server.exe')
            else:
                binary = Path('bin/llama-server')
                alt_binary = Path('llama-server')
            
            if binary.exists():
                print(f"✓ llama-server binary found: {binary}")
            elif alt_binary.exists():
                print(f"✓ llama-server binary found: {alt_binary}")
            else:
                errors.append(f"llama-server not found at {binary}")
            
            # 5. Check server is running
            print("\nChecking API server...")
            try:
                import requests
                try:
                    response = requests.get(f"http://127.0.0.1:{api_port}/health", timeout=2)
                    if response.status_code == 200:
                        print(f"✓ API server running on port {api_port}")
                    else:
                        warnings.append(f"API server returned status {response.status_code}")
                except requests.exceptions.ConnectionError:
                    warnings.append(f"API server not running on port {api_port}")
                    print(f"  ⚠ Server not running. Start with:")
                    print(f"    powershell -ExecutionPolicy Bypass -File core\\launch_api.ps1")
            except ImportError:
                warnings.append("'requests' module not installed - cannot check server status")
            
            # 6. Dependencies check
            print("\nChecking Python dependencies...")
            deps_to_check = [
                ('requests', 'requests'),
            ]
            
            missing_deps = []
            for module, package in deps_to_check:
                try:
                    __import__(module)
                except ImportError:
                    missing_deps.append(package)
            
            if missing_deps:
                warnings.append(f"Missing Python packages: {', '.join(missing_deps)}")
                print(f"  ⚠ Missing: {', '.join(missing_deps)}")
                print(f"    Install: pip install {' '.join(missing_deps)}")
            else:
                print(f"✓ All required dependencies installed")
            
        except json.JSONDecodeError as e:
            errors.append(f"Invalid config.json: {e}")
    
    print("\n" + "=" * 60)
    
    if errors:
        print("ERRORS (must fix before running):")
        for e in errors:
            print(f"  ✗ {e}")
    
    if warnings:
        print("WARNINGS (may affect functionality):")
        for w in warnings:
            print(f"  ⚠ {w}")
    
    if not errors and not warnings:
        print("🎉 ALL CHECKS PASSED - Ready to query!")
    elif not errors:
        print("\n✓ Core requirements met (warnings are non-critical)")
    
    print("=" * 60)
    
    return len(errors) == 0

if __name__ == "__main__":
    success = validate_all()
    sys.exit(0 if success else 1)
