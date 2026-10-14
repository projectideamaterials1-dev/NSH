"""
assistant/tools.py
------------------
Read-only tools the assistant can call. Each one wraps an existing route handler, so the model
sees exactly what the dashboard sees and no physics is re-implemented here. Results are trimmed
to the fields an explanation needs - a small local model has an 8k-token context to work in.

Nothing here can change mission state. Actions (burns, proposal answers, autopilot changes) can
only be proposed (actions.py) and are executed by the dashboard after the operator confirms.
"""
import copy
import json
import logging
import math
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict, List, Optional

from fastapi import HTTPException, Request

from satellite_api.config import CONFIG
from satellite_api.routers import operations
from satellite_api.timeutils import iso_z, parse_iso_utc

logger = logging.getLogger(__name__)

MAX_RESULT_CHARS = 12000
_CDM_FIELDS = ("cdm_id", "satellite_id", "object_id", "object_type", "tca", "miss_distance_km",
               "relative_velocity_kms", "pc", "pc_max", "pc_diluted", "pc_trend", "short_encounter_valid", "pc_mc",
               "object_maneuvered",
               "risk", "status", "safe_miss_km", "mitigation_burn_ids")


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: dict
    handler: Callable[[Request, dict], Awaitable[object]]

    def spec(self) -> dict:
        return {"type": "function",
                "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


class ToolError(ValueError):
    """A bad tool argument; the message goes back to the model so it can correct the call."""


# ─── argument helpers (small models send strings for numbers, wrong case for IDs, ...) ──
def _int(args: dict, key: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(float(args.get(key, default)))))
    except (TypeError, ValueError):
        raise ToolError(f"{key} must be an integer")


def _choice(args: dict, key: str, default: str, choices: tuple) -> str:
    value = str(args.get(key) or default)
    for c in choices:
        if c.lower() == value.lower():
            return c
    raise ToolError(f"{key} must be one of {list(choices)}")


def _satellite_id(request: Request, args: dict, required: bool) -> Optional[str]:
    raw = str(args.get("satellite_id") or "").strip()
    if not raw:
        if required:
            raise ToolError("satellite_id is required")
        return None
    known = request.app.state.orbital_state.sat_id_to_idx
    if raw in known:
        return raw
    folded = [s for s in known if s.casefold() == raw.casefold()]
    partial = folded or [s for s in known if raw.casefold() in s.casefold()]
    if len(partial) == 1:
        return partial[0]
    if partial:
        raise ToolError(f"satellite_id {raw!r} is ambiguous: {sorted(partial)[:8]}")
    raise ToolError(f"Unknown satellite {raw!r}; use list_satellites to find the exact id")


def _cdm_id(args: dict) -> str:
    raw = str(args.get("cdm_id") or "").strip().upper()
    if not raw:
        raise ToolError("cdm_id is required")
    return raw


def _minutes_until(request: Request, ts: Optional[float]) -> Optional[float]:
    now = request.app.state.orbital_state.now_ts if request.app.state.orbital_state.is_ready() else None
    return None if ts is None or now is None else round((ts - now) / 60.0, 1)


# ─── tools ─────────────────────────────────────────────────────────────────────────────
async def _list_conjunctions(request: Request, args: dict):
    status = _choice(args, "status", "open", ("open", "all"))
    limit = _int(args, "limit", 10, 1, 25)
    data = await operations.list_conjunctions(request, status=status, satellite_id=_satellite_id(request, args, False),
                                              limit=500)
    items = sorted(data["conjunctions"], key=lambda c: (-(c.get("pc") or 0.0), c["miss_distance_km"]))
    rows = []
    for c in items[:limit]:
        row = {k: c.get(k) for k in _CDM_FIELDS}
        row["minutes_to_tca"] = _minutes_until(request, c.get("tca_ts"))
        rows.append(row)
    return {"pc_maneuver_threshold": CONFIG.pcManeuverThreshold, "total_matching": len(items),
            "sorted_by": "pc descending, then miss distance", "conjunctions": rows, "counts": data["counts"]}


