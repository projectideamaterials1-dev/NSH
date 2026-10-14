"""Operator assistant: tool loop, read-only tools, grounding report, model client and auth."""
import json

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from satellite_api.acm.scenario import circular_state_over, make_threat
from satellite_api.assistant import tools
from satellite_api.assistant.llm import AssistantSettings, ModelUnavailable, OllamaClient
from satellite_api.config import CONFIG
from satellite_api.ground_stations import STATIONS
from satellite_api.main import app
from satellite_api.middleware.auth import APIKeyMiddleware
from satellite_api.timeutils import iso_z, parse_iso_utc
from tests.conftest import make_object

T0 = 1767225600.0


class ScriptedModel:
    """Stands in for OllamaClient: replays canned assistant messages and records what it was sent."""

    def __init__(self, *replies, max_steps=4):
        self.replies = list(replies)
        self.settings = AssistantSettings(model="scripted", max_steps=max_steps)
        self.calls = []

    async def chat(self, messages, tool_specs, think):
        self.calls.append({"messages": json.loads(json.dumps(messages)), "tools": tool_specs, "think": think})
        return self.replies.pop(0) if self.replies else {"role": "assistant", "content": "done"}

    async def status(self):
        return {"provider": "scripted"}


def _tool_call(name, **args):
    return {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": name, "arguments": args}}]}


def _answer(text):
    return {"role": "assistant", "content": text}


@pytest.fixture
def model(monkeypatch):
    def install(*replies, **kw):
        m = ScriptedModel(*replies, **kw)
        monkeypatch.setattr(app.state, "assistant_client", m, raising=False)
        return m
    return install


@pytest.fixture(autouse=True)
def _no_drag():
    CONFIG.atmosphericDrag = False


async def _ask(client, question="What is the riskiest conjunction?", **extra):
    return await client.post("/api/assistant/chat", json={"messages": [{"role": "user", "content": question}], **extra})


async def _plant_conjunction(client):
    station = STATIONS[0]
    sat = circular_state_over(station.latitude, station.longitude, T0)
    debris = make_threat(sat, 1800.0, 0.05)
    objects = [make_object("SAT-A", "SATELLITE", sat[:3], sat[3:]),
               make_object("DEB-THREAT", "DEBRIS", debris[:3], debris[3:])]
    assert (await client.post("/api/telemetry", json={"timestamp": iso_z(T0), "objects": objects})).status_code == 200
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200, "plan": False})
    return (await client.get("/api/conjunctions")).json()["conjunctions"][0]


@pytest.mark.asyncio
async def test_model_calls_a_tool_and_the_answer_is_grounded(client, model):
    cdm = await _plant_conjunction(client)
    miss = f"{cdm['miss_distance_km']:.3f}"
    m = model(_tool_call("list_conjunctions", limit="5"),
              _answer(f"{cdm['cdm_id']} on SAT-A has a miss distance of {miss} km and a 0.731 km margin."))

    resp = await _ask(client)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # The tool ran against the real engine state and its data went back to the model.
    [call] = body["tool_calls"]
    assert call["name"] == "list_conjunctions"
    assert call["result"]["conjunctions"][0]["cdm_id"] == cdm["cdm_id"]
    assert call["result"]["conjunctions"][0]["minutes_to_tca"] == pytest.approx((cdm["tca_ts"] - T0) / 60.0, abs=0.1)
    tool_msg = m.calls[1]["messages"][-1]
    assert tool_msg["role"] == "tool" and cdm["cdm_id"] in tool_msg["content"]
    assert {t["function"]["name"] for t in m.calls[0]["tools"]} >= {"list_conjunctions", "get_trade_study"}
    assert m.calls[0]["think"] is False

    # The real miss distance passes; the made-up margin is flagged; the cited CDM comes back verbatim.
    assert [i["claim"] for i in body["grounding"]["issues"]] == ["0.731"]
    assert body["grounding"]["citations"][cdm["cdm_id"]]["miss_distance_km"] == cdm["miss_distance_km"]
    assert body["stopped"] == "answer"


