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
from satellite_api.coordinates import convert_states_to_lla

# ============================================================================
# ORBITAL & SPACECRAFT CONSTANTS (EXACT NSH 2026 VALUES)
# ============================================================================
MU_EARTH = 398600.4418      
R_EARTH = 6378.137          
J2 = 1.08263e-3             
J3 = -2.53266e-6            
J4 = 1.61962e-6             
J2_CONST = 1.5 * J2 * MU_EARTH * R_EARTH * R_EARTH
J3_CONST = 0.5 * J3 * MU_EARTH * R_EARTH**3
J4_CONST = 0.125 * J4 * MU_EARTH * R_EARTH**4
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
            import os
            import sys
            if os.environ.get("UVICORN_WORKERS") and int(os.environ.get("UVICORN_WORKERS", 1)) > 1:
                print(f"⚠️ Warning: Running with multiple workers (UVICORN_WORKERS={os.environ['UVICORN_WORKERS']}) - state will be duplicated!", file=sys.stderr)
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
            cls._instance.sat_drag_coeff = np.full((100,), 0.02, dtype=np.float64)
            cls._instance.debris_drag_coeff = np.full((15000,), 0.05, dtype=np.float64)
            
            # ── 4. Bi-Directional ID Mapping ───────────────────────────────────
            cls._instance.sat_id_to_idx: Dict[str, int] = {}
            cls._instance.idx_to_sat_id: Dict[int, str] = {}
            cls._instance.debris_id_to_idx: Dict[str, int] = {}
            cls._instance.idx_to_debris_id: Dict[int, str] = {}
            
            # ── 5. Temporal Maneuver Queue ─────────────────────────────────────
            cls._instance.maneuver_queue: List[Tuple[float, str, float, float, float, str]] = []
            cls._instance.maneuver_history: List[dict] = []
            
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
        """Zero-allocation J3/J4 acceleration. Mutates the pre-allocated out_a buffer."""
        x = r[:n_sats, 0]
        y = r[:n_sats, 1]
        z = r[:n_sats, 2]
        
        r2 = x*x + y*y + z*z
        r_mag = np.sqrt(r2)
        r_inv = 1.0 / r_mag
        r2_inv = r_inv * r_inv
        r3_inv = r2_inv * r_inv
        r4_inv = r2_inv * r2_inv
        r5_inv = r3_inv * r2_inv
        r7_inv = r4_inv * r3_inv

        a_base = -MU_EARTH * r3_inv
        
        # J2
        j2_base = J2_CONST * r5_inv
        z2_r2 = z * z * r2_inv
        
        # J3
        j3_base = J3_CONST * r7_inv
        z_r = z * r_inv
        
        # J4
        j4_base = J4_CONST * r7_inv * r2_inv
        z4_r4 = (z_r**2)**2

        t1 = a_base + j2_base * (5.0 * z2_r2 - 1.0) + \
             x * j3_base * (5.0 * (7.0 * z_r**2 - 3.0) * z_r) + \
             j4_base * (3.0 - 42.0 * z_r**2 + 63.0 * z4_r4)
             
        t3 = a_base + j2_base * (5.0 * z2_r2 - 3.0) + \
             j3_base * (35.0 * z_r**3 - 30.0 * z_r) + \
             j4_base * (15.0 - 70.0 * z_r**2 + 63.0 * z4_r4)

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
                    
                    new_drag = np.full((new_size,), 0.02, dtype=np.float64)
                    new_drag[:self.sat_drag_coeff.shape[0]] = self.sat_drag_coeff
                    self.sat_drag_coeff = new_drag
                    
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
                # Pack as tuple: (ts, sat_id, dvx, dvy, dvz, burn_id)
                if len(maneuver) == 6:
                    burn_ts, sat_id, dvx, dvy, dvz, burn_id = maneuver
                else:
                    burn_ts, sat_id, dvx, dvy, dvz = maneuver
                    burn_id = f"PENDING_{sat_id}_{int(burn_ts)}"
                
                if burn_ts <= (target_time_ts + 0.1):
                    if sat_id in self.sat_id_to_idx:
                        idx = self.sat_id_to_idx[sat_id]
                        
                        # Cooldown check
                        if self.sat_cooldown_timers[idx] > 0.1:
                            logger.warning(f"BLOCKED: {sat_id} attempted burn during cooldown (remaining {self.sat_cooldown_timers[idx]:.1f}s)")
                            continue
                        
                        # Fuel constraint
                        dv_mag_mps = math.sqrt(dvx**2 + dvy**2 + dvz**2) * 1000.0
                        current_mass = DRY_MASS + self.sat_fuel[idx]
                        required_fuel = current_mass * (1.0 - math.exp(-dv_mag_mps / (I_SP * G0)))
                        
                        if self.sat_fuel[idx] < required_fuel:
                            logger.warning(f"FAILED: {sat_id} insufficient fuel.")
                            continue
                        
                        # Get current position (ECI) for lat/lon
                        r_eci = self.sat_buffer[idx, 0:3].copy()
                        # Convert to LLA using current_time
                        lla_list = convert_states_to_lla(r_eci.reshape(1, 3), self.current_time)
                        lat, lon = lla_list[0][1], lla_list[0][2]  # [idx, lat, lon, alt]
                        
                        # Execute burn
                        self.sat_buffer[idx, 3] += dvx
                        self.sat_buffer[idx, 4] += dvy
                        self.sat_buffer[idx, 5] += dvz
                        
                        # Deduct fuel and set cooldown
                        self.sat_fuel[idx] -= required_fuel
                        self.sat_cooldown_timers[idx] = COOLDOWN_LIMIT
                        
                        # Record in history
                        burn_record = {
                            "burn_id": burn_id if burn_id.startswith("EXEC") else f"EXEC_{burn_id}",
                            "satellite_id": sat_id,
                            "burnTime": datetime.fromtimestamp(burn_ts, tz=timezone.utc).isoformat() + "Z",
                            "deltaV_vector": {"x": dvx, "y": dvy, "z": dvz},
                            "maneuver_type": "UNKNOWN",  # We don't store type in queue; can be passed via extra field
                            "duration_seconds": 1,
                            "cooldown_start": datetime.fromtimestamp(burn_ts, tz=timezone.utc).isoformat() + "Z",
                            "cooldown_end": datetime.fromtimestamp(burn_ts + COOLDOWN_LIMIT, tz=timezone.utc).isoformat() + "Z",
                            "delta_v_magnitude": dv_mag_mps,
                            "fuel_consumed_kg": required_fuel,
                            "lat": lat,
                            "lon": lon,
                            "status": "EXECUTED"
                        }
                        self.maneuver_history.append(burn_record)
                        executed_count += 1
                        print(f"🔥 Burn Executed on {sat_id} | Cost: {required_fuel:.4f}kg | Fuel Rem: {self.sat_fuel[idx]:.2f}kg")
                else:
                    remaining_queue.append(maneuver)
            
            self.maneuver_queue = remaining_queue
        return executed_count

    async def add_maneuver(self, maneuver: tuple):
        """Adds a maneuver to the queue. maneuver: (ts, sat_id, dvx, dvy, dvz, burn_id)"""
        async with self.lock:
            self.maneuver_queue.append(maneuver)

    async def cancel_maneuver(self, burn_id: str) -> bool:
        """Cancels a maneuver by burn_id."""
        async with self.lock:
            new_queue = []
            found = False
            for maneuver in self.maneuver_queue:
                if len(maneuver) >= 6 and maneuver[5] == burn_id:
                    found = True
                    continue
                new_queue.append(maneuver)
            self.maneuver_queue = new_queue
            return found

    async def get_all_maneuvers(self) -> List[dict]:
        async with self.lock:
            # Build pending maneuvers from queue
            pending = []
            for maneuver in self.maneuver_queue:
                if len(maneuver) == 6:
                    burn_ts, sat_id, dvx, dvy, dvz, burn_id = maneuver
                else:
                    burn_ts, sat_id, dvx, dvy, dvz = maneuver
                    burn_id = f"PENDING_{sat_id}_{int(burn_ts)}"
                pending.append({
                    "burn_id": burn_id,
                    "satellite_id": sat_id,
                    "burnTime": datetime.fromtimestamp(burn_ts, tz=timezone.utc).isoformat() + "Z",
                    "deltaV_vector": {"x": dvx, "y": dvy, "z": dvz},
                    "maneuver_type": "UNKNOWN",
                    "duration_seconds": 1,
                    "cooldown_start": datetime.fromtimestamp(burn_ts, tz=timezone.utc).isoformat() + "Z",
                    "cooldown_end": datetime.fromtimestamp(burn_ts + COOLDOWN_LIMIT, tz=timezone.utc).isoformat() + "Z",
                    "delta_v_magnitude": math.sqrt(dvx**2 + dvy**2 + dvz**2) * 1000.0,
                    "fuel_consumed_kg": None,  # not known until execution
                    "lat": None,
                    "lon": None,
                    "status": "pending"
                })
            # Combine with history (most recent first)
            all_maneuvers = pending + self.maneuver_history
            return all_maneuvers

    
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