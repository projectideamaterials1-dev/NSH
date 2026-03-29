#!/usr/bin/env python3
"""
NSH 2026: Extended 30‑Day Live Demonstration with Real‑Time Speed Control
==========================================================================
50 Satellites | 10,000 Debris
Continuous simulation with frontend sync. The simulation advances at a
configurable pace so you can watch satellites move in real time.
"""

import requests
import time
import math
import numpy as np
import random
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Optional, Tuple

# Import Autonomous Brain
sys.path.append('satellite_api')
try:
    from acm.brain import AutonomousBrain, Conjunction, ManeuverType
except ImportError:
    print("⚠️ WARNING: acm.brain module not found. Ensure 'satellite_api' is in the python path.")
    sys.exit(1)

# ============================================================================
# CONFIGURATION
# ============================================================================
BASE_URL = "http://127.0.0.1:8000"
R_EARTH = 6378.137
MU_EARTH = 398600.4418

NUM_SATELLITES = 50
NUM_DEBRIS = 10000

SIMULATION_DAYS = 30
STEP_SECONDS = 60                     # 1 minute per simulation step
TOTAL_STEPS = (SIMULATION_DAYS * 24 * 3600) // STEP_SECONDS

# 🚀 Speed control: seconds to sleep after each simulation step
#    Set to 0 for maximum speed (no sleep). Values > 0 make the demo
#    progress slower so you can watch the frontend move smoothly.
SLEEP_PER_STEP = 0.2                  # 0.2 sec sleep → 5 steps/sec → 5 min simulation / real sec

# Seed for reproducibility
np.random.seed(42)
random.seed(42)

# ============================================================================
# ORBITAL MECHANICS (unchanged)
# ============================================================================

def print_header(title: str):
    print(f"\n{'='*35}\n{title}\n{'='*35}")

def generate_circular_orbit(altitude_km: float, inclination_deg: Optional[float] = None):
    r_mag = R_EARTH + altitude_km
    v_mag = math.sqrt(MU_EARTH / r_mag)
    
    if inclination_deg is not None:
        inc_rad = math.radians(inclination_deg)
        raan = np.random.uniform(0, 2*math.pi)
        u = np.random.uniform(0, 2*math.pi)
        x = r_mag * (math.cos(raan)*math.cos(u) - math.sin(raan)*math.sin(u)*math.cos(inc_rad))
        y = r_mag * (math.sin(raan)*math.cos(u) + math.cos(raan)*math.sin(u)*math.cos(inc_rad))
        z = r_mag * math.sin(u) * math.sin(inc_rad)
    else:
        phi = np.random.uniform(0, math.pi)
        theta = np.random.uniform(0, 2 * math.pi)
        x = r_mag * math.sin(phi) * math.cos(theta)
        y = r_mag * math.sin(phi) * math.sin(theta)
        z = r_mag * math.cos(phi)
    
    r_vec = np.array([x, y, z])
    random_vec = np.array([0, 0, 1]) if abs(z) < r_mag * 0.9 else np.array([1, 0, 0])
    v_vec = np.cross(r_vec, random_vec)
    v_vec = (v_vec / np.linalg.norm(v_vec)) * v_mag
    
    return (
        {"x": float(x), "y": float(y), "z": float(z)},
        {"x": float(v_vec[0]), "y": float(v_vec[1]), "z": float(v_vec[2])}
    )

