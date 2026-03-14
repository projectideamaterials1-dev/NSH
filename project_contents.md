# File Structure

```text
satellite_api/
├── main.py
├── models.py
├── physics.py
├── collision.py
├── state.py
├── test_api.py
├── requirements.txt
└── routers/
    ├── simulation.py
    └── telemetry.py
```

# Code Files

## `satellite_api/main.py`

```py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from satellite_api.routers import telemetry, simulation
from satellite_api.state import AppState

app = FastAPI(
    title="Satellite Collision Avoidance API",
    description="Real-time telemetry ingestion and orbital simulation with collision detection",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Shared in-memory state (replace with DB in production)
app.state.orbital_state = AppState()

app.include_router(telemetry.router, prefix="/api", tags=["Telemetry"])
app.include_router(simulation.router, prefix="/api", tags=["Simulation"])


@app.get("/", tags=["Health"])
def root():
    return {"status": "online", "system": "Satellite Collision Avoidance API v1.0"}
```

## `satellite_api/models.py`

```py
from pydantic import BaseModel, Field
from typing import List, Literal, Optional
from datetime import datetime


# ─── Shared Vector ────────────────────────────────────────────────────────────

class Vec3(BaseModel):
    x: float
    y: float
    z: float

    def to_list(self) -> list[float]:
        return [self.x, self.y, self.z]

    @staticmethod
    def from_list(v: list[float]) -> "Vec3":
        return Vec3(x=v[0], y=v[1], z=v[2])


# ─── Core Domain Object ───────────────────────────────────────────────────────

class SpaceObject(BaseModel):
    id: str
    type: Literal["SATELLITE", "DEBRIS", "ROCKET_BODY"]
    r: Vec3 = Field(..., description="Position vector (km)")
    v: Vec3 = Field(..., description="Velocity vector (km/s)")


# ─── /api/telemetry ───────────────────────────────────────────────────────────

class TelemetryIngestionRequest(BaseModel):
    timestamp: datetime
    objects: List[SpaceObject]


class TelemetryIngestionResponse(BaseModel):
    status: str = "ACK"
    processed_count: int
    active_cdm_warnings: int
    warning_pairs: Optional[List[dict]] = None


# ─── /api/simulation/tick ─────────────────────────────────────────────────────

class SimulationTickRequest(BaseModel):
    tick_duration_s: float = Field(
        ..., gt=0, le=3600, description="Seconds to advance (1–3600)"
    )


class CollisionWarning(BaseModel):
    object1: str
    object2: str
    closest_approach_km: float
    predicted_time: Optional[str] = None
    risk_level: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]


class UpdatedObject(BaseModel):
    id: str
    type: str
    r: Vec3
    v: Vec3


class SimulationTickResponse(BaseModel):
    status: str = "TICK_PROCESSED"
    sim_time_elapsed_s: float
    tick_duration_s: float
    updated_objects: List[UpdatedObject]
    collision_warnings: List[CollisionWarning]
    total_objects_tracked: int
```

## `satellite_api/physics.py`

