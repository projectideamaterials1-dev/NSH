"""
routers/operations.py
---------------------
Operations API used by the dashboard (the PS endpoints are unchanged):

  GET  /api/conjunctions                 predicted conjunctions (CDMs)
  POST /api/conjunctions/screen          run screening (+ autopilot) now
  GET  /api/events                       operator event feed
  GET  /api/metrics                      mission scorecard
  GET  /api/autopilot  | PUT /api/autopilot
  GET  /api/avoidance/strategies         available avoidance plugins
  GET  /api/satellites                   per-satellite operational details (incl. altitude)
  GET  /api/satellites/{id}/track        predicted ground track
  GET  /api/satellites/{id}/passes       ground-station contact windows
  POST /api/maneuver/manual              plan (dry run) or schedule an RTN/ECI burn sequence
  GET  /api/archive/maneuvers | /api/archive/events   persisted history (SQLite)
"""
import math
from datetime import timedelta
from typing import List, Literal, Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from satellite_api.acm.autopilot import ConjunctionService
from satellite_api.acm.plugins import PLUGINS
from satellite_api.acm.scheduler import BurnRequest, evaluate_sequence, queue_burns
from satellite_api.config import CONFIG, save_config
from satellite_api.coordinates import convert_states_to_lla
from satellite_api.gravity import PRESETS, GravityModel
from satellite_api.ground_stations import STATIONS, elevations_deg, visible_mask
from satellite_api.physics_engine import propagate_states
from satellite_api.timeutils import iso_z, parse_iso_utc

router = APIRouter()
MU_EARTH = 398600.4418
R_EARTH = 6378.137


# ============================================================================
# helpers
# ============================================================================
def get_service_for_state(app, state) -> ConjunctionService:
    service = getattr(app.state, "conjunction_service", None)
    if service is None or service.state is not state:
        service = ConjunctionService(state)
        app.state.conjunction_service = service
    return service


def get_service(request: Request) -> ConjunctionService:
    return get_service_for_state(request.app, request.app.state.orbital_state)


def _require_ready(state):
    if not state.is_ready() or state.current_time is None:
        raise HTTPException(status_code=400, detail="State not initialized.")


def _sat_index(state, sat_id: str) -> int:
    idx = state.sat_id_to_idx.get(sat_id)
    if idx is None:
        raise HTTPException(status_code=404, detail=f"Satellite {sat_id} not found.")
    return idx


def _rtn_basis(r: np.ndarray, v: np.ndarray) -> np.ndarray:
    r_hat = r / np.linalg.norm(r)
    n_hat = np.cross(r, v)
    n_hat /= np.linalg.norm(n_hat)
    return np.column_stack([r_hat, np.cross(n_hat, r_hat), n_hat])


def _orbit_summary(state_vec: np.ndarray) -> dict:
    r, v = state_vec[:3], state_vec[3:]
    rn, vn = np.linalg.norm(r), np.linalg.norm(v)
    energy = vn ** 2 / 2 - MU_EARTH / rn
    a = -MU_EARTH / (2 * energy)
    h = np.cross(r, v)
    e_vec = np.cross(v, h) / MU_EARTH - r / rn
    e = float(np.linalg.norm(e_vec))
    return {
        "semi_major_axis_km": round(float(a), 3),
        "eccentricity": round(e, 6),
        "perigee_alt_km": round(float(a * (1 - e) - R_EARTH), 3),
        "apogee_alt_km": round(float(a * (1 + e) - R_EARTH), 3),
        "inclination_deg": round(math.degrees(math.acos(h[2] / np.linalg.norm(h))), 4),
        "period_min": round(2 * math.pi * math.sqrt(a ** 3 / MU_EARTH) / 60.0, 3),
    }


# ============================================================================
# conjunctions, events, metrics, autopilot
# ============================================================================
@router.get("/api/conjunctions", tags=["Operations"])
async def list_conjunctions(
    request: Request,
    status: Optional[str] = Query("open", description="open | all | ACTIVE | MITIGATED | CLEARED | RESOLVED | COLLIDED"),
    satellite_id: Optional[str] = None,
    limit: int = Query(500, ge=1, le=2000),
):
    state = request.app.state.orbital_state
    async with state.lock:
        items = state.cdms.list(None if status == "all" else status, satellite_id)[:limit]
        return {"conjunctions": items, "counts": state.cdms.counts(), "last_screen": state.last_screen}


@router.post("/api/conjunctions/screen", tags=["Operations"])
async def screen_now(
    request: Request,
    horizon_s: Optional[float] = Query(None, ge=60, le=172800),
    plan: Optional[bool] = Query(None, description="Override autopilot planning for this run"),
):
    state = request.app.state.orbital_state
    _require_ready(state)
    return await get_service(request).run_cycle(horizon_s=horizon_s, plan=plan)


