import asyncio
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Tuple
from satellite_api.models import SpaceObject, Burn

class AppState:
    def __init__(self):
        self._lock = asyncio.Lock()
        self.objects: Dict[str, SpaceObject] = {}          # id -> current state
        self.object_last_update: Dict[str, datetime] = {}  # id -> time of state
        self.fuel: Dict[str, float] = {}                   # satellite_id -> remaining fuel (kg)
        self.last_burn_time: Dict[str, datetime] = {}      # satellite_id -> last burn time
        self.maneuvers: List[Tuple[datetime, str, Burn]] = []  # (burn_time, sat_id, burn)
        self.dry_mass = 500.0
        self.current_time: datetime = datetime(2026, 3, 12, 8, 0, 0, tzinfo=timezone.utc)  # default start
        self.epoch: datetime = self.current_time            # reference for propagation

    @property
    def sim_time_s(self) -> float:
        return (self.current_time - self.epoch).total_seconds()

    @sim_time_s.setter
    def sim_time_s(self, value: float):
        self.current_time = self.epoch + timedelta(seconds=value)

    async def upsert(self, obj: SpaceObject, timestamp: datetime):
        async with self._lock:
            self.objects[obj.id] = obj
            self.object_last_update[obj.id] = timestamp
            if obj.type == "SATELLITE" and obj.id not in self.fuel:
                self.fuel[obj.id] = 50.0  # initial fuel (kg)

    async def get_all(self) -> List[SpaceObject]:
        async with self._lock:
            return list(self.objects.values())

    async def count(self) -> int:
        async with self._lock:
            return len(self.objects)

    async def add_maneuver(self, sat_id: str, burn: Burn):
        async with self._lock:
            self.maneuvers.append((burn.burnTime, sat_id, burn))
            self.maneuvers.sort(key=lambda x: x[0])  # keep sorted by time

    async def get_upcoming_maneuvers(self, until_time: datetime) -> List[Tuple[datetime, str, Burn]]:
        """Retrieve and remove all maneuvers scheduled at or before until_time."""
        async with self._lock:
            result = []
            while self.maneuvers and self.maneuvers[0][0] <= until_time:
                result.append(self.maneuvers.pop(0))
            return result

    async def set_current_time(self, new_time: datetime):
        async with self._lock:
            self.current_time = new_time