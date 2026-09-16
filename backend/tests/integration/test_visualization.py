import pytest

@pytest.mark.asyncio
async def test_visualization_snapshot(client):
    headers = {"X-API-Key": "CRIMSON_NEBULA_2026"}
    telemetry_payload = {
        "timestamp": "2026-01-01T00:00:00.000Z",
        "objects": [
            {
                "id": "SAT-001",
                "type": "SATELLITE",
                "r": {"x": 7000.0, "y": 0.0, "z": 0.0},
                "v": {"x": 0.0, "y": 7.5, "z": 0.0}
            }
        ]
    }
    await client.post("/api/telemetry", json=telemetry_payload, headers=headers)
    
    response = await client.get("/api/visualization/snapshot", headers=headers)
    assert response.status_code == 200
    data = response.json()
    assert "timestamp" in data
    assert "satellites" in data
