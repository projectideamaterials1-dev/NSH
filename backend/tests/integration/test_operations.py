"""Autonomy loop and operations API: screening, autopilot, events, metrics, satellites, planner, config."""
import numpy as np
import pytest

from satellite_api.acm.brain import AutonomousBrain, Conjunction
from satellite_api.acm.scenario import circular_state_over, make_threat
from satellite_api.config import CONFIG
from satellite_api.ground_stations import STATIONS
from satellite_api.timeutils import iso_z
from tests.conftest import make_object

T0 = 1767225600.0
ISTRAC = next(s for s in STATIONS if s.id == "GS-001")


def _obj(obj_id, obj_type, vec):
    return make_object(obj_id, obj_type, vec[:3], vec[3:])


async def _ingest(client, objects, ts=T0):
    resp = await client.post("/api/telemetry", json={"timestamp": iso_z(ts), "objects": objects})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _threat_scenario(client, tca_s=1800.0, miss_km=0.05):
    sat = circular_state_over(ISTRAC.latitude, ISTRAC.longitude, T0)      # directly above a ground station
    far = circular_state_over(-45.0, -150.0, T0)                          # no contact
    threat = make_threat(sat, tca_s, miss_km, 90.0)
    await _ingest(client, [_obj("SAT-A", "SATELLITE", sat), _obj("SAT-B", "SATELLITE", far),
                           _obj("DEB-THREAT", "DEBRIS", threat)])
    return sat


@pytest.mark.asyncio
async def test_autopilot_detects_and_avoids_conjunction(client):
    await _threat_scenario(client)

    screen = (await client.post("/api/conjunctions/screen", params={"horizon_s": 7200})).json()
    assert screen["status"] == "OK" and screen["new"] >= 1 and screen["sequences_scheduled"] == 1

    cdms = (await client.get("/api/conjunctions")).json()["conjunctions"]
    threat = next(c for c in cdms if c["object_id"] == "DEB-THREAT")
    assert threat["risk"] == "CRITICAL" and threat["status"] == "MITIGATED"
    assert threat["tca"] == iso_z(T0 + 1800)

    queued = (await client.get("/api/maneuvers", params={"status": "pending", "satellite_id": "SAT-A"})).json()["maneuvers"]
    assert queued[0]["maneuver_type"] in ("PHASING_PROGRADE", "PHASING_RETROGRADE", "RADIAL_SHUNT")
    assert queued[0]["burn_id"].startswith("AUTO-SAT-A")

    collisions = 0
    for i in range(35):
        step = (await client.post("/api/simulate/step", json={"step_seconds": 60})).json()
        collisions += step["collisions_detected"]
        if i % 5 == 4:   # periodic re-screen, as the background service does
            await client.post("/api/conjunctions/screen", params={"horizon_s": 7200})
    assert collisions == 0

    all_cdms = (await client.get("/api/conjunctions", params={"status": "all"})).json()["conjunctions"]
    threat = next(c for c in all_cdms if c["object_id"] == "DEB-THREAT" and c["peak_risk"] == "CRITICAL")
    assert threat["status"] == "RESOLVED"

    metrics = (await client.get("/api/metrics")).json()
    assert metrics["collisions_avoided"] == 1
    assert metrics["collisions_detected"] == 0
    assert metrics["avoidance_burns_executed"] >= 1
    assert metrics["fuel_used_kg"] > 0
    assert metrics["station_keeping"]["time_weighted_uptime_percentage"] == 100.0

    events = (await client.get("/api/events")).json()["events"]
    categories = {e["category"] for e in events}
    assert {"conjunction", "autopilot", "maneuver"} <= categories
    assert any("avoided" in e["message"] for e in events)
    last = events[-1]["id"]
    assert (await client.get("/api/events", params={"after_id": last})).json()["events"] == []


@pytest.mark.asyncio
async def test_without_autopilot_the_collision_happens(client):
    await client.put("/api/autopilot", json={"enabled": False})
    await _threat_scenario(client, tca_s=600.0, miss_km=0.02)
    await client.post("/api/conjunctions/screen", params={"horizon_s": 3600})
    collisions = 0
    for _ in range(12):
        collisions += (await client.post("/api/simulate/step", json={"step_seconds": 60})).json()["collisions_detected"]
    assert collisions == 1
    metrics = (await client.get("/api/metrics")).json()
    assert metrics["collisions_detected"] == 1 and metrics["collisions_avoided"] == 0
    statuses = [c["status"] for c in (await client.get("/api/conjunctions", params={"status": "all"})).json()["conjunctions"]]
    assert "COLLIDED" in statuses


