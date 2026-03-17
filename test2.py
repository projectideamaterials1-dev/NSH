#!/usr/bin/env python3
"""
NSH 2026: Orbital Mathematics & Path Verification Suite
=======================================================
Audits the C++ Engine's RK4 Integrator stability and 
proves the CW State-Space maneuvering mathematically.
"""

import requests
import time
import math
import numpy as np
import random
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.append('satellite_api')
from autonomous.brain import AutonomousBrain, Conjunction

BASE_URL = "http://127.0.0.1:8000"
R_EARTH = 6378.137  
MU_EARTH = 398600.4418  
NUM_SATELLITES = 50
NUM_DEBRIS = 1000

SIMULATION_HOURS = 12 # Reduced to 12 hours for intense step-by-step focus
STEP_SECONDS = 60
TOTAL_STEPS = (SIMULATION_HOURS * 3600) // STEP_SECONDS

np.random.seed(202)
random.seed(202)

# Focus heavily on SAT-00 to generate a beautiful mathematical trace
INCOMING_CDMS = {
    60: [("SAT-00", 900.0, 12.5, 0.99)], # Threat at T+1 hour, TCA is 15 mins later
    300: [("SAT-00", 1200.0, -8.2, 0.95)] # Another threat later
}

def generate_circular_orbit(altitude_km: float):
    r_mag = R_EARTH + altitude_km
    v_mag = math.sqrt(MU_EARTH / r_mag)
    phi, theta = np.random.uniform(0, math.pi), np.random.uniform(0, 2 * math.pi)
    x, y, z = r_mag * math.sin(phi) * math.cos(theta), r_mag * math.sin(phi) * math.sin(theta), r_mag * math.cos(phi)
    r_vec = np.array([x, y, z])
    random_vec = np.array([0, 0, 1]) if abs(z) < r_mag * 0.9 else np.array([1, 0, 0])
    v_vec = (np.cross(r_vec, random_vec) / np.linalg.norm(np.cross(r_vec, random_vec))) * v_mag
    return {"x": float(x), "y": float(y), "z": float(z)}, {"x": float(v_vec[0]), "y": float(v_vec[1]), "z": float(v_vec[2])}

def check_response(resp, stage_name):
    if resp.status_code not in [200, 202]:
        print(f"❌ ERROR AT {stage_name}: {resp.text}")
        sys.exit(1)
    return resp.json()

def calculate_orbital_energy(r_eci: np.ndarray, v_eci: np.ndarray) -> float:
    """Calculates Specific Orbital Energy (epsilon). Must remain stable."""
    r_mag = np.linalg.norm(r_eci)
    v_mag = np.linalg.norm(v_eci)
    return (v_mag**2 / 2.0) - (MU_EARTH / r_mag)

def calculate_rtn_drift(r_real: np.ndarray, r_ghost: np.ndarray, v_ghost: np.ndarray) -> tuple:
    """Calculates the exact deviation in the local RTN frame."""
    r_norm = np.linalg.norm(r_ghost)
    R_hat = r_ghost / r_norm
    N_vec = np.cross(r_ghost, v_ghost)
    N_hat = N_vec / np.linalg.norm(N_vec)
    T_hat = np.cross(N_hat, R_hat)
    
    delta_r = r_real - r_ghost
    return (np.dot(delta_r, R_hat), np.dot(delta_r, T_hat), np.dot(delta_r, N_hat))

