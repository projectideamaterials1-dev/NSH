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
    fuel_kg: float = 50.0
    dry_mass_kg: float = 500.0
    last_burn_time_s: float = -9999.0


# ─── /api/telemetry ───────────────────────────────────────────────────────────

class TelemetryIngestionRequest(BaseModel):
    timestamp: datetime
    objects: List[SpaceObject]


class TelemetryIngestionResponse(BaseModel):
    status: str = "ACK"
    processed_count: int
    active_cdm_warnings: int
    warning_pairs: Optional[List[dict]] = None


# ─── Collision Warning (used by collision.py) ─────────────────────────────────

class CollisionWarning(BaseModel):
    object1: str
    object2: str
    closest_approach_km: float
    predicted_time: Optional[str] = None
    risk_level: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]


# ─── /api/simulate/step ───────────────────────────────────────────────────────

class SimulateStepRequest(BaseModel):
    step_seconds: float = Field(..., gt=0, description="Seconds to advance")


class SimulateStepResponse(BaseModel):
    status: str = "STEP_COMPLETE"
    new_timestamp: str
    collisions_detected: int
    maneuvers_executed: int


# ─── Maneuver structures (for teammate's API + tick execution) ─────────────────

class BurnCommand(BaseModel):
    burn_id: str
    burnTime: datetime
    deltaV_vector: Vec3


class ScheduledManeuver(BaseModel):
    satelliteId: str
    maneuver_sequence: List[BurnCommand]