@pytest.mark.asyncio
async def test_trade_study_tool_summarizes_options(client, model):
    cdm = await _plant_conjunction(client)
    model(_tool_call("get_trade_study", cdm_id=cdm["cdm_id"].lower()), _answer("ok"))
    study = (await _ask(client)).json()["tool_calls"][0]["result"]
    assert study["cdm_id"] == cdm["cdm_id"] and study["axis_meaning"] == "along-track"
    assert study["options_evaluated"] > 0
    # The engine's verdict, not the model's: a 50 m miss is above the Pc threshold.
    assert study["maneuver_required"] is (cdm["pc"] >= CONFIG.pcManeuverThreshold) is True
    assert study["minutes_to_tca"] == pytest.approx((cdm["tca_ts"] - T0) / 60.0, abs=0.1)
    for option in study["cheapest_safe_options"]:
        assert option["pc"] < study["pc_threshold"] and option["dv_mps"] != 0.0
        burn_ts = parse_iso_utc(option["burn_time"]).timestamp()
        assert T0 < burn_ts < cdm["tca_ts"]
        assert option["minutes_before_tca"] == pytest.approx((cdm["tca_ts"] - burn_ts) / 60.0, abs=0.06)


@pytest.mark.asyncio
async def test_bad_tool_arguments_go_back_to_the_model(client, model):
    await _plant_conjunction(client)
    m = model(_tool_call("get_ground_passes", satellite_id="NOPE"), _tool_call("no_such_tool"),
              _tool_call("get_ground_passes", satellite_id="sat-a"), _answer("ok"))
    calls = (await _ask(client)).json()["tool_calls"]
    assert "Unknown satellite 'NOPE'" in calls[0]["error"]
    assert "Unknown tool" in calls[1]["error"]
    assert calls[2]["result"]["satellite_id"] == "SAT-A"     # case-insensitive id resolution
    assert len(m.calls) == 4


@pytest.mark.asyncio
async def test_step_limit_forces_an_answer_without_tools(client, model):
    m = model(_tool_call("get_mission_metrics"), _tool_call("get_mission_metrics"), _answer("summary"), max_steps=2)
    body = (await _ask(client)).json()
    assert body["stopped"] == "step_limit" and body["answer"] == "summary"
    assert len(body["tool_calls"]) == 2
    assert m.calls[-1]["tools"] is None


@pytest.mark.asyncio
async def test_decision_records_are_not_modified_by_the_tool(client, model):
    await _plant_conjunction(client)
    state = app.state.orbital_state
    state.record_decision(satellite_id="SAT-A", kind="TEST", outcome="SCHEDULED", rationale="r",
                          burns=[{"burn_id": "B1", "ts": 1.0, "delta_v_mps": 0.5}])
    model(_tool_call("list_decisions"), _answer("ok"))
    result = (await _ask(client)).json()["tool_calls"][0]["result"]
    assert "ts" not in result["decisions"][0]["burns"][0]
    assert state.decisions[-1]["burns"][0]["ts"] == 1.0


@pytest.mark.asyncio
async def test_model_unavailable_is_503_and_history_must_end_with_user(client, monkeypatch):
    class Down(ScriptedModel):
        async def chat(self, *a):
            raise ModelUnavailable("Model server unreachable at http://x (ConnectError)")
    monkeypatch.setattr(app.state, "assistant_client", Down(), raising=False)
    resp = await _ask(client)
    assert resp.status_code == 503 and "unreachable" in resp.json()["detail"]
    resp = await client.post("/api/assistant/chat", json={"messages": [{"role": "assistant", "content": "hi"}]})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_readonly_key_may_chat_but_not_command(model):
    model(_answer("hello"))
    # Reconfigure the app's own APIKeyMiddleware with a read-only key, then rebuild the stack.
    middleware = next(m for m in app.user_middleware if m.cls is APIKeyMiddleware)
    original = dict(middleware.kwargs)
    middleware.kwargs.update(readonly_keys=frozenset({"ro-key"}), operator_keys=frozenset())
    app.middleware_stack = None
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            h = {"X-API-Key": "ro-key"}
            assert (await c.post("/api/assistant/chat", headers=h,
                                 json={"messages": [{"role": "user", "content": "hi"}]})).status_code == 200
            assert (await c.post("/api/conjunctions/screen", headers=h)).status_code == 403
            assert (await c.post("/api/assistant/chat",
                                 json={"messages": [{"role": "user", "content": "hi"}]})).status_code == 401
    finally:
        middleware.kwargs.clear()
        middleware.kwargs.update(original)
        app.middleware_stack = None


