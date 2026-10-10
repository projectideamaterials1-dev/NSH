"""Decision support: post-maneuver verification, rationale log, approval mode and trade space."""
import numpy as np
import pytest

from satellite_api.acm.brain import AutonomousBrain, Conjunction
from satellite_api.acm.scenario import circular_state_over, make_threat
from satellite_api.config import CONFIG
from satellite_api.ground_stations import STATIONS
from satellite_api.physics_engine import propagate_states
from satellite_api.timeutils import iso_z
from tests.conftest import make_object

T0 = 1767225600.0
ISTRAC = next(s for s in STATIONS if s.id == "GS-001")


def _obj(obj_id, obj_type, vec):
    return make_object(obj_id, obj_type, vec[:3], vec[3:])


async def _ingest(client, objects):
    resp = await client.post("/api/telemetry", json={"timestamp": iso_z(T0), "objects": objects})
    assert resp.status_code == 200, resp.text


async def _threat(client, tca_s=1800.0, miss_km=0.05):
    sat = circular_state_over(ISTRAC.latitude, ISTRAC.longitude, T0)
    await _ingest(client, [_obj("SAT-A", "SATELLITE", sat), _obj("DEB-THREAT", "DEBRIS", make_threat(sat, tca_s, miss_km))])
    return sat


def _backwards(state: np.ndarray, dt: float) -> np.ndarray:
    """Present-epoch state whose free flight passes through `state` after `dt` (time reversal)."""
    s = state.reshape(1, 6).copy()
    s[0, 3:] *= -1
    propagate_states(s, dt)
    s[0, 3:] *= -1
    return s[0]


@pytest.fixture(autouse=True)
def _no_drag():
    # The planted geometry is built drag-free; keep the engine drag-free so it stays exact.
    CONFIG.atmosphericDrag = False


@pytest.mark.asyncio
async def test_evasion_that_creates_a_secondary_conjunction_is_replaced(client):
    sat = await _threat(client)
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200, "plan": False})
    cdm = (await client.get("/api/conjunctions")).json()["conjunctions"][0]

    # Reproduce the planner's first choice and plant a second object on *that* post-burn path.
    first = AutonomousBrain().calculate_perfect_evasion_sequence(
        0, [Conjunction(0, 0, cdm["tca_ts"] - T0, cdm["miss_distance_km"], 7.5, 1.0, cdm["pc"], True,
                        min(cdm["safe_miss_km"], 5.0))], CONFIG.initialFuel, sat, sat)
    burn = first[0]
    post = sat.reshape(1, 6).copy()
    propagate_states(post, burn.burn_time_offset_s)
    post[0, 3:] += [burn.delta_v_eci_dict[a] for a in "xyz"]
    ghost = _backwards(post[0], burn.burn_time_offset_s)
    await _ingest(client, [_obj("DEB-SECOND", "DEBRIS", make_threat(ghost, 1500.0, 0.02, 60.0))])

    result = (await client.post("/api/conjunctions/screen", params={"horizon_s": 7200})).json()
    assert result["sequences_scheduled"] == 1

    decision = (await client.get("/api/decisions", params={"satellite_id": "SAT-A"})).json()["decisions"][0]
    assert decision["outcome"] == "SCHEDULED" and decision["kind"] == "EVASION"
    rejected, chosen = decision["candidates"][0], decision["candidates"][-1]
    assert rejected["clean"] is False and not rejected["chosen"]
    assert any(r["object_id"] == "DEB-SECOND" and r["needs_action"] for r in rejected["verification"]["secondary"])
    assert chosen["chosen"] and chosen["clean"] is True
    assert chosen["label"] != rejected["label"]
    assert "Rejected" in decision["rationale"] and "secondary" in decision["rationale"]

    # The queued burns carry the rationale, and the primary threat is cleared by the chosen option.
    pending = (await client.get("/api/maneuvers", params={"status": "pending", "satellite_id": "SAT-A"})).json()["maneuvers"]
    assert pending and all(m["rationale"] == decision["rationale"] for m in pending)
    assert all(not r["needs_action"] for r in chosen["verification"]["primary"])


@pytest.mark.asyncio
async def test_clean_evasion_keeps_the_planner_choice_and_explains_it(client):
    await _threat(client)
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200})
    decision = (await client.get("/api/decisions")).json()["decisions"][0]
    assert len(decision["candidates"]) == 1 and decision["candidates"][0]["clean"] is True
    text = decision["rationale"]
    assert "DEB-THREAT" in text and "Pc" in text and "No secondary conjunctions" in text


