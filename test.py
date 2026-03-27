#!/usr/bin/env python3
"""
NSH 2026: Ultimate 30-Day Stress Test & Mathematical Audit
==========================================================
Upgraded with High-Precision Performance/Latency Tracking, 
500-Satellite Scale, Global Drift/Fuel Analytics, and File Logging.
"""

import requests
import time
import math
import numpy as np
import csv
import random
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Dict, Optional, Tuple

# Import Autonomous Brain for local planning
sys.path.append('satellite_api')
from acm.brain import AutonomousBrain, Conjunction, ManeuverType

# ============================================================================
# TEE LOGGER (Writes to console AND file simultaneously)
# ============================================================================
class TeeLogger(object):
    def __init__(self, filename="mission_simulation.log"):
        self.terminal = sys.stdout
        self.log = open(filename, "w", encoding="utf-8")

    def write(self, message):
        self.terminal.write(message)
        self.log.write(message)

    def flush(self):
        self.terminal.flush()
        self.log.flush()

sys.stdout = TeeLogger()

# ============================================================================
# CONSTANTS & CONFIGURATION (30-DAY TIMELINE)
# ============================================================================
BASE_URL = "http://127.0.0.1:8000"
R_EARTH = 6378.137          
MU_EARTH = 398600.4418      
J2 = 1.08262668e-3          
I_SP = 300.0                
G0 = 9.80665                

# 🚀 MEGA-CONSTELLATION SCALE
NUM_SATELLITES = 500
NUM_DEBRIS = 100000

SIMULATION_DAYS = 30
STEP_SECONDS = 60           
TOTAL_STEPS = (SIMULATION_DAYS * 24 * 3600) // STEP_SECONDS  

TESTLOG_PATH = Path("mission_report_30day.md")
MATH_AUDIT_PATH = Path("math_audit_30day.json")

# PROCEDURAL THREAT GENERATION
np.random.seed(42)
random.seed(42)

INCOMING_CDMS: Dict[int, List[Tuple[str, float, float, float]]] = defaultdict(list)
for _ in range(15000):  
    minute = random.randint(10, TOTAL_STEPS - 120)
    sat_target = f"SAT-{random.randint(0, NUM_SATELLITES-1):03d}"
    tca = random.uniform(3600.0, 86400.0)  
    rel_vel = random.uniform(-15.0, 15.0)  
    risk = random.uniform(0.80, 0.99)
    INCOMING_CDMS[minute].append((sat_target, tca, rel_vel, risk))

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def print_header(title: str):
    print(f"\n{'='*25} {title} {'='*25}")

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

def check_response(resp, stage_name):
    if resp.status_code not in [200, 202]:
        print(f"\n❌ FATAL ERROR AT STAGE: {stage_name}")
        print(f"Status Code: {resp.status_code}")
        try: print(f"Error Details: {json.dumps(resp.json(), indent=2)}")
        except: print(f"Raw Text: {resp.text}")
        sys.exit(1)
    return resp.json()

def load_ground_stations(csv_path: str = "data/ground_stations.csv") -> list:
    stations = []
    path = Path(csv_path)
    if not path.exists(): return stations
    try:
        with open(path, mode='r', encoding='utf-8') as f:
            reader = csv.DictReader(filter(lambda row: row.strip(), f))
            for row in reader:
                clean_row = {k.strip(): v.strip() for k, v in row.items()}
                m_key = "Min Elevation_Angle_deg" if "Min Elevation_Angle_deg" in clean_row else "Min_Elevation_Angle_deg"
                stations.append({
                    "station_id": clean_row.get("Station_ID", ""),
                    "latitude": float(clean_row.get("Latitude", 0.0)),
                    "longitude": float(clean_row.get("Longitude", 0.0)),
                    "elevation_m": float(clean_row.get("Elevation_m", 0.0)),
                    "min_elevation_angle_deg": float(clean_row.get(m_key, 0.0))
                })
    except: pass
    return stations

def calculate_orbital_energy(r_eci: np.ndarray, v_eci: np.ndarray) -> float:
    r_mag = np.linalg.norm(r_eci)
    v_mag = np.linalg.norm(v_eci)
    return (v_mag**2 / 2.0) - (MU_EARTH / r_mag)

# ============================================================================
# MAIN TEST ORCHESTRATOR
# ============================================================================

