"""
test_api.py — Quick integration test using requests
Run: python test_api.py  (while uvicorn is running on port 8000)
"""

import json
import urllib.request

BASE = "http://127.0.0.1:8000"


def post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


# ── Test 1: Telemetry Ingestion ───────────────────────────────────────────────
print("\n=== POST /api/telemetry ===")
telemetry_payload = {
    "timestamp": "2026-03-12T08:00:00.000Z",
    "objects": [
        {
            "id": "SAT-Alpha-04",
            "type": "SATELLITE",
            "r": {"x": 6578.0, "y": 0.0, "z": 0.0},
            "v": {"x": 0.0,    "y": 7.784, "z": 0.0},
        },
        {
            "id": "DEB-99421",
            "type": "DEBRIS",
            "r": {"x": 6579.0, "y": 0.5, "z": 0.1},
            "v": {"x": 0.001,  "y": 7.780, "z": 0.002},
        },
        {
            "id": "DEB-00112",
            "type": "DEBRIS",
            "r": {"x": 7000.0, "y": 1000.0, "z": 300.0},
            "v": {"x": -1.25,  "y": 6.84, "z": 3.12},
        },
    ],
}
result = post("/api/telemetry", telemetry_payload)
print(json.dumps(result, indent=2))

# ── Test 2: Simulation Tick ───────────────────────────────────────────────────
print("\n=== POST /api/simulation/tick ===")
tick_payload = {"tick_duration_s": 60}
result = post("/api/simulation/tick", tick_payload)
print(json.dumps(result, indent=2))

# ── Test 3: Another tick to see state advancing ───────────────────────────────
print("\n=== POST /api/simulation/tick (second tick) ===")
result = post("/api/simulation/tick", {"tick_duration_s": 300})
print(json.dumps(result, indent=2))