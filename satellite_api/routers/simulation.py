"""
routers/simulation.py
----------------------
POST /api/simulation/tick

Advances the simulation by tick_duration_s seconds.
Uses RK4 integrator with J2 perturbation to update all object positions.
Re-runs collision screening on updated state.
"""

from fastapi import APIRouter, Request, HTTPException
from models import (
    SimulationTickRequest,
    SimulationTickResponse,
    SpaceObject,
    UpdatedObject,
    Vec3,
)
from physics import rk4_step
from collision import run_collision_screening

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