def _option(o: dict, now_ts: float, tca_ts: float) -> dict:
    # One absolute time plus one relative clock: given both "minutes from now" and "minutes before
    # TCA", qwen3:8b swapped them in live tests. An absolute UTC time can't be misread that way.
    burn_ts = now_ts + o["burn_offset_s"]
    return {"burn_time": iso_z(burn_ts), "minutes_before_tca": round((tca_ts - burn_ts) / 60.0, 1),
            "dv_mps": o["dv_mps"], "miss_km": round(o["miss_km"], 3), "pc": o["pc"], "fuel_kg": round(o["fuel_kg"], 4)}


async def _trade_study(request: Request, args: dict, min_lead_s: float = 0.0):
    """min_lead_s drops options that burn sooner than that - a proposal needs time to be read and confirmed."""
    axis = _choice(args, "axis", "T", ("T", "R", "N"))
    data = await operations.conjunction_tradespace(_cdm_id(args), request, axis=axis, n_times=8, n_dv=11)
    threshold = data["pc_threshold"]
    now_ts = parse_iso_utc(data["computed_at"]).timestamp()
    tca_ts = parse_iso_utc(data["tca"]).timestamp()
    baseline_pc = data["baseline"].get("pc")
    required = baseline_pc is not None and baseline_pc >= threshold
    burns = [o for o in data["grid"] if o["dv_mps"] != 0.0 and o["burn_offset_s"] >= min_lead_s]
    safe = [o for o in burns if o["pc"] is not None and o["pc"] < threshold]
    # The refined minimum Δv per burn time (bisected between grid cells) beats the coarse grid when present.
    refined = [o for o in data.get("min_dv_options", []) if o["burn_offset_s"] >= min_lead_s
               and o["pc"] is not None and o["pc"] < threshold]
    cheapest = (refined or sorted(safe, key=lambda o: (abs(o["dv_mps"]), -o["miss_km"])))[:3]
    latest = sorted(safe, key=lambda o: (-o["burn_offset_s"], abs(o["dv_mps"])))[:1]
    widest = sorted(burns, key=lambda o: -o["miss_km"])[:1]
    return {
        "cdm_id": data["cdm_id"], "satellite_id": data["satellite_id"], "object_id": data["object_id"],
        "now": data["computed_at"], "tca": data["tca"], "minutes_to_tca": round((tca_ts - now_ts) / 60.0, 1),
        "axis": data["axis"], "axis_meaning": {"T": "along-track", "R": "radial", "N": "cross-track"}[data["axis"]],
        "pc_threshold": threshold, "baseline_no_burn": data["baseline"],
        "maneuver_required": required,
        "assessment": ("The no-burn pc is at or above the threshold: an avoidance maneuver is required."
                       if required else "The no-burn pc is below the threshold: no maneuver is required. "
                       "The options below are for reference only."),
        "planned_burn": data["planned_burn"],
        "options_evaluated": len(burns), "options_below_threshold": len(safe),
        "cheapest_safe_options": [_option(o, now_ts, tca_ts) for o in cheapest],
        "latest_safe_option": [_option(o, now_ts, tca_ts) for o in latest],
        "largest_miss_option": [_option(o, now_ts, tca_ts) for o in widest],
    }


async def _list_decisions(request: Request, args: dict):
    data = await operations.list_decisions(request, satellite_id=_satellite_id(request, args, False),
                                           limit=_int(args, "limit", 5, 1, 10))
    # These are the live records in state.decisions - copy before trimming.
    decisions = copy.deepcopy(data["decisions"])
    for d in decisions:
        for b in d.get("burns", []):
            b.pop("ts", None)
    return {"decisions": decisions}


