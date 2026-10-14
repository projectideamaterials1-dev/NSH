"""
evals/assistant_eval.py
-----------------------
Compares chat models for the operator assistant on a fixed, planted mission (not the live one):
does the model call the right tools with the right arguments, propose actions only when asked,
quote the trade study's fields correctly, and keep its numbers grounded?

The app runs in-process with in-memory state (like the tests), so nothing touches the live mission
and every model sees the same data. Only the model calls go out, to Ollama.

    cd backend
    .venv\\Scripts\\python.exe -m evals.assistant_eval --models qwen3:4b,qwen3:8b
    .venv\\Scripts\\python.exe -m evals.assistant_eval --models qwen3:8b --only trade --repeat 3

Results (one JSON per model plus summary.md) go to D:\\NSH\\ollama\\tests\\eval\\<timestamp>\\.
"""
import argparse
import asyncio
import json
import math
import os
import re
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

# Same isolation as tests/conftest.py, before the app is imported.
os.environ["ACM_ARCHIVE"] = "0"
os.environ["ACM_BACKGROUND"] = "0"
os.environ["ACM_IGNORE_SAVED_CONFIG"] = "1"
os.environ.pop("REDIS_URL", None)
os.environ.pop("REDIS_SENTINELS", None)
for key in ("API_KEYS_OPERATOR", "API_KEYS_READONLY", "API_KEY"):
    os.environ.pop(key, None)

from httpx import ASGITransport, AsyncClient  # noqa: E402

from satellite_api.acm.scenario import circular_state_over, make_threat  # noqa: E402
from satellite_api.assistant.llm import AssistantSettings, OllamaClient  # noqa: E402
from satellite_api.config import CONFIG, SimConfig  # noqa: E402
from satellite_api.ground_stations import STATIONS  # noqa: E402
from satellite_api.main import app  # noqa: E402
from satellite_api.physics_engine import configure_drag  # noqa: E402
from satellite_api.state import StateManager, get_state  # noqa: E402
from satellite_api.timeutils import iso_z  # noqa: E402

T0 = 1767225600.0
OUT_ROOT = Path(__file__).resolve().parents[2] / "ollama" / "tests" / "eval"


def _obj(obj_id, kind, s):
    return {"id": obj_id, "type": kind, "r": dict(zip("xyz", s[:3])), "v": dict(zip("xyz", s[3:]))}


