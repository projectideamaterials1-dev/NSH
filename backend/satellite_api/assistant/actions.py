"""
assistant/actions.py
--------------------
Tools that let the assistant *propose* an operator action. Nothing here executes anything: a
proposal is validated (burns through the engine's own dry run, evaluate_sequence) and returned as
an action card. The dashboard shows the card and, only when the operator clicks Confirm, calls the
existing endpoint for that kind with the operator's own key - so the usual validation, auth and
audit trail apply, and the model never chooses a URL:

  kind               confirmed via
  manual_burn        POST /api/maneuver/manual (dry_run=false)    burns are re-validated there
  approve_proposal   POST /api/proposals/{id}/approve              burns are re-targeted there
  reject_proposal    POST /api/proposals/{id}/reject
  set_autopilot      PUT  /api/autopilot
  screen_now         POST /api/conjunctions/screen

Burns are time-tagged commands: the engine checks ground-station line of sight when a burn is
*scheduled* (uplinked), not when it fires. So a burn card carries the contact window it can be
confirmed in, and trade-study burns are only picked if they fire after that window opens.
"""
import math
import uuid
from typing import Optional

from fastapi import Request

from satellite_api.acm.plugins import PLUGINS
from satellite_api.assistant.tools import Tool, ToolError, _choice, _satellite_id, _trade_study
from satellite_api.config import CONFIG
from satellite_api.ground_stations import STATIONS
from satellite_api.routers import operations
from satellite_api.timeutils import iso_z, parse_iso_utc

NOT_EXECUTED = "Not executed. The operator must review this card and click Confirm in the dashboard."
# Proposed burns start at least this far after the operator can first confirm them, so there is time
# to read the card (the trade study's earliest option is 15 s out - expired before anyone can click).
MIN_LEAD_S = 120.0
# A contact window must stay open at least this long to be worth confirming in.
MIN_CONTACT_S = 60.0
_AXIS_KEY = {"T": "t", "R": "r", "N": "n"}


def _action(kind: str, title: str, params: dict, preview: dict, valid: bool = True, warnings=(), expires=None,
            confirm_window: Optional[dict] = None) -> dict:
    return {"proposed_action": {
        "action_id": f"ACT-{uuid.uuid4().hex[:8]}", "kind": kind, "title": title, "params": params,
        "preview": preview, "valid": valid, "warnings": list(warnings), "expires": expires,
        "confirm_window": confirm_window,
    }, "note": NOT_EXECUTED}


async def _uplink_window(request: Request, sat_id: str, until_ts: float) -> Optional[dict]:
    """The first ground contact, now or ahead and opening before until_ts, that stays open at least
    MIN_CONTACT_S. Passes over different stations that overlap are merged. None if there is none."""
    state = request.app.state.orbital_state
    operations._require_ready(state)
    now_ts = state.now_ts
    if not STATIONS:  # no stations configured: the engine skips the line-of-sight check
        return {"from_ts": now_ts, "until_ts": math.inf, "in_contact_now": True, "stations": []}
    hours = min(48.0, max(0.05, (until_ts - now_ts) / 3600.0))
    passes = (await operations.ground_station_passes(request, sat_id, hours=hours, step_s=30.0))["passes"]
    windows = []
    for p in passes:  # sorted by start
        start, end = parse_iso_utc(p["start"]).timestamp(), parse_iso_utc(p["end"]).timestamp()
        if windows and start <= windows[-1]["until_ts"]:
            windows[-1]["until_ts"] = max(windows[-1]["until_ts"], end)
            windows[-1]["stations"].append(p["station_name"])
        else:
            windows.append({"from_ts": start, "until_ts": end, "in_contact_now": p["in_progress"],
                            "stations": [p["station_name"]]})
    for w in windows:
        if w["from_ts"] < until_ts and w["until_ts"] - max(w["from_ts"], now_ts) >= MIN_CONTACT_S:
            w["from_ts"] = max(w["from_ts"], now_ts)
            return w
    return None


def _confirm_window(window: dict, burn_ts: float) -> dict:
    """What the dashboard gates Confirm on: inside the contact and before the burn time."""
    return {"from": iso_z(window["from_ts"]), "until": iso_z(min(window["until_ts"], burn_ts)),
            "stations": sorted(set(window["stations"]))}


