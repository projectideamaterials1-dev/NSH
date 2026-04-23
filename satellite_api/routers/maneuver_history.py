"""
routers/maneuver_history.py
---------------------------
GET /api/maneuvers
Returns all scheduled and executed maneuvers.
"""

from fastapi import APIRouter, Request, HTTPException, Query
from typing import Optional

router = APIRouter()

@router.get("/api/maneuvers")
async def get_maneuvers(
    request: Request, 
    satellite_id: Optional[str] = None,
    status: Optional[str] = Query(None, pattern="^(pending|executed|all)$")
):
    """Get all maneuvers (pending + executed), optionally filtered by satellite_id and status."""
    state = request.app.state.orbital_state
    if not state.is_ready():
        raise HTTPException(status_code=400, detail="State not initialized.")
    
    all_maneuvers = await state.get_all_maneuvers()
    
    if satellite_id:
        all_maneuvers = [m for m in all_maneuvers if m["satellite_id"] == satellite_id]
    
    if status and status != "all":
        all_maneuvers = [m for m in all_maneuvers if m.get("status", "pending").lower() == status.lower()]
    
    return {"maneuvers": all_maneuvers}
