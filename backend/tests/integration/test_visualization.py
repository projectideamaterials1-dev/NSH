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


@pytest.mark.asyncio
async def test_predict_applies_queued_burns_and_lists_events(client):
    from satellite_api.acm.scenario import circular_state_over
    from tests.conftest import make_object
    t0 = "2026-01-01T00:00:00.000Z"
    sat = circular_state_over(13.0, 77.5, 1767225600.0)
    await client.post("/api/telemetry", json={"timestamp": t0, "objects": [
        make_object("SAT-P", "SATELLITE", sat[:3], sat[3:]), make_object("SAT-Q", "SATELLITE", sat[:3], sat[3:])]})
    await client.post("/api/maneuver/schedule", json={"satelliteId": "SAT-P", "maneuver_sequence": [
        {"burn_id": "PRED-1", "burnTime": "2026-01-01T00:01:00.000Z", "deltaV_vector": {"x": 0.0, "y": 0.0, "z": 0.005}}]})

    resp = await client.get("/api/predict", params={"horizon_s": 1800, "step_s": 300})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["satellite_ids"] == ["SAT-P", "SAT-Q"] and len(data["frames"]) == 6
    first, last = data["frames"][0]["positions"], data["frames"][-1]["positions"]
    # Identical satellites diverge only because SAT-P's queued burn is applied in the prediction.
    assert first[0] != first[1] and last[0] != last[1]
    assert any(e["kind"] == "BURN" and e["label"] == "PRED-1" for e in data["events"])
    assert (await client.get("/api/predict", params={"horizon_s": 86400, "step_s": 30})).status_code == 400
