import numpy as np
import asyncio
from typing import List, Optional, Dict, Tuple
from datetime import datetime, timedelta
import logging

# ============================================================================
# ORBITAL & SPACECRAFT CONSTANTS (Synced with physics_rk4.cpp)
# ============================================================================
MU_EARTH = 398600.4418      # km³/s²
R_EARTH = 6378.137          # km
J2 = 1.08263e-3             # Exact match to PDF
I_SP = 300.0                # seconds
G0 = 9.80665                # m/s²
MAX_DELTA_V_MPS = 15.0      # m/s per burn
COOLDOWN_SECONDS = 600.0    # Thermal cooldown in seconds
INITIAL_FUEL = 50.0         # kg
DRY_MASS = 500.0            # kg

logger = logging.getLogger(__name__)

class StateManager:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(StateManager, cls).__new__(cls)
            cls._instance._lock = None
            
            # Kinematic State Buffers (ECI Frame)
            cls._instance.sat_buffer = np.zeros((100, 6), dtype=np.float64)
            cls._instance.debris_buffer = np.zeros((15000, 6), dtype=np.float64)
            
            # 1D Constraint Tracking Arrays
            cls._instance.sat_fuel = np.full((100,), INITIAL_FUEL, dtype=np.float64)
            cls._instance.sat_cooldown_timers = np.zeros((100,), dtype=np.float64)
            cls._instance.sat_initial_mass = np.full((100,), DRY_MASS + INITIAL_FUEL, dtype=np.float64)
            
            # Feature 1: Bi-Directional ID Mapping
            cls._instance.sat_id_to_idx: Dict[str, int] = {}
            cls._instance.idx_to_sat_id: List[str] = []
            cls._instance.idx_to_debris_id: List[str] = []
            
            # Feature 2: Temporal Maneuver Queue
            # Elements: (burn_timestamp, sat_id, dv_x, dv_y, dv_z)
            cls._instance.maneuver_queue: List[Tuple[float, str, float, float, float]] = []
            
            # State Metrics
            cls._instance.sat_count = 0
            cls._instance.debris_count = 0
            cls._instance.is_initialized = False
            cls._instance.current_time: Optional[datetime] = None
        return cls._instance

    @property
    def lock(self):
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def update_telemetry_raw(self, sat_data: List, debris_data: List, 
                                   sat_ids: List[str], debris_ids: List[str], 
                                   timestamp_str: str):
        """Ingests raw telemetry, resizes buffers, and maps String IDs to NumPy indices."""
        async with self.lock:
            self.current_time = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
            
            if sat_data:
                sat_array = np.array(sat_data, dtype=np.float64)
                target_len = len(sat_array)
                
                # --- CRITICAL FIX: Preserve Fuel/Constraints by ID, not Index ---
                # Create a map of existing fuel states before resizing
                old_fuel_map = {}
                old_cooldown_map = {}
                old_mass_map = {}
                for i in range(self.sat_count):
                    if i < len(self.idx_to_sat_id):
                        sid = self.idx_to_sat_id[i]
                        old_fuel_map[sid] = self.sat_fuel[i]
                        old_cooldown_map[sid] = self.sat_cooldown_timers[i]
                        old_mass_map[sid] = self.sat_initial_mass[i]
                # ---------------------------------------------------------------

                # Dynamic Resize Logic
                if target_len > self.sat_buffer.shape[0]:
                    new_size = max(target_len, self.sat_buffer.shape[0] * 2)
                    
                    new_buffer = np.zeros((new_size, 6), dtype=np.float64)
                    new_buffer[:self.sat_count, :] = self.sat_buffer[:self.sat_count, :]
                    self.sat_buffer = new_buffer
                    
                    # Resize 1D arrays
                    self.sat_fuel = np.resize(self.sat_fuel, new_size)
                    self.sat_cooldown_timers = np.resize(self.sat_cooldown_timers, new_size)
                    self.sat_initial_mass = np.resize(self.sat_initial_mass, new_size)

                self.sat_buffer[:target_len, :] = sat_array
                self.sat_count = target_len
                
                # ID Mapping Updates
                self.idx_to_sat_id = sat_ids
                self.sat_id_to_idx = {sid: idx for idx, sid in enumerate(sat_ids)}

                # --- CRITICAL FIX: Restore Fuel/Constraints by New ID Index ---
                for i, sid in enumerate(sat_ids):
                    self.sat_fuel[i] = old_fuel_map.get(sid, INITIAL_FUEL)
                    self.sat_cooldown_timers[i] = old_cooldown_map.get(sid, 0.0)
                    self.sat_initial_mass[i] = old_mass_map.get(sid, DRY_MASS + INITIAL_FUEL)
                # ---------------------------------------------------------------
            
            if debris_data:
                debris_array = np.array(debris_data, dtype=np.float64)
                target_len = len(debris_array)
                
                if target_len > self.debris_buffer.shape[0]:
                    new_size = max(target_len, self.debris_buffer.shape[0] * 2)
                    new_buffer = np.zeros((new_size, 6), dtype=np.float64)
                    new_buffer[:self.debris_count, :] = self.debris_buffer[:self.debris_count, :]
                    self.debris_buffer = new_buffer
                    
                self.debris_buffer[:target_len, :] = debris_array
                self.debris_count = target_len
                self.idx_to_debris_id = debris_ids
                
            self.is_initialized = True

    async def get_state_buffers(self) -> tuple:
        async with self.lock:
            if not self.is_initialized:
                return np.empty((0, 6)), np.empty((0, 6))
            return (
                self.sat_buffer[:self.sat_count, :].copy(),
                self.debris_buffer[:self.debris_count, :].copy()
            )

    async def commit_state_buffers(self, updated_sat_array: np.ndarray, updated_debris_array: np.ndarray):
        async with self.lock:
            self.sat_buffer[:self.sat_count, :] = updated_sat_array
            self.debris_buffer[:self.debris_count, :] = updated_debris_array

    async def add_maneuver(self, sat_id: str, burn_time_ts: float, dvx: float, dvy: float, dvz: float, fuel_cost: float):
        async with self.lock:
            if sat_id not in self.sat_id_to_idx:
                raise ValueError(f"Satellite {sat_id} not found in active telemetry.")
            
            sat_idx = self.sat_id_to_idx[sat_id]
            self.sat_fuel[sat_idx] -= fuel_cost
            self.sat_cooldown_timers[sat_idx] = burn_time_ts
            self.maneuver_queue.append((burn_time_ts, sat_id, dvx, dvy, dvz))
            self.maneuver_queue.sort(key=lambda x: x[0])
            logger.info(f"QUEUED: Maneuver for {sat_id} at {burn_time_ts}. Fuel reserved: {fuel_cost:.2f}kg.")
    async def execute_pending_maneuvers(self, target_time_ts: float) -> int:
        executed_count = 0
        remaining_queue = []
        
        async with self.lock:
            for maneuver in self.maneuver_queue:
                burn_ts, sat_id, dvx, dvy, dvz = maneuver
                if burn_ts <= target_time_ts:
                    if sat_id in self.sat_id_to_idx:
                        idx = self.sat_id_to_idx[sat_id]
                        self.sat_buffer[idx, 3] += dvx
                        self.sat_buffer[idx, 4] += dvy
                        self.sat_buffer[idx, 5] += dvz
                        executed_count += 1
                    else:
                        logger.warning(f"DROPPED: Maneuver for {sat_id}. Object no longer in telemetry.")
                else:
                    remaining_queue.append(maneuver)
            self.maneuver_queue = remaining_queue
        return executed_count

    async def advance_time(self, seconds: float) -> str:
        async with self.lock:
            self.current_time += timedelta(seconds=seconds)
            return self.current_time.strftime('%Y-%m-%dT%H:%M:%S.000Z')

    def is_ready(self) -> bool:
        return self.is_initialized

def get_state() -> StateManager:
    return StateManager()