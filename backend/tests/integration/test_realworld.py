"""Real-world data API: CelesTrak catalog loading (offline fixture), SGP4 anchoring, live mode,
cache fallback, SGP4 conjunction refinement and space weather."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest
from sgp4.api import jday

from satellite_api.main import app
from satellite_api.realworld import catalog, live, space_weather
from satellite_api.realworld.catalog import CatalogError

FIXTURE = json.loads((Path(__file__).resolve().parent.parent / "fixtures" / "celestrak_sample.json").read_text())
NOW = datetime(2026, 9, 14, 8, 0, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now


@pytest.fixture
def celestrak(monkeypatch):
    calls = []

    def fake_query(query):
        calls.append(query)
        key = query.split("=", 1)[1]
        if key not in FIXTURE:
            return []
        return FIXTURE[key]

    clock = Clock()
    monkeypatch.setattr(catalog, "_http_query", fake_query)
    monkeypatch.setattr(live, "_utcnow", clock)
    catalog._last_failure.clear()
    app.state.realworld = None
    yield calls, clock
    service = getattr(app.state, "realworld", None)
    if service:
        service.live = False


async def _load(client, **overrides):
    body = {"fleet": ["stations"], "objects": ["cosmos-2251-debris"], "live": False, **overrides}
    resp = await client.post("/api/catalog/load", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_load_ingests_real_satellites_and_debris(client, celestrak):
    status = await _load(client)
    assert status["satellites"] == len(FIXTURE["stations"])
    assert 0 < status["tracked_objects"] <= len(FIXTURE["cosmos-2251-debris"])
    assert status["live"] is False and status["warnings"] == []

    sats = (await client.get("/api/satellites")).json()
    assert sats["timestamp"].startswith("2026-09-14T08:00:00")
    iss = next(s for s in sats["satellites"] if s["id"] == "ISS (ZARYA)")
    assert 400 < iss["alt_km"] < 440 and iss["drift_km"] == 0.0

    info = (await client.get("/api/catalog/objects/ISS (ZARYA)")).json()
    assert info["norad_id"] == 25544 and info["intl_designator"] == "1998-067A"
    assert 90 < info["elements"]["period_min"] < 95 and info["kind"] == "satellite"
    assert (await client.get("/api/catalog/objects/NOPE")).status_code == 404

    snapshot = (await client.get("/api/visualization/snapshot")).json()
    assert len(snapshot["satellites"]) == status["satellites"]


@pytest.mark.asyncio
async def test_positions_match_sgp4(client, celestrak):
    await _load(client)
    state = app.state.orbital_state
    service = app.state.realworld
    obj = service.fleet["ISS (ZARYA)"]
    jd, fr = jday(2026, 9, 14, 8, 0, 0)
    _, r, v = obj.satrec.sgp4(jd, fr)
    idx = state.sat_id_to_idx["ISS (ZARYA)"]
    np.testing.assert_allclose(state.sat_buffer[idx], np.array(r + v), atol=1e-9)


@pytest.mark.asyncio
async def test_docked_vehicles_are_not_collisions(client, celestrak):
    status = await _load(client)
    state = app.state.orbital_state
    assert status["attached_pairs"] > 0
    docked = [p for p in state.attached_pairs if "ISS (ZARYA)" in p]
    assert docked, "vehicles sharing the ISS element set should be attached to it"

    await client.put("/api/live", json={"enabled": False})
    step = (await client.post("/api/simulate/step", json={"step_seconds": 60})).json()
    assert step["collisions_detected"] == 0
    screen = (await client.post("/api/conjunctions/screen", params={"horizon_s": 600})).json()
    cdms = (await client.get("/api/conjunctions")).json()["conjunctions"]
    assert screen["status"] == "OK"
    assert not any(state.is_attached(c["satellite_id"], c["object_id"]) for c in cdms)


@pytest.mark.asyncio
async def test_rejects_unknown_source_and_empty_fleet(client, celestrak):
    assert (await client.post("/api/catalog/load", json={"fleet": ["nope"]})).status_code == 422
    assert (await client.post("/api/catalog/load", json={"fleet": [], "objects": []})).status_code == 422


@pytest.mark.asyncio
async def test_live_mode_locks_clock_and_blocks_manual_steps(client, celestrak):
    _, clock = celestrak
    await _load(client, live=True)
    assert (await client.get("/api/live")).json()["enabled"] is True
    assert (await client.post("/api/simulate/step", json={"step_seconds": 10})).status_code == 409

    clock.now = NOW + timedelta(seconds=30)
    await app.state.realworld.tick()
    assert app.state.orbital_state.current_time == clock.now

    clock.now = NOW + timedelta(hours=2)          # far behind: re-anchored instead of integrated
    await app.state.realworld.tick()
    assert app.state.orbital_state.current_time == clock.now

    resp = await client.put("/api/live", json={"enabled": False})
    assert resp.status_code == 200 and resp.json()["enabled"] is False
    assert (await client.post("/api/simulate/step", json={"step_seconds": 10})).status_code == 200


@pytest.mark.asyncio
async def test_resync_keeps_manoeuvred_satellites(client, celestrak):
    await _load(client)
    state = app.state.orbital_state
    service = app.state.realworld
    burned, untouched = "ISS (ZARYA)", next(s for s in service.fleet if s != "ISS (ZARYA)")
    i_burned, i_untouched = state.sat_id_to_idx[burned], state.sat_id_to_idx[untouched]
    state.sat_fuel[i_burned] -= 1.0                      # as if a burn had been executed
    state.sat_buffer[i_burned, 3] += 0.001
    state.sat_buffer[i_untouched, 3] += 0.001
    kept = state.sat_buffer[i_burned].copy()

    await service.resync(state.current_time)
    np.testing.assert_array_equal(state.sat_buffer[i_burned], kept)
    jd, fr = jday(2026, 9, 14, 8, 0, 0)
    _, r, v = service.fleet[untouched].satrec.sgp4(jd, fr)
    np.testing.assert_allclose(state.sat_buffer[i_untouched], np.array(r + v), atol=1e-9)


@pytest.mark.asyncio
async def test_cached_data_used_when_celestrak_is_down(client, celestrak, monkeypatch):
    await _load(client)

    def offline(query):
        raise CatalogError("CelesTrak unreachable (test)")

    monkeypatch.setattr(catalog, "_http_query", offline)
    status = await _load(client, force_refresh=True)
    assert status["satellites"] == len(FIXTURE["stations"])
    assert any("using cached data" in w for w in status["warnings"])


def test_sgp4_refiner_matches_brute_force():
    fleet = catalog.parse_records(FIXTURE["stations"], "stations")
    debris = catalog.parse_records(FIXTURE["cosmos-2251-debris"], "cosmos-2251-debris")
    sat, deb = fleet[0], debris[0]

    def distance(t: datetime) -> float:
        jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond / 1e6)
        return float(np.linalg.norm(np.subtract(sat.satrec.sgp4(jd, fr)[1], deb.satrec.sgp4(jd, fr)[1])))

    # Find a local minimum of the separation by brute force, then offer the refiner a guess 40 s off.
    coarse = [NOW + timedelta(seconds=s) for s in range(0, 6000, 10)]
    d = [distance(t) for t in coarse]
    k = next(i for i in range(1, len(d) - 1) if d[i] <= d[i - 1] and d[i] <= d[i + 1])
    fine = [coarse[k] + timedelta(milliseconds=ms) for ms in range(-10000, 10000, 5)]
    truth_t = min(fine, key=distance)

    guess = {"satellite_id": "A", "object_id": "B", "object_type": "DEBRIS", "tca_ts": truth_t.timestamp() + 40.0,
             "miss_distance_km": 1.0, "relative_velocity_kms": 0.0, "approach_angle_deg": 0.0}
    snapshot = {"satellites": {"A": sat.satrec}, "objects": {"B": deb.satrec}}
    [refined] = live.Sgp4Refiner.refine([guess], snapshot, warning_km=1e6)
    assert refined["propagator"] == "SGP4"
    assert abs(refined["miss_distance_km"] - distance(truth_t)) < 0.005
    # This pair's minimum is thousands of km and very flat, so the TCA itself is loosely defined;
    # real conjunctions (km miss, km/s closing speed) are sharp and resolve to milliseconds.
    assert abs(refined["tca_ts"] - truth_t.timestamp()) < 1.0


def test_space_weather_parses_noaa_products(monkeypatch):
    responses = {
        "/products/noaa-planetary-k-index.json": [{"time_tag": "2026-09-14T06:00:00", "Kp": 5.33}],
        "/json/f107_cm_flux.json": [{"time_tag": "2026-09-13T20:00:00", "flux": 114.0},
                                    {"time_tag": "2026-09-13T22:00:00", "flux": 109.0}],
        "/products/noaa-scales.json": {"0": {"G": {"Scale": "1", "Text": "minor"}, "S": {"Scale": "0", "Text": "none"},
                                             "R": {"Scale": "0", "Text": "none"}}},
    }
    monkeypatch.setattr(space_weather, "_get", lambda path: responses[path])
    data = space_weather.fetch_space_weather(force=True)
    assert data["kp"] == 5.33 and data["kp_level"] == "storm"
    assert data["f107_sfu"] == 109.0 and data["scales"]["G"] == {"scale": 1, "text": "minor"}
