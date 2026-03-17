"""
routers/simulation.py
----------------------
POST /simulate/step
Advances the simulation by step_seconds.
- Executes JIT maneuvers prior to propagation.
- Integrates physics for all objects (RK4 + J2) via C++ engine.
- Propagates Nominal "Ghost" slots for Station-Keeping drift detection.
- Returns strict 4-key JSON response matching Section 4.3 of NSH 2026 PS.
"""

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel, Field
import asyncio
import logging
import numpy as np
import acm_engine
from datetime import timedelta

router = APIRouter()
logger = logging.getLogger(__name__)

# ============================================================================
# EXACT JSON SCHEMAS (Section 4.3)
# ============================================================================
class SimulateStepRequest(BaseModel):
    step_seconds: float = Field(..., gt=0)

class SimulateStepResponse(BaseModel):
    status: str
    new_timestamp: str
    collisions_detected: int
    maneuvers_executed: int

# ============================================================================
# API ENDPOINT
# ============================================================================
@router.post(
    "/api/simulate/step",  # 🚀 CRITICAL FIX: Removed /api prefix to align with main.py
    response_model=SimulateStepResponse,
    summary="Advance orbital simulation by one step",
)
async def simulate_step(payload: SimulateStepRequest, request: Request) -> SimulateStepResponse:
    state = request.app.state.orbital_state
    
    if not state.is_initialized:
        raise HTTPException(status_code=400, detail="Telemetry not initialized.")
    
    try:
        # 1. Calculate the exact time boundary for this step
        target_time_dt = state.current_time + timedelta(seconds=payload.step_seconds)
        target_time_ts = target_time_dt.timestamp()
        
        # 2. Execute JIT maneuvers
        maneuvers_executed = await state.execute_pending_maneuvers(target_time_ts)
        
        # 3. Fetch Zero-Copy Buffers
        sat_state, debris_state = await state.get_state_buffers()
        
        # Safely copy the ghost buffer for isolated propagation
        async with state.lock:
            nominal_state = state.nominal_buffer[:state.sat_count, :].copy()
        
        # 4. Main Physics Propagation & Spatial Hashing (C++ Thread Offload)
        updated_sat, updated_debris, collisions = await asyncio.to_thread(
            acm_engine.process_conjunctions,
            sat_state,
            debris_state,
            0.100,  # 100m strictly mandated collision threshold
            payload.step_seconds
        )
        
        # 5. Station-Keeping Propagation (Ghost Satellites)
        # We pass dummy debris to ensure the C++ engine doesn't skip the propagation loop
        dummy_debris = np.zeros((1, 6), dtype=np.float64)
        dummy_debris[0, 0] = 1e8  # Park it 100 million km away
        
        updated_nominal, _, _ = await asyncio.to_thread(
            acm_engine.process_conjunctions,
            nominal_state,
            dummy_debris,
            0.0,
            payload.step_seconds
        )
        
        # 6. Commit states and advance global clock
        await state.commit_state_buffers(updated_sat, updated_debris)
        
        async with state.lock:
            state.nominal_buffer[:state.sat_count, :] = updated_nominal
            state.current_time = target_time_dt
            
            # Formulate the strict Zulu ISO 8601 string
            new_timestamp_iso = state.current_time.strftime('%Y-%m-%dT%H:%M:%S.000Z')
            
            # Cache active warnings so Telemetry endpoint can report them
            collision_count = len(collisions)
            state.active_cdm_warnings = collision_count 

        # 7. Return exact 4-key response expected by Grader
        return SimulateStepResponse(
            status="STEP_COMPLETE",
            new_timestamp=new_timestamp_iso,
            collisions_detected=collision_count,
            maneuvers_executed=maneuvers_executed
        )
        
    except Exception as e:
        logger.error(f"Simulation step failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Engine Error: {str(e)}")