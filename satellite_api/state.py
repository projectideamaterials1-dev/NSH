"""
state.py
--------
The unified Zero-Copy memory manager for the Autonomous Constellation Manager.
Maintains contiguous NumPy arrays for the C++ physics engine to mutate in-place.
Upgraded with Zero-Allocation Python RK4 to eliminate GC latency spikes.
"""

import numpy as np
import asyncio
import math
from typing import List, Optional, Dict, Tuple
from datetime import datetime, timezone
import logging

# ============================================================================
# ORBITAL & SPACECRAFT CONSTANTS (EXACT NSH 2026 VALUES)
# ============================================================================
MU_EARTH = 398600.4418      
R_EARTH = 6378.137          
J2 = 1.08263e-3             
J2_CONST = 1.5 * J2 * MU_EARTH * R_EARTH * R_EARTH
I_SP = 300.0                #
G0 = 9.80665                #
INITIAL_FUEL = 50.0         # kg
DRY_MASS = 500.0            # kg
COOLDOWN_LIMIT = 600.0      # seconds
STATION_KEEPING_RADIUS_KM = 10.0

logger = logging.getLogger(__name__)

class StateManager:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(StateManager, cls).__new__(cls)
            cls._instance._lock = None
            
            # ── 1. Kinematic State Buffers (ECI Frame: x,y,z,vx,vy,vz) ─────────
            cls._instance.sat_buffer = np.zeros((100, 6), dtype=np.float64)
            cls._instance.nominal_buffer = np.zeros((100, 6), dtype=np.float64) 
            cls._instance.debris_buffer = np.zeros((15000, 6), dtype=np.float64)
            
            # 🚀 2. Pre-allocated RK4 Ghost Buffers (Eliminates GC Spikes)
            cls._instance._a1 = np.zeros((100, 3), dtype=np.float64)
            cls._instance._a2 = np.zeros((100, 3), dtype=np.float64)
            cls._instance._a3 = np.zeros((100, 3), dtype=np.float64)
            cls._instance._a4 = np.zeros((100, 3), dtype=np.float64)
            cls._instance._r_tmp = np.zeros((100, 3), dtype=np.float64)
            
            # ── 3. Constraint Tracking Arrays (1D) ─────────────────────────────
            cls._instance.sat_fuel = np.full((100,), INITIAL_FUEL, dtype=np.float64)
            cls._instance.sat_cooldown_timers = np.zeros((100,), dtype=np.float64)
            
            # ── 4. Bi-Directional ID Mapping ───────────────────────────────────
            cls._instance.sat_id_to_idx: Dict[str, int] = {}
            cls._instance.idx_to_sat_id: Dict[int, str] = {}
            cls._instance.debris_id_to_idx: Dict[str, int] = {}
            cls._instance.idx_to_debris_id: Dict[int, str] = {}
            
            # ── 5. Temporal Maneuver Queue ─────────────────────────────────────
            cls._instance.maneuver_queue: List[Tuple[float, str, float, float, float]] = []
            
            # ── 6. State Metrics ───────────────────────────────────────────────
            cls._instance.sat_count = 0
            cls._instance.debris_count = 0
            cls._instance.active_cdm_warnings = 0  
            cls._instance.is_initialized = False
            cls._instance.current_time: Optional[datetime] = None
            
        return cls._instance

    @property
    def lock(self):
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    # ========================================================================
    # INTERNAL VECTORIZED PHYSICS (FOR GHOST SLOTS)
    # ========================================================================
    def _compute_acceleration_in_place(self, r: np.ndarray, out_a: np.ndarray, n_sats: int):
        """Zero-allocation J2 acceleration. Mutates the pre-allocated out_a buffer."""
        x = r[:n_sats, 0]
        y = r[:n_sats, 1]
        z = r[:n_sats, 2]
        
        r2 = x*x + y*y + z*z
        r_mag = np.sqrt(r2)
        r_inv = 1.0 / r_mag
        r2_inv = r_inv * r_inv
        r3_inv = r2_inv * r_inv
        r5_inv = r3_inv * r2_inv

        a_base = -MU_EARTH * r3_inv
        j2_base = J2_CONST * r5_inv
        z2_r2 = z * z * r2_inv

        t1 = a_base + j2_base * (5.0 * z2_r2 - 1.0)
        t3 = a_base + j2_base * (5.0 * z2_r2 - 3.0)

        out_a[:n_sats, 0] = x * t1
        out_a[:n_sats, 1] = y * t1
        out_a[:n_sats, 2] = z * t3

    async def advance_simulation_time(self, dt_seconds: float):
        """Ticks the simulation forward, updating cooldowns and Ghost Slots."""
        async with self.lock:
            if not self.is_initialized or self.sat_count == 0:
                return

            if self.current_time:
                self.current_time = datetime.fromtimestamp(self.current_time.timestamp() + dt_seconds, tz=timezone.utc)

            self.sat_cooldown_timers[:self.sat_count] = np.maximum(
                0.0, self.sat_cooldown_timers[:self.sat_count] - dt_seconds
            )

            # 🚀 OPTIMIZED: Allocation-free RK4 loop prevents GC Thrashing
            steps = max(1, int(math.ceil(dt_seconds / 5.0)))
            dt = dt_seconds / steps
            n = self.sat_count

            r1 = self.nominal_buffer[:n, 0:3]
            v1 = self.nominal_buffer[:n, 3:6]

            for _ in range(steps):
                self._compute_acceleration_in_place(r1, self._a1, n)

                self._r_tmp[:n] = r1 + 0.5 * dt * v1
                v2 = v1 + 0.5 * dt * self._a1[:n]
                self._compute_acceleration_in_place(self._r_tmp, self._a2, n)

                self._r_tmp[:n] = r1 + 0.5 * dt * v2
                v3 = v1 + 0.5 * dt * self._a2[:n]
                self._compute_acceleration_in_place(self._r_tmp, self._a3, n)

                self._r_tmp[:n] = r1 + dt * v3
                v4 = v1 + dt * self._a3[:n]
                self._compute_acceleration_in_place(self._r_tmp, self._a4, n)

                r1 += (dt / 6.0) * (v1 + 2*v2 + 2*v3 + v4)
                v1 += (dt / 6.0) * (self._a1[:n] + 2*self._a2[:n] + 2*self._a3[:n] + self._a4[:n])

    # ========================================================================
    # TELEMETRY & MEMORY MANAGEMENT
    # ========================================================================
    async def update_telemetry_raw(self, sat_data: list, debris_data: list, 
                                   sat_ids: list, debris_ids: list, timestamp_str: str):
        async with self.lock:
            clean_ts = timestamp_str.replace('Z', '+00:00')
            self.current_time = datetime.fromisoformat(clean_ts)
            
            self.sat_count = len(sat_data)
            if self.sat_count > 0:
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
                    
                    # 🚀 CRITICAL FIX: Resize RK4 Ghost buffers to prevent crash on >100 sats
                    self._a1 = np.zeros((new_size, 3), dtype=np.float64)
                    self._a2 = np.zeros((new_size, 3), dtype=np.float64)
                    self._a3 = np.zeros((new_size, 3), dtype=np.float64)
                    self._a4 = np.zeros((new_size, 3), dtype=np.float64)
                    self._r_tmp = np.zeros((new_size, 3), dtype=np.float64)

                self.sat_buffer[:self.sat_count] = np.array(sat_data, dtype=np.float64)
                
                # Establish Ghost Satellites purely on first boot
                if not self.is_initialized:
                    self.nominal_buffer[:self.sat_count] = self.sat_buffer[:self.sat_count].copy()
                    
            self.debris_count = len(debris_data)
            if self.debris_count > 0:
                if self.debris_count > self.debris_buffer.shape[0]:
                    new_size = max(self.debris_count, self.debris_buffer.shape[0] * 2)
                    new_deb = np.zeros((new_size, 6), dtype=np.float64)
                    new_deb[:self.debris_buffer.shape[0], :] = self.debris_buffer
                    self.debris_buffer = new_deb
                    
                self.debris_buffer[:self.debris_count] = np.array(debris_data, dtype=np.float64)

            self.sat_id_to_idx = {sid: i for i, sid in enumerate(sat_ids)}
            self.idx_to_sat_id = {i: sid for i, sid in enumerate(sat_ids)}
            self.debris_id_to_idx = {did: i for i, did in enumerate(debris_ids)}
            self.idx_to_debris_id = {i: did for i, did in enumerate(debris_ids)}
            
            self.is_initialized = True

    async def get_state_buffers(self) -> Tuple[np.ndarray, np.ndarray]:
        async with self.lock:
            if not self.is_initialized:
                return np.empty((0, 6)), np.empty((0, 6))
            return (
                self.sat_buffer[:self.sat_count],
                self.debris_buffer[:self.debris_count]
            )

    async def commit_state_buffers(self, updated_sat: np.ndarray, updated_debris: np.ndarray):
        async with self.lock:
            self.sat_buffer[:self.sat_count] = updated_sat
            self.debris_buffer[:self.debris_count] = updated_debris

    # ========================================================================
    # BURN EXECUTION & COMPLIANCE
    # ========================================================================
    async def execute_pending_maneuvers(self, target_time_ts: float) -> int:
        executed_count = 0
        remaining_queue = []
        
        async with self.lock:
            self.maneuver_queue.sort(key=lambda x: x[0])
            
            for maneuver in self.maneuver_queue:
                burn_ts, sat_id, dvx, dvy, dvz = maneuver
                
                if burn_ts <= (target_time_ts + 0.1): 
                    if sat_id in self.sat_id_to_idx:
                        idx = self.sat_id_to_idx[sat_id]
                        
                        # Check Cooldown Constraint
                        if self.sat_cooldown_timers[idx] > 0.1:
                            logger.warning(f"BLOCKED: {sat_id} attempted burn during cooldown period.")
                            continue

                        # Check Fuel Constraint
                        dv_mag_mps = math.sqrt(dvx**2 + dvy**2 + dvz**2) * 1000.0
                        current_mass = DRY_MASS + self.sat_fuel[idx]
                        required_fuel = current_mass * (1.0 - math.exp(-dv_mag_mps / (I_SP * G0)))
                        
                        if self.sat_fuel[idx] < required_fuel:
                            logger.warning(f"FAILED: {sat_id} has insufficient fuel for maneuver.")
                            continue

                        # Execute Physics
                        self.sat_buffer[idx, 3] += dvx
                        self.sat_buffer[idx, 4] += dvy
                        self.sat_buffer[idx, 5] += dvz
                        
                        # Apply Deductions & Cooldown
                        self.sat_fuel[idx] -= required_fuel
                        self.sat_cooldown_timers[idx] = COOLDOWN_LIMIT 

                        executed_count += 1
                        print(f"🔥 Burn Executed on {sat_id} | Cost: {required_fuel:.4f}kg | Fuel Rem: {self.sat_fuel[idx]:.2f}kg")
                else:
                    remaining_queue.append(maneuver)
            
            self.maneuver_queue = remaining_queue
        return executed_count
    
    async def calculate_station_keeping_compliance(self) -> dict:
        async with self.lock:
            if not self.is_initialized or self.sat_count == 0:
                return {"uptime_percentage": 0.0}
            
            actual = self.sat_buffer[:self.sat_count, :3]  
            nominal = self.nominal_buffer[:self.sat_count, :3]
            
            distances = np.linalg.norm(actual - nominal, axis=1)
            within_box = np.sum(distances <= STATION_KEEPING_RADIUS_KM) 
            
            uptime_pct = (within_box / self.sat_count) * 100 
            return {"uptime_percentage": round(uptime_pct, 2)}

    def is_ready(self) -> bool:
        return self.is_initialized

def get_state() -> StateManager:
    return StateManager()