# ─── OllamaClient wire format ──────────────────────────────────────────────────────────
def _ollama(handler):
    return OllamaClient(AssistantSettings(model="qwen3:8b", keep_alive="30s", num_ctx=4096),
                        transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_ollama_request_body_and_think_fallback():
    bodies = []

    def handler(request):
        body = json.loads(request.content)
        bodies.append(body)
        if "think" in body:
            return httpx.Response(400, json={"error": "\"llama3.1\" does not support thinking"})
        return httpx.Response(200, json={"message": {"role": "assistant", "content": "hi"}})

    msg = await _ollama(handler).chat([{"role": "user", "content": "q"}], tools.specs(), think=True)
    assert msg["content"] == "hi"
    first, retry = bodies
    assert first["think"] is True and first["keep_alive"] == "30s" and first["options"] == {"num_ctx": 4096}
    assert first["stream"] is False and len(first["tools"]) == len(tools.specs()) > len(tools.TOOLS)
    assert "think" not in retry


@pytest.mark.asyncio
async def test_ollama_errors_become_model_unavailable():
    with pytest.raises(ModelUnavailable, match="ollama pull qwen3:8b"):
        await _ollama(lambda r: httpx.Response(404, json={"error": "model not found"})).chat([], None, False)

    def refuse(request):
        raise httpx.ConnectError("refused")
    with pytest.raises(ModelUnavailable, match="unreachable"):
        await _ollama(refuse).chat([], None, False)
    assert (await _ollama(refuse).status())["reachable"] is False


# ─── action proposals (Step 3): proposed by the model, executed only by the operator ───────
@pytest.mark.asyncio
async def test_burn_proposal_is_dry_run_only_and_confirming_it_schedules(client, model):
    cdm = await _plant_conjunction(client)
    queue_before = list(app.state.orbital_state.maneuver_queue)
    model(_tool_call("propose_burn_from_trade_study", cdm_id=cdm["cdm_id"], option="cheapest"),
          _answer("A burn is ready for you to confirm."))
    body = (await _ask(client, "Schedule the cheapest avoidance burn")).json()

    [action] = body["actions"]
    assert action["kind"] == "manual_burn" and action["preview"]["cdm_id"] == cdm["cdm_id"]
    assert action["preview"]["dry_run_status"] == "SCHEDULED" and action["valid"] is True
    assert action["preview"]["predicted_pc"] < CONFIG.pcManeuverThreshold <= cdm["pc"]
    # Enough lead time to read and confirm the card.
    assert parse_iso_utc(action["params"]["burns"][0]["burnTime"]).timestamp() >= T0 + 120.0
    assert any("recovery" in w for w in action["warnings"])
    assert "Confirm" in body["tool_calls"][0]["result"]["note"]
    assert list(app.state.orbital_state.maneuver_queue) == queue_before        # nothing executed

    # What the dashboard's Confirm button sends: the card's params to the existing endpoint.
    p = action["params"]
    resp = await client.post("/api/maneuver/manual", json={"satelliteId": p["satellite_id"], "burns": p["burns"],
                                                             "dry_run": False})
    assert resp.status_code == 200 and resp.json()["scheduled"] is True
    assert len(app.state.orbital_state.maneuver_queue) == len(queue_before) + 1


@pytest.mark.asyncio
async def test_manual_burn_proposal_validation(client, model):
    await _plant_conjunction(client)
    model(_tool_call("propose_manual_burn", satellite_id="SAT-A", minutes_from_now=5),
          _tool_call("propose_manual_burn", satellite_id="SAT-A", minutes_from_now=5, dv_t_mps=99),
          _answer("ok"))
    body = (await _ask(client)).json()
    assert "zero delta-v" in body["tool_calls"][0]["error"]
    [action] = body["actions"]
    assert action["valid"] is False and action["params"]["burns"][0]["dv_mps"] == {"t": 99.0}
    assert any("exceeds the per-burn limit" in w for w in action["warnings"])


def _out_of_contact(monkeypatch, *passes):
    """The satellite has no line of sight now; its next contacts are the given (start_s, end_s) after T0."""
    from satellite_api.acm import scheduler
    from satellite_api.routers import operations
    monkeypatch.setattr(scheduler, "has_los", lambda r, ts: False)

    async def fake_passes(request, sat_id, hours, step_s):
        return {"passes": [{"station_id": "GS-X", "station_name": "Station X", "start": iso_z(T0 + a),
                            "end": iso_z(T0 + b), "in_progress": False} for a, b in passes]}
    monkeypatch.setattr(operations, "ground_station_passes", fake_passes)


@pytest.mark.asyncio
async def test_burn_proposal_out_of_contact_waits_for_the_next_pass(client, model, monkeypatch):
    cdm = await _plant_conjunction(client)
    _out_of_contact(monkeypatch, (600, 630), (620, 900))   # overlapping passes merge into 600-900 s
    model(_tool_call("propose_burn_from_trade_study", cdm_id=cdm["cdm_id"], option="cheapest"), _answer("ok"))
    [action] = (await _ask(client)).json()["actions"]

    assert action["valid"] is True and action["preview"]["dry_run_status"] == "REJECTED: NO_LINE_OF_SIGHT"
    burn_ts = parse_iso_utc(action["params"]["burns"][0]["burnTime"]).timestamp()
    assert burn_ts >= T0 + 600 + 120                        # fires after the contact opens, plus the lead
    window = action["confirm_window"]
    assert window["from"] == iso_z(T0 + 600) and window["until"] == iso_z(min(T0 + 900, burn_ts))
    assert window["stations"] == ["Station X"] and action["preview"]["uplink_window"] == window
    assert any("not in ground contact now" in w for w in action["warnings"])


@pytest.mark.asyncio
async def test_burn_proposals_without_a_usable_contact(client, model, monkeypatch):
    cdm = await _plant_conjunction(client)
    _out_of_contact(monkeypatch, (0, 30), (600, 900))      # the first pass is too short to confirm in
    model(_tool_call("propose_manual_burn", satellite_id="SAT-A", minutes_from_now=5, dv_t_mps=0.5),
          _answer("ok"))
    [action] = (await _ask(client)).json()["actions"]
    assert action["valid"] is False and action["confirm_window"] is None
    assert any("too late to uplink" in w and "12 minutes" in w for w in action["warnings"]), action["warnings"]

    _out_of_contact(monkeypatch)
    model(_tool_call("propose_burn_from_trade_study", cdm_id=cdm["cdm_id"]), _answer("ok"))
    body = (await _ask(client)).json()
    assert body["actions"] == [] and "no ground-station contact" in body["tool_calls"][0]["error"]


@pytest.mark.asyncio
async def test_proposal_answer_and_autopilot_proposals_change_nothing(client, model):
    await _plant_conjunction(client)
    state = app.state.orbital_state
    state.proposals["PROP-1"] = {"proposal_id": "PROP-1", "satellite_id": "SAT-A", "kind": "AVOIDANCE",
                                 "status": "PENDING", "rationale": "r", "burns": [], "fuel_kg": 0.1,
                                 "cdm_ids": [], "expires_at": "2026-01-01T01:00:00Z", "_internal": object()}
    state.proposals["PROP-2"] = {**state.proposals["PROP-1"], "proposal_id": "PROP-2", "status": "APPROVED"}
    model(_tool_call("propose_proposal_decision", proposal_id="prop-1", decision="reject", reason="too costly"),
          _tool_call("propose_proposal_decision", proposal_id="PROP-2", decision="approve"),
          _tool_call("propose_autopilot_change", enabled=False),
          _tool_call("propose_screening"), _answer("ok"))
    body = (await _ask(client)).json()
    reject, autopilot, screen = body["actions"]
    assert reject["kind"] == "reject_proposal" and reject["params"] == {"proposal_id": "PROP-1", "reason": "too costly"}
    assert "_internal" not in reject["preview"]
    assert "APPROVED, not PENDING" in body["tool_calls"][1]["error"]
    assert autopilot["params"] == {"enabled": False} and autopilot["warnings"]
    assert screen["kind"] == "screen_now"
    assert state.proposals["PROP-1"]["status"] == "PENDING" and CONFIG.autopilotEnabled is True