def generate_assassin_debris(r_sat0: dict, v_sat0: dict, tca_sec: float, v_rel_mag: float = 12.0):
    r0 = np.array([r_sat0['x'], r_sat0['y'], r_sat0['z']])
    v0 = np.array([v_sat0['x'], v_sat0['y'], v_sat0['z']])

    r_mag = np.linalg.norm(r0)
    omega_sat = np.linalg.norm(np.cross(r0, v0)) / (r_mag**2)

    r_tca = r0 * math.cos(omega_sat * tca_sec) + (v0 / omega_sat) * math.sin(omega_sat * tca_sec)
    v_tca = -r0 * omega_sat * math.sin(omega_sat * tca_sec) + v0 * math.cos(omega_sat * tca_sec)

    random_vec = np.random.randn(3)
    u = np.cross(r_tca, random_vec)
    u = u / np.linalg.norm(u)
    
    v_deb_tca = v_tca + (u * v_rel_mag)

    omega_deb = np.linalg.norm(np.cross(r_tca, v_deb_tca)) / (r_mag**2)
    t_back = -tca_sec

    r_deb0 = r_tca * math.cos(omega_deb * t_back) + (v_deb_tca / omega_deb) * math.sin(omega_deb * t_back)
    v_deb0 = -r_tca * omega_deb * math.sin(omega_deb * t_back) + v_deb_tca * math.cos(omega_deb * t_back)

    return (
        {"x": float(r_deb0[0]), "y": float(r_deb0[1]), "z": float(r_deb0[2])},
        {"x": float(v_deb0[0]), "y": float(v_deb0[1]), "z": float(v_deb0[2])}
    )

def check_response(resp, stage_name):
    if resp.status_code not in [200, 202]:
        print(f"\n❌ FATAL ERROR AT STAGE: {stage_name}")
        print(f"Status Code: {resp.status_code}")
        try: print(f"Error Details: {json.dumps(resp.json(), indent=2)}")
        except: print(f"Raw Text: {resp.text}")
        sys.exit(1)
    return resp.json()

# ============================================================================
# MAIN ORCHESTRATOR
# ============================================================================