def _float(args: dict, key: str, default: Optional[float] = None) -> float:
    value = args.get(key, default)
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise ToolError(f"{key} must be a number")
    if not math.isfinite(value):
        raise ToolError(f"{key} must be finite")
    return value


_CHECK_REASON = {"cooldown": "COOLDOWN_ACTIVE", "max_delta_v": "MAX_THRUST_EXCEEDED", "fuel": "INSUFFICIENT_FUEL"}


async def _dry_run_burn(request: Request, sat_id: str, burn_time: str, dv_rtn: dict, title: str, extra: dict,
                        warnings: list, window: Optional[dict]) -> dict:
    total = math.sqrt(sum(v * v for v in dv_rtn.values()))
    if total <= 0.0:
        raise ToolError("The burn has zero delta-v")
    if total > CONFIG.maxDeltaV:
        warnings.append(f"Delta-v {total:.3f} m/s exceeds the per-burn limit of {CONFIG.maxDeltaV} m/s")
    burn = {"burnTime": burn_time, "frame": "RTN", "dv_mps": dv_rtn}
    plan = operations.ManualPlanRequest(satelliteId=sat_id, burns=[operations.ManualBurn(**burn)], dry_run=True)
    check = await operations.manual_maneuver(plan, request)

    # Line of sight is checked at the uplink, so "not in contact now" only means "confirm later".
    failed = [_CHECK_REASON[name] for name, ok in check["checks"].items() if not ok and name in _CHECK_REASON]
    if failed:
        warnings.append(f"The engine's dry run rejected this burn: {', '.join(failed)}")
    burn_ts = parse_iso_utc(burn_time).timestamp()
    confirm = None
    if window is None:
        warnings.append("No ground-station contact before the burn time: the burn cannot be uplinked.")
    elif window["from_ts"] + MIN_LEAD_S > burn_ts:
        lead_min = math.ceil((window["from_ts"] + MIN_LEAD_S - request.app.state.orbital_state.now_ts) / 60.0)
        warnings.append(f"The next ground contact opens at {iso_z(window['from_ts'])[11:19]}Z, too late to uplink "
                        f"this burn: it must be at least {lead_min} minutes from now.")
        window = None
    else:
        confirm = _confirm_window(window, burn_ts)
        if not window["in_contact_now"]:
            warnings.append(f"{sat_id} is not in ground contact now (the dry run's NO_LINE_OF_SIGHT). Confirm "
                            f"opens at {confirm['from'][11:19]}Z ({', '.join(confirm['stations'])}) and closes at "
                            f"{confirm['until'][11:19]}Z.")
    valid = not failed and window is not None
    preview = {"satellite_id": sat_id, "burn_time": burn_time, "frame": "RTN", "dv_mps": dv_rtn,
               "total_dv_mps": round(total, 4), "dry_run_status": check["status"], "checks": check["checks"],
               "uplink_window": confirm,
               "fuel_needed_kg": check["fuel_needed_kg"], "available_fuel_kg": check["available_fuel_kg"],
               "orbit_before": check["orbit_before"], "orbit_after": check["orbit_after"], **extra}
    return _action("manual_burn", title, {"satellite_id": sat_id, "burns": [burn]}, preview, valid, warnings,
                   expires=burn_time, confirm_window=confirm)