@pytest.mark.asyncio
async def test_autopilot_strategy_selection(client):
    resp = (await client.put("/api/autopilot", json={"strategy": "RadialOverride"})).json()
    assert resp["strategy"] == "RadialOverride"
    await _threat_scenario(client)
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200})
    queued = (await client.get("/api/maneuvers", params={"status": "pending"})).json()["maneuvers"]
    assert [m["maneuver_type"] for m in queued] == ["RADIAL_SHUNT", "RECOVERY"]
    assert (await client.put("/api/autopilot", json={"strategy": "Bogus"})).status_code == 422


@pytest.mark.asyncio
async def test_end_of_life_graveyard(client):
    from satellite_api.main import app
    sat = circular_state_over(ISTRAC.latitude, ISTRAC.longitude, T0)
    await _ingest(client, [_obj("SAT-OLD", "SATELLITE", sat)])
    state = app.state.orbital_state
    state.sat_fuel[0] = 2.0

    await client.post("/api/conjunctions/screen", params={"horizon_s": 600})
    queued = (await client.get("/api/maneuvers", params={"status": "pending"})).json()["maneuvers"]
    assert [m["maneuver_type"] for m in queued] == ["EOL_GRAVEYARD"]

    await client.post("/api/simulate/step", json={"step_seconds": 60})
    sats = (await client.get("/api/satellites")).json()["satellites"]
    assert sats[0]["mode"] == "GRAVEYARD" and sats[0]["fuel_kg"] < 2.0
    assert (await client.get("/api/metrics")).json()["eol_satellites"] == 1


@pytest.mark.asyncio
async def test_satellite_details_track_and_passes(client):
    await _threat_scenario(client)
    sats = {s["id"]: s for s in (await client.get("/api/satellites")).json()["satellites"]}
    assert sats["SAT-A"]["alt_km"] == pytest.approx(550.0, abs=1.0)
    assert sats["SAT-A"]["in_contact"] is True and sats["SAT-B"]["in_contact"] is False
    assert sats["SAT-A"]["in_box"] is True and sats["SAT-A"]["mode"] == "NOMINAL"

    track = (await client.get("/api/satellites/SAT-A/track", params={"minutes": 30, "step_s": 300})).json()
    assert len(track["points"]) == 7
    assert track["points"][0]["lat"] == pytest.approx(ISTRAC.latitude, abs=0.5)
    j6 = (await client.get("/api/satellites/SAT-A/track", params={"minutes": 30, "step_s": 300, "model": "J6"})).json()
    assert abs(j6["points"][-1]["lat"] - track["points"][-1]["lat"]) < 0.5
    assert (await client.get("/api/satellites/SAT-A/track", params={"model": "EGM"})).status_code == 422

    passes = (await client.get("/api/satellites/SAT-A/passes", params={"hours": 3})).json()
    assert passes["in_contact_now"] is True
    first = passes["passes"][0]
    assert first["station_id"] == "GS-001" and first["in_progress"] and first["max_elevation_deg"] > 80
    assert (await client.get("/api/satellites/NOPE/passes")).status_code == 404


@pytest.mark.asyncio
async def test_manual_burn_preview_and_schedule(client):
    await _threat_scenario(client)
    body = {"satelliteId": "SAT-A", "burns": [{"offset_s": 30, "frame": "RTN", "dv_mps": {"t": 2.0}}], "dry_run": True}

    preview = (await client.post("/api/maneuver/manual", json=body)).json()
    assert preview["status"] == "SCHEDULED" and preview["scheduled"] is False
    assert preview["burns_eci"][0]["delta_v_mps"] == pytest.approx(2.0, rel=1e-6)
    assert preview["orbit_after"]["apogee_alt_km"] > preview["orbit_before"]["apogee_alt_km"] + 3
    assert preview["fuel_needed_kg"] > 0
    assert (await client.get("/api/maneuvers", params={"status": "pending"})).json()["maneuvers"] == []

    body["dry_run"] = False
    scheduled = (await client.post("/api/maneuver/manual", json=body)).json()
    assert scheduled["scheduled"] is True
    pending = (await client.get("/api/maneuvers", params={"status": "pending"})).json()["maneuvers"]
    assert pending[0]["maneuver_type"] == "MANUAL"

    burn_id = pending[0]["burn_id"]
    assert (await client.delete(f"/api/maneuver/{burn_id}")).status_code == 200
    cancelled = (await client.get("/api/maneuvers", params={"status": "cancelled"})).json()["maneuvers"]
    assert cancelled[0]["burn_id"] == burn_id

    no_los = {"satelliteId": "SAT-B", "burns": [{"offset_s": 30, "dv_mps": {"t": 1.0}}]}
    assert (await client.post("/api/maneuver/manual", json=no_los)).json()["status"] == "REJECTED: NO_LINE_OF_SIGHT"