```py
"""
physics.py — Orbital mechanics engine
--------------------------------------
Implements:
  • Two-body gravity
  • J2 oblateness perturbation
  • RK4 numerical integrator
  • Closest Approach distance (TCA) estimator
"""

import math
from typing import Tuple

# ─── Earth Constants ──────────────────────────────────────────────────────────
MU    = 398600.4418       # km³/s²  — Earth's gravitational parameter
R_EQ  = 6378.137          # km      — Earth equatorial radius
J2    = 1.08262668e-3     # Dimensionless — J2 oblateness coefficient
CRIT_DIST_KM = 5.0        # km      — Collision warning threshold


# ─── Acceleration ─────────────────────────────────────────────────────────────

def acceleration(r: list[float]) -> list[float]:
    """
    Compute total acceleration at position r [km].

    a = a_gravity + a_J2

    a_gravity = -μ/|r|³ * r

    a_J2 = (3/2) * J2 * μ * R_eq² / |r|⁵ * [
        x * (5z²/r² - 1),
        y * (5z²/r² - 1),
        z * (5z²/r² - 3)
    ]
    """
    x, y, z = r
    r_mag = math.sqrt(x*x + y*y + z*z)
    r3    = r_mag ** 3
    r5    = r_mag ** 5

    # Two-body gravity
    ax_grav = -MU * x / r3
    ay_grav = -MU * y / r3
    az_grav = -MU * z / r3

    # J2 perturbation
    coeff = 1.5 * J2 * MU * (R_EQ ** 2) / r5
    factor_xy = 1.0 - 5.0 * (z * z) / (r_mag * r_mag)
    factor_z  = 3.0 - 5.0 * (z * z) / (r_mag * r_mag)

    ax_j2 = coeff * x * (-factor_xy)
    ay_j2 = coeff * y * (-factor_xy)
    az_j2 = coeff * z * (-factor_z)

    return [
        ax_grav + ax_j2,
        ay_grav + ay_j2,
        az_grav + az_j2,
    ]


# ─── RK4 Integrator ───────────────────────────────────────────────────────────

def _add(a: list[float], b: list[float]) -> list[float]:
    return [a[i] + b[i] for i in range(3)]

def _scale(v: list[float], s: float) -> list[float]:
    return [x * s for x in v]


def rk4_step(r: list[float], v: list[float], dt: float) -> Tuple[list[float], list[float]]:
    """
    Advance state (r, v) by dt seconds using 4th-order Runge-Kutta.

    State derivative:
        dr/dt = v
        dv/dt = a(r)
    """
    def deriv(ri, vi):
        return vi, acceleration(ri)

    # k1
    dr1, dv1 = deriv(r, v)

    # k2
    r2 = _add(r, _scale(dr1, dt / 2))
    v2 = _add(v, _scale(dv1, dt / 2))
    dr2, dv2 = deriv(r2, v2)

    # k3
    r3 = _add(r, _scale(dr2, dt / 2))
    v3 = _add(v, _scale(dv2, dt / 2))
    dr3, dv3 = deriv(r3, v3)

    # k4
    r4 = _add(r, _scale(dr3, dt))
    v4 = _add(v, _scale(dv3, dt))
    dr4, dv4 = deriv(r4, v4)

    # Weighted sum
    r_new = [
        r[i] + (dt / 6) * (dr1[i] + 2*dr2[i] + 2*dr3[i] + dr4[i])
        for i in range(3)
    ]
    v_new = [
        v[i] + (dt / 6) * (dv1[i] + 2*dv2[i] + 2*dv3[i] + dv4[i])
        for i in range(3)
    ]

    return r_new, v_new


# ─── Collision / Closest Approach ─────────────────────────────────────────────

def separation_km(r1: list[float], r2: list[float]) -> float:
    """Euclidean distance between two position vectors (km)."""
    return math.sqrt(sum((r1[i] - r2[i]) ** 2 for i in range(3)))


def relative_velocity_kms(v1: list[float], v2: list[float]) -> float:
    """Relative speed between two objects (km/s)."""
    return math.sqrt(sum((v1[i] - v2[i]) ** 2 for i in range(3)))


def time_to_closest_approach(
    r1: list[float], v1: list[float],
    r2: list[float], v2: list[float],
) -> Tuple[float, float]:
    """
    Linear TCA estimate (seconds until minimum separation).
    Uses dot product of relative position and velocity.

    Returns (tca_seconds, min_dist_km).
    """
    dr = [r2[i] - r1[i] for i in range(3)]
    dv = [v2[i] - v1[i] for i in range(3)]

    dv2 = sum(x * x for x in dv)
    if dv2 < 1e-12:
        # Objects moving in parallel — current separation is closest
        return 0.0, separation_km(r1, r2)

    t_min = -sum(dr[i] * dv[i] for i in range(3)) / dv2

    # Clamp to positive future
    t_min = max(0.0, t_min)

    r1_tca = [r1[i] + v1[i] * t_min for i in range(3)]
    r2_tca = [r2[i] + v2[i] * t_min for i in range(3)]
    dist_tca = separation_km(r1_tca, r2_tca)

    return t_min, dist_tca


def risk_level(dist_km: float) -> str:
    """Classify collision risk by closest-approach distance."""
    if dist_km < 0.5:
        return "CRITICAL"
    elif dist_km < 1.5:
        return "HIGH"
    elif dist_km < CRIT_DIST_KM:
        return "MEDIUM"
    else:
        return "LOW"
```

## `satellite_api/collision.py`