async def _propose_trade_study_burn(request: Request, args: dict):
    option = _choice(args, "option", "cheapest", ("cheapest", "latest", "largest_miss"))
    state = request.app.state.orbital_state
    operations._require_ready(state)
    cdm_id = str(args.get("cdm_id") or "").strip().upper()
    async with state.lock:
        cdm = next(({"sat": c["satellite_id"], "tca_ts": c["tca_ts"]} for c in state.cdms.items
                    if c["cdm_id"] == cdm_id), None)
        now_ts = state.now_ts
    # Unknown ids fall through to the trade study's own error.
    window = None if cdm is None else await _uplink_window(request, cdm["sat"], cdm["tca_ts"])
    if cdm is not None and window is None:
        raise ToolError(f"{cdm['sat']} has no ground-station contact before the TCA of {cdm_id}, so no avoidance "
                        f"burn can be uplinked in time.")
    lead_s = MIN_LEAD_S if window is None else window["from_ts"] - now_ts + MIN_LEAD_S
    study = await _trade_study(request, args, min_lead_s=lead_s)
    picked = {"cheapest": study["cheapest_safe_options"], "latest": study["latest_safe_option"],
              "largest_miss": study["largest_miss_option"]}[option]
    if not picked:
        opens = "" if window is None or window["in_contact_now"] else \
            f" (the next ground contact, when it can be uplinked, opens at {iso_z(window['from_ts'])[11:19]}Z)"
        raise ToolError(f"The trade study has no {option} option below the pc threshold for {study['cdm_id']} "
                        f"that burns at least {lead_s / 60:.0f} minutes from now{opens}")
    opt = picked[0]
    warnings = []
    if not study["maneuver_required"]:
        warnings.append("The no-burn pc is already below the threshold: no maneuver is required.")
    if study["planned_burn"]:
        warnings.append(f"A mitigation burn is already planned for this conjunction ({study['planned_burn']['burn_id']}).")
    warnings.append("Single avoidance burn only: no recovery burn back to the slot is included.")
    dv = {_AXIS_KEY[study["axis"]]: opt["dv_mps"]}
    title = (f"{study['satellite_id']}: {opt['dv_mps']:+g} m/s {study['axis_meaning']} burn at "
             f"{opt['burn_time'][11:19]}Z to avoid {study['object_id']} ({study['cdm_id']})")
    extra = {"cdm_id": study["cdm_id"], "trade_option": option, "predicted_miss_km": opt["miss_km"],
             "predicted_pc": opt["pc"], "baseline_no_burn": study["baseline_no_burn"],
             "pc_threshold": study["pc_threshold"], "minutes_before_tca": opt["minutes_before_tca"]}
    return await _dry_run_burn(request, study["satellite_id"], opt["burn_time"], dv, title, extra, warnings, window)


async def _propose_manual_burn(request: Request, args: dict):
    sat_id = _satellite_id(request, args, True)
    minutes = _float(args, "minutes_from_now")
    if not MIN_LEAD_S / 60.0 <= minutes <= 1440:
        raise ToolError(f"minutes_from_now must be between {MIN_LEAD_S / 60:g} and 1440")
    dv = {k: _float(args, f"dv_{k}_mps", 0.0) for k in ("r", "t", "n")}
    dv = {k: v for k, v in dv.items() if v != 0.0}
    state = request.app.state.orbital_state
    operations._require_ready(state)
    burn_ts = state.now_ts + minutes * 60.0
    burn_time = iso_z(burn_ts)
    parts = ", ".join(f"{v:+g} m/s {k.upper()}" for k, v in dv.items()) or "0 m/s"
    title = f"{sat_id}: manual burn ({parts}) at {burn_time[11:19]}Z"
    # Look past the burn time too, so a burn set before the next contact can say how late it must be.
    window = await _uplink_window(request, sat_id, burn_ts + 3 * 3600.0)
    return await _dry_run_burn(request, sat_id, burn_time, dv, title, {}, [], window)


async def _propose_proposal_answer(request: Request, args: dict):
    decision = _choice(args, "decision", "", ("approve", "reject"))
    pid = str(args.get("proposal_id") or "").strip()
    state = request.app.state.orbital_state
    async with state.lock:
        prop = next((p for k, p in state.proposals.items() if k.casefold() == pid.casefold()), None)
        prop = None if prop is None else {k: v for k, v in prop.items() if not k.startswith("_")}
    if prop is None:
        raise ToolError(f"Proposal {pid!r} not found; use list_proposals")
    if prop["status"] != "PENDING":
        raise ToolError(f"Proposal {prop['proposal_id']} is {prop['status']}, not PENDING")
    reason = str(args.get("reason") or "")[:500]
    params = {"proposal_id": prop["proposal_id"]} | ({"reason": reason} if decision == "reject" else {})
    title = f"{decision.capitalize()} proposal {prop['proposal_id']} for {prop['satellite_id']}"
    preview = {k: prop.get(k) for k in ("proposal_id", "satellite_id", "kind", "rationale", "burns", "fuel_kg",
                                        "cdm_ids", "expires_at")}
    return _action(f"{decision}_proposal", title, params, preview, expires=prop.get("expires_at"))