async def _list_proposals(request: Request, args: dict):
    data = await operations.list_proposals(request, status=_choice(args, "status", "PENDING", ("PENDING", "all")))
    data["proposals"] = data["proposals"][:_int(args, "limit", 5, 1, 10)]
    return data


async def _list_satellites(request: Request, args: dict):
    only = _choice(args, "filter", "all", ("all", "threatened", "outside_box", "low_fuel"))
    limit = _int(args, "limit", 15, 1, 25)
    sat_id = _satellite_id(request, args, False)
    sats = (await operations.satellites(request))["satellites"]
    keep = {
        "all": lambda s: True,
        "threatened": lambda s: s.get("threat") is not None,
        "outside_box": lambda s: not s.get("in_box", True),
        "low_fuel": lambda s: s.get("fuel_kg", math.inf) <= CONFIG.lowFuelWarning,
    }[only]
    rows = [s for s in sats if (s["id"] == sat_id if sat_id else keep(s))]
    return {"fleet_size": len(sats), "filter": only, "matching": len(rows), "satellites": rows[:limit],
            "low_fuel_warning_kg": CONFIG.lowFuelWarning, "box_radius_km": CONFIG.stationKeepingRadius}


async def _ground_passes(request: Request, args: dict):
    hours = _int(args, "hours", 6, 1, 24)
    data = await operations.ground_station_passes(request, _satellite_id(request, args, True), hours=hours, step_s=30.0)
    # The answer to "when can we uplink?", spelled out: given only the pass list, qwen3:8b led with the
    # next pass even while a pass was in progress.
    current = next((p for p in data["passes"] if p["in_progress"]), None)
    upcoming = next((p for p in data["passes"] if not p["in_progress"]), None)
    if current:
        data["next_uplink"] = (f"NOW: in contact with {current['station_name']} until {current['end']}. "
                               "Commands can be uplinked immediately.")
    elif upcoming:
        data["next_uplink"] = f"Not in contact now. Next contact: {upcoming['station_name']} from {upcoming['start']}."
    else:
        data["next_uplink"] = f"No ground contact in the next {hours} h."
    return {"next_uplink": data.pop("next_uplink"), **data}


async def _mission_metrics(request: Request, args: dict):
    return await operations.mission_metrics(request)


async def _autopilot_status(request: Request, args: dict):
    return {**await operations.get_autopilot(), "mode": CONFIG.autopilotMode,
            "approval_timeout_s": CONFIG.approvalTimeoutSeconds, "approval_timeout_action": CONFIG.approvalTimeoutAction,
            "pc_maneuver_threshold": CONFIG.pcManeuverThreshold, "max_delta_v_mps": CONFIG.maxDeltaV}


async def _physics_model(request: Request, args: dict):
    return await operations.physics_model()


