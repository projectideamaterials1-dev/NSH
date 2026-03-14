import math
from datetime import datetime, timedelta, timezone
from typing import List

from fastapi import APIRouter, Request, HTTPException

from satellite_api.models import (
    SimulationTickRequest,
    SimulationTickResponse,
    UpdatedObject,
    CollisionWarning,
    Vec3,
)
from satellite_api.physics import rk4_step, propagate_object
from satellite_api.collision import run_collision_screening
from satellite_api.state import AppState

router = APIRouter()

MAX_STEP_S = 30.0  # maximum substep for RK4

async def simulation_tick(
    payload: SimulationTickRequest,
    request: Request,
) -> SimulationTickResponse:
    state: AppState = request.app.state.orbital_state
    dt_total = payload.tick_duration_s

    async with state._lock:
        if not state.objects:
            raise HTTPException(status_code=400, detail="No objects in state")
        # Get current simulation datetime
        current_time = state.current_time
        target_time = current_time + timedelta(seconds=dt_total)

        # Retrieve all maneuvers scheduled up to target_time
        upcoming = await state.get_upcoming_maneuvers(target_time)

    # We'll need to propagate all objects, but we must stop at each burn time.
    # Build a list of all distinct burn times in the upcoming maneuvers.
    burn_times = sorted(set(burn_time for burn_time, sat_id, burn in upcoming))
    # Add target_time as the final time
    all_segment_ends = burn_times + [target_time]
    # Remove duplicates and ensure sorted
    all_segment_ends = sorted(set(all_segment_ends))

    # Current time for propagation
    t_current = current_time
    # Keep track of executed maneuvers count
    executed_count = 0

    async with state._lock:
        # We'll propagate all objects in state.
        # Convert objects to mutable lists for efficiency
        obj_ids = list(state.objects.keys())
        # Store current r,v as lists for each object
        rv = {}
        for oid in obj_ids:
            obj = state.objects[oid]
            rv[oid] = (obj.r.to_list(), obj.v.to_list())

        # Iterate through each segment between burn times
        for seg_end in all_segment_ends:
            if seg_end <= t_current:
                continue
            # Propagate from t_current to seg_end
            dt_seg = (seg_end - t_current).total_seconds()
            if dt_seg <= 0:
                continue

            # Propagate all objects by dt_seg using RK4 with substepping
            for oid in obj_ids:
                r, v = rv[oid]
                r_new, v_new = propagate_object(r, v, dt_seg)  # use propagate_object with substepping
                rv[oid] = (r_new, v_new)

            t_current = seg_end

            # If this segment ended at a burn time, apply all burns scheduled for this time
            if seg_end in burn_times:
                # Find all burns at this time
                burns_now = [ (sat_id, burn) for (bt, sat_id, burn) in upcoming if bt == seg_end ]
                for sat_id, burn in burns_now:
                    # Apply the burn to the satellite
                    if sat_id in rv:
                        r, v = rv[sat_id]
                        # Convert deltaV_vector to list
                        dv = [burn.deltaV_vector.x, burn.deltaV_vector.y, burn.deltaV_vector.z]
                        # Update velocity (impulsive)
                        v_new = [v[i] + dv[i] for i in range(3)]
                        rv[sat_id] = (r, v_new)  # position unchanged

                        # Deduct fuel
                        if sat_id in state.fuel:
                            # Compute fuel consumption for this burn
                            dv_mag = math.sqrt(dv[0]**2 + dv[1]**2 + dv[2]**2) * 1000.0  # km/s -> m/s
                            Isp = 300.0
                            g0 = 9.80665
                            current_mass = state.dry_mass + state.fuel[sat_id]
                            delta_m = current_mass * (1 - math.exp(-dv_mag / (Isp * g0)))
                            state.fuel[sat_id] -= delta_m
                            # Ensure non-negative
                            if state.fuel[sat_id] < 0:
                                state.fuel[sat_id] = 0.0
                        executed_count += 1

        # After all segments, update state.objects with new r,v
        for oid in obj_ids:
            r, v = rv[oid]
            state.objects[oid].r = Vec3.from_list(r)
            state.objects[oid].v = Vec3.from_list(v)
            # Update last_update time? We can set it to target_time
            state.object_last_update[oid] = target_time

        # Update global simulation time
        state.current_time = target_time
        state.sim_time_s = (target_time - state.epoch).total_seconds()

        # Get all objects for collision screening
        all_objects = list(state.objects.values())

    # Run collision screening (outside lock to avoid blocking)
    warnings = run_collision_screening(all_objects, sim_time_offset_s=state.sim_time_s)

    # Prepare updated_objects list for response
    updated_objs = [
        UpdatedObject(id=obj.id, type=obj.type, r=obj.r, v=obj.v)
        for obj in all_objects
    ]

    return SimulationTickResponse(
        status="TICK_PROCESSED",
        sim_time_elapsed_s=state.sim_time_s,
        tick_duration_s=dt_total,
        updated_objects=updated_objs,
        collision_warnings=warnings,
        total_objects_tracked=len(all_objects),
        maneuvers_executed=executed_count,
    )

router.post(
    "/simulation/tick",
    response_model=SimulationTickResponse,
    summary="Advance orbital simulation by one tick",
    description=(
        "Propagates all tracked objects forward by tick_duration_s using "
        "RK4 integration with J2 oblateness perturbation. After propagation, "
        "runs full collision detection and returns updated states + warnings."
    ),
)(simulation_tick)