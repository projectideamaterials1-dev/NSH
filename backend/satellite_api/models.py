"""
models.py
---------
Strict Pydantic schemas for the NSH 2026 API.
Matches Section 4 and Section 6.3 of the Problem Statement exactly.
"""
from pydantic import BaseModel, Field
from typing import List, Literal, Optional, Any, Tuple, Union
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
    burn_id: str = Field(..., json_schema_extra={"examples": ["BURN-001"]})
    burnTime: str = Field(..., json_schema_extra={"examples": ["2026-01-01T00:00:10.000Z"]}) # Kept as string to exactly match API payload expectations
    deltaV_vector: Vec3

class ManeuverScheduleRequest(BaseModel):
    """Complete maneuver sequence for a satellite."""
    satelliteId: str = Field(..., json_schema_extra={"examples": ["SAT-042"]})
    maneuver_sequence: List[BurnCommand] = Field(..., json_schema_extra={"examples": [[
        {"burn_id": "BURN-001", "burnTime": "2026-01-01T00:00:10.000Z", "deltaV_vector": {"x":0,"y":0.0075,"z":0}}
    ]]})

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
    id: str
    lat: float
    lon: float
    fuel_kg: float
    status: str

class VisualizationSnapshotResponse(BaseModel):
    timestamp: str
    satellites: List[SatelliteStatus]
    # The exact tuple definition to force the JSON array-of-arrays
    debris_cloud: List[Tuple[str, float, float, float]]
# ============================================================================
# DELTA TELEMETRY
# ============================================================================
class DeltaTelemetryRequest(BaseModel):
    timestamp: datetime
    updated_objects: List[SpaceObject]  # only changed objects
    deleted_ids: List[str] = []         # IDs to remove

class DeltaTelemetryResponse(BaseModel):
    status: str = "ACK"
    processed_updates: int
    processed_deletes: int
