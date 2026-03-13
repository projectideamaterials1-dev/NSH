from typing import Dict
from models import SpaceObject


class AppState:
    """
    Thread-safe (for single-worker) in-memory store for all tracked space objects.
    In production, replace with Redis / TimescaleDB.
    """

    def __init__(self):
        # object_id -> SpaceObject
        self.objects: Dict[str, SpaceObject] = {}
        # Simulation clock (seconds elapsed since first telemetry)
        self.sim_time_s: float = 0.0

    def upsert(self, obj: SpaceObject):
        self.objects[obj.id] = obj

    def get_all(self) -> list[SpaceObject]:
        return list(self.objects.values())

    def count(self) -> int:
        return len(self.objects)