@router.get("/api/events", tags=["Operations"])
async def list_events(request: Request, after_id: int = Query(0, ge=0), limit: int = Query(200, ge=1, le=1000)):
    state = request.app.state.orbital_state
    async with state.lock:
        return {"events": state.events_after(after_id, limit), "last_id": state.event_seq}


@router.get("/api/metrics", tags=["Operations"])
async def mission_metrics(request: Request):
    state = request.app.state.orbital_state
    async with state.lock:
        return state.metrics()


class AutopilotUpdate(BaseModel):
    enabled: Optional[bool] = None
    strategy: Optional[Literal["Auto", "TriShunt", "RadialOverride"]] = None


@router.get("/api/autopilot", tags=["Operations"])
async def get_autopilot():
    return {"enabled": CONFIG.autopilotEnabled, "strategy": CONFIG.avoidanceStrategy,
            "strategies": [{"name": k, "description": p.description()} for k, p in PLUGINS.items()]}


@router.put("/api/autopilot", tags=["Operations"])
async def update_autopilot(update: AutopilotUpdate, request: Request):
    changes = {}
    if update.enabled is not None:
        changes["autopilotEnabled"] = update.enabled
    if update.strategy is not None:
        changes["avoidanceStrategy"] = update.strategy
    CONFIG.update(changes)
    save_config(CONFIG)
    state = request.app.state.orbital_state
    async with state.lock:
        state.emit("info", "autopilot", f"Autopilot {'enabled' if CONFIG.autopilotEnabled else 'disabled'} "
                   f"(strategy {CONFIG.avoidanceStrategy})")
    return await get_autopilot()


@router.get("/api/avoidance/strategies", tags=["Operations"])
async def avoidance_strategies():
    return [{"name": k, "mode": p.mode, "description": p.description()} for k, p in PLUGINS.items()]


# ============================================================================
# satellites
# ============================================================================
@router.get("/api/satellites", tags=["Satellites"])
async def satellites(request: Request):
    state = request.app.state.orbital_state
    if not state.is_ready() or state.current_time is None:
        return {"timestamp": None, "satellites": []}
    async with state.lock:
        return {"timestamp": iso_z(state.current_time), "satellites": state.satellite_details()}


