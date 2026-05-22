#!/usr/bin/env python3
"""Check if Lumina Edge API server is running on the configured port."""

import json
import os
import sys


def check_server():
    """Ping the /health endpoint of a running Lumina API server. Returns True if alive."""
    try:
        config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'config.json')
        config_path = os.path.normpath(config_path)
        with open(config_path) as f:
            config = json.load(f)
    except FileNotFoundError:
        print("ERROR: config.json not found")
        return False
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid config.json: {e}")
        return False

    api_port = config.get('api_port', 8090)

    print(f"Checking API server on port {api_port}...")

    try:
        import requests
        response = requests.get(f"http://127.0.0.1:{api_port}/health", timeout=3)
        if response.status_code == 200:
            print(f"✓ Server is running on port {api_port}")
            data = response.json()
            if 'status' in data:
                print(f"  Status: {data['status']}")
            return True
        else:
            print(f"⚠ Server responded with status {response.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        print(f"✗ Server not responding on port {api_port}")
        print(f"\nTo start the server, run:")
        print(f"  Windows: powershell -ExecutionPolicy Bypass -File core\\launch_api.ps1")
        print(f"  Linux:   ./core/launch_api.sh")
        print(f"  macOS:   ./start_lumina.sh")
        return False
    except requests.exceptions.Timeout:
        print(f"✗ Connection timed out (server may be starting)")
        return False
    except ImportError:
        # Fallback to urllib if requests is not installed
        import urllib.request
        import urllib.error
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{api_port}/health", timeout=3)
            print(f"✓ Server is running on port {api_port}")
            return True
        except urllib.error.URLError:
            print(f"✗ Server not responding on port {api_port}")
            print(f"\nTo start the server, run:")
            print(f"  Windows: powershell -ExecutionPolicy Bypass -File core\\launch_api.ps1")
            print(f"  Linux:   ./core/launch_api.sh")
            print(f"  macOS:   ./start_lumina.sh")
            return False
        except Exception as e:
            print(f"✗ Error: {e}")
            return False


if __name__ == "__main__":
    success = check_server()
    sys.exit(0 if success else 1)
