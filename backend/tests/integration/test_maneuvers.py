import pytest

@pytest.mark.asyncio
async def test_schedule_maneuver(client):
    headers = {"X-API-Key": "CRIMSON_NEBULA_2026"}
    telemetry_payload = {
        "timestamp": "2026-01-01T00:00:00.000Z",
        "objects": [
            {
                "id": "SAT-001",
                "type": "SATELLITE",
                "r": {"x": 0.0, "y": 0.0, "z": 7000.0}, # Over North Pole
                "v": {"x": 7.5, "y": 0.0, "z": 0.0}
            }
        ]
    }
    await client.post("/api/telemetry", json=telemetry_payload, headers=headers)
    
    burn_time = "2026-01-01T00:00:10.000Z"
    payload = {
        "satelliteId": "SAT-001",
        "maneuver_sequence": [
            {
                "burn_id": "BURN-001",
                "burnTime": burn_time,
                "deltaV_vector": {"x": 0.0, "y": 0.0075, "z": 0.0}
            }
        ]
    }
    response = await client.post("/api/maneuver/schedule", json=payload, headers=headers)
    assert response.status_code == 202
    data = response.json()
    assert data["status"] == "SCHEDULED"