@router.get("/api/satellites/{sat_id}/track", tags=["Satellites"])
async def predicted_track(
    request: Request, sat_id: str,
    minutes: float = Query(95.0, gt=0, le=1440),
    step_s: float = Query(60.0, ge=5, le=600),
    model: str = Query("J2", description="Gravity model: J2 (engine), J4, J6"),
):
    state = request.app.state.orbital_state
    _require_ready(state)
    if model not in PRESETS:
        raise HTTPException(status_code=422, detail=f"model must be one of {sorted(PRESETS)}")
    async with state.lock:
        idx = _sat_index(state, sat_id)
        vec = state.sat_buffer[idx:idx + 1].copy()
        start = state.current_time
    gravity = None if model == "J2" else GravityModel(preset=model)
    samples = int(minutes * 60 // step_s) + 1
    points = []
    for k in range(samples):
        if k:
            if gravity:
                gravity.propagate(vec, step_s, max_step=min(step_s, 10.0))
            else:
                propagate_states(vec, step_s)
        t = start + timedelta(seconds=k * step_s)
        _, lat, lon, _ = convert_states_to_lla(vec, t)[0]
        points.append({"t": iso_z(t), "offset_s": k * step_s, "lat": round(lat, 4), "lon": round(lon, 4),
                       "alt_km": round(float(np.linalg.norm(vec[0, :3]) - R_EARTH), 3)})
    return {"satellite_id": sat_id, "model": model, "points": points}


@router.get("/api/satellites/{sat_id}/passes", tags=["Satellites"])
async def ground_station_passes(
    request: Request, sat_id: str,
    hours: float = Query(6.0, gt=0, le=48),
    step_s: float = Query(30.0, ge=5, le=300),
):
    state = request.app.state.orbital_state
    _require_ready(state)
    async with state.lock:
        idx = _sat_index(state, sat_id)
        vec = state.sat_buffer[idx:idx + 1].copy()
        start_ts = state.now_ts
    samples = int(hours * 3600 // step_s) + 1
    open_pass = {}
    passes = []
    for k in range(samples):
        if k:
            propagate_states(vec, step_s)
        ts = start_ts + k * step_s
        visible = visible_mask(vec[:, :3], ts)[0]
        elev = elevations_deg(vec[:, :3], ts)[0]
        for g, st in enumerate(STATIONS):
            if visible[g]:
                p = open_pass.setdefault(g, {"station_id": st.id, "station_name": st.name, "start_ts": ts,
                                             "max_elevation_deg": -90.0, "in_progress": k == 0})
                p["max_elevation_deg"] = max(p["max_elevation_deg"], float(elev[g]))
                p["end_ts"] = ts
            elif g in open_pass:
                passes.append(open_pass.pop(g))
    passes.extend(open_pass.values())
    out = sorted(({
        "station_id": p["station_id"], "station_name": p["station_name"],
        "start": iso_z(p["start_ts"]), "end": iso_z(p["end_ts"]),
        "duration_s": round(p["end_ts"] - p["start_ts"] + step_s, 0),
        "max_elevation_deg": round(p["max_elevation_deg"], 1), "in_progress": p["in_progress"],
    } for p in passes), key=lambda p: p["start"])
    return {"satellite_id": sat_id, "from": iso_z(start_ts), "hours": hours, "passes": out,
            "in_contact_now": any(p["in_progress"] for p in out)}


# ============================================================================
# manual burn planner
# ============================================================================
class ManualBurn(BaseModel):
    burn_id: Optional[str] = None
    offset_s: Optional[float] = Field(None, ge=0, description="Seconds after current simulation time")
    burnTime: Optional[str] = None
    frame: Literal["RTN", "ECI"] = "RTN"
    dv_mps: dict = Field(..., description="Components in m/s: RTN uses keys r,t,n; ECI uses x,y,z")


class ManualPlanRequest(BaseModel):
    satelliteId: str
    burns: List[ManualBurn] = Field(..., min_length=1, max_length=10)
    dry_run: bool = True
    maneuver_type: str = "MANUAL"


@router.post("/api/maneuver/manual", tags=["Maneuvers"])
async def manual_maneuver(plan: ManualPlanRequest, request: Request):
    state = request.app.state.orbital_state
    _require_ready(state)
    async with state.lock:
        idx = _sat_index(state, plan.satelliteId)
        now_ts = state.now_ts
        work = state.sat_buffer[idx:idx + 1].copy()

        timed = []
        for k, b in enumerate(plan.burns):
            if b.burnTime:
                try:
                    ts = parse_iso_utc(b.burnTime).timestamp()
                except ValueError:
                    raise HTTPException(status_code=422, detail=f"Invalid burnTime {b.burnTime!r}")
            else:
                ts = now_ts + (b.offset_s if b.offset_s is not None else 30.0)
            if ts < now_ts:
                raise HTTPException(status_code=422, detail="Burns must be in the future")
            timed.append((ts, k, b))
        timed.sort()

        burns, t_curr = [], now_ts
        for ts, k, b in timed:
            propagate_states(work, ts - t_curr)
            t_curr = ts
            if b.frame == "RTN":
                comp = np.array([b.dv_mps.get("r", 0.0), b.dv_mps.get("t", 0.0), b.dv_mps.get("n", 0.0)], dtype=float)
                dv_eci = _rtn_basis(work[0, :3], work[0, 3:]) @ (comp / 1000.0)
            else:
                dv_eci = np.array([b.dv_mps.get("x", 0.0), b.dv_mps.get("y", 0.0), b.dv_mps.get("z", 0.0)], dtype=float) / 1000.0
            work[0, 3:] += dv_eci
            burns.append(BurnRequest(
                burn_id=b.burn_id or f"MAN-{plan.satelliteId}-{int(ts)}-{k}",
                ts=ts, dv_kms=tuple(float(c) for c in dv_eci), maneuver_type=plan.maneuver_type,
            ))

        evaluation = evaluate_sequence(state, plan.satelliteId, burns)
        scheduled = False
        if evaluation.accepted and not plan.dry_run:
            queue_burns(state, plan.satelliteId, burns, source="operator")
            scheduled = True
        elif not evaluation.accepted and not plan.dry_run:
            state.emit("warn", "maneuver", f"Manual burn rejected: {evaluation.reason.replace('_', ' ').lower()}",
                       satellite_id=plan.satelliteId, reason=evaluation.reason)

        before = _orbit_summary(state.sat_buffer[idx])
    return {
        **evaluation.to_dict(),
        "dry_run": plan.dry_run,
        "scheduled": scheduled,
        "burns_eci": [{"burn_id": b.burn_id, "burnTime": iso_z(b.ts), "deltaV_vector": dict(zip("xyz", b.dv_kms)),
                       "delta_v_mps": round(b.dv_mps, 4)} for b in burns],
        "orbit_before": before,
        "orbit_after": _orbit_summary(work[0]),
    }


# ============================================================================
# archive (SQLite)
# ============================================================================
def _archive(request: Request):
    archive = getattr(request.app.state, "archive", None)
    if archive is None:
        raise HTTPException(status_code=503, detail="Mission archive is disabled (ACM_ARCHIVE=0).")
    return archive


@router.get("/api/archive/maneuvers", tags=["Archive"])
async def archived_maneuvers(request: Request, satellite_id: Optional[str] = None, status: Optional[str] = None,
                             limit: int = Query(200, ge=1, le=5000)):
    return {"maneuvers": _archive(request).maneuvers(satellite_id, status, limit)}


@router.get("/api/archive/events", tags=["Archive"])
async def archived_events(request: Request, level: Optional[str] = None, satellite_id: Optional[str] = None,
                          limit: int = Query(200, ge=1, le=5000)):
    return {"events": _archive(request).events(level, satellite_id, limit)}
