"""
routers/simulation.py
----------------------
POST /api/simulate/step

Advances the simulation by step_seconds.
- Propagates all objects with RK4 + J2
- Executes any scheduled maneuvers whose burnTime falls in the time window
- Applies Tsiolkovsky rocket equation to deduct fuel
- Re-runs collision detection on updated state
"""

from fastapi import APIRouter, Request, HTTPException
from models import SimulateStepRequest, SimulateStepResponse, SpaceObject, Vec3
from physics import rk4_step
from collision import run_collision_screening
from datetime import timedelta
import math

router = APIRouter()

MAX_SUBSTEP_S  = 30.0
ISP            = 300.0
G0             = 9.80665 / 1000.0  # km/s²
MAX_DV_KMS     = 0.015             # 15 m/s in km/s
COOLDOWN_S     = 600.0


@router.post(
    "/simulate/step",
    response_model=SimulateStepResponse,
    summary="Advance orbital simulation by one step",
)
async def simulate_step(
    payload: SimulateStepRequest,
    request: Request,
) -> SimulateStepResponse:

    state = request.app.state.orbital_state

    if not state.objects:
        raise HTTPException(
            status_code=400,
            detail="No objects in state. Ingest telemetry via POST /api/telemetry first.",
        )

    dt_total     = payload.step_seconds
    window_start = state.sim_time_s
    window_end   = state.sim_time_s + dt_total

    # ── 1. Collect maneuvers due in this time window ──────────────────────────
    due_maneuvers = []
    if state.sim_epoch is not None:
        due_maneuvers = state.pop_due_maneuvers(window_start, window_end)

    maneuvers_executed = 0

    # ── 2. Propagate each object ──────────────────────────────────────────────
    for obj_id, obj in list(state.objects.items()):
        r    = obj.r.to_list()
        v    = obj.v.to_list()
        fuel = obj.fuel_kg
        mass = obj.dry_mass_kg + fuel

        # Burns for this satellite sorted by burnTime
        my_burns = sorted(
            [(sat_id, burn) for sat_id, burn in due_maneuvers if sat_id == obj_id],
            key=lambda x: x[1].burnTime,
        )

        if not my_burns:
            time_remaining = dt_total
            while time_remaining > 0:
                dt_step = min(time_remaining, MAX_SUBSTEP_S)
                r, v = rk4_step(r, v, dt_step)
                time_remaining -= dt_step

        else:
            current_time_s = window_start
            last_burn_time_s = obj.last_burn_time_s

            for _, burn in my_burns:
                burn_offset_s = (burn.burnTime - state.sim_epoch).total_seconds()
                seg_dt = burn_offset_s - current_time_s

                # Propagate to burn time
                time_remaining = seg_dt
                while time_remaining > 0:
                    dt_step = min(time_remaining, MAX_SUBSTEP_S)
                    r, v = rk4_step(r, v, dt_step)
                    time_remaining -= dt_step

                # Apply impulsive ΔV
                dv = burn.deltaV_vector
                dv_mag = math.sqrt(dv.x**2 + dv.y**2 + dv.z**2)
                cooldown_ok = (burn_offset_s - last_burn_time_s) >= COOLDOWN_S

                if dv_mag <= MAX_DV_KMS and fuel > 0 and cooldown_ok:
                    delta_m = mass * (1.0 - math.exp(-dv_mag / (ISP * G0)))
                    fuel    = max(0.0, fuel - delta_m)
                    mass    = obj.dry_mass_kg + fuel
                    v[0]   += dv.x
                    v[1]   += dv.y
                    v[2]   += dv.z
                    last_burn_time_s = burn_offset_s
                    maneuvers_executed += 1

                current_time_s = burn_offset_s

            # Propagate remaining time after last burn
            time_remaining = window_end - current_time_s
            while time_remaining > 0:
                dt_step = min(time_remaining, MAX_SUBSTEP_S)
                r, v = rk4_step(r, v, dt_step)
                time_remaining -= dt_step

            obj = SpaceObject(
                id=obj.id, type=obj.type,
                r=Vec3.from_list(r), v=Vec3.from_list(v),
                fuel_kg=fuel, dry_mass_kg=obj.dry_mass_kg,
                last_burn_time_s=last_burn_time_s,
            )

        # Write back to state
        state.upsert(SpaceObject(
            id=obj.id,
            type=obj.type,
            r=Vec3.from_list(r),
            v=Vec3.from_list(v),
            fuel_kg=fuel,
            dry_mass_kg=obj.dry_mass_kg,
            last_burn_time_s=obj.last_burn_time_s,
        ))

    # ── 3. Advance simulation clock ───────────────────────────────────────────
    state.sim_time_s += dt_total

    new_timestamp = (
        (state.sim_epoch + timedelta(seconds=state.sim_time_s)).isoformat()
        if state.sim_epoch
        else f"{state.sim_time_s}s"
    )

    # ── 4. Collision detection on updated positions ───────────────────────────
    warnings = run_collision_screening(state.get_all(), sim_time_offset_s=state.sim_time_s)
    collisions_detected = len(warnings)

    return SimulateStepResponse(
        status="STEP_COMPLETE",
        new_timestamp=new_timestamp,
        collisions_detected=collisions_detected,
        maneuvers_executed=maneuvers_executed,
    )