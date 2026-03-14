from pydantic import BaseModel, Field
from typing import List, Literal, Optional
from datetime import datetime

# ============================================================================
# SHARED TYPES
# ============================================================================

class Vec3(BaseModel):
    """3D Vector for position and velocity."""
    x: float = Field(..., description="X component (km or km/s)")
    y: float = Field(..., description="Y component (km or km/s)")
    z: float = Field(..., description="Z component (km or km/s)")

# ============================================================================
# CORE DOMAIN OBJECTS
# ============================================================================

class SpaceObject(BaseModel):
    """Represents a satellite, debris, or rocket body in orbit."""
    id: str = Field(..., description="Unique object identifier (e.g., 'SAT-001', 'DEB-12345')")
    type: Literal["SATELLITE", "DEBRIS", "ROCKET_BODY"] = Field(
        ..., 
        description="Object classification"
    )
    r: Vec3 = Field(..., description="Position vector in ECI frame (km)")
    v: Vec3 = Field(..., description="Velocity vector in ECI frame (km/s)")
    fuel_kg: float = Field(default=50.0, description="Remaining fuel mass (kg)")
    dry_mass_kg: float = Field(default=500.0, description="Spacecraft dry mass (kg)")
    last_burn_time_s: float = Field(default=-9999.0, description="Last burn timestamp (seconds)")

# ============================================================================
# TELEMETRY ENDPOINTS (/api/telemetry)
# ============================================================================

class TelemetryIngestionRequest(BaseModel):
    """Request payload for telemetry ingestion."""
    timestamp: datetime = Field(
        ..., 
        description="ISO 8601 timestamp (e.g., '2026-03-12T08:00:00.000Z')"
    )
    objects: List[SpaceObject] = Field(
        ..., 
        description="List of space objects with position/velocity vectors"
    )

class TelemetryIngestionResponse(BaseModel):
    """Response payload for telemetry ingestion."""
    status: str = Field(default="ACK", description="Acknowledgment status")
    processed_count: int = Field(..., description="Number of objects processed")
    active_cdm_warnings: int = Field(default=0, description="Active Conjunction Data Message warnings")
    warning_pairs: Optional[List[dict]] = Field(default=None, description="Collision warning pairs")

# ============================================================================
# COLLISION WARNING TYPES
# ============================================================================

class CollisionWarning(BaseModel):
    """Collision warning between two space objects."""
    object1: str = Field(..., description="First object ID")
    object2: str = Field(..., description="Second object ID")
    closest_approach_km: float = Field(..., description="Minimum separation distance (km)")
    predicted_time: Optional[str] = Field(default=None, description="Predicted TCA (ISO 8601)")
    risk_level: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"] = Field(
        ..., 
        description="Risk classification"
    )

# ============================================================================
# SIMULATION ENDPOINTS (/api/simulate/step)
# ============================================================================

class SimulateStepRequest(BaseModel):
    """Request payload for simulation step."""
    step_seconds: float = Field(
        ..., 
        gt=0.0, 
        description="Time to advance the simulation in seconds"
    )

class SimulateStepResponse(BaseModel):
    """Response payload for simulation step."""
    status: str = Field(default="STEP_COMPLETE", description="Execution status")
    new_timestamp: str = Field(..., description="New simulation timestamp (ISO 8601)")
    collisions_detected: int = Field(..., description="Number of conjunctions detected")
    maneuvers_executed: int = Field(..., description="Number of maneuvers executed this step")
    collision_data: Optional[List[list]] = Field(
        default=None, 
        description="Array of [sat_idx, target_idx, is_debris_flag, distance_km]"
    )

# ============================================================================
# MANEUVER ENDPOINTS (/api/maneuver/schedule)
# ============================================================================

class BurnCommand(BaseModel):
    """Individual burn command within a maneuver sequence."""
    burn_id: str = Field(..., description="Unique burn identifier")
    burnTime: datetime = Field(..., description="Scheduled burn time (ISO 8601)")
    deltaV_vector: Vec3 = Field(..., description="Delta-V vector in ECI frame (km/s)")

# CRITICAL FIX: Renamed from ScheduledManeuver to match router imports
class ManeuverScheduleRequest(BaseModel):
    """Complete maneuver sequence for a satellite."""
    satelliteId: str = Field(..., description="Target satellite ID")
    maneuver_sequence: List[BurnCommand] = Field(
        ..., 
        description="Ordered list of burn commands"
    )

class ValidationResult(BaseModel):
    """Validation results for maneuver scheduling."""
    ground_station_los: bool = Field(..., description="Line-of-sight validation result")
    sufficient_fuel: bool = Field(..., description="Fuel sufficiency validation result")
    projected_mass_remaining_kg: float = Field(..., description="Projected mass after maneuvers (kg)")

class ManeuverScheduleResponse(BaseModel):
    """Response payload for maneuver scheduling."""
    status: str = Field(..., description="Scheduling status (SCHEDULED or REJECTED: reason)")
    validation: ValidationResult = Field(..., description="Validation results")

# ============================================================================
# VISUALIZATION ENDPOINTS (/api/visualization/snapshot)
# ============================================================================

class SatelliteStatus(BaseModel):
    """Satellite status for frontend visualization."""
    id: str = Field(..., description="Satellite ID")
    lat: float = Field(..., description="Latitude (degrees)")
    lon: float = Field(..., description="Longitude (degrees)")
    alt_km: float = Field(..., description="Altitude (km)")
    fuel_kg: float = Field(..., description="Remaining fuel (kg)")
    status: Literal["NOMINAL", "CRITICAL_FUEL", "EOL"] = Field(..., description="Operational status")

class VisualizationSnapshotResponse(BaseModel):
    """Response payload for visualization snapshot."""
    timestamp: str = Field(..., description="Current simulation timestamp (ISO 8601)")
    satellites: List[SatelliteStatus] = Field(..., description="Satellite status list")
    debris_cloud: List[list] = Field(..., description="Compact debris array [id, lat, lon, alt]")