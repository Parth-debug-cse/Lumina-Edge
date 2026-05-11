#!/usr/bin/env python3
"""
Pipeline Test Script
Sends hardcoded sample logs to the orchestrator and validates the response.
"""

import json
import sys

import httpx


ORCHESTRATOR_URL = "http://localhost:8000/v1/chat/completions"
MODEL_NAME = "lumina-pipeline"

SAMPLE_LOGS = """2024-01-15 14:32:01 INFO Starting application server on node-07
2024-01-15 14:32:05 DEBUG GC sweep completed in 23ms
2024-01-15 14:33:12 WARN Failed authentication attempt for user admin@example.com from 192.168.1.45
2024-01-15 14:33:15 ERROR Database connection timeout: mysql://db-prod-01:3306 (retry 3/5)
2024-01-15 14:33:20 INFO Payment gateway response: transaction_id=tx_789456, status=declined
2024-01-15 14:33:45 DEBUG Heartbeat ping to monitoring service
2024-01-15 14:34:01 INFO Request processed: GET /api/v1/users 200 145ms
2024-01-15 14:34:10 WARN Rate limit exceeded for IP 10.0.0.99, endpoint /api/v1/login
2024-01-15 14:34:30 ERROR Critical: Disk space below threshold on /dev/sda1 (5% remaining)
2024-01-15 14:35:00 INFO Scheduled backup started: full_system_weekly"""


def test_pipeline():
    print("=" * 60)
    print("Lumina Pipeline Test")
    print("=" * 60)
    print()

    print(f"Sending request to: {ORCHESTRATOR_URL}")
    print(f"Model: {MODEL_NAME}")
    print(f"Sample logs ({len(SAMPLE_LOGS)} chars):")
    print("-" * 40)
    print(SAMPLE_LOGS)
    print("-" * 40)
    print()

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "user", "content": SAMPLE_LOGS}
        ],
        "temperature": 0.7,
        "max_tokens": 2048
    }

    try:
        response = httpx.post(ORCHESTRATOR_URL, json=payload, timeout=180.0)
    except httpx.ConnectError as e:
        print(f"FAIL: Could not connect to orchestrator at {ORCHESTRATOR_URL}")
        print(f"Error: {e}")
        print()
        print("Make sure the pipeline is running: ./start_pipeline.sh")
        return False
    except httpx.TimeoutException:
        print("FAIL: Request timed out after 180 seconds")
        return False

    print(f"Response status: {response.status_code}")

    if response.status_code != 200:
        print(f"FAIL: Non-200 status code received")
        print(f"Response body: {response.text}")
        return False

    try:
        result = response.json()
    except json.JSONDecodeError as e:
        print(f"FAIL: Response is not valid JSON: {e}")
        print(f"Response text: {response.text}")
        return False

    print(f"Response JSON: {json.dumps(result, indent=2)}")
    print()

    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not content:
        print("FAIL: No content in response")
        return False

    print(f"Content extracted: {content[:500]}...")
    print()

    parsed_categories = []
    for line in content.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            parsed_categories.append(obj)
        except json.JSONDecodeError:
            pass

    if not parsed_categories:
        print("FAIL: No valid JSON objects found in response content")
        return False

    print(f"Parsed {len(parsed_categories)} category objects")
    print()

    required_fields = ["timestamp", "severity", "category", "message"]
    valid = True

    for i, entry in enumerate(parsed_categories):
        missing = [f for f in required_fields if f not in entry]
        if missing:
            print(f"FAIL: Entry {i} missing fields: {missing}")
            valid = False
        else:
            severity = entry.get("severity", "")
            category = entry.get("category", "")
            if severity not in ["INFO", "WARN", "ERROR", "CRITICAL"]:
                print(f"WARN: Entry {i} has invalid severity: {severity}")
            if category not in ["auth", "network", "db", "app", "payment", "system"]:
                print(f"WARN: Entry {i} has invalid category: {category}")

    if valid:
        print("PASS: All entries have required fields (timestamp, severity, category, message)")
    print()

    return valid


if __name__ == "__main__":
    success = test_pipeline()
    sys.exit(0 if success else 1)