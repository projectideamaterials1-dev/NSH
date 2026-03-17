import numpy as np
import math
from typing import List, Optional
from datetime import datetime, timedelta
from dataclasses import dataclass
from enum import Enum

# ============================================================================
# ORBITAL CONSTANTS (Strictly matched to NSH 2026 Problem Statement)
# ============================================================================
MU_EARTH = 398600.4418      # km³/s²
R_EARTH = 6378.137          # km
J2 = 1.08263e-3             # Dimensionless
I_SP = 300.0                # seconds
G0 = 9.80665                # m/s²
MAX_DELTA_V_MPS = 15.0      # m/s per burn
MAX_DELTA_V_KMS = MAX_DELTA_V_MPS / 1000.0  
COOLDOWN_SECONDS = 600.0    # Thermal cooldown
INITIAL_FUEL = 50.0         # kg
DRY_MASS = 500.0            # kg
STATION_KEEPING_RADIUS_KM = 10.0  
COLLISION_THRESHOLD_KM = 0.100    
OMEGA_EARTH = 7.2921159e-5  # Earth rotation rate (rad/s)

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

class AutonomousBrain:
    def __init__(self):
        self.planned_maneuvers: List[ManeuverPlan] = []
        
    def eci_to_rtn_basis(self, r_eci: np.ndarray, v_eci: np.ndarray) -> np.ndarray:
        """Computes the Radial-Transverse-Normal rotation matrix from ECI vectors."""
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
    
    def calculate_fuel_cost(self, delta_v_kms: float, current_mass_kg: float) -> float:
        """Exact Tsiolkovsky rocket equation for fuel mass depletion. """
        delta_v_mps = delta_v_kms * 1000.0
        return current_mass_kg * (1.0 - math.exp(-delta_v_mps / (I_SP * G0)))

    def check_line_of_sight(self, sat_eci: np.ndarray, sim_time: datetime, ground_stations: list) -> bool:
        """Checks geometric visibility against Ground Station masks. """
        if not ground_stations: return True 
        
        theta_gmst = (OMEGA_EARTH * sim_time.timestamp()) % (2 * math.pi)
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
            z_eci = z_ecef
            gs_eci = np.array([x_eci, y_eci, z_eci])
            
            range_vec = sat_eci - gs_eci
            range_mag = np.linalg.norm(range_vec)
            
            zenith_vec = gs_eci / np.linalg.norm(gs_eci)
            cos_zenith = np.dot(zenith_vec, range_vec) / range_mag
            cos_zenith = max(-1.0, min(1.0, cos_zenith))
            
            elevation_deg = math.degrees(math.asin(cos_zenith))
            if elevation_deg >= gs['min_elevation_angle_deg']:
                return True
        return False
    
    def calculate_graveyard_maneuver(self, sat_idx: int, current_fuel_kg: float) -> Optional[ManeuverPlan]:
        """Dumps remaining fuel into a massive prograde burn to retire the satellite. """
        current_mass = DRY_MASS + current_fuel_kg
        burnable_fuel = current_fuel_kg - 0.1 # Safety buffer
        if burnable_fuel <= 0: return None
        
        max_dv_mps = -I_SP * G0 * math.log(1.0 - (burnable_fuel / current_mass))
        delta_v_rtn = np.array([0.0, max_dv_mps / 1000.0, 0.0])
        
        return ManeuverPlan(
            sat_idx=sat_idx, maneuver_type=ManeuverType.EOL_GRAVEYARD,
            delta_v_rtn=delta_v_rtn, burn_time_offset_s=15.0, 
            estimated_fuel_kg=burnable_fuel, recovery_required=False, confidence=1.0
        )
    
    def calculate_optimal_maneuver(self, sat_state: np.ndarray, conj: Conjunction, current_fuel_kg: float) -> Optional[ManeuverPlan]:
        """
        Multi-Objective State-Space Optimizer. 
        Evaluates Phasing maneuvers at expanding magnitudes before falling back to Radial shunts.
        """
        time_to_tca = conj.tca_seconds
        if time_to_tca <= 15.0: return None # Too late to upload command 

        current_mass = DRY_MASS + current_fuel_kg
        r_mag = np.linalg.norm(sat_state[:3])
        n = math.sqrt(MU_EARTH / (r_mag**3)) # Mean motion
        
        # 🚀 UPGRADE: Dynamic Magnitude Scaling (1 m/s, 2 m/s, 5 m/s, 10 m/s)
        magnitudes_kms = [0.001, 0.002, 0.005, 0.010]
        
        best_plan = None
        lowest_cost = float('inf')
        
        for dv_mag in magnitudes_kms:
            # 🚀 UPGRADE: Strict Phasing Priority
            candidates = [
                (ManeuverType.PHASING_PROGRADE, np.array([0.0, dv_mag, 0.0])),
                (ManeuverType.PHASING_RETROGRADE, np.array([0.0, -dv_mag, 0.0])),
                (ManeuverType.RADIAL_SHUNT, np.array([dv_mag, 0.0, 0.0])),
                (ManeuverType.RADIAL_SHUNT, np.array([-dv_mag, 0.0, 0.0]))
            ]
            
            for m_type, dv_rtn in candidates:
                fuel_cost = self.calculate_fuel_cost(dv_mag, current_mass)
                
                # CW State-Space Projection
                drift_x = (dv_rtn[0] / n) * math.sin(n * time_to_tca) + (2 * dv_rtn[1] / n) * (1 - math.cos(n * time_to_tca))
                drift_y = (2 * dv_rtn[0] / n) * (math.cos(n * time_to_tca) - 1) + (dv_rtn[1] / n) * (4 * math.sin(n * time_to_tca) - 3 * n * time_to_tca)
                drift_z = (dv_rtn[2] / n) * math.sin(n * time_to_tca)
                
                projected_clearance_km = math.sqrt(drift_x**2 + drift_y**2 + drift_z**2)
                
                # Uptime Penalty: Penalize secular transverse drift 
                drift_penalty = abs(drift_y) if abs(drift_y) > 0.1 else 0.0
                
                # Safety Constraint: Must clear 150m (0.150km) to ensure survival of 100m threshold 
                safety_penalty = 1000.0 if projected_clearance_km < 0.150 else 0.0 
                
                cost = (fuel_cost * 10.0) + (drift_penalty * 2.0) + safety_penalty
                
                if cost < lowest_cost and safety_penalty == 0.0:
                    lowest_cost = cost
                    best_plan = ManeuverPlan(
                        sat_idx=conj.sat_idx, maneuver_type=m_type, delta_v_rtn=dv_rtn,
                        burn_time_offset_s=max(15.0, time_to_tca - 60.0), 
                        estimated_fuel_kg=fuel_cost, recovery_required=True, confidence=0.95
                    )
            
            # 🚀 UPGRADE: Early Exit. If a small Phasing burn clears the threat, don't test larger burns!
            if best_plan is not None:
                break
                
        return best_plan
    
    def predict_position(self, r0: np.ndarray, v0: np.ndarray, dt_s: float) -> np.ndarray:
        """Fast analytical Keplerian propagation to find future satellite positions."""
        if dt_s <= 0: return r0
        r_mag = np.linalg.norm(r0)
        v_mag = np.linalg.norm(v0)
        n = v_mag / r_mag  
        theta = n * dt_s   
        h_vec = np.cross(r0, v0)
        h_hat = h_vec / np.linalg.norm(h_vec)
        return r0 * math.cos(theta) + np.cross(h_hat, r0) * math.sin(theta)
    
    def calculate_recovery_maneuver(self, sat_state: np.ndarray, original_maneuver: ManeuverPlan,
                                    conjunction: Conjunction, current_fuel_kg: float) -> Optional[ManeuverPlan]:
        """
        Halts the secular drift by firing the exact inverse vector (-dV) 
        exactly one POST-BURN orbital period later, correcting for J2 perturbations.
        """
        r_vec = sat_state[:3]
        v_vec = sat_state[3:6]
        
        # 1. Convert the planned Evasion RTN vector to ECI to find post-burn velocity
        rtn_matrix = self.eci_to_rtn_basis(r_vec, v_vec)
        dv_eci = rtn_matrix @ original_maneuver.delta_v_rtn
        v_post_burn = v_vec + dv_eci
        
        r_mag = np.linalg.norm(r_vec)
        v_mag_post = np.linalg.norm(v_post_burn)
        
        # 2. Vis-viva Equation for the NEW Semi-Major Axis (a)
        specific_energy = (v_mag_post**2 / 2.0) - (MU_EARTH / r_mag)
        a_post_burn = -MU_EARTH / (2.0 * specific_energy)
        
        # 3. J2 Perturbation Correction for Mean Motion
        h_vec = np.cross(r_vec, v_post_burn)
        inc_rad = math.acos(h_vec[2] / np.linalg.norm(h_vec))
        
        n_0 = math.sqrt(MU_EARTH / (a_post_burn**3))
        j2_correction = 1.0 + (1.5 * J2 * (R_EARTH / a_post_burn)**2 * (1.0 - 1.5 * math.sin(inc_rad)**2))
        n_perturbed = n_0 * j2_correction
        
        # 4. The Exact Post-Burn Orbital Period
        exact_orbital_period = 2 * math.pi / n_perturbed
        
        recovery_delta_v = -1.0 * original_maneuver.delta_v_rtn 
        
        # 🚀 Execute exactly 1 corrected orbit later to perfectly cancel secular drift
        recovery_offset = original_maneuver.burn_time_offset_s + exact_orbital_period
        
        post_evasion_mass = DRY_MASS + current_fuel_kg - original_maneuver.estimated_fuel_kg
        fuel_cost = self.calculate_fuel_cost(np.linalg.norm(recovery_delta_v), post_evasion_mass)
        
        return ManeuverPlan(
            sat_idx=original_maneuver.sat_idx, maneuver_type=ManeuverType.RECOVERY,
            delta_v_rtn=recovery_delta_v, burn_time_offset_s=recovery_offset,
            estimated_fuel_kg=fuel_cost, recovery_required=False, confidence=0.99
        )
    
    def plan_evasion(self, sat_states: np.ndarray, sat_fuels: List[float],
                     conjunctions: List[Conjunction], current_time: datetime,
                     ground_stations: list) -> List[ManeuverPlan]:
        """Main optimization loop with strict Future-LOS prediction."""
        plans = []
        prioritized_threats = sorted(conjunctions, key=lambda c: c.risk_score, reverse=True)
        eol_scheduled = set()
        
        for conj in prioritized_threats:
            if conj.sat_idx in eol_scheduled: continue
            if conj.miss_distance_km > COLLISION_THRESHOLD_KM * 2.0: continue
            if conj.risk_score < 0.7: continue
                
            sat_state = sat_states[conj.sat_idx]
            sat_fuel = sat_fuels[conj.sat_idx]
            
            if sat_fuel <= 2.5:
                graveyard_plan = self.calculate_graveyard_maneuver(conj.sat_idx, sat_fuel)
                if graveyard_plan:
                    plans.append(graveyard_plan)
                    eol_scheduled.add(conj.sat_idx)
                continue
            
            # 2. CW State-Space Optimizer
            plan = self.calculate_optimal_maneuver(sat_state, conj, sat_fuel)
            
            if plan and plan.confidence > 0.7:
                # 3. Evasion LOS Constraint Check (Predictive)
                evasion_upload_offset = plan.burn_time_offset_s - 10.0
                future_r_evasion = self.predict_position(sat_state[:3], sat_state[3:6], evasion_upload_offset)
                evasion_upload_time = current_time + timedelta(seconds=evasion_upload_offset)
                
                # If we won't have LOS at the optimal time, force the burn ASAP (15s from now)
                if not self.check_line_of_sight(future_r_evasion, evasion_upload_time, ground_stations):
                    plan.burn_time_offset_s = 15.0
                
                plans.append(plan)
                
                # 4. Recovery Maneuver LOS Constraint Check
                if plan.recovery_required:
                    recovery = self.calculate_recovery_maneuver(sat_state, plan, conj, sat_fuel)
                    if recovery:
                        # Iterate to find a valid LOS window for recovery (checking in 60s increments)
                        for _ in range(30): # Search up to 30 minutes forward
                            rec_upload_offset = recovery.burn_time_offset_s - 10.0
                            future_r_rec = self.predict_position(sat_state[:3], sat_state[3:6], rec_upload_offset)
                            rec_upload_time = current_time + timedelta(seconds=rec_upload_offset)
                            
                            if self.check_line_of_sight(future_r_rec, rec_upload_time, ground_stations):
                                break # Found a clear signal window!
                            
                            # Shift the recovery burn later if currently in a blackout zone
                            recovery.burn_time_offset_s += 60.0 
                            
                        plans.append(recovery)
                    
        return plans

    def convert_rtn_to_eci_dict(self, delta_v_rtn: np.ndarray, r_eci: np.ndarray, 
                                v_eci: np.ndarray, dt_s: float = 0.0) -> dict:
        """
        Converts local RTN vectors to ECI.
        Uses Rodrigues' rotation formula to project the RTN frame forward in time.
        """
        if dt_s > 0:
            r_mag = np.linalg.norm(r_eci)
            v_mag = np.linalg.norm(v_eci)
            n = v_mag / r_mag  
            theta = n * dt_s   
            
            h_vec = np.cross(r_eci, v_eci)
            h_norm = np.linalg.norm(h_vec)
            
            if h_norm > 1e-10:
                h_hat = h_vec / h_norm
                r_eci_fut = r_eci * math.cos(theta) + np.cross(h_hat, r_eci) * math.sin(theta)
                v_eci_fut = v_eci * math.cos(theta) + np.cross(h_hat, v_eci) * math.sin(theta)
                r_eci = r_eci_fut
                v_eci = v_eci_fut
                
        rtn_basis = self.eci_to_rtn_basis(r_eci, v_eci)
        eci_vector = rtn_basis @ delta_v_rtn
        return {"x": float(eci_vector[0]), "y": float(eci_vector[1]), "z": float(eci_vector[2])}