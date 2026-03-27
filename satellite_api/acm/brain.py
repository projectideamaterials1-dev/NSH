import numpy as np
import math
from typing import List, Optional
from datetime import datetime, timedelta
from dataclasses import dataclass
from enum import Enum

# ============================================================================
# EXACT ORBITAL CONSTANTS & CONSTRAINTS (NSH 2026 Strict Compliance)
# ============================================================================
MU_EARTH = 398600.4418      
R_EARTH = 6378.137          
J2 = 1.08263e-3             
I_SP = 300.0                
G0 = 9.80665                
MAX_DELTA_V_MPS = 15.0      
MAX_DELTA_V_KMS = MAX_DELTA_V_MPS / 1000.0  
COOLDOWN_SECONDS = 600.0    
INITIAL_FUEL = 50.0         
DRY_MASS = 500.0            
STATION_KEEPING_RADIUS_KM = 10.0  
COLLISION_THRESHOLD_KM = 0.100    
J2_CONST = 1.5 * J2 * MU_EARTH * R_EARTH * R_EARTH

class ManeuverType(Enum):
    PHASING_PROGRADE = "PHASING_PROGRADE"
    PHASING_RETROGRADE = "PHASING_RETROGRADE"
    RADIAL_SHUNT = "RADIAL_SHUNT"
    RECOVERY = "RECOVERY"
    EOL_GRAVEYARD = "EOL_GRAVEYARD"

@dataclass
class Conjunction:
    sat_idx: int
    debris_idx: int
    tca_seconds: float          
    miss_distance_km: float     
    relative_velocity_kms: float 
    risk_score: float           

@dataclass
class ManeuverPlan:
    sat_idx: int
    maneuver_type: ManeuverType
    delta_v_rtn: np.ndarray     
    burn_time_offset_s: float   
    estimated_fuel_kg: float
    recovery_required: bool
    confidence: float           
    delta_v_eci_dict: dict = None  # Pre-calculated sequential ECI vector