_SAT_ARG = {"type": "string", "description": "Exact satellite id, e.g. 'RISAT-1' (optional)."}
TOOLS: List[Tool] = [
    Tool("list_conjunctions",
         "Predicted close approaches (conjunctions, CDMs) between our satellites and other objects, most dangerous "
         "first: miss distance, collision probability (pc), time of closest approach (tca), risk and status.",
         {"type": "object", "properties": {
             "satellite_id": _SAT_ARG,
             "status": {"type": "string", "enum": ["open", "all"], "description": "open (default) or all incl. resolved"},
             "limit": {"type": "integer", "description": "Max rows, default 10"}}},
         _list_conjunctions),
    Tool("get_trade_study",
         "Avoidance-maneuver trade study for one conjunction: the engine simulates single burns over a grid of burn "
         "times and delta-v and reports the resulting miss distance and pc. Returns the no-burn baseline, the burn "
         "already planned (if any), and the cheapest, latest and largest-miss options.",
         {"type": "object", "required": ["cdm_id"], "properties": {
             "cdm_id": {"type": "string", "description": "Conjunction id, e.g. 'CDM-00018'"},
             "axis": {"type": "string", "enum": ["T", "R", "N"],
                      "description": "Burn direction: T along-track (default), R radial, N cross-track"}}},
         _trade_study),
    Tool("list_decisions",
         "The autopilot's recent decisions, newest first, each with its plain-language rationale, the options it "
         "considered, the burns it chose and the outcome. Use this to explain why the system did something.",
         {"type": "object", "properties": {"satellite_id": _SAT_ARG,
                                           "limit": {"type": "integer", "description": "Max rows, default 5"}}},
         _list_decisions),
    Tool("list_proposals",
         "Maneuver proposals waiting for operator approval (APPROVAL mode), or all proposals.",
         {"type": "object", "properties": {
             "status": {"type": "string", "enum": ["PENDING", "all"]},
             "limit": {"type": "integer", "description": "Max rows, default 5"}}},
         _list_proposals),
    Tool("list_satellites",
         "Our satellites with position, altitude, fuel, station-keeping drift and current threat level. "
         "Give satellite_id for one satellite, or a filter.",
         {"type": "object", "properties": {
             "satellite_id": _SAT_ARG,
             "filter": {"type": "string", "enum": ["all", "threatened", "outside_box", "low_fuel"]},
             "limit": {"type": "integer", "description": "Max rows, default 15"}}},
         _list_satellites),
    Tool("get_ground_passes",
         "Upcoming ground-station contact windows for one satellite (when commands can be uplinked).",
         {"type": "object", "required": ["satellite_id"], "properties": {
             "satellite_id": {"type": "string", "description": "Exact satellite id"},
             "hours": {"type": "integer", "description": "Look-ahead in hours, default 6"}}},
         _ground_passes),
    Tool("get_mission_metrics",
         "Mission scorecard: fleet size, conjunctions by status and risk, burns executed, fuel used, "
         "station-keeping uptime and the last screening run.",
         {"type": "object", "properties": {}}, _mission_metrics),
    Tool("get_autopilot_status",
         "Whether the autopilot is enabled, its mode (AUTONOMOUS or APPROVAL), avoidance strategy, "
         "Pc maneuver threshold and delta-v limit.",
         {"type": "object", "properties": {}}, _autopilot_status),
    Tool("get_physics_model",
         "The force model, propagator, collision-probability method and covariance assumptions in use, "
         "plus the fidelity caveats. Use this when asked how reliable, accurate or trustworthy the numbers, "
         "predictions or collision probabilities are.",
         {"type": "object", "properties": {}}, _physics_model),
]
def all_tools() -> List[Tool]:
    """Read-only tools plus the action-proposal tools (actions.py imports this module, hence the late import)."""
    from satellite_api.assistant.actions import ACTION_TOOLS
    return TOOLS + ACTION_TOOLS


def specs(actions: bool = True) -> List[dict]:
    """actions=False leaves out the propose_* tools (the operator asked a question, not for an action)."""
    return [t.spec() for t in all_tools() if actions or not t.name.startswith("propose_")]


async def call(name: str, request: Request, args: Optional[dict]) -> dict:
    """Runs one tool. Errors come back as {"error": ...} so the model can recover instead of the request failing."""
    by_name: Dict[str, Tool] = {t.name: t for t in all_tools()}
    tool = by_name.get(name)
    if tool is None:
        return {"error": f"Unknown tool {name!r}. Available: {sorted(by_name)}"}
    if not isinstance(args, dict):
        args = {}
    logger.info("assistant tool call", extra={"tool_name": name, "tool_args": args,
                                               "actor": getattr(request.state, "actor", "unknown")})
    try:
        return {"result": await tool.handler(request, args)}
    except ToolError as e:
        return {"error": str(e)}
    except HTTPException as e:
        return {"error": str(e.detail)}


def to_model_text(outcome: dict) -> str:
    text = json.dumps(outcome, default=str, separators=(",", ":"))
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + " ...(truncated; ask for fewer rows)"
    return text
