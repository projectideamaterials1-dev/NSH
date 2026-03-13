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


# ─── /api/telemetry ───────────────────────────────────────────────────────────

class TelemetryIngestionRequest(BaseModel):
    timestamp: datetime
    objects: List[SpaceObject]


class TelemetryIngestionResponse(BaseModel):
    status: str = "ACK"
    processed_count: int
    active_cdm_warnings: int
    warning_pairs: Optional[List[dict]] = None


# ─── /api/simulation/tick ─────────────────────────────────────────────────────

class SimulationTickRequest(BaseModel):
    tick_duration_s: float = Field(
        ..., gt=0, le=3600, description="Seconds to advance (1–3600)"
    )


class CollisionWarning(BaseModel):
    object1: str
    object2: str
    closest_approach_km: float
    predicted_time: Optional[str] = None
    risk_level: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]


class UpdatedObject(BaseModel):
    id: str
    type: str
    r: Vec3
    v: Vec3


class SimulationTickResponse(BaseModel):
    status: str = "TICK_PROCESSED"
    sim_time_elapsed_s: float
    tick_duration_s: float
    updated_objects: List[UpdatedObject]
    collision_warnings: List[CollisionWarning]
    total_objects_tracked: int