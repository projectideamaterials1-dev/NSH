"""
models.py
---------
Strict Pydantic schemas for the NSH 2026 API.
Matches Section 4 and Section 6.3 of the Problem Statement exactly.
"""

from pydantic import BaseModel, Field
from typing import List, Literal, Optional, Any
from datetime import datetime

# ============================================================================
# SHARED TYPES
# ============================================================================
class Vec3(BaseModel):
    """3D Vector for position and velocity."""
    x: float
    y: float
    z: float

class SpaceObject(BaseModel):
    """Represents a satellite, debris, or rocket body in orbit."""
    id: str = Field(..., description="Unique object identifier (e.g., 'SAT-00', 'DEB-1234')")
    type: Literal["SATELLITE", "DEBRIS", "ROCKET_BODY"]
    r: Vec3
    v: Vec3

# ============================================================================
# TELEMETRY ENDPOINTS (/telemetry)
# ============================================================================
class TelemetryIngestionRequest(BaseModel):
    """Request payload for telemetry ingestion."""
    timestamp: datetime
    objects: List[SpaceObject]

class TelemetryIngestionResponse(BaseModel):
    """Response payload for telemetry ingestion. (Strict Section 4.1 Schema)"""
    status: str = Field(default="ACK")
    processed_count: int
    active_cdm_warnings: int
    warning_pairs: Optional[List[dict]] = None 

# ============================================================================
# SIMULATION ENDPOINTS (/simulate/step)
# ============================================================================
class SimulateStepRequest(BaseModel):
    """Request payload for simulation step."""
    step_seconds: float = Field(..., gt=0.0)

class SimulateStepResponse(BaseModel):
    """Response payload for simulation step. (Strict Section 4.3 Schema)"""
    status: str = Field(default="STEP_COMPLETE")
    new_timestamp: str = Field(..., description="ISO 8601 Timestamp")
    collisions_detected: int
    maneuvers_executed: int
    # 🚀 STRICT COMPLIANCE: collision_data field completely removed

# ============================================================================
# MANEUVER ENDPOINTS (/maneuver/schedule)
# ============================================================================
class BurnCommand(BaseModel):
    """Individual burn command within a maneuver sequence."""
    burn_id: str
    burnTime: str  # Kept as string to exactly match API payload expectations
    deltaV_vector: Vec3

class ManeuverScheduleRequest(BaseModel):
    """Complete maneuver sequence for a satellite."""
    satelliteId: str
    maneuver_sequence: List[BurnCommand]

class ValidationResult(BaseModel):
    """Validation results for maneuver scheduling."""
    ground_station_los: bool
    sufficient_fuel: bool
    projected_mass_remaining_kg: float

class ManeuverScheduleResponse(BaseModel):
    """Response payload for maneuver scheduling. (Strict Section 4.2 Schema)"""
    status: str
    validation: ValidationResult

# ============================================================================
# VISUALIZATION ENDPOINTS (/visualization/snapshot)
# ============================================================================
class SatelliteStatus(BaseModel):
    """Satellite status for frontend visualization. (Strict Section 6.3 Schema)"""
    id: str
    lat: float
    lon: float
    fuel_kg: float
    status: Literal["NOMINAL", "CRITICAL_FUEL", "EOL"]
    
class VisualizationSnapshotResponse(BaseModel):
    """Response payload for visualization snapshot."""
    timestamp: str
    satellites: List[SatelliteStatus]
    debris_cloud: List[List[Any]] # Flattened: [ID, Lat, Lon, Alt]