@pytest.mark.asyncio
async def test_config_changes_apply_immediately(client):
    await _threat_scenario(client)
    cfg = (await client.post("/api/config", json={"maxDeltaV": 5.0, "cooldownSeconds": 120})).json()
    assert cfg["config"]["maxDeltaV"] == 5.0

    burn = {"satelliteId": "SAT-A", "maneuver_sequence": [
        {"burn_id": "B1", "burnTime": iso_z(T0 + 30), "deltaV_vector": {"x": 0.0, "y": 0.0075, "z": 0.0}}]}
    assert (await client.post("/api/maneuver/schedule", json=burn)).json()["status"] == "REJECTED: MAX_THRUST_EXCEEDED"

    two = {"satelliteId": "SAT-A", "maneuver_sequence": [
        {"burn_id": "B2", "burnTime": iso_z(T0 + 30), "deltaV_vector": {"x": 0.0, "y": 0.001, "z": 0.0}},
        {"burn_id": "B3", "burnTime": iso_z(T0 + 160), "deltaV_vector": {"x": 0.0, "y": 0.001, "z": 0.0}}]}
    assert (await client.post("/api/maneuver/schedule", json=two)).json()["status"] == "SCHEDULED"

    assert (await client.post("/api/config", json={"maxDeltaV": -1})).status_code == 422
    assert (await client.post("/api/config", json={"bogus": 1})).status_code == 422
    assert (await client.get("/api/config")).json()["cooldownSeconds"] == 120


@pytest.mark.asyncio
async def test_telemetry_ack_reports_warning_pairs(client):
    await _threat_scenario(client)
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200, "plan": False})
    ack = await _ingest(client, [], ts=T0 + 1)
    assert ack["active_cdm_warnings"] >= 1
    assert ack["warning_pairs"][0]["object_id"] == "DEB-THREAT"


@pytest.mark.asyncio
async def test_planner_acts_when_contact_begins_between_screens(client):
    """A threat detected while the satellite has no contact is avoided once contact starts,
    without waiting for the next full screening cycle."""
    from satellite_api.main import app
    from satellite_api.routers.operations import get_service_for_state

    sat = circular_state_over(ISTRAC.latitude, ISTRAC.longitude, T0)
    threat = make_threat(sat, 1800.0, 0.05, 90.0)
    await _ingest(client, [_obj("SAT-A", "SATELLITE", sat), _obj("DEB-THREAT", "DEBRIS", threat)])
    state = app.state.orbital_state
    service = get_service_for_state(app, state)

    import satellite_api.acm.autopilot as autopilot_module
    real_has_los = autopilot_module.has_los
    blackout = {"on": True}
    import satellite_api.acm.scheduler as scheduler_module
    real_sched_los = scheduler_module.has_los
    scheduler_module.has_los = lambda r, ts: False if blackout["on"] else real_sched_los(r, ts)
    service.autopilot.stations = []           # brain LOS check defers to the scheduler's validation
    try:
        first = await service.run_cycle(horizon_s=3600)
        assert first["new"] == 1 and first["sequences_scheduled"] == 0     # no contact yet

        await client.post("/api/simulate/step", json={"step_seconds": 30})
        blackout["on"] = False                                               # contact begins
        assert service.plan_due() is True and service.due() is False
        summary = await service.plan_cycle()
        assert summary["sequences_scheduled"] == 1
        assert service.plan_due() is False                                   # throttled until sim time moves on
    finally:
        scheduler_module.has_los = real_sched_los
        autopilot_module.has_los = real_has_los

    cdm = next(c for c in state.cdms.items if c["object_id"] == "DEB-THREAT")
    assert cdm["status"] == "MITIGATED"
    rejections = [e for e in state.events if e["category"] == "autopilot" and "rejected" in e["message"]]
    assert len(rejections) == 1                                              # not repeated every pass


def _drift_earliest_burn_ts(state, sat_id: str) -> float:
    """Earliest queued burn timestamp for a satellite (its t1 station-keeping leg)."""
    return min(item[0] for item in state.maneuver_queue if item[1] == sat_id)


def _drift_along_track(state, sat_id: str, km: float) -> None:
    """Nudges a satellite along its own velocity direction, away from its nominal ghost slot.
    The station-keeping healer only reacts to along-track drift (it heals via a period
    adjustment) - a purely radial offset produces a near-zero required delta-v and no plan."""
    idx = state.sat_id_to_idx[sat_id]
    v_hat = state.sat_buffer[idx, 3:6] / np.linalg.norm(state.sat_buffer[idx, 3:6])
    state.sat_buffer[idx, :3] += km * v_hat