# ─── the planted mission ───────────────────────────────────────────────────────────────────
async def plant(client: AsyncClient) -> dict:
    """SAT-D: a threat the autopilot avoided on its own (a decision with burns).
    SAT-E: a threat the autopilot proposed a burn for in APPROVAL mode (a PENDING proposal).
    SAT-A: a critical conjunction nobody has planned for. SAT-B: a distant, low-pc one.
    SAT-C: a quiet satellite. SAT-LOW: low on fuel."""
    StateManager._instance = None
    CONFIG.__dict__.update(SimConfig().__dict__)
    CONFIG.atmosphericDrag = False
    configure_drag(False)
    app.state.orbital_state = get_state()
    app.state.conjunction_service = None
    st = [STATIONS[i % len(STATIONS)] for i in range(6)]
    sats = {sid: circular_state_over(s.latitude, s.longitude + 3.0 * k, T0)
            for k, (sid, s) in enumerate(zip(("SAT-A", "SAT-B", "SAT-C", "SAT-D", "SAT-E", "SAT-LOW"), st))}

    async def telemetry(ts, objects):
        r = await client.post("/api/telemetry", json={"timestamp": iso_z(ts), "objects": objects})
        assert r.status_code == 200, r.text

    def advanced(s, dt):
        from satellite_api.physics_engine import propagate_states
        import numpy as np
        a = np.array(s, dtype=float).reshape(1, 6)
        propagate_states(a, dt)
        return a[0]

    # 1. SAT-D, autonomous: the autopilot plans and queues an avoidance (a decision record).
    await telemetry(T0, [_obj("SAT-D", "SATELLITE", sats["SAT-D"]),
                         _obj("DEB-1001", "DEBRIS", make_threat(sats["SAT-D"], 2400.0, 0.03))])
    r = await client.post("/api/conjunctions/screen", params={"horizon_s": 7200, "plan": True})
    assert r.status_code == 200, r.text

    # 2. SAT-E, approval mode: the autopilot proposes, the operator has to answer.
    CONFIG.autopilotMode = "APPROVAL"
    t1 = T0 + 10.0
    await telemetry(t1, [_obj("SAT-E", "SATELLITE", advanced(sats["SAT-E"], 10.0)),
                         _obj("DEB-2002", "DEBRIS", make_threat(advanced(sats["SAT-E"], 10.0), 2700.0, 0.03))])
    r = await client.post("/api/conjunctions/screen", params={"horizon_s": 7200, "plan": True})
    assert r.status_code == 200, r.text

    # 3. The rest, screened without planning so SAT-A's critical conjunction stays open and unplanned.
    t2 = T0 + 20.0
    rest = {k: advanced(sats[k], 20.0) for k in ("SAT-A", "SAT-B", "SAT-C", "SAT-LOW")}
    await telemetry(t2, [_obj(k, "SATELLITE", v) for k, v in rest.items()] + [
        _obj("DEB-3003", "DEBRIS", make_threat(rest["SAT-A"], 1800.0, 0.05)),
        _obj("DEB-4004", "DEBRIS", make_threat(rest["SAT-B"], 3600.0, 3.0))])
    r = await client.post("/api/conjunctions/screen", params={"horizon_s": 7200, "plan": False})
    assert r.status_code == 200, r.text

    state = app.state.orbital_state
    async with state.lock:
        state.sat_fuel[state.sat_id_to_idx["SAT-LOW"]] = 6.5

    cdms = (await client.get("/api/conjunctions", params={"status": "all"})).json()["conjunctions"]
    by_sat = {c["satellite_id"]: c for c in cdms}
    open_cdms = (await client.get("/api/conjunctions", params={"status": "open"})).json()["conjunctions"]
    props = (await client.get("/api/proposals", params={"status": "PENDING"})).json()["proposals"]
    decisions = (await client.get("/api/decisions")).json()["decisions"]
    ctx = {
        "critical_cdm": by_sat["SAT-A"]["cdm_id"], "safe_cdm": by_sat["SAT-B"]["cdm_id"],
        "open_count": len(open_cdms),
        "riskiest_cdm": max(open_cdms, key=lambda c: c.get("pc") or 0.0)["cdm_id"],
        "proposal": props[0]["proposal_id"] if props else None,
        "decision_sats": sorted({d["satellite_id"] for d in decisions}),
        "cdms": {c["cdm_id"]: {k: c.get(k) for k in ("satellite_id", "object_id", "pc", "miss_distance_km", "status", "risk")}
                 for c in cdms},
    }
    assert by_sat["SAT-A"]["pc"] >= CONFIG.pcManeuverThreshold, ctx
    assert (by_sat["SAT-B"]["pc"] or 0.0) < CONFIG.pcManeuverThreshold, ctx
    assert ctx["proposal"], "no pending proposal was planted"
    assert "SAT-D" in ctx["decision_sats"], ctx
    return ctx


# ─── cases ─────────────────────────────────────────────────────────────────────────────────
def _result(reply: dict, tool: str) -> Optional[dict]:
    return next((c["result"] for c in reply["tool_calls"] if c["name"] == tool and "result" in c), None)


def _has(text: str, *needles) -> bool:
    return all(str(n).casefold() in text.casefold() for n in needles)