class AutonomousBrain:
    def __init__(self):
        self.eol_scheduled = set()
        # 🚀 PATCH 1: Global Sequence Registry to prevent overlapping burns
        self.locked_satellites = {}
        
    # ========================================================================
    # 1. HIGH-FIDELITY PHYSICS & FRAME ROTATION
    # ========================================================================
    def eci_to_rtn_basis(self, r_eci: np.ndarray, v_eci: np.ndarray) -> np.ndarray:
        r_norm = np.linalg.norm(r_eci)
        v_norm = np.linalg.norm(v_eci)
        if r_norm < 1e-10 or v_norm < 1e-10: return np.eye(3)
        R_hat = r_eci / r_norm
        N_hat = np.cross(r_eci, v_eci)
        n_norm = np.linalg.norm(N_hat)
        if n_norm < 1e-10: return np.eye(3)
        N_hat = N_hat / n_norm
        T_hat = np.cross(N_hat, R_hat)
        return np.column_stack([R_hat, T_hat, N_hat])
        
    def _compute_acceleration(self, state: np.ndarray) -> np.ndarray:
        r = state[:3]
        r2 = np.dot(r, r)
        r_mag = math.sqrt(r2)
        r3_inv = 1.0 / (r_mag * r2)
        r5_inv = r3_inv / r2
        a_two_body = -MU_EARTH * r3_inv
        j2_factor = J2_CONST * r5_inv
        z2_r2 = (r[2] ** 2) / r2
        ax = r[0] * (a_two_body + j2_factor * (5.0 * z2_r2 - 1.0))
        ay = r[1] * (a_two_body + j2_factor * (5.0 * z2_r2 - 1.0))
        az = r[2] * (a_two_body + j2_factor * (5.0 * z2_r2 - 3.0))
        return np.array([ax, ay, az])

    def propagate_rk4(self, r_eci: np.ndarray, v_eci: np.ndarray, dt_s: float) -> tuple:
        if dt_s <= 0: return r_eci.copy(), v_eci.copy()
        state = np.concatenate([r_eci, v_eci])
        steps = max(1, int(math.ceil(dt_s / 5.0))) 
        dt = dt_s / steps
        for _ in range(steps):
            v1 = state[3:6]
            a1 = self._compute_acceleration(state)
            s2 = state + 0.5 * dt * np.concatenate([v1, a1])
            v2 = s2[3:6]
            a2 = self._compute_acceleration(s2)
            s3 = state + 0.5 * dt * np.concatenate([v2, a2])
            v3 = s3[3:6]
            a3 = self._compute_acceleration(s3)
            s4 = state + dt * np.concatenate([v3, a3])
            v4 = s4[3:6]
            a4 = self._compute_acceleration(s4)
            state += (dt / 6.0) * np.concatenate([v1 + 2*v2 + 2*v3 + v4, a1 + 2*a2 + 2*a3 + a4])
        return state[:3], state[3:6]

    # ========================================================================
    # 2. COMMUNICATION & RESOURCE MANAGEMENT
    # ========================================================================
    def calculate_fuel_cost(self, delta_v_kms: float, current_mass_kg: float) -> float:
        delta_v_mps = delta_v_kms * 1000.0
        return current_mass_kg * (1.0 - math.exp(-abs(delta_v_mps) / (I_SP * G0)))

    def _calculate_gmst(self, sim_time: datetime) -> float:
        jd = sim_time.timestamp() / 86400.0 + 2440587.5
        d = jd - 2451545.0
        gmst = 18.697374558 + 24.06570982441908 * d
        return (gmst % 24) * 15.0 * math.pi / 180.0

    def check_line_of_sight(self, sat_eci: np.ndarray, sim_time: datetime, ground_stations: list) -> bool:
        if not ground_stations: return True 
        theta_gmst = self._calculate_gmst(sim_time)
        cos_t, sin_t = math.cos(theta_gmst), math.sin(theta_gmst)
        for gs in ground_stations:
            lat_rad = math.radians(gs['latitude'])
            lon_rad = math.radians(gs['longitude'])
            alt_km = gs['elevation_m'] / 1000.0
            r = R_EARTH + alt_km
            x_ecef = r * math.cos(lat_rad) * math.cos(lon_rad)
            y_ecef = r * math.cos(lat_rad) * math.sin(lon_rad)
            z_ecef = r * math.sin(lat_rad)
            x_eci = x_ecef * cos_t - y_ecef * sin_t
            y_eci = x_ecef * sin_t + y_ecef * cos_t
            gs_eci = np.array([x_eci, y_eci, z_ecef])
            range_vec = sat_eci - gs_eci
            range_mag = np.linalg.norm(range_vec)
            cos_zenith = np.dot(gs_eci / np.linalg.norm(gs_eci), range_vec) / range_mag
            if math.degrees(math.asin(max(-1.0, min(1.0, cos_zenith)))) >= gs['min_elevation_angle_deg']:
                return True
        return False

    # ========================================================================
    # 3. HYBRID TARGETING (MULTI-THREAT MINIMAX WITH SEQUENTIAL ECI INTEGRATION)
    # ========================================================================
    def _generate_sequential_eci(self, plans: List[ManeuverPlan], r0: np.ndarray, v0: np.ndarray):
        """Propagates the orbit sequentially, applying each burn to find the true RTN axes."""
        r_curr, v_curr = r0.copy(), v0.copy()
        t_curr = 0.0
        
        for p in plans:
            dt = p.burn_time_offset_s - t_curr
            r_curr, v_curr = self.propagate_rk4(r_curr, v_curr, dt)
            
            rtn_matrix = self.eci_to_rtn_basis(r_curr, v_curr)
            dv_eci = rtn_matrix @ p.delta_v_rtn
            
            p.delta_v_eci_dict = {"x": float(dv_eci[0]), "y": float(dv_eci[1]), "z": float(dv_eci[2])}
            v_curr += dv_eci
            t_curr = p.burn_time_offset_s

    def calculate_perfect_evasion_sequence(self, sat_idx: int, threats: List[Conjunction], current_fuel_kg: float, sat_state: np.ndarray, nominal_state: np.ndarray) -> List[ManeuverPlan]:
        earliest_tca = min(t.tca_seconds for t in threats)
        
        # 🚀 24-HOUR LEVERAGE: Execute burn ASAP to maximize drift time
        t1 = 15.0 if earliest_tca > 18.0 else max(10.1, earliest_tca - 3.0)
        
        r_mag = np.linalg.norm(sat_state[:3])
        v_mag = np.linalg.norm(sat_state[3:6])
        a = 1.0 / (2.0/r_mag - (v_mag**2)/MU_EARTH)
        n_mean = math.sqrt(MU_EARTH / (a**3))
        
        h_vec = np.cross(sat_state[:3], sat_state[3:6])
        inc_rad = math.acos(h_vec[2] / np.linalg.norm(h_vec))
        j2_correction = 1.0 + (1.5 * J2 * (R_EARTH / a)**2 * (1.0 - 1.5 * math.sin(inc_rad)**2))
        t_orb_base = (2 * math.pi) / (n_mean * j2_correction)

        target_clearance_km = 0.200 
        max_req_dv_trans = 0.0
        max_req_dv_rad = 0.0
        
        for conj in threats:
            drift_time_s = conj.tca_seconds - t1
            if drift_time_s <= 1.0: continue
            
            # The longer the drift_time_s (e.g. 24 hours), the smaller these required dVs become!
            cw_y_factor = abs(4.0 * math.sin(n_mean * drift_time_s) - 3.0 * n_mean * drift_time_s)
            dv_t = (target_clearance_km * n_mean) / max(cw_y_factor, 1e-6)
            max_req_dv_trans = max(max_req_dv_trans, dv_t)
            
            sin_nt = abs(math.sin(n_mean * drift_time_s))
            dv_r = (target_clearance_km * n_mean) / max(sin_nt, 1e-4)
            max_req_dv_rad = max(max_req_dv_rad, dv_r)

        if max_req_dv_trans == 0.0 and max_req_dv_rad == 0.0:
            return []

        # 🚀 THE SURVIVAL CLAMP: Calculate Absolute Maximum Future Apogee
        current_drift_km = np.linalg.norm(sat_state[:3] - nominal_state[:3])
        max_excursion_km = 3.0 * max_req_dv_trans * t_orb_base
        absolute_future_apogee = current_drift_km + max_excursion_km

        plans = []
        if absolute_future_apogee <= 9.0:
            # OPTION A: Transverse Tri-Shunt (Fuel efficient, safe inside the box)
            req_dv = math.copysign(min(max_req_dv_trans, MAX_DELTA_V_KMS / 2.0), max_req_dv_trans)
            
            v_post_1 = v_mag + req_dv
            a_post_1 = 1.0 / (2.0/r_mag - (v_post_1**2)/MU_EARTH)
            n_post_1 = math.sqrt(MU_EARTH / (a_post_1**3))
            j2_corr_1 = 1.0 + (1.5 * J2 * (R_EARTH / a_post_1)**2 * (1.0 - 1.5 * math.sin(inc_rad)**2))
            t_orb_1 = (2 * math.pi) / (n_post_1 * j2_corr_1)
            t2 = t1 + t_orb_1
            
            v_post_2 = v_post_1 - (2.0 * req_dv)
            a_post_2 = 1.0 / (2.0/r_mag - (v_post_2**2)/MU_EARTH)
            n_post_2 = math.sqrt(MU_EARTH / (a_post_2**3))
            j2_corr_2 = 1.0 + (1.5 * J2 * (R_EARTH / a_post_2)**2 * (1.0 - 1.5 * math.sin(inc_rad)**2))
            t_orb_2 = (2 * math.pi) / (n_post_2 * j2_corr_2)
            t3 = t2 + t_orb_2
            
            f1 = self.calculate_fuel_cost(req_dv, DRY_MASS + current_fuel_kg)
            f2 = self.calculate_fuel_cost(-2.0 * req_dv, DRY_MASS + current_fuel_kg - f1)
            f3 = self.calculate_fuel_cost(req_dv, DRY_MASS + current_fuel_kg - f1 - f2)
            if current_fuel_kg < (f1 + f2 + f3): return []

            m_type1 = ManeuverType.PHASING_PROGRADE if req_dv > 0 else ManeuverType.PHASING_RETROGRADE
            m_type2 = ManeuverType.PHASING_RETROGRADE if req_dv > 0 else ManeuverType.PHASING_PROGRADE
            
            plans = [
                ManeuverPlan(sat_idx, m_type1, np.array([0.0, req_dv, 0.0]), t1, f1, False, 0.99),
                ManeuverPlan(sat_idx, m_type2, np.array([0.0, -2.0 * req_dv, 0.0]), t2, f2, False, 0.99),
                ManeuverPlan(sat_idx, ManeuverType.RECOVERY, np.array([0.0, req_dv, 0.0]), t3, f3, False, 0.99)
            ]
        else:
            # 🚀 OPTION B: RADIAL OVERRIDE (Survival at all costs)
            # If drifting backward pushes us past 9.0km, force an Up/Down dodge.
            req_dv = math.copysign(min(max_req_dv_rad, MAX_DELTA_V_KMS), max_req_dv_rad)
            
            v_mag_post_radial = math.sqrt(v_mag**2 + req_dv**2)
            a_post = 1.0 / (2.0/r_mag - (v_mag_post_radial**2)/MU_EARTH)
            n_post = math.sqrt(MU_EARTH / (a_post**3))
            j2_corr_post = 1.0 + (1.5 * J2 * (R_EARTH / a_post)**2 * (1.0 - 1.5 * math.sin(inc_rad)**2))
            t_orb_perturbed = (2 * math.pi) / (n_post * j2_corr_post)
            
            t2 = t1 + t_orb_perturbed 
            f1 = self.calculate_fuel_cost(req_dv, DRY_MASS + current_fuel_kg)
            f2 = self.calculate_fuel_cost(-req_dv, DRY_MASS + current_fuel_kg - f1)
            if current_fuel_kg < (f1 + f2): return []

            plans = [
                ManeuverPlan(sat_idx, ManeuverType.RADIAL_SHUNT, np.array([req_dv, 0.0, 0.0]), t1, f1, False, 0.99),
                ManeuverPlan(sat_idx, ManeuverType.RECOVERY, np.array([-req_dv, 0.0, 0.0]), t2, f2, False, 0.99)
            ]
            
        if plans:
            self._generate_sequential_eci(plans, sat_state[:3], sat_state[3:6])
        return plans
        
    # ========================================================================
    # 4. ORCHESTRATOR
    # ========================================================================
    def plan_evasion(self, sat_states: np.ndarray, nominal_states: np.ndarray, 
                     sat_fuels: List[float], conjunctions: List[Conjunction], 
                     current_time: datetime, ground_stations: list) -> List[ManeuverPlan]:
        plans = []
        curr_ts = current_time.timestamp()
        
        # ── 1. CLOSED-LOOP STATION KEEPING (The 6km Healing Drift) ──
        for sat_idx in range(len(sat_states)):
            if sat_idx in self.eol_scheduled: continue
            
            # Skip if currently executing a maneuver sequence
            if sat_idx in self.locked_satellites and curr_ts < self.locked_satellites[sat_idx]:
                continue
                
            # 🚀 THE BLACKOUT PATCH: Do not evaluate or lock if the satellite has no signal!
            if not self.check_line_of_sight(sat_states[sat_idx][:3], current_time, ground_stations):
                continue

            # Skip if there is an active emergency threat for this satellite
            has_threat = any(c.sat_idx == sat_idx for c in conjunctions if c.miss_distance_km <= COLLISION_THRESHOLD_KM * 1.5)
            if has_threat: continue

            # Evaluate distance to the Nominal Ghost Slot
            sat_state = sat_states[sat_idx]
            drift_vec = sat_state[:3] - nominal_states[sat_idx][:3]
            drift_km = np.linalg.norm(drift_vec)

            # If the Radial Shunt leaked energy and drifted past 6km, heal it!
            if drift_km > 6.0 and sat_fuels[sat_idx] > 5.0:
                v_hat = sat_state[3:6] / np.linalg.norm(sat_state[3:6])
                along_track_offset = np.dot(drift_vec, v_hat)
                
                # 🚀 THE PARADOX FIX: Exact Vis-Viva Period Targeting
                r_mag = np.linalg.norm(sat_state[:3])
                v_mag = np.linalg.norm(sat_state[3:6])
                a = 1.0 / (2.0/r_mag - (v_mag**2)/MU_EARTH)
                n_mean = math.sqrt(MU_EARTH / (a**3))
                
                h_vec = np.cross(sat_state[:3], sat_state[3:6])
                inc_rad = math.acos(h_vec[2] / np.linalg.norm(h_vec))
                j2_correction = 1.0 + (1.5 * J2 * (R_EARTH / a)**2 * (1.0 - 1.5 * math.sin(inc_rad)**2))
                t_orb_base = (2 * math.pi) / (n_mean * j2_correction)
                
                # If ahead (offset > 0), satellite period must INCREASE to let Ghost catch up.
                time_offset_s = along_track_offset / v_mag
                t_target = t_orb_base + time_offset_s
                
                # Kepler's Third Law to find required semi-major axis
                a_target = a * (t_target / t_orb_base)**(2.0/3.0)
                
                # Vis-Viva to find required velocity
                v_req = math.sqrt(MU_EARTH * (2.0/r_mag - 1.0/a_target))
                req_dv_kms = v_req - v_mag
                
                # Cap the correction to 1 m/s to prevent aggressive overshoots
                req_dv_kms = math.copysign(min(abs(req_dv_kms), 1.0 / 1000.0), req_dv_kms)
                
                if abs(req_dv_kms) > 0.0001:
                    t1 = 15.0
                    
                    # Recalculate exact period of the temporary phasing orbit
                    v_post = v_mag + req_dv_kms
                    a_post = 1.0 / (2.0/r_mag - (v_post**2)/MU_EARTH)
                    n_post = math.sqrt(MU_EARTH / (a_post**3))
                    j2_corr_post = 1.0 + (1.5 * J2 * (R_EARTH / a_post)**2 * (1.0 - 1.5 * math.sin(inc_rad)**2))
                    t_phasing = (2 * math.pi) / (n_post * j2_corr_post)
                    
                    t2 = t1 + t_phasing 
                    
                    f1 = self.calculate_fuel_cost(req_dv_kms, DRY_MASS + sat_fuels[sat_idx])
                    f2 = self.calculate_fuel_cost(-req_dv_kms, DRY_MASS + sat_fuels[sat_idx] - f1)
                    
                    m_type1 = ManeuverType.PHASING_PROGRADE if req_dv_kms > 0 else ManeuverType.PHASING_RETROGRADE
                    m_type2 = ManeuverType.PHASING_RETROGRADE if req_dv_kms > 0 else ManeuverType.PHASING_PROGRADE
                    
                    # A perfect 2-Burn Hohmann Phasing sequence
                    sk_plans = [
                        ManeuverPlan(sat_idx, m_type1, np.array([0.0, req_dv_kms, 0.0]), t1, f1, False, 0.99),
                        ManeuverPlan(sat_idx, m_type2, np.array([0.0, -req_dv_kms, 0.0]), t2, f2, False, 0.99)
                    ]
                    self._generate_sequential_eci(sk_plans, sat_state[:3], sat_state[3:6])
                    self.locked_satellites[sat_idx] = curr_ts + t2 + 1.0
                    plans.extend(sk_plans)

        # ── 2. MULTI-THREAT EVASION RESOLUTION ──
        threats_by_sat = {}
        for conj in conjunctions:
            if conj.sat_idx in self.eol_scheduled: continue
            
            if conj.sat_idx in self.locked_satellites:
                if curr_ts < self.locked_satellites[conj.sat_idx]:
                    continue
                    
            if conj.miss_distance_km > COLLISION_THRESHOLD_KM * 1.5: continue
            
            if conj.sat_idx not in threats_by_sat:
                threats_by_sat[conj.sat_idx] = []
            threats_by_sat[conj.sat_idx].append(conj)
            
        for sat_idx, threats in threats_by_sat.items():
            sat_state = sat_states[sat_idx]
            sat_fuel = sat_fuels[sat_idx]
            
            if not self.check_line_of_sight(sat_state[:3], current_time, ground_stations): continue 
            
            # EOL Graveyard Handling
            if sat_fuel <= 2.5:
                burnable_fuel = sat_fuel - 0.1
                if burnable_fuel > 0:
                    current_mass = DRY_MASS + sat_fuel
                    max_dv_mps = -I_SP * G0 * math.log(1.0 - (burnable_fuel / current_mass))
                    
                    p = ManeuverPlan(
                        sat_idx=sat_idx, maneuver_type=ManeuverType.EOL_GRAVEYARD,
                        delta_v_rtn=np.array([0.0, max_dv_mps / 1000.0, 0.0]), burn_time_offset_s=15.0, 
                        estimated_fuel_kg=burnable_fuel, recovery_required=False, confidence=1.0
                    )
                    self._generate_sequential_eci([p], sat_state[:3], sat_state[3:6])
                    plans.append(p)
                    self.eol_scheduled.add(sat_idx)
                continue
            
            sequence = self.calculate_perfect_evasion_sequence(sat_idx, threats, sat_fuel, sat_state, nominal_states[sat_idx])
            if sequence:
                self.locked_satellites[sat_idx] = curr_ts + sequence[-1].burn_time_offset_s + 1.0
                plans.extend(sequence)
                        
        return plans