def run_live_demo():
    print_header(f"CRIMSON NEBULA – 30‑DAY CONTINUOUS DEMO\n{NUM_SATELLITES} SATS | {NUM_DEBRIS} DEBRIS | KEPLER ENGINE")
    print(f"Simulation step: {STEP_SECONDS} seconds | Sleep between steps: {SLEEP_PER_STEP} sec")
    print("Frontend polls snapshot every 2 seconds – you will see smooth movement.\n")

    # ── 1. GENERATE DATA ──
    print("\n[1/4] Generating orbital vectors and assassin trajectories...")
    objects = []
    sat_states = {}
    
    for i in range(NUM_SATELLITES):
        alt = 400.0 + np.random.uniform(-5, 5)
        inc = 51.6 + np.random.uniform(-1, 1)
        r, v = generate_circular_orbit(alt, inclination_deg=inc)
        sat_id = f"SAT-{i:03d}"
        sat_states[sat_id] = (r, v)
        objects.append({"id": sat_id, "type": "SATELLITE", "r": r, "v": v})
        
    WARNING_TIME_MINUTES = 60
    INCOMING_CDMS = defaultdict(list)
    
    print(f"      -> Injecting 150 high‑risk intersecting vectors...")
    assassin_count = 0
    for i in range(150):
        target_sat_idx = random.randint(0, NUM_SATELLITES - 1)
        target_sat_id = f"SAT-{target_sat_idx:03d}"
        
        collision_step = random.randint(100, TOTAL_STEPS - 100)
        tca_seconds = collision_step * STEP_SECONDS
        
        sat_r, sat_v = sat_states[target_sat_id]
        deb_r, deb_v = generate_assassin_debris(sat_r, sat_v, tca_seconds, v_rel_mag=12.5)
        
        deb_id = f"DEB-ASSN-{assassin_count:03d}"
        objects.append({"id": deb_id, "type": "DEBRIS", "r": deb_r, "v": deb_v})
        
        trigger_step = collision_step - WARNING_TIME_MINUTES
        if trigger_step > 0:
            INCOMING_CDMS[trigger_step].append((
                target_sat_id, 
                WARNING_TIME_MINUTES * 60.0, 
                12.5,                        
                0.999                        
            ))
        assassin_count += 1
        
    print(f"      -> Filling remaining {NUM_DEBRIS - assassin_count} background debris...")
    for i in range(assassin_count, NUM_DEBRIS):
        alt = np.random.uniform(350, 450)
        r, v = generate_circular_orbit(alt)
        objects.append({"id": f"DEB-BG-{i:05d}", "type": "DEBRIS", "r": r, "v": v})

    # ── 2. UPLINK TELEMETRY ──
    current_sim_time_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    print(f"\n[2/4] Uplinking telemetry payload to backend...")
    
    t0_tel = time.perf_counter()
    telemetry_resp = requests.post(f"{BASE_URL}/api/telemetry", json={"timestamp": current_sim_time_iso, "objects": objects})
    t1_tel = time.perf_counter()
    
    print(f"✅ Telemetry initialized in {(t1_tel - t0_tel)*1000:.2f} ms")
    check_response(telemetry_resp, "Initial Telemetry Ingestion")
    
    # ── 3. START AUTO‑SYNC ON FRONTEND ──
    print(f"\n[3/4] Frontend auto‑sync is assumed to be active (every 2s).")
    
    # ── 4. IGNITE SIMULATION ──
    brain = AutonomousBrain()
    print_header(f"IGNITING 30‑DAY SIMULATION ({TOTAL_STEPS} steps @ {STEP_SECONDS}s/step)")
    print("Frontend will show satellites moving, fuel decreasing, and evasion trails.\n")
    
    # Live tracking metrics
    total_evasions = 0
    total_fuel = 0.0
    sat_max_drift = {f"SAT-{i:03d}": 0.0 for i in range(NUM_SATELLITES)}
    sat_fuel_used = {f"SAT-{i:03d}": 0.0 for i in range(NUM_SATELLITES)}
    
    start_real = time.time()
    for step in range(TOTAL_STEPS):
        # ── A. TRIGGER MANEUVERS VIA CDMS ──
        if step in INCOMING_CDMS:
            try:
                debug_data = requests.get(f"{BASE_URL}/api/internal/debug_state", timeout=10).json()
            except:
                debug_data = {}
            
            sat_states_arr = np.zeros((NUM_SATELLITES, 6))
            nominal_states_arr = np.zeros((NUM_SATELLITES, 6))
            sat_fuels = np.full(NUM_SATELLITES, 50.0)
            
            for i in range(NUM_SATELLITES):
                sid = f"SAT-{i:03d}"
                if sid in debug_data:
                    sat_states_arr[i] = debug_data[sid]["r_eci"] + debug_data[sid]["v_eci"]
                    nominal_states_arr[i] = debug_data[sid]["r_nominal_eci"] + debug_data[sid]["v_eci"]
                    sat_fuels[i] = debug_data[sid]["fuel_kg"]
            
            conjunctions = []
            for sat_id, tca, rel_vel, risk in INCOMING_CDMS[step]:
                sat_idx = int(sat_id.split("-")[1])
                conjunctions.append(Conjunction(sat_idx=sat_idx, debris_idx=9999, tca_seconds=tca, miss_distance_km=0.01, relative_velocity_kms=rel_vel, risk_score=risk))
                
            sim_time_dt = datetime.fromisoformat(current_sim_time_iso.replace('Z', '+00:00'))
            
            plans = brain.plan_evasion(sat_states_arr, nominal_states_arr, sat_fuels.tolist(), conjunctions, sim_time_dt, [])
            
            if plans:
                plans_by_sat = defaultdict(list)
                for p in plans: 
                    plans_by_sat[f"SAT-{p.sat_idx:03d}"].append(p)
                    
                for sid, sat_plans in plans_by_sat.items():
                    seq = []
                    fuel_cost = 0.0
                    for i, p in enumerate(sat_plans):
                        burn_dt = sim_time_dt + timedelta(seconds=p.burn_time_offset_s)
                        iso_time = burn_dt.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                        seq.append({"burn_id": f"EVADE-{sid}-{step}-{i}", "burnTime": iso_time, "deltaV_vector": p.delta_v_eci_dict})
                        fuel_cost += p.estimated_fuel_kg
                    
                    schedule_resp = requests.post(f"{BASE_URL}/api/maneuver/schedule", json={"satelliteId": sid, "maneuver_sequence": seq})
                    if schedule_resp.status_code == 202:
                        print(f"\n🚨 [DEFCON 1] T-{WARNING_TIME_MINUTES}m | {sid} Locked on Assassin Debris!")
                        print(f"   ↳ Firing Thrusters: {sat_plans[0].maneuver_type.name} | Est. Fuel: {fuel_cost:.3f} kg")
                        total_evasions += 1
                        total_fuel += fuel_cost
                        sat_fuel_used[sid] += fuel_cost
                        
        # ── B. STEP PHYSICS ENGINE ──
        try:
            t0_phys = time.perf_counter()
            sim_resp = requests.post(f"{BASE_URL}/api/simulate/step", json={"step_seconds": STEP_SECONDS}, timeout=10)
            phys_ms = (time.perf_counter() - t0_phys) * 1000.0
            
            sim_data = check_response(sim_resp, f"Simulation Step {step}")
            current_sim_time_iso = sim_data.get("new_timestamp", current_sim_time_iso)
            executed_this_step = sim_data.get('maneuvers_executed', 0)
            
            if executed_this_step > 0:
                print(f" 🔥 [TELEMETRY] Main Engine Burn confirmed on {executed_this_step} satellites in orbit.")
                
        except Exception as e:
            print(f"⚠️ Physics Step Timeout/Error: {e}")

        # ── C. DRIFT AUDIT & RADAR (every 5 simulated hours) ──
        if step % 300 == 0 and step > 0:   # 300 steps = 5 hours
            try:
                debug_resp = requests.get(f"{BASE_URL}/api/internal/debug_state", timeout=5)
                if debug_resp.status_code == 200:
                    debug_data = debug_resp.json()
                    
                    active_evaders = []
                    for sid, s_data in debug_data.items():
                        if not sid.startswith("SAT-"): continue
                        
                        r_real = np.array(s_data["r_eci"])
                        r_ghost = np.array(s_data["r_nominal_eci"])
                        drift_km = np.linalg.norm(r_real - r_ghost)
                        fuel = s_data.get("fuel_kg", 50.0)
                        
                        if drift_km > sat_max_drift[sid]:
                            sat_max_drift[sid] = drift_km
                        
                        if drift_km > 0.1:
                            active_evaders.append((sid, drift_km, fuel))
                    
                    if active_evaders:
                        print(f"\n📡 [RADAR] Active Evasion Drifts Detected at {current_sim_time_iso.split('T')[1][:8]}Z:")
                        for sid, d, f in active_evaders[:10]:
                            indicator = "🟢 Recovering" if d < 2.0 else "🟡 Evading" if d < 10.0 else "🔴 Max Drift"
                            print(f"   ↳ {sid} | Current: {d:6.2f} km | Max Peak: {sat_max_drift[sid]:6.2f} km | Status: {indicator}")
                        
            except: pass

        # Progress heartbeat (every 1 simulated hour)
        if step % 60 == 0:
            sim_time_obj = datetime.fromisoformat(current_sim_time_iso.replace('Z', '+00:00'))
            elapsed_real = time.time() - start_real
            print(f"⏱️ Step {step:05d}/{TOTAL_STEPS} | Sim Time: {sim_time_obj.strftime('%Y-%m-%d %H:%M')}Z | Real: {elapsed_real:.1f}s | Engine Latency: {phys_ms:.1f}ms")

        # Sleep to control simulation speed (so frontend updates are visible)
        if SLEEP_PER_STEP > 0:
            time.sleep(SLEEP_PER_STEP)

    # ========================================================================
    # POST-DEMO REPORT
    # ========================================================================
    print_header("MISSION CONCLUDED – FINAL AUDIT REPORT")
    print(f"✅ Total Evasions Executed: {total_evasions}")
    print(f"✅ Total Fuel Expended: {total_fuel:.2f} kg")
    
    print("\n📊 MAXIMUM DRIFT PEAKS (Top 15 Evaders):")
    drifting_sats = sorted(sat_max_drift.items(), key=lambda x: x[1], reverse=True)
    printed = 0
    for sid, max_d in drifting_sats:
        if max_d > 0.05:
            print(f"   🚀 {sid}: {max_d:7.4f} km max offset (Fuel used: {sat_fuel_used[sid]:.2f} kg)")
            printed += 1
            if printed >= 15: break
            
    if printed == 0:
        print("   ↳ No significant drifts recorded (Flawless nominal keeping).")
        
    print("\n[NOTE] During this run, the frontend updated every 2 seconds.")
    print("You should have observed satellites moving, fuel decreasing, and evasion trails.")

if __name__ == "__main__":
    run_live_demo()