from typing import Dict, List
from models import SpaceObject
from datetime import datetime


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
        # Real-world epoch of simulation start (set on first telemetry)
        self.sim_epoch: datetime = None
        # satelliteId -> list of BurnCommand (populated by maneuver API)
        self.scheduled_maneuvers: Dict[str, List] = {}

    def upsert(self, obj: SpaceObject):
        self.objects[obj.id] = obj

    def get_all(self) -> list[SpaceObject]:
        return list(self.objects.values())

    def count(self) -> int:
        return len(self.objects)

    def add_maneuver(self, satellite_id: str, burns: list):
        """Called by maneuver scheduling API to register burns."""
        self.scheduled_maneuvers[satellite_id] = burns

    def pop_due_maneuvers(self, window_start_s: float, window_end_s: float) -> list:
        """Returns burns due within [window_start_s, window_end_s] and removes them from store."""
        due = []
        for sat_id, burns in list(self.scheduled_maneuvers.items()):
            remaining = []
            for burn in burns:
                burn_s = (burn.burnTime - self.sim_epoch).total_seconds()
                if window_start_s <= burn_s <= window_end_s:
                    due.append((sat_id, burn))
                else:
                    remaining.append(burn)
            if remaining:
                self.scheduled_maneuvers[sat_id] = remaining
            else:
                del self.scheduled_maneuvers[sat_id]
        return due