@pytest.mark.asyncio
async def test_approval_mode_holds_burns_until_an_operator_approves(client):
    CONFIG.autopilotMode = "APPROVAL"
    await _threat(client)
    result = (await client.post("/api/conjunctions/screen", params={"horizon_s": 7200})).json()
    assert result["sequences_proposed"] == 1 and result["sequences_scheduled"] == 0
    assert (await client.get("/api/maneuvers", params={"status": "pending"})).json()["maneuvers"] == []

    proposals = (await client.get("/api/proposals")).json()["proposals"]
    assert len(proposals) == 1
    prop = proposals[0]
    assert prop["status"] == "PENDING" and prop["kind"] == "EVASION" and "_plans" not in prop

    # Re-screening while the proposal is pending does not stack a second one.
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200})
    assert len((await client.get("/api/proposals")).json()["proposals"]) == 1

    # Time passes before the operator answers: burns are re-targeted from the state at approval.
    await client.post("/api/simulate/step", json={"step_seconds": 60})
    approved = (await client.post(f"/api/proposals/{prop['proposal_id']}/approve")).json()
    assert approved["status"] == "APPROVED" and approved["answered_by"].startswith("operator:")
    pending = (await client.get("/api/maneuvers", params={"status": "pending", "satellite_id": "SAT-A"})).json()["maneuvers"]
    assert pending and all(m["actor"].startswith("operator:") for m in pending)
    assert min(m["burnTime"] for m in pending) > iso_z(T0 + 60)

    cdm = (await client.get("/api/conjunctions")).json()["conjunctions"][0]
    assert cdm["status"] == "MITIGATED"
    again = await client.post(f"/api/proposals/{prop['proposal_id']}/approve")
    assert again.status_code == 409
    outcomes = [d["outcome"] for d in (await client.get("/api/decisions")).json()["decisions"]]
    assert outcomes[:2] == ["APPROVED", "PROPOSED"]


@pytest.mark.asyncio
async def test_rejected_and_expired_proposals(client):
    CONFIG.autopilotMode = "APPROVAL"
    CONFIG.approvalTimeoutSeconds = 120.0
    await _threat(client)
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200})
    pid = (await client.get("/api/proposals")).json()["proposals"][0]["proposal_id"]
    rejected = (await client.post(f"/api/proposals/{pid}/reject", json={"reason": "awaiting refined CDM"})).json()
    assert rejected["status"] == "REJECTED" and rejected["reason"] == "awaiting refined CDM"
    assert (await client.post("/api/proposals/nope/approve")).status_code == 404

    # The encounter is still open, so the next pass proposes again; leaving it unanswered expires it.
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200})
    second = (await client.get("/api/proposals")).json()["proposals"]
    assert len(second) == 1 and second[0]["proposal_id"] != pid
    assert len((await client.get("/api/proposals", params={"status": "all"})).json()["proposals"]) == 2
    for _ in range(3):
        await client.post("/api/simulate/step", json={"step_seconds": 60})
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200, "plan": True})
    every = (await client.get("/api/proposals", params={"status": "all"})).json()["proposals"]
    assert any(p["status"] == "EXPIRED" for p in every)
    events = (await client.get("/api/events")).json()["events"]
    assert any("expired without an operator decision" in e["message"] for e in events)


@pytest.mark.asyncio
async def test_timeout_action_execute_queues_the_burns(client):
    CONFIG.autopilotMode = "APPROVAL"
    CONFIG.approvalTimeoutSeconds = 60.0
    CONFIG.approvalTimeoutAction = "EXECUTE"
    await _threat(client)
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200})
    await client.post("/api/simulate/step", json={"step_seconds": 90})
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200})
    every = (await client.get("/api/proposals", params={"status": "all"})).json()["proposals"]
    assert every[-1]["status"] == "APPROVED" and every[-1]["answered_by"] == "autopilot:timeout"
    pending = (await client.get("/api/maneuvers", params={"status": "pending", "satellite_id": "SAT-A"})).json()["maneuvers"]
    assert pending


@pytest.mark.asyncio
async def test_tradespace_shows_how_burn_size_and_timing_change_miss_and_pc(client):
    await _threat(client)
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200, "plan": False})
    cdm = (await client.get("/api/conjunctions")).json()["conjunctions"][0]
    resp = await client.get(f"/api/conjunctions/{cdm['cdm_id']}/tradespace", params={"n_times": 4, "n_dv": 5})
    assert resp.status_code == 200, resp.text
    study = resp.json()
    assert study["axis"] == "T" and len(study["grid"]) == 4 * 5
    cell = {(g["burn_offset_s"], g["dv_mps"]): g for g in study["grid"]}
    earliest, latest = study["burn_offsets_s"][0], study["burn_offsets_s"][-1]
    biggest = max(study["dv_mps"])

    # No burn reproduces the screened encounter.
    assert cell[(earliest, 0.0)]["miss_km"] == pytest.approx(cdm["miss_distance_km"], abs=0.01)
    # A larger, earlier along-track burn moves the miss further and lowers Pc.
    assert cell[(earliest, biggest)]["miss_km"] > cell[(latest, biggest)]["miss_km"] > cdm["miss_distance_km"]
    assert cell[(earliest, biggest)]["pc"] < cdm["pc"]
    assert cell[(earliest, biggest)]["fuel_kg"] > 0 == cell[(earliest, 0.0)]["fuel_kg"]

    assert (await client.get("/api/conjunctions/CDM-99999/tradespace")).status_code == 404


@pytest.mark.asyncio
async def test_config_rejects_unknown_autopilot_modes(client):
    resp = await client.post("/api/config", json={"autopilotMode": "YOLO"})
    assert resp.status_code in (400, 422)