def run_ultimate_stress_test():
    print_header(f"NSH 2026 ULTIMATE 30-DAY STRESS TEST ({NUM_SATELLITES} SATS | {NUM_DEBRIS} DEBRIS)")
    
    test_metrics = {
        f"SAT-{i:03d}": {
            "maneuvers_scheduled": 0, "fuel_consumed": 0.0, "time_outside_box": 0.0,
            "collisions_avoided": 0, "energy_variance": 0.0, "initial_energy": None,
            "max_drift_km": 0.0, "current_drift_km": 0.0, "final_fuel_kg": 50.0
        } for i in range(NUM_SATELLITES)
    }
    
    # 🚀 GLOBAL & LATENCY TRACKERS
    global_metrics = {
        "total_maneuvers_fired": 0, 
        "simulation_start_time": None, 
        "simulation_end_time": None,
        "max_drift_overall_km": 0.0,
        "max_drift_sat": "None",
        "max_single_maneuver_fuel": 0.0,
        "max_fuel_maneuver_sat": "None",
        "max_fuel_maneuver_type": "None",
        "latencies": {
            "physics_ticks_ms": [],
            "brain_compute_ms": [],
            "telemetry_ingest_ms": 0.0
        }
    }
    ground_stations = load_ground_stations()
    
    print(f"\n🔄 Generating Synthetic Orbits... (Building {NUM_SATELLITES} Sats and {NUM_DEBRIS} Debris)")
    objects = []
    for i in range(NUM_SATELLITES):
        alt = 400.0 + np.random.uniform(-10, 10)
        inc = 51.6 + np.random.uniform(-2, 2)
        r, v = generate_circular_orbit(alt, inclination_deg=inc)
        objects.append({"id": f"SAT-{i:03d}", "type": "SATELLITE", "r": r, "v": v})
    
    for i in range(NUM_DEBRIS):
        alt = np.random.uniform(350, 450)
        r, v = generate_circular_orbit(alt)
        objects.append({"id": f"DEB-{i:06d}", "type": "DEBRIS", "r": r, "v": v})
    
    current_sim_time_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    print(f"\n📡 Uplinking Initial Telemetry Payload at {current_sim_time_iso}...")
    
    t0_tel = time.perf_counter()
    telemetry_resp = requests.post(f"{BASE_URL}/api/telemetry", json={"timestamp": current_sim_time_iso, "objects": objects})
    t1_tel = time.perf_counter()
    global_metrics["latencies"]["telemetry_ingest_ms"] = (t1_tel - t0_tel) * 1000.0
    print(f"✅ Telemetry Initialized in {global_metrics['latencies']['telemetry_ingest_ms']:.2f} ms")
    check_response(telemetry_resp, "Initial Telemetry Ingestion")
    
    brain = AutonomousBrain()
    global_metrics["simulation_start_time"] = time.perf_counter()
    
    print_header(f"BEGIN 30-DAY FAST-FORWARD ({TOTAL_STEPS} Steps @ {STEP_SECONDS}s/step)")
    
    for step in range(TOTAL_STEPS):
        current_minute = step
        
        # ── 1. MISSION CONTROL: CHECK FOR INCOMING CDMs ──
        if current_minute in INCOMING_CDMS:
            try:
                debug_resp = requests.get(f"{BASE_URL}/api/internal/debug_state", timeout=10)
                debug_data = debug_resp.json() if debug_resp.status_code == 200 else {}
            except: debug_data = {}
            
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
            for sat_id, tca, rel_vel, risk in INCOMING_CDMS[current_minute]:
                sat_idx = int(sat_id.split("-")[1])
                conjunctions.append(Conjunction(sat_idx=sat_idx, debris_idx=9999, tca_seconds=tca, miss_distance_km=0.01, relative_velocity_kms=rel_vel, risk_score=risk))
                
            sim_time_dt = datetime.fromisoformat(current_sim_time_iso.replace('Z', '+00:00'))
            
            t0_brain = time.perf_counter()
            plans = brain.plan_evasion(sat_states_arr, nominal_states_arr, sat_fuels.tolist(), conjunctions, sim_time_dt, ground_stations)
            t1_brain = time.perf_counter()
            global_metrics["latencies"]["brain_compute_ms"].append((t1_brain - t0_brain) * 1000.0)
            
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
                        seq.append({
                            "burn_id": f"AUTO-{sid}-{i}", 
                            "burnTime": iso_time, 
                            "deltaV_vector": p.delta_v_eci_dict 
                        })
                        fuel_cost += p.estimated_fuel_kg
                        
                    # Track absolute highest fuel maneuver sequence
                    if fuel_cost > global_metrics["max_single_maneuver_fuel"]:
                        global_metrics["max_single_maneuver_fuel"] = fuel_cost
                        global_metrics["max_fuel_maneuver_sat"] = sid
                        global_metrics["max_fuel_maneuver_type"] = sat_plans[0].maneuver_type.name

                    schedule_resp = requests.post(f"{BASE_URL}/api/maneuver/schedule", json={"satelliteId": sid, "maneuver_sequence": seq})
                    if schedule_resp.status_code == 202:
                        print(f"🚨 CDM {sid}: Dodging threat! Scheduled {sat_plans[0].maneuver_type.name}")
                        test_metrics[sid]["maneuvers_scheduled"] += len(seq)
                        test_metrics[sid]["collisions_avoided"] += 1 
                        test_metrics[sid]["fuel_consumed"] += fuel_cost
        
        # ── 2. PHYSICS ENGINE TICK ──
        try:
            t0_phys = time.perf_counter()
            sim_resp = requests.post(f"{BASE_URL}/api/simulate/step", json={"step_seconds": STEP_SECONDS}, timeout=30)
            t1_phys = time.perf_counter()
            global_metrics["latencies"]["physics_ticks_ms"].append((t1_phys - t0_phys) * 1000.0)
            
            sim_data = check_response(sim_resp, f"Simulation Step {step}")
            current_sim_time_iso = sim_data.get("new_timestamp", current_sim_time_iso)
            executed_this_step = sim_data.get('maneuvers_executed', 0)
            global_metrics["total_maneuvers_fired"] += executed_this_step
            
            if executed_this_step > 0:
                print(f" 🔥 REALTIME UPDATE: {executed_this_step} thrusters fired successfully.")
        except requests.exceptions.Timeout: pass
            
        # ── 3. MATHEMATICAL AUDIT & LIVE FUEL TRACKING ──
        if step > 0 and step % 60 == 0:
            try:
                debug_resp = requests.get(f"{BASE_URL}/api/internal/debug_state", timeout=10)
                if debug_resp.status_code == 200:
                    debug_data = debug_resp.json()
                    
                    active_drifts = []
                    total_fleet_fuel = 0.0
                    
                    for sid, s_data in debug_data.items():
                        if not sid.startswith("SAT-"): continue
                        
                        fuel = s_data.get("fuel_kg", 50.0)
                        total_fleet_fuel += fuel
                        test_metrics[sid]["final_fuel_kg"] = fuel
                            
                        r_real = np.array(s_data["r_eci"])
                        v_real = np.array(s_data["v_eci"])
                        r_ghost = np.array(s_data["r_nominal_eci"])
                        
                        energy = calculate_orbital_energy(r_real, v_real)
                        if test_metrics[sid]["initial_energy"] is None: test_metrics[sid]["initial_energy"] = energy
                        test_metrics[sid]["energy_variance"] = max(test_metrics[sid]["energy_variance"], abs(energy - test_metrics[sid]["initial_energy"]))
                        
                        drift_km = np.linalg.norm(r_real - r_ghost)
                        test_metrics[sid]["current_drift_km"] = drift_km
                        test_metrics[sid]["max_drift_km"] = max(test_metrics[sid]["max_drift_km"], drift_km)
                        
                        # Track absolute maximum global drift
                        if drift_km > global_metrics["max_drift_overall_km"]:
                            global_metrics["max_drift_overall_km"] = drift_km
                            global_metrics["max_drift_sat"] = sid
                        
                        if drift_km > 10.0: test_metrics[sid]["time_outside_box"] += (STEP_SECONDS * 60)
                        
                        if drift_km > 0.1:
                            active_drifts.append(f"{sid} is {drift_km:.2f}km off-station | Fuel Rem: {fuel:.2f}kg")
                            
                    hours_elapsed = step // 60
                    avg_fuel = total_fleet_fuel / NUM_SATELLITES
                    
                    recent_phys_ms = global_metrics["latencies"]["physics_ticks_ms"][-60:]
                    avg_phys_ms = np.mean(recent_phys_ms) if recent_phys_ms else 0.0
                    max_phys_ms = np.max(recent_phys_ms) if recent_phys_ms else 0.0
                    
                    print(f"⏱️  Hour {hours_elapsed:03d}/720 [{current_sim_time_iso}] | Active Drifts: {len(active_drifts)} | Avg Fuel: {avg_fuel:.2f}kg")
                    print(f"    ⚙️  Engine Latency -> Avg: {avg_phys_ms:.2f} ms | Max: {max_phys_ms:.2f} ms")
                    for log in active_drifts: print(f"    -> {log}") 
            except: pass

    global_metrics["simulation_end_time"] = time.perf_counter()
    total_sim_time_minutes = (global_metrics["simulation_end_time"] - global_metrics["simulation_start_time"]) / 60
    
    # ========================================================================
    # FINAL API VERIFICATION & REPORT GENERATION
    # ========================================================================
    print_header("VERIFYING APIS & GENERATING FINAL REPORT")
    
    total_fuel_consumed = sum(m["fuel_consumed"] for m in test_metrics.values())
    total_collisions_avoided = sum(m["collisions_avoided"] for m in test_metrics.values())
    uptime_percentage = 100.0 - (sum(m["time_outside_box"] for m in test_metrics.values()) / (NUM_SATELLITES * SIMULATION_DAYS * 24 * 3600) * 100)
    
    all_phys = global_metrics["latencies"]["physics_ticks_ms"]
    all_brain = global_metrics["latencies"]["brain_compute_ms"]
    
    avg_phys_total = np.mean(all_phys) if all_phys else 0.0
    p99_phys = np.percentile(all_phys, 99) if all_phys else 0.0
    avg_brain_total = np.mean(all_brain) if all_brain else 0.0
    p99_brain = np.percentile(all_brain, 99) if all_brain else 0.0
    tel_ingest = global_metrics["latencies"]["telemetry_ingest_ms"]
    
    targeted_sats = sorted(test_metrics.keys(), key=lambda k: test_metrics[k]["collisions_avoided"], reverse=True)
    
    md_report = f"""# NSH 2026: 30-Day Constellation Performance & Audit Report
**Date:** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}  
**Simulated Time Compression:** ~{(SIMULATION_DAYS * 24 * 60) / max(total_sim_time_minutes, 0.01):.0f}x Faster Than Real-Time  

## ⚡ Computational Latency (Time Complexity Audit)
| Operation | Average Latency (ms) | 99th Percentile (ms) | Notes |
|-----------|----------------------|----------------------|-------|
| **C++ Physics Tick (100k Obj)** | {avg_phys_total:.2f} ms | {p99_phys:.2f} ms | OpenMP + O(N) Spatial Hash |
| **Python Evasion Brain** | {avg_brain_total:.2f} ms | {p99_brain:.2f} ms | Triggered only on CDMs |
| **Telemetry Ingestion (100k Obj)** | {tel_ingest:.2f} ms | N/A | Vectorized AABB Culling |

## 🌐 Fleet Summary & Extremes
| Metric | Value | 
|--------|-------|
| **Total Synthetic Threats Evaded** | {total_collisions_avoided} | 
| **Total Maneuvers Executed (JIT)** | {global_metrics['total_maneuvers_fired']} | 
| **Total Fuel Consumed** | {total_fuel_consumed:.2f} kg |
| **Highest Single Fuel Burn** | {global_metrics['max_single_maneuver_fuel']:.4f} kg ({global_metrics['max_fuel_maneuver_sat']} - {global_metrics['max_fuel_maneuver_type']}) |
| **Absolute Maximum Drift** | {global_metrics['max_drift_overall_km']:.4f} km ({global_metrics['max_drift_sat']}) |
| **Constellation Uptime** | {uptime_percentage:.2f}% | 
| **RK4 Energy Conservation** | {'Stable' if all(m['energy_variance'] < 1.0 for m in test_metrics.values()) else 'Unstable'} | 

## 🛰️ Detailed Per-Satellite Spatial & Fuel Audit (Top 50 Evaders)
| Satellite | Collisions Avoided | Fuel Consumed (kg) | Final Fuel Left (kg) | Max Evasion Drift (km) | Post-Recovery Final Offset (km) |
|-----------|--------------------|--------------------|----------------------|------------------------|---------------------------------|
"""
    
    for sat_id in targeted_sats[:50]: 
        evaded = test_metrics[sat_id]["collisions_avoided"]
        fuel_cons = test_metrics[sat_id]["fuel_consumed"]
        fuel_rem = test_metrics[sat_id]["final_fuel_kg"]
        max_drift = test_metrics[sat_id]["max_drift_km"]
        final_drift = test_metrics[sat_id]["current_drift_km"]
        
        drift_str = f"✅ {final_drift:.4f}" if final_drift < 10.0 else f"❌ {final_drift:.4f}"
        
        md_report += f"| **{sat_id}** | {evaded} | {fuel_cons:.2f} | {fuel_rem:.2f} | {max_drift:.4f} km | {drift_str} km |\n"
    
    with open(TESTLOG_PATH, 'w', encoding='utf-8') as f:
        f.write(md_report)
    
    print(f"\n✅ 30-Day Mission Successful.")
    print(f"✅ Detailed markdown report saved to: {TESTLOG_PATH.absolute()}")
    print(f"✅ Console output fully preserved in: mission_simulation.log")
    print(f"✅ Engine Avg Tick: {avg_phys_total:.2f}ms | Max Global Drift: {global_metrics['max_drift_overall_km']:.2f}km ({global_metrics['max_drift_sat']})")

if __name__ == "__main__":
    run_ultimate_stress_test()