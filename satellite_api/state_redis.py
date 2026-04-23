import redis.asyncio as redis
import json
import numpy as np
from typing import List, Tuple, Optional
from datetime import datetime, timezone

class RedisStateManager:
    def __init__(self, redis_url: str = "redis://localhost:6379"):
        self.redis = redis.from_url(redis_url, decode_responses=True)
        self.lock_key = "state_lock"
        from satellite_api.db import init_db
        init_db()

    async def acquire_lock(self, timeout: int = 5) -> bool:
        return await self.redis.set(self.lock_key, "locked", nx=True, ex=timeout)

    async def release_lock(self):
        await self.redis.delete(self.lock_key)

    async def update_telemetry(self, sat_data: list, debris_data: list, 
                               sat_ids: list, debris_ids: list, timestamp_str: str):
        async with self.redis.lock(self.lock_key, timeout=5):
            await self.redis.set("sat_data", json.dumps(sat_data))
            await self.redis.set("debris_data", json.dumps(debris_data))
            await self.redis.set("sat_ids", json.dumps(sat_ids))
            await self.redis.set("debris_ids", json.dumps(debris_ids))
            await self.redis.set("timestamp", timestamp_str)
            await self.redis.set("initialized", "true")

    async def apply_delta_telemetry(self, updated_objects: list, deleted_ids: list, timestamp_str: str):
        pass # Placeholder

    async def get_state_buffers(self) -> Tuple[np.ndarray, np.ndarray]:
        sat_data = await self.redis.get("sat_data")
        debris_data = await self.redis.get("debris_data")
        if not sat_data:
            return np.empty((0, 6)), np.empty((0, 6))
        sat_arr = np.array(json.loads(sat_data), dtype=np.float64)
        debris_arr = np.array(json.loads(debris_data), dtype=np.float64)
        return sat_arr, debris_arr

    async def commit_state_buffers(self, updated_sat: np.ndarray, updated_debris: np.ndarray):
        await self.redis.set("sat_data", json.dumps(updated_sat.tolist()))
        await self.redis.set("debris_data", json.dumps(updated_debris.tolist()))

    async def add_maneuver(self, maneuver: tuple):
        from satellite_api.db import add_pending_maneuver
        add_pending_maneuver(*maneuver)

    async def cancel_maneuver(self, burn_id: str) -> bool:
        return True

    async def get_all_maneuvers(self) -> List[dict]:
        return []

    def is_ready(self) -> bool:
        return True

    @property
    def current_time(self):
        return datetime.now(timezone.utc)

    @property
    def sat_fuel(self):
        return []
    
    @property
    def lock(self):
        class DummyLock:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
        return DummyLock()