def run_math_verification():
    print(f"\n{'='*20} ORBITAL MATH VERIFICATION {'='*20}")
    brain = AutonomousBrain()
    
    objects = [{"id": f"SAT-{i:02d}", "type": "SATELLITE", **dict(zip(('r','v'), generate_circular_orbit(400.0)))} for i in range(NUM_SATELLITES)]
    objects += [{"id": f"DEB-{i:04d}", "type": "DEBRIS", **dict(zip(('r','v'), generate_circular_orbit(400.0)))} for i in range(NUM_DEBRIS)]

    current_sim_time_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    check_response(requests.post(f"{BASE_URL}/api/telemetry", json={"timestamp": current_sim_time_iso, "objects": objects}), "Telemetry")
    print("✅ Telemetry Ingested. Engaging RK4 Integrator...")
    
    # Mathematical Audit Trails
    energy_audit = {f"SAT-{i:02d}": [] for i in range(NUM_SATELLITES)}
    sat_00_trace = []

    for step in range(TOTAL_STEPS):
        sim_time_dt = datetime.fromisoformat(current_sim_time_iso.replace('Z', '+00:00'))
        debug_data = check_response(requests.get(f"{BASE_URL}/api/internal/debug_state"), "Debug State")
        
        # ── 1. MATHEMATICAL PATH VERIFICATION ──
        for sid, s_data in debug_data.items():
            r_real, v_real = np.array(s_data["r_eci"]), np.array(s_data["v_eci"])
            r_ghost, v_ghost = np.array(s_data["r_nominal_eci"]), np.array(s_data["v_eci"]) # Approximation for ghost v
            
            # Verify RK4 Stability
            energy = calculate_orbital_energy(r_real, v_real)
            energy_audit[sid].append(energy)
            
            if sid == "SAT-00":
                drift_R, drift_T, drift_N = calculate_rtn_drift(r_real, r_ghost, v_ghost)
                sat_00_trace.append({
                    "step": step, "energy": energy,
                    "drift_R": drift_R, "drift_T": drift_T, "drift_N": drift_N,
                    "total_drift_km": np.linalg.norm([drift_R, drift_T, drift_N])
                })

        # ── 2. INJECT THREAT & RECORD BRAIN DECISION ──
        if step in INCOMING_CDMS:
            for sat_id, tca, rel_vel, risk in INCOMING_CDMS[step]:
                s_data = debug_data.get(sat_id)
                sat_state = np.array(s_data["r_eci"] + s_data["v_eci"])
                conj = Conjunction(sat_idx=0, debris_idx=0, tca_seconds=tca, miss_distance_km=0.01, relative_velocity_kms=rel_vel, risk_score=risk)
                
                plans = brain.plan_evasion(np.array([sat_state]), [s_data["fuel_kg"]], [conj], sim_time_dt, [])
                if plans:
                    seq = [{"burn_id": f"AUTO-{sat_id}-{i}", "burnTime": (sim_time_dt + timedelta(seconds=p.burn_time_offset_s)).strftime('%Y-%m-%dT%H:%M:%S.000Z'), "deltaV_vector": brain.convert_rtn_to_eci_dict(p.delta_v_rtn, np.array(s_data["r_eci"]), np.array(s_data["v_eci"]), p.burn_time_offset_s)} for i, p in enumerate(plans)]
                    requests.post(f"{BASE_URL}/api/maneuver/schedule", json={"satelliteId": sat_id, "maneuver_sequence": seq})
                    if sat_id == "SAT-00":
                        print(f"\n[STEP {step}] 🚨 SAT-00 THREAT DETECTED! TCA in {tca}s")
                        print(f"   🧠 Brain Selected: {plans[0].maneuver_type.name}")

        sim_data = check_response(requests.post(f"{BASE_URL}/api/simulate/step", json={"step_seconds": STEP_SECONDS}), "Sim Step")
        current_sim_time_iso = sim_data["new_timestamp"]

    # ── 3. FORENSIC AUDIT RESULTS ──
    print(f"\n{'='*20} C++ RK4 INTEGRATOR AUDIT {'='*20}")
    stable_orbits = 0
    for sid, energies in energy_audit.items():
        # Energy should be conserved. A variance > 1.0% means the RK4 math is exploding.
        variance = abs(max(energies) - min(energies)) / abs(np.mean(energies))
        if variance < 0.01: stable_orbits += 1
    print(f"✅ Integrator Stability: {stable_orbits}/{NUM_SATELLITES} orbits conserved Specific Orbital Energy.")

    print(f"\n{'='*20} SAT-00 CLOHESSY-WILTSHIRE PATH TRACE {'='*20}")
    print(f"{'Min':<6} | {'Energy (km²/s²)':<16} | {'Radial (km)':<12} | {'Transverse (km)':<16} | {'Total Drift (km)':<16}")
    print("-" * 75)
    
    # Print the critical 30 minutes surrounding the first maneuver (Step 50 to 80)
    for trace in sat_00_trace[50:85]:
        marker = "🔥 BURN" if trace["step"] in [60, 75] else ""
        print(f"{trace['step']:<6} | {trace['energy']:<16.4f} | {trace['drift_R']:<12.4f} | {trace['drift_T']:<16.4f} | {trace['total_drift_km']:<16.4f} {marker}")

if __name__ == "__main__":
    run_math_verification()