@pytest.mark.asyncio
async def test_fleet_coordinator_staggers_clustered_sk_burns_end_to_end(client):
    """Regression test for the clustering bug: without fleet coordination every station-keeping
    burn planned in the same cycle defaults to the same hardcoded t1=15.0 offset."""
    from satellite_api.main import app
    from satellite_api.routers.operations import get_service_for_state

    sat = circular_state_over(ISTRAC.latitude, ISTRAC.longitude, T0)
    fuels = {"SAT-0": 6.0, "SAT-1": 40.0, "SAT-2": 20.0, "SAT-3": 45.0}   # SAT-0 most urgent, SAT-3 least
    await _ingest(client, [_obj(sid, "SATELLITE", sat) for sid in fuels])

    state = app.state.orbital_state
    for sid, fuel in fuels.items():
        _drift_along_track(state, sid, 7.0)    # past 0.6 * stationKeepingRadius (default 10km -> 6km)
        state.sat_fuel[state.sat_id_to_idx[sid]] = fuel

    service = get_service_for_state(app, state)
    summary = await service.plan_cycle()

    assert summary["sequences_scheduled"] == 4 and summary["sequences_rejected"] == 0
    assert summary["sk_burns_staggered"] == 3   # the lowest-fuel satellite keeps its original slot

    burn_ts = {sid: _drift_earliest_burn_ts(state, sid) for sid in fuels}
    assert len({round(t) for t in burn_ts.values()}) == 4     # no two satellites share a burn time
    assert burn_ts["SAT-0"] == pytest.approx(T0 + 15.0)        # most urgent (lowest fuel): unstaggered
    assert burn_ts["SAT-0"] < burn_ts["SAT-2"] < burn_ts["SAT-1"] < burn_ts["SAT-3"]

    events = [e for e in state.events if e["category"] == "fleet_coordinator"]
    assert len(events) == 3
    assert {e["satellite_id"] for e in events} == {"SAT-1", "SAT-2", "SAT-3"}
    assert all("priority_score" in e["data"] for e in events)


@pytest.mark.asyncio
async def test_fleet_coordinator_never_retimes_evasion(client):
    """A live evasion sequence planned in the same cycle as a clustered station-keeping group
    must come out exactly as AutonomousBrain would plan it alone - the coordinator only ever
    delays STATION_KEEPING plans."""
    from satellite_api.main import app
    from satellite_api.routers.operations import get_service_for_state

    sat_a = await _threat_scenario(client, tca_s=1800.0, miss_km=0.05)   # SAT-A: threatened, evades

    sk_fuels = {"SAT-C": 6.0, "SAT-D": 40.0, "SAT-E": 20.0}
    sk_sat = circular_state_over(ISTRAC.latitude, ISTRAC.longitude, T0)
    await _ingest(client, [_obj(sid, "SATELLITE", sk_sat) for sid in sk_fuels])

    state = app.state.orbital_state
    for sid, fuel in sk_fuels.items():
        _drift_along_track(state, sid, 7.0)
        state.sat_fuel[state.sat_id_to_idx[sid]] = fuel

    service = get_service_for_state(app, state)
    await service.run_cycle(horizon_s=7200)   # screens for the debris threat, then plans+schedules

    # Reconstruct the exact same evasion sequence AutonomousBrain would plan on its own, fed
    # the actual measured TCA from the CDM the live cycle just detected (not the nominal 1800.0,
    # to avoid asserting against a value the refinement pass may have adjusted by a second or two).
    cdm = next(c for c in state.cdms.items if c["object_id"] == "DEB-THREAT")
    expected = AutonomousBrain().calculate_perfect_evasion_sequence(
        sat_idx=0, threats=[Conjunction(sat_idx=0, debris_idx=0, tca_seconds=cdm["tca_ts"] - T0,
                                        miss_distance_km=cdm["miss_distance_km"], relative_velocity_kms=7.5,
                                        risk_score=1.0)],
        current_fuel_kg=CONFIG.initialFuel, sat_state=sat_a, nominal_state=sat_a,
    )
    expected_offsets = sorted(p.burn_time_offset_s for p in expected)

    actual_offsets = sorted(ts - T0 for ts in
                            (item[0] for item in state.maneuver_queue if item[1] == "SAT-A"))
    assert actual_offsets == pytest.approx(expected_offsets, abs=1e-3)

    # The SK cluster was still staggered - both effects happened in the same cycle independently.
    sk_ts = {sid: _drift_earliest_burn_ts(state, sid) for sid in sk_fuels}
    assert len({round(t) for t in sk_ts.values()}) == 3