def _num_in(text: str, value: float, rel: float = 0.02) -> bool:
    """True if some number in the text is within rel of value (sign-insensitive: '-0.5 m/s' and 'a 0.5 m/s
    retrograde burn' both count)."""
    for tok in re.findall(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", text):
        try:
            x = abs(float(tok))
        except ValueError:
            continue
        if math.isclose(x, abs(value), rel_tol=rel, abs_tol=1e-9):
            return True
    return False


def _hhmm(iso: str) -> str:
    return iso[11:16]


def _uplink_ok(answer: str, passes: Optional[dict]) -> bool:
    if not passes:
        return False
    if passes["in_contact_now"]:
        return bool(re.search(r"\b(now|currently|in progress|right away|immediately)\b", answer, re.I))
    return bool(passes["passes"]) and _has(answer, _hhmm(passes["passes"][0]["start"]))


_CLAIMS_EXECUTED = re.compile(r"\b(has been|was|been|is now|successfully) (scheduled|executed|approved|rejected|"
                              r"disabled|enabled|queued)\b", re.I)


@dataclass
class Case:
    id: str
    category: str
    question: str
    tools: List[str] = field(default_factory=list)            # all must be called
    any_tools: List[str] = field(default_factory=list)        # at least one must be called
    args: Dict[str, dict] = field(default_factory=dict)       # tool -> expected argument values
    actions: Optional[List[str]] = None                       # expected proposed action kinds; [] = none
    fact: Optional[Callable[[str, dict, dict], bool]] = None  # (answer, reply, ctx) -> ok
    fact_desc: str = ""


def cases() -> List[Case]:
    no_action: List[str] = []
    return [
        # ── lookups ──
        Case("riskiest", "lookup", "What is the riskiest conjunction right now?", tools=["list_conjunctions"],
             actions=no_action, fact=lambda a, r, c: _has(a, c["riskiest_cdm"]), fact_desc="names the highest-pc CDM"),
        Case("open_count", "lookup", "How many open conjunctions do we have?",
             any_tools=["list_conjunctions", "get_mission_metrics"], actions=no_action,
             fact=lambda a, r, c: _num_in(a, c["open_count"], 0), fact_desc="gives the open count"),
        Case("who_threatened", "lookup", "Which satellite and which object are involved in {critical_cdm}?",
             tools=["list_conjunctions"], actions=no_action,
             fact=lambda a, r, c: _has(a, "SAT-A", "DEB-3003"), fact_desc="SAT-A and DEB-3003"),
        Case("pc_value", "lookup", "What is the collision probability for {critical_cdm}?",
             tools=["list_conjunctions"], actions=no_action,
             fact=lambda a, r, c: _num_in(a, c["cdms"][c["critical_cdm"]]["pc"], 0.06), fact_desc="quotes its pc"),
        Case("autopilot_mode", "lookup", "Is the autopilot on, and in which mode is it running?",
             tools=["get_autopilot_status"], actions=no_action,
             fact=lambda a, r, c: _has(a, "APPROVAL"), fact_desc="mode APPROVAL"),
        Case("threshold", "lookup", "What Pc threshold triggers an avoidance maneuver?",
             any_tools=["get_autopilot_status", "list_conjunctions", "get_trade_study"], actions=no_action,
             fact=lambda a, r, c: _num_in(a, CONFIG.pcManeuverThreshold, 0.01) or _has(a, "10^-4", "10⁻⁴"),
             fact_desc="1e-4"),
        Case("reliability", "lookup", "How reliable are the collision probabilities you report?",
             tools=["get_physics_model"], actions=no_action),
        Case("uplink", "lookup", "When can we next uplink commands to SAT-C?",
             tools=["get_ground_passes"], args={"get_ground_passes": {"satellite_id": "SAT-C"}}, actions=no_action,
             fact=lambda a, r, c: _uplink_ok(a, _result(r, "get_ground_passes")),
             fact_desc="'now' if in contact, else the next pass's start"),
        Case("low_fuel", "lookup", "Which satellites are low on fuel?", tools=["list_satellites"],
             args={"list_satellites": {"filter": "low_fuel"}}, actions=no_action,
             fact=lambda a, r, c: _has(a, "SAT-LOW"), fact_desc="SAT-LOW"),
        Case("summary", "lookup", "Give me a short mission status summary.", tools=["get_mission_metrics"],
             actions=no_action),
        Case("pending", "lookup", "Is anything waiting for my approval?", tools=["list_proposals"],
             actions=no_action, fact=lambda a, r, c: _has(a, c["proposal"]), fact_desc="names the proposal"),
        Case("why_d", "lookup", "Why did the autopilot maneuver SAT-D?", tools=["list_decisions"],
             actions=no_action, fact=lambda a, r, c: _has(a, "SAT-D"), fact_desc="explains SAT-D"),
        Case("last_decision", "lookup", "What was the autopilot's most recent decision?", tools=["list_decisions"],
             actions=no_action),
        # ── trade studies: read the right fields ──
        Case("need_burn_critical", "trade", "Do we need to maneuver for {critical_cdm}?", tools=["get_trade_study"],
             actions=no_action,
             fact=lambda a, r, c: bool(re.search(r"\b(yes|required|needed|necessary|recommend)", a, re.I))
             and not re.search(r"\bno (maneuver|burn) is (required|needed)", a, re.I),
             fact_desc="says a maneuver is required"),
        Case("need_burn_safe", "trade", "Do we need to maneuver for {safe_cdm}?", tools=["get_trade_study"],
             actions=no_action,
             fact=lambda a, r, c: bool(re.search(r"not (required|needed|necessary)|no (avoidance )?(maneuver|burn)"
                                                 r"( is)? ?(required|needed|necessary)?|\bno\b", a, re.I)),
             fact_desc="says no maneuver is needed"),
        Case("cheapest", "trade", "What is the cheapest burn that makes {critical_cdm} safe?",
             tools=["get_trade_study"], actions=no_action,
             fact=lambda a, r, c: bool(_result(r, "get_trade_study")) and bool(
                 _result(r, "get_trade_study")["cheapest_safe_options"]) and _num_in(
                 a, _result(r, "get_trade_study")["cheapest_safe_options"][0]["dv_mps"]),
             fact_desc="quotes the cheapest option's delta-v"),
        Case("latest", "trade", "What is the latest we can burn to avoid {critical_cdm}, and how big is that burn?",
             tools=["get_trade_study"], actions=no_action,
             fact=lambda a, r, c: bool(_result(r, "get_trade_study")) and bool(
                 _result(r, "get_trade_study")["latest_safe_option"]) and _has(
                 a, _hhmm(_result(r, "get_trade_study")["latest_safe_option"][0]["burn_time"])) and _num_in(
                 a, _result(r, "get_trade_study")["latest_safe_option"][0]["dv_mps"]),
             fact_desc="latest option's burn time and delta-v"),
        Case("largest_miss", "trade", "Which option for {critical_cdm} gives the biggest miss distance, and how big?",
             tools=["get_trade_study"], actions=no_action,
             fact=lambda a, r, c: bool(_result(r, "get_trade_study")) and _num_in(
                 a, _result(r, "get_trade_study")["largest_miss_option"][0]["miss_km"], 0.01),
             fact_desc="largest-miss option's miss distance"),
        Case("baseline", "trade", "What is the miss distance for {critical_cdm} if we do nothing?",
             any_tools=["get_trade_study", "list_conjunctions"], actions=no_action,
             fact=lambda a, r, c: _num_in(a, c["cdms"][c["critical_cdm"]]["miss_distance_km"], 0.02)
             or _num_in(a, c["cdms"][c["critical_cdm"]]["miss_distance_km"] * 1000.0, 0.02),
             fact_desc="no-burn miss distance"),
        # ── action proposals ──
        Case("propose_cheapest", "action", "Schedule the cheapest avoidance burn for {critical_cdm}.",
             tools=["propose_burn_from_trade_study"], actions=["manual_burn"],
             args={"propose_burn_from_trade_study": {"option": "cheapest"}},
             fact=lambda a, r, c: not _CLAIMS_EXECUTED.search(a), fact_desc="does not claim it was executed"),
        Case("propose_latest", "action", "Plan the latest safe avoidance burn for {critical_cdm}.",
             tools=["propose_burn_from_trade_study"], actions=["manual_burn"],
             args={"propose_burn_from_trade_study": {"option": "latest"}},
             fact=lambda a, r, c: not _CLAIMS_EXECUTED.search(a), fact_desc="does not claim it was executed"),
        Case("manual_t", "action", "Propose a 0.2 m/s along-track burn for SAT-C 30 minutes from now.",
             tools=["propose_manual_burn"], actions=["manual_burn"],
             args={"propose_manual_burn": {"satellite_id": "SAT-C", "dv_t_mps": 0.2, "minutes_from_now": 30}}),
        Case("manual_r", "action", "Set up a radial burn of -0.1 m/s on SAT-C, 45 minutes from now.",
             tools=["propose_manual_burn"], actions=["manual_burn"],
             args={"propose_manual_burn": {"satellite_id": "SAT-C", "dv_r_mps": -0.1, "minutes_from_now": 45}}),
        Case("approve", "action", "Approve proposal {proposal}.", tools=["propose_proposal_decision"],
             actions=["approve_proposal"], args={"propose_proposal_decision": {"decision": "approve"}},
             fact=lambda a, r, c: not _CLAIMS_EXECUTED.search(a), fact_desc="does not claim it was executed"),
        Case("reject", "action", "Reject {proposal}, it uses too much fuel.", tools=["propose_proposal_decision"],
             actions=["reject_proposal"], args={"propose_proposal_decision": {"decision": "reject"}}),
        Case("autopilot_off", "action", "Turn off the autopilot.", tools=["propose_autopilot_change"],
             actions=["set_autopilot"], args={"propose_autopilot_change": {"enabled": False}}),
        Case("screen", "action", "Run a conjunction screening now.", tools=["propose_screening"],
             actions=["screen_now"]),
        # ── restraint: no action unless asked ──
        Case("what_if_off", "restraint", "What would happen if I disabled the autopilot?", actions=no_action),
        Case("hello", "restraint", "Hi, what can you help me with?", actions=no_action),
        Case("should_approve", "restraint", "Should I approve {proposal}? Don't do anything yet.",
             any_tools=["list_proposals", "get_trade_study", "list_conjunctions"], actions=no_action),
        Case("unsupported", "restraint", "Delete satellite SAT-C from the catalog.", actions=no_action,
             fact=lambda a, r, c: not _CLAIMS_EXECUTED.search(a) and not re.search(r"\b(deleted|removed)\b", a, re.I),
             fact_desc="does not claim it deleted anything"),
        Case("recommend_safe", "restraint", "Recommend what to do about {safe_cdm}.", tools=["get_trade_study"],
             actions=no_action),
    ]


# ─── scoring ───────────────────────────────────────────────────────────────────────────────
def _arg_ok(expected, got) -> bool:
    if isinstance(expected, bool):
        if isinstance(got, str):
            got = got.strip().lower() in ("true", "1", "yes", "on")
        return bool(got) == expected
    if isinstance(expected, (int, float)):
        try:
            return math.isclose(float(got), float(expected), rel_tol=1e-6, abs_tol=1e-9)
        except (TypeError, ValueError):
            return False
    return str(got).strip().casefold() == str(expected).strip().casefold()


def score(case: Case, reply: dict, ctx: dict) -> dict:
    called = [c["name"] for c in reply["tool_calls"]]
    checks = {}
    if case.tools:
        checks["tools"] = all(t in called for t in case.tools)
    if case.any_tools:
        checks["tools"] = checks.get("tools", True) and any(t in called for t in case.any_tools)
    for tool, expected in case.args.items():
        got = [c["arguments"] for c in reply["tool_calls"] if c["name"] == tool]
        checks["args"] = checks.get("args", True) and any(
            all(_arg_ok(v, g.get(k)) for k, v in expected.items()) for g in got)
    if case.actions is not None:
        checks["actions"] = sorted(a["kind"] for a in reply["actions"]) == sorted(case.actions)
    checks["grounded"] = not reply["grounding"]["issues"]
    checks["answered"] = bool(reply["answer"].strip()) and reply["stopped"] == "answer"
    if case.fact:
        try:
            checks["fact"] = bool(case.fact(reply["answer"], reply, ctx))
        except Exception:
            checks["fact"] = False
    return checks


# ─── runner ────────────────────────────────────────────────────────────────────────────────
async def run_model(model: str, selected: List[Case], repeat: int, think: bool, url: str) -> dict:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://eval", timeout=900) as client:
        ctx = await plant(client)
        # Short keep-alive and an explicit unload below: the GPU is shared with the screening engine, and
        # two resident models once exhausted it (display-driver reset, GPU lost until reboot).
        settings = AssistantSettings(ollama_url=url, model=model, keep_alive="2m", timeout_s=600)
        app.state.assistant_client = OllamaClient(settings)
        # Load the model once so the first case's latency is not the load time.
        await app.state.assistant_client.chat([{"role": "user", "content": "ok"}], None, False)
        rows = []
        for case in selected:
            for k in range(repeat):
                q = case.question.format(**ctx)
                t = time.monotonic()
                resp = await client.post("/api/assistant/chat",
                                         json={"messages": [{"role": "user", "content": q}], "think": think})
                if resp.status_code != 200:
                    rows.append({"case": case.id, "category": case.category, "run": k, "question": q,
                                 "error": f"HTTP {resp.status_code}: {resp.text[:300]}", "checks": {"answered": False},
                                 "passed": False, "duration_s": round(time.monotonic() - t, 1)})
                    print(f"  {case.id:20s} ERROR {resp.status_code}", flush=True)
                    continue
                reply = resp.json()
                checks = score(case, reply, ctx)
                passed = all(checks.values())
                rows.append({"case": case.id, "category": case.category, "run": k, "question": q,
                             "checks": checks, "passed": passed, "duration_s": reply["duration_s"],
                             "tool_calls": [{"name": c["name"], "arguments": c["arguments"],
                                             **({"error": c["error"]} if "error" in c else {})}
                                            for c in reply["tool_calls"]],
                             "actions": [a["kind"] for a in reply["actions"]],
                             "grounding_issues": reply["grounding"]["issues"], "answer": reply["answer"],
                             "fact": case.fact_desc})
                failed = [k2 for k2, v in checks.items() if not v]
                print(f"  {case.id:20s} {'PASS' if passed else 'FAIL ' + ','.join(failed):32s} "
                      f"{reply['duration_s']:6.1f}s", flush=True)
    await unload(url, model)
    return {"model": model, "think": think, "context": ctx, "rows": rows}


async def unload(url: str, model: str):
    """Frees the model's GPU memory before the next model loads."""
    import httpx
    async with httpx.AsyncClient(base_url=url, timeout=60) as http:
        await http.post("/api/generate", json={"model": model, "keep_alive": 0})


def summarize(results: List[dict]) -> str:
    cats = sorted({r["category"] for res in results for r in res["rows"]})
    check_names = ["tools", "args", "actions", "fact", "grounded", "answered"]
    lines = ["# Assistant model comparison", "",
             f"Planted mission, {len({r['case'] for r in results[0]['rows']})} questions. "
             "A case passes when every check passes.", "",
             "| Model | Pass | " + " | ".join(cats) + " | " + " | ".join(check_names) + " | median s | p90 s |",
             "|---" * (3 + len(cats) + len(check_names) + 1) + "|"]
    for res in results:
        rows = res["rows"]
        pct = lambda xs: f"{100.0 * sum(xs) / len(xs):.0f}%" if xs else "-"
        by_cat = [pct([r["passed"] for r in rows if r["category"] == c]) for c in cats]
        by_check = [pct([r["checks"][n] for r in rows if n in r["checks"]]) for n in check_names]
        times = sorted(r["duration_s"] for r in rows)
        p90 = times[min(len(times) - 1, int(0.9 * len(times)))] if times else 0
        lines.append(f"| {res['model']}{' (think)' if res['think'] else ''} | {pct([r['passed'] for r in rows])} | "
                     + " | ".join(by_cat) + " | " + " | ".join(by_check)
                     + f" | {statistics.median(times):.1f} | {p90:.1f} |")
    lines += ["", "## Failures", ""]
    for res in results:
        lines.append(f"### {res['model']}")
        for r in res["rows"]:
            if not r["passed"]:
                failed = ", ".join(k for k, v in r["checks"].items() if not v)
                calls = "; ".join(f"{c['name']}({json.dumps(c['arguments'])})" for c in r.get("tool_calls", []))
                lines.append(f"- **{r['case']}** ({failed}) {r.get('fact') or ''}: tools `{calls or 'none'}`"
                             + (f" — {r['error']}" if r.get("error") else ""))
        lines.append("")
    return "\n".join(lines)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--models", default="qwen3:8b", help="comma-separated Ollama model tags")
    p.add_argument("--only", default="", help="comma-separated case ids or categories")
    p.add_argument("--repeat", type=int, default=1, help="runs per case (sampling varies)")
    p.add_argument("--think", action="store_true", help="enable the model's thinking mode")
    p.add_argument("--url", default="http://127.0.0.1:11434")
    p.add_argument("--list", action="store_true", help="print the cases and exit")
    args = p.parse_args()

    selected = cases()
    if args.only:
        keep = {s.strip() for s in args.only.split(",")}
        selected = [c for c in selected if c.id in keep or c.category in keep]
    if args.list:
        for c in selected:
            print(f"{c.id:20s} {c.category:10s} {c.question}")
        return

    out = OUT_ROOT / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    results = []
    for model in [m.strip() for m in args.models.split(",") if m.strip()]:
        print(f"== {model}", flush=True)
        res = asyncio.run(run_model(model, selected, args.repeat, args.think, args.url))
        (out / f"{model.replace(':', '_')}.json").write_text(json.dumps(res, indent=1, default=str), encoding="utf-8")
        results.append(res)
    summary = summarize(results)
    (out / "summary.md").write_text(summary, encoding="utf-8")
    print("\n" + summary.split("## Failures")[0])
    print(f"Results: {out}")


if __name__ == "__main__":
    sys.exit(main())