```py
"""
collision.py — Collision Detection Service
-------------------------------------------
Two-stage pipeline:
  Stage 1 (Fast Filter)   — Bounding-box coarse screen (O(n²) but cheap)
  Stage 2 (Precise Check) — TCA-based closest approach for flagged pairs
"""

from typing import List, Tuple
from satellite_api.models import SpaceObject, CollisionWarning
from satellite_api.physics import separation_km, time_to_closest_approach, risk_level, CRIT_DIST_KM
from datetime import datetime, timedelta, timezone

# Coarse filter threshold — only pairs within this distance get precise TCA check
COARSE_THRESHOLD_KM = 50.0


def run_collision_screening(
    objects: List[SpaceObject],
    sim_time_offset_s: float = 0.0,
) -> List[CollisionWarning]:
    """
    Full two-stage collision screening across all tracked objects.

    Returns list of CollisionWarning for pairs within CRIT_DIST_KM.
    """
    warnings: List[CollisionWarning] = []
    n = len(objects)

    if n < 2:
        return warnings

    # Stage 1: Coarse bounding-box filter
    candidate_pairs: List[Tuple[int, int]] = []
    for i in range(n):
        for j in range(i + 1, n):
            dist = separation_km(
                objects[i].r.to_list(),
                objects[j].r.to_list(),
            )
            if dist < COARSE_THRESHOLD_KM:
                candidate_pairs.append((i, j))

    # Stage 2: Precise TCA check for candidate pairs
    for i, j in candidate_pairs:
        o1, o2 = objects[i], objects[j]

        tca_s, min_dist = time_to_closest_approach(
            o1.r.to_list(), o1.v.to_list(),
            o2.r.to_list(), o2.v.to_list(),
        )

        if min_dist < CRIT_DIST_KM:
            # Predicted TCA timestamp
            tca_time = (
                datetime.now(tz=timezone.utc) + timedelta(seconds=tca_s + sim_time_offset_s)
            ).isoformat()

            warnings.append(
                CollisionWarning(
                    object1=o1.id,
                    object2=o2.id,
                    closest_approach_km=round(min_dist, 4),
                    predicted_time=tca_time,
                    risk_level=risk_level(min_dist),
                )
            )

    # Sort by distance (closest first)
    warnings.sort(key=lambda w: w.closest_approach_km)
    return warnings
```

## `satellite_api/state.py`

```py
from typing import Dict
from satellite_api.models import SpaceObject


class AppState:
    """
    Thread-safe (for single-worker) in-memory store for all tracked space objects.
    In production, replace with Redis / TimescaleDB.
    """

    def __init__(self):
        # object_id -> SpaceObject
        self.objects: Dict[str, SpaceObject] = {}
        # Simulation clock (seconds elapsed since first telemetry)
        self.sim_time_s: float = 0.0

    def upsert(self, obj: SpaceObject):
        self.objects[obj.id] = obj

    def get_all(self) -> list[SpaceObject]:
        return list(self.objects.values())

    def count(self) -> int:
        return len(self.objects)
```

## `satellite_api/test_api.py`

```py
"""
test_api.py — Quick integration test using requests
Run: python test_api.py  (while uvicorn is running on port 8000)
"""

import json
import urllib.request

BASE = "http://127.0.0.1:8000"


def post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


# ── Test 1: Telemetry Ingestion ───────────────────────────────────────────────
print("\n=== POST /api/telemetry ===")
telemetry_payload = {
    "timestamp": "2026-03-12T08:00:00.000Z",
    "objects": [
        {
            "id": "SAT-Alpha-04",
            "type": "SATELLITE",
            "r": {"x": 6578.0, "y": 0.0, "z": 0.0},
            "v": {"x": 0.0,    "y": 7.784, "z": 0.0},
        },
        {
            "id": "DEB-99421",
            "type": "DEBRIS",
            "r": {"x": 6579.0, "y": 0.5, "z": 0.1},
            "v": {"x": 0.001,  "y": 7.780, "z": 0.002},
        },
        {
            "id": "DEB-00112",
            "type": "DEBRIS",
            "r": {"x": 7000.0, "y": 1000.0, "z": 300.0},
            "v": {"x": -1.25,  "y": 6.84, "z": 3.12},
        },
    ],
}
result = post("/api/telemetry", telemetry_payload)
print(json.dumps(result, indent=2))

# ── Test 2: Simulation Tick ───────────────────────────────────────────────────
print("\n=== POST /api/simulation/tick ===")
tick_payload = {"tick_duration_s": 60}
result = post("/api/simulation/tick", tick_payload)
print(json.dumps(result, indent=2))

# ── Test 3: Another tick to see state advancing ───────────────────────────────
print("\n=== POST /api/simulation/tick (second tick) ===")
result = post("/api/simulation/tick", {"tick_duration_s": 300})
print(json.dumps(result, indent=2))
```

## `satellite_api/requirements.txt`

```text
fastapi==0.115.6
uvicorn[standard]==0.34.0
pydantic==2.10.6
```

## `satellite_api/routers/simulation.py`

