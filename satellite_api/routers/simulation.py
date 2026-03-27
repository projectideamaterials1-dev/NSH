"""
routers/simulation.py
----------------------
POST /api/simulate/step
Advances the simulation by step_seconds.
- Executes JIT maneuvers prior to propagation.
- Integrates physics for all objects (RK4 + J2) via C++ Continuous Collision Detection (CCD) engine.
- Propagates Nominal "Ghost" slots for Station-Keeping drift detection via Vectorized Python RK4.
- Returns strict 4-key JSON response matching Section 4.3 of NSH 2026 PS.
"""

from fastapi import APIRouter, Request, HTTPException
import asyncio
import logging
import acm_engine
from datetime import timedelta

# 🚀 CRITICAL FIX: Import strict schemas directly from models.py
from satellite_api.models import SimulateStepRequest, SimulateStepResponse

router = APIRouter()
logger = logging.getLogger(__name__)

# ============================================================================
# API ENDPOINT
# ============================================================================
@router.post(
    "/api/simulate/step", 
    response_model=SimulateStepResponse,
    summary="Advance orbital simulation by one step",
)
async def simulate_step(payload: SimulateStepRequest, request: Request) -> SimulateStepResponse:
    # Retrieve the Zero-Copy StateManager instantiated in main.py
    state = request.app.state.orbital_state
    
    if not state.is_ready():
        raise HTTPException(status_code=400, detail="Telemetry not initialized.")
    
    try:
        # 1. Temporal Bounds (Calculate horizon for JIT Execution)
        async with state.lock:
            target_time_dt = state.current_time + timedelta(seconds=payload.step_seconds)
            target_time_ts = target_time_dt.timestamp()
        
        # 2. Execute JIT Maneuvers
        # Applies impulsive Delta-V to the raw velocity vectors *before* the physics step
        maneuvers_executed = await state.execute_pending_maneuvers(target_time_ts)
        
        # 3. Fetch Zero-Copy Buffers
        sat_state, debris_state = await state.get_state_buffers()
        
        # 4. Main Physics Propagation & Continuous Collision Detection (C++ Engine Offload)
        # Returns the [N, 5] array containing: sat_id, target_id, is_debris, miss_dist, exact_tca
        updated_sat, updated_debris, collisions = await asyncio.to_thread(
            acm_engine.process_conjunctions,
            sat_state,
            debris_state,
            0.100,  # 100m strictly mandated collision threshold (Section 3.3)
            payload.step_seconds
        )
        
        # 5. Commit Physical States 
        await state.commit_state_buffers(updated_sat, updated_debris)
        
        # 6. Advance Ghost Slots, Cooldowns, and Global Time
        # 🚀 CRITICAL FIX: Replaced the old hacky C++ "dummy debris" call with our new 
        # blazing-fast Vectorized Python RK4 inside the StateManager.
        await state.advance_simulation_time(payload.step_seconds)
        
        # 7. Format Response & Cache State
        async with state.lock:
            # Formulate the strict Zulu ISO 8601 string expected by the automated grader
            new_timestamp_iso = state.current_time.strftime('%Y-%m-%dT%H:%M:%S.000Z')
            
            # Cache active warnings so Telemetry endpoint can report them in its ACK
            collision_count = len(collisions)
            state.active_cdm_warnings = collision_count 

        # Return exact 4-key response matching Section 4.3
        return SimulateStepResponse(
            status="STEP_COMPLETE",
            new_timestamp=new_timestamp_iso,
            collisions_detected=collision_count,
            maneuvers_executed=maneuvers_executed
        )
        
    except Exception as e:
        logger.error(f"Simulation step failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Engine Error: {str(e)}")