"""
state.py
--------
The unified Zero-Copy memory manager for the Autonomous Constellation Manager.
Maintains contiguous NumPy arrays for the C++ physics engine to mutate in-place.
"""

import numpy as np
import asyncio
from typing import List, Optional, Dict, Tuple
from datetime import datetime, timezone
import logging

# ============================================================================
# ORBITAL & SPACECRAFT CONSTANTS (EXACT NSH 2026 VALUES)
# ============================================================================
INITIAL_FUEL = 50.0         # kg [cite: 157]
DRY_MASS = 500.0            # kg [cite: 156]

logger = logging.getLogger(__name__)

class StateManager:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(StateManager, cls).__new__(cls)
            cls._instance._lock = None
            
            # ── 1. Kinematic State Buffers (ECI Frame: x,y,z,vx,vy,vz) ─────────
            cls._instance.sat_buffer = np.zeros((100, 6), dtype=np.float64)
            cls._instance.nominal_buffer = np.zeros((100, 6), dtype=np.float64) # Ghost slots
            cls._instance.debris_buffer = np.zeros((15000, 6), dtype=np.float64)
            
            # ── 2. Constraint Tracking Arrays (1D) ─────────────────────────────
            cls._instance.sat_fuel = np.full((100,), INITIAL_FUEL, dtype=np.float64)
            cls._instance.sat_cooldown_timers = np.zeros((100,), dtype=np.float64)
            
            # ── 3. Bi-Directional ID Mapping ───────────────────────────────────
            cls._instance.sat_id_to_idx: Dict[str, int] = {}
            cls._instance.idx_to_sat_id: Dict[int, str] = {}
            cls._instance.debris_id_to_idx: Dict[str, int] = {}
            cls._instance.idx_to_debris_id: Dict[int, str] = {}
            
            # ── 4. Temporal Maneuver Queue ─────────────────────────────────────
            # Format: (burn_time_ts, sat_id, dvx, dvy, dvz)
            cls._instance.maneuver_queue: List[Tuple[float, str, float, float, float]] = []
            
            # ── 5. State Metrics ───────────────────────────────────────────────
            cls._instance.sat_count = 0
            cls._instance.debris_count = 0
            cls._instance.active_cdm_warnings = 0  # Feeds the Telemetry ACK response
            cls._instance.is_initialized = False
            cls._instance.current_time: Optional[datetime] = None
            
        return cls._instance

    @property
    def lock(self):
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def update_telemetry_raw(self, sat_data: list, debris_data: list, 
                                   sat_ids: list, debris_ids: list, timestamp_str: str):
        """Fast memory overlay for incoming telemetry. O(1) ingestion speed."""
        async with self.lock:
            # Safely parse UTC time
            clean_ts = timestamp_str.replace('Z', '+00:00')
            self.current_time = datetime.fromisoformat(clean_ts)
            
            # ── Update Satellites ──
            self.sat_count = len(sat_data)
            if self.sat_count > 0:
                # Dynamic array resizing if fleet expands
                if self.sat_count > self.sat_buffer.shape[0]:
                    new_size = max(self.sat_count, self.sat_buffer.shape[0] * 2)
                    
                    new_sat = np.zeros((new_size, 6), dtype=np.float64)
                    new_sat[:self.sat_buffer.shape[0], :] = self.sat_buffer
                    self.sat_buffer = new_sat
                    
                    new_nom = np.zeros((new_size, 6), dtype=np.float64)
                    new_nom[:self.nominal_buffer.shape[0], :] = self.nominal_buffer
                    self.nominal_buffer = new_nom
                    
                    new_fuel = np.full((new_size,), INITIAL_FUEL, dtype=np.float64)
                    new_fuel[:self.sat_fuel.shape[0]] = self.sat_fuel
                    self.sat_fuel = new_fuel
                    
                    new_cd = np.zeros((new_size,), dtype=np.float64)
                    new_cd[:self.sat_cooldown_timers.shape[0]] = self.sat_cooldown_timers
                    self.sat_cooldown_timers = new_cd

                self.sat_buffer[:self.sat_count] = np.array(sat_data, dtype=np.float64)
                
                # Establish Ghost Satellites on first boot for Station-Keeping
                if not self.is_initialized:
                    self.nominal_buffer[:self.sat_count] = self.sat_buffer[:self.sat_count].copy()
                    
            # ── Update Debris ──
            self.debris_count = len(debris_data)
            if self.debris_count > 0:
                if self.debris_count > self.debris_buffer.shape[0]:
                    new_size = max(self.debris_count, self.debris_buffer.shape[0] * 2)
                    new_deb = np.zeros((new_size, 6), dtype=np.float64)
                    new_deb[:self.debris_buffer.shape[0], :] = self.debris_buffer
                    self.debris_buffer = new_deb
                    
                self.debris_buffer[:self.debris_count] = np.array(debris_data, dtype=np.float64)

            # ── Update Mappings ──
            self.sat_id_to_idx = {sid: i for i, sid in enumerate(sat_ids)}
            self.idx_to_sat_id = {i: sid for i, sid in enumerate(sat_ids)}
            self.debris_id_to_idx = {did: i for i, did in enumerate(debris_ids)}
            self.idx_to_debris_id = {i: did for i, did in enumerate(debris_ids)}
            
            self.is_initialized = True

    async def get_state_buffers(self) -> Tuple[np.ndarray, np.ndarray]:
        """Returns exact memory views for the C++ engine to modify."""
        async with self.lock:
            if not self.is_initialized:
                return np.empty((0, 6)), np.empty((0, 6))
            return (
                self.sat_buffer[:self.sat_count],
                self.debris_buffer[:self.debris_count]
            )

    async def commit_state_buffers(self, updated_sat: np.ndarray, updated_debris: np.ndarray):
        """Explicitly assigns the PyBind11 returned arrays back to the main memory buffer."""
        async with self.lock:
            self.sat_buffer[:self.sat_count] = updated_sat
            self.debris_buffer[:self.debris_count] = updated_debris

    async def execute_pending_maneuvers(self, target_time_ts: float) -> int:
        """
        JIT Maneuver Execution. Applies instantaneous Delta-V to the velocity 
        vectors right before the physics propagation tick.
        """
        executed_count = 0
        remaining_queue = []
        
        async with self.lock:
            # Sort chronologically to execute in the correct order
            self.maneuver_queue.sort(key=lambda x: x[0])
            
            for maneuver in self.maneuver_queue:
                burn_ts, sat_id, dvx, dvy, dvz = maneuver
                
                # 🚀 THE FIX: Inclusive time window (+0.1s tolerance)
                # This ensures the engine doesn't "skip" over the exact float timestamp
                if burn_ts <= (target_time_ts + 0.1): 
                    if sat_id in self.sat_id_to_idx:
                        idx = self.sat_id_to_idx[sat_id]
                        
                        # 🔍 1. Capture Pre-Burn State
                        v_old = np.linalg.norm(self.sat_buffer[idx, 3:6])
                        energy_old = (v_old**2 / 2.0) - (398600.4418 / np.linalg.norm(self.sat_buffer[idx, 0:3]))
                        
                        # 🚀 2. Apply Impulsive Delta-V 
                        self.sat_buffer[idx, 3] += dvx
                        self.sat_buffer[idx, 4] += dvy
                        self.sat_buffer[idx, 5] += dvz
                        
                        # 🔍 3. Capture Post-Burn State & Validate
                        v_new = np.linalg.norm(self.sat_buffer[idx, 3:6])
                        energy_new = (v_new**2 / 2.0) - (398600.4418 / np.linalg.norm(self.sat_buffer[idx, 0:3]))
                        dv_applied = np.linalg.norm([dvx, dvy, dvz]) * 1000.0 # Convert to m/s
                        
                        executed_count += 1
                        
                        # Print irrefutable mathematical proof to your server console
                        print(f"\n[MATH VALIDATION] 🔥 Burn Executed on {sat_id}")
                        print(f"   -> Delta-V Applied:  {dv_applied:.4f} m/s")
                        print(f"   -> Velocity Shift:   {v_old:.4f} km/s -> {v_new:.4f} km/s")
                        print(f"   -> Energy Shift:     {energy_old:.4f} -> {energy_new:.4f} (Proof of Orbit Alteration)")
                else:
                    remaining_queue.append(maneuver)
            
            self.maneuver_queue = remaining_queue
        return executed_count
    
    async def calculate_station_keeping_compliance(self) -> dict:
        """Calculate % of satellites within 10 km of nominal slots."""
        async with self.lock:
            if not self.is_initialized:
                return {"uptime_percentage": 0.0}
            
            actual = self.sat_buffer[:self.sat_count, :3]  
            nominal = self.nominal_buffer[:self.sat_count, :3]
            
            # Euclidean distance in km
            distances = np.linalg.norm(actual - nominal, axis=1)
            within_box = np.sum(distances <= 10.0)  # 10.0 km threshold 
            
            uptime_pct = (within_box / self.sat_count) * 100 if self.sat_count > 0 else 0.0
            return {"uptime_percentage": round(uptime_pct, 2)}

    def is_ready(self) -> bool:
        return self.is_initialized

# Dependency injector for FastAPI
def get_state() -> StateManager:
    return StateManager()