async def _propose_autopilot(request: Request, args: dict):
    params = {}
    if args.get("enabled") is not None:
        value = args["enabled"]
        if isinstance(value, str):
            value = value.strip().lower() in ("true", "1", "yes", "on")
        params["enabled"] = bool(value)
    if args.get("strategy"):
        params["strategy"] = _choice(args, "strategy", "", tuple(PLUGINS))
    if not params:
        raise ToolError("Give enabled and/or strategy")
    current = {"enabled": CONFIG.autopilotEnabled, "strategy": CONFIG.avoidanceStrategy}
    changes = ", ".join(f"{k} {current[k]} -> {v}" for k, v in params.items())
    warnings = ["Disabling the autopilot stops automatic collision avoidance for the whole fleet."] \
        if params.get("enabled") is False and CONFIG.autopilotEnabled else []
    return _action("set_autopilot", f"Autopilot: {changes}", params, {"current": current, "new": params},
                   warnings=warnings)


async def _propose_screening(request: Request, args: dict):
    return _action("screen_now", "Run conjunction screening now", {},
                   {"horizon_s": CONFIG.cdmHorizonSeconds, "warning_km": CONFIG.cdmWarningKm,
                    "autopilot_plans_after": CONFIG.autopilotEnabled})


ACTION_TOOLS = [
    Tool("propose_burn_from_trade_study",
         "Propose an avoidance burn taken from a conjunction's trade study (cheapest, latest or largest-miss option). "
         "Only burns that fire after the next ground contact opens are considered, because a burn can only be "
         "uplinked in contact; the card says when it can be confirmed. The engine dry-runs it. NOT executed: the "
         "operator must confirm it in the dashboard.",
         {"type": "object", "required": ["cdm_id"], "properties": {
             "cdm_id": {"type": "string", "description": "Conjunction id, e.g. 'CDM-00018'"},
             "option": {"type": "string", "enum": ["cheapest", "latest", "largest_miss"]},
             "axis": {"type": "string", "enum": ["T", "R", "N"], "description": "Burn direction, default T"}}},
         _propose_trade_study_burn),
    Tool("propose_manual_burn",
         "Propose a single RTN burn for a satellite at a time from now. It must be confirmed during a ground "
         "contact before the burn time (see get_ground_passes). The engine dry-runs it. NOT executed: the "
         "operator must confirm it. Prefer propose_burn_from_trade_study for collision avoidance.",
         {"type": "object", "required": ["satellite_id", "minutes_from_now"], "properties": {
             "satellite_id": {"type": "string"},
             "minutes_from_now": {"type": "number"},
             "dv_r_mps": {"type": "number", "description": "Radial delta-v, m/s"},
             "dv_t_mps": {"type": "number", "description": "Along-track delta-v, m/s"},
             "dv_n_mps": {"type": "number", "description": "Cross-track delta-v, m/s"}}},
         _propose_manual_burn),
    Tool("propose_proposal_decision",
         "Propose approving or rejecting a PENDING autopilot maneuver proposal. NOT executed: the operator must confirm.",
         {"type": "object", "required": ["proposal_id", "decision"], "properties": {
             "proposal_id": {"type": "string"},
             "decision": {"type": "string", "enum": ["approve", "reject"]},
             "reason": {"type": "string", "description": "Why (for a rejection)"}}},
         _propose_proposal_answer),
    Tool("propose_autopilot_change",
         "Propose enabling/disabling the autopilot or changing its avoidance strategy. NOT executed: the operator "
         "must confirm.",
         {"type": "object", "properties": {
             "enabled": {"type": "boolean"},
             "strategy": {"type": "string", "enum": list(PLUGINS)}}},
         _propose_autopilot),
    Tool("propose_screening",
         "Propose running conjunction screening immediately. NOT executed: the operator must confirm.",
         {"type": "object", "properties": {}}, _propose_screening),
]