```py
"""
routers/simulation.py
----------------------
POST /api/simulation/tick

Advances the simulation by tick_duration_s seconds.
Uses RK4 integrator with J2 perturbation to update all object positions.
Re-runs collision screening on updated state.
"""

from fastapi import APIRouter, Request, HTTPException
from satellite_api.models import (
    SimulationTickRequest,
    SimulationTickResponse,
    SpaceObject,
    UpdatedObject,
    Vec3,
)
from satellite_api.physics import rk4_step
from satellite_api.collision import run_collision_screening

router = APIRouter()

# Sub-step size for RK4 — prevents accuracy loss on large ticks
MAX_SUBSTEP_S = 30.0


@router.post(
    "/simulation/tick",
    response_model=SimulationTickResponse,
    summary="Advance orbital simulation by one tick",
    description=(
        "Propagates all tracked objects forward by tick_duration_s using "
        "RK4 integration with J2 oblateness perturbation. After propagation, "
        "runs full collision detection and returns updated states + warnings."
    ),
)
async def simulation_tick(
    payload: SimulationTickRequest,
    request: Request,
) -> SimulationTickResponse:

    state = request.app.state.orbital_state
    all_objects = state.get_all()

    if not all_objects:
        raise HTTPException(
            status_code=400,
            detail="No objects in state. Ingest telemetry via POST /api/telemetry first.",
        )

    dt_total = payload.tick_duration_s

    # ── 1. Propagate each object with RK4 (sub-stepped for accuracy) ──────────
    updated: list[UpdatedObject] = []

    for obj in all_objects:
        r = obj.r.to_list()
        v = obj.v.to_list()

        time_remaining = dt_total
        while time_remaining > 0:
            dt_step = min(time_remaining, MAX_SUBSTEP_S)
            r, v = rk4_step(r, v, dt_step)
            time_remaining -= dt_step

        # Write back to shared state
        new_obj = SpaceObject(
            id=obj.id,
            type=obj.type,
            r=Vec3.from_list(r),
            v=Vec3.from_list(v),
        )
        state.upsert(new_obj)

        updated.append(
            UpdatedObject(
                id=new_obj.id,
                type=new_obj.type,
                r=new_obj.r,
                v=new_obj.v,
            )
        )

    # ── 2. Advance simulation clock ───────────────────────────────────────────
    state.sim_time_s += dt_total

    # ── 3. Re-run collision screening on updated positions ────────────────────
    refreshed_objects = state.get_all()
    warnings = run_collision_screening(refreshed_objects, sim_time_offset_s=state.sim_time_s)

    return SimulationTickResponse(
        status="TICK_PROCESSED",
        sim_time_elapsed_s=round(state.sim_time_s, 3),
        tick_duration_s=dt_total,
        updated_objects=updated,
        collision_warnings=warnings,
        total_objects_tracked=state.count(),
    )
```

## `satellite_api/routers/telemetry.py`

```py
"""
routers/telemetry.py
---------------------
POST /api/telemetry

Receives position/velocity telemetry for satellites and debris,
updates internal state, and runs collision screening.
"""

from fastapi import APIRouter, Request
from satellite_api.models import TelemetryIngestionRequest, TelemetryIngestionResponse
from satellite_api.collision import run_collision_screening

router = APIRouter()


@router.post(
    "/telemetry",
    response_model=TelemetryIngestionResponse,
    summary="Ingest telemetry for space objects",
    description=(
        "Accepts real-time position (r) and velocity (v) vectors for "
        "satellites and debris. Updates internal state and runs two-stage "
        "collision screening. Returns ACK with active CDM warning count."
    ),
)
async def ingest_telemetry(
    payload: TelemetryIngestionRequest,
    request: Request,
) -> TelemetryIngestionResponse:

    state = request.app.state.orbital_state

    # ── 1. Upsert all incoming objects into shared state ──────────────────────
    for obj in payload.objects:
        state.upsert(obj)

    # ── 2. Run collision screening on full object catalog ─────────────────────
    all_objects = state.get_all()
    warnings = run_collision_screening(all_objects, sim_time_offset_s=state.sim_time_s)

    # ── 3. Build response ─────────────────────────────────────────────────────
    warning_pairs = [
        {
            "object1": w.object1,
            "object2": w.object2,
            "closest_approach_km": w.closest_approach_km,
            "risk_level": w.risk_level,
            "predicted_time": w.predicted_time,
        }
        for w in warnings
    ]

    return TelemetryIngestionResponse(
        status="ACK",
        processed_count=len(payload.objects),
        active_cdm_warnings=len(warnings),
        warning_pairs=warning_pairs if warnings else None,
    )
```

