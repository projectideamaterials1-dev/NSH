"""End-to-end API regressions for telemetry upserts, burn scheduling and stepping."""
import math

import pytest

from tests.conftest import make_object

R = 6378.137 + 500.0
V = math.sqrt(398600.4418 / R)
T0 = "2026-01-01T00:00:00.000Z"


def polar_sat(sat_id="SAT-001"):
    # Over the North Pole: in view of Svalbard, so LOS checks pass.
    return make_object(sat_id, "SATELLITE", (0.0, 0.0, R), (V, 0.0, 0.0))


def burn(burn_id, t, dv=(0.0, 0.002, 0.0)):
    return {"burn_id": burn_id, "burnTime": t, "deltaV_vector": dict(zip("xyz", dv))}


async def ingest(client, objects, ts=T0):
    resp = await client.post("/api/telemetry", json={"timestamp": ts, "objects": objects})
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_partial_telemetry_keeps_existing_objects(client):
    await ingest(client, [polar_sat("SAT-A"), polar_sat("SAT-B"),
                          make_object("DEB-1", "DEBRIS", (R, 0, 0), (0, V, 0))])
    # A later packet with only one satellite must not wipe the others
    await ingest(client, [polar_sat("SAT-B")], ts="2026-01-01T00:00:01.000Z")

    snap = (await client.get("/api/visualization/snapshot")).json()
    assert sorted(s["id"] for s in snap["satellites"]) == ["SAT-A", "SAT-B"]
    assert [d[0] for d in snap["debris_cloud"]] == ["DEB-1"]


@pytest.mark.asyncio
async def test_stale_telemetry_is_ignored(client):
    await ingest(client, [polar_sat()], ts="2026-01-01T00:10:00.000Z")
    data = await ingest(client, [polar_sat("SAT-OLD")], ts=T0)
    assert data["processed_count"] == 0


@pytest.mark.asyncio
async def test_schedule_twice_and_execute_both_burns_in_one_long_step(client):
    await ingest(client, [polar_sat()])

    first = await client.post("/api/maneuver/schedule", json={
        "satelliteId": "SAT-001", "maneuver_sequence": [burn("B1", "2026-01-01T00:00:10.000Z")]})
    assert first.json()["status"] == "SCHEDULED"

    # Second request must account for the queued burn (previously crashed on tuple unpacking)
    too_soon = await client.post("/api/maneuver/schedule", json={
        "satelliteId": "SAT-001", "maneuver_sequence": [burn("B2", "2026-01-01T00:05:00.000Z")]})
    assert too_soon.json()["status"] == "REJECTED: COOLDOWN_ACTIVE"

    second = await client.post("/api/maneuver/schedule", json={
        "satelliteId": "SAT-001", "maneuver_sequence": [burn("B3", "2026-01-01T00:10:20.000Z")]})
    assert second.json()["status"] == "SCHEDULED"

    pending = (await client.get("/api/maneuvers", params={"status": "pending"})).json()["maneuvers"]
    assert [m["burn_id"] for m in pending] == ["B1", "B3"]

    step = await client.post("/api/simulate/step", json={"step_seconds": 3600})
    body = step.json()
    assert step.status_code == 200, body
    assert body["maneuvers_executed"] == 2
    assert body["new_timestamp"] == "2026-01-01T01:00:00.000Z"

    executed = (await client.get("/api/maneuvers", params={"status": "executed"})).json()["maneuvers"]
    assert [m["burn_id"] for m in executed] == ["B1", "B3"]
    assert executed[0]["burnTime"] == "2026-01-01T00:00:10.000Z"
    assert all(m["fuel_consumed_kg"] > 0 for m in executed)

    snap = (await client.get("/api/visualization/snapshot")).json()
    assert snap["satellites"][0]["fuel_kg"] < 50.0


@pytest.mark.asyncio
async def test_invalid_burn_time_is_422(client):
    await ingest(client, [polar_sat()])
    resp = await client.post("/api/maneuver/schedule", json={
        "satelliteId": "SAT-001", "maneuver_sequence": [burn("B1", "not-a-time")]})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_cancel_pending_burn(client):
    await ingest(client, [polar_sat()])
    await client.post("/api/maneuver/schedule", json={
        "satelliteId": "SAT-001", "maneuver_sequence": [burn("B1", "2026-01-01T00:00:30.000Z")]})
    assert (await client.delete("/api/maneuver/B1")).status_code == 200
    assert (await client.delete("/api/maneuver/B1")).status_code == 404
    step = await client.post("/api/simulate/step", json={"step_seconds": 60})
    assert step.json()["maneuvers_executed"] == 0


@pytest.mark.asyncio
async def test_snapshot_returns_full_debris_cloud_and_paginates_on_request(client):
    debris = [make_object(f"DEB-{i}", "DEBRIS", (R * math.cos(i / 500), R * math.sin(i / 500), 0),
                          (0, V, 0)) for i in range(2500)]
    await ingest(client, [polar_sat()] + debris)

    full = await client.get("/api/visualization/snapshot")
    assert len(full.json()["debris_cloud"]) == 2500

    page = await client.get("/api/visualization/snapshot", params={"per_page": 1000, "page": 3})
    assert len(page.json()["debris_cloud"]) == 500
    assert page.headers["X-Total-Count"] == "2500"

    bad = await client.get("/api/visualization/snapshot", params={"bbox": "1,2,3"})
    assert bad.status_code == 400


@pytest.mark.asyncio
async def test_czml_export_contains_real_tracks(client):
    await ingest(client, [polar_sat()])
    resp = await client.get("/api/export/czml", params={"step_seconds": 600})
    assert resp.status_code == 200
    doc = resp.json()
    track = doc[1]["position"]["cartographicDegrees"]
    assert len(track) == 7 * 4  # one hour at 600 s -> 7 samples
    assert abs(track[2] - 90.0) < 0.5  # starts over the pole
    assert track[-2] < 80.0  # and has moved off it


@pytest.mark.asyncio
async def test_api_key_middleware():
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from satellite_api.middleware.auth import APIKeyMiddleware

    async def call(operator_key, path, headers=None, method="GET", readonly_key=""):
        mini = FastAPI()
        mini.add_middleware(
            APIKeyMiddleware,
            operator_keys=frozenset({operator_key}) if operator_key else frozenset(),
            readonly_keys=frozenset({readonly_key}) if readonly_key else frozenset(),
        )

        @mini.get("/api/ping")
        async def ping():
            return {"ok": True}

        @mini.post("/api/ping")
        async def ping_post():
            return {"ok": True}

        @mini.get("/health")
        async def health():
            return {"ok": True}

        @mini.get("/docs")
        async def docs():
            return {"ok": True}

        async with AsyncClient(transport=ASGITransport(app=mini), base_url="http://t") as c:
            return (await c.request(method, path, headers=headers)).status_code

    assert await call("", "/api/ping") == 200                       # disabled by default
    assert await call("s3cret", "/api/ping") == 401
    assert await call("s3cret", "/api/ping", {"X-API-Key": "nope"}) == 401
    assert await call("s3cret", "/api/ping", {"X-API-Key": "s3cret"}) == 200
    assert await call("s3cret", "/health") == 200                   # health stays public
    assert await call("s3cret", "/api/ping", method="OPTIONS") != 401  # CORS preflight not blocked
    assert await call("s3cret", "/docs") == 401                     # docs protected once keys are configured

    # role-scoped keys: a readonly key can GET but not mutate; an operator key can do both
    assert await call("op-key", "/api/ping", {"X-API-Key": "ro-key"}, readonly_key="ro-key") == 200
    assert await call("op-key", "/api/ping", {"X-API-Key": "ro-key"}, method="POST", readonly_key="ro-key") == 403
    assert await call("op-key", "/api/ping", {"X-API-Key": "op-key"}, method="POST", readonly_key="ro-key") == 200
