import requests
import json
import time

BASE_URL = "http://127.0.0.1:8000"

def print_section(title):
    print(f"\n{'='*20} {title} {'='*20}")

def test_health():
    print_section("1. HEALTH CHECK")
    try:
        resp = requests.get(f"{BASE_URL}/")
        print(f"Status: {resp.status_code}")
        print(f"Response: {json.dumps(resp.json(), indent=2)}")
        return resp.status_code == 200
    except Exception as e:
        print(f"Failed: {e}")
        return False

def test_telemetry():
    print_section("2. TELEMETRY INGESTION")
    payload = {
        "timestamp": "2026-03-12T08:00:00.000Z",
        "objects": [
            {
                "id": "SAT-Alpha-04",
                "type": "SATELLITE",
                # Moved to an orbit highly visible from the Northern Hemisphere/Asia
                "r": {"x": 2000.0, "y": 5500.0, "z": 3500.0}, 
                "v": {"x": -2.0, "y": 4.0, "z": 6.0}
            },
            {
                "id": "DEB-99421",
                "type": "DEBRIS",
                "r": {"x": 6578.1, "y": 0.0, "z": 0.0}, # Very close for collision test
                "v": {"x": 0.0, "y": 7.784, "z": 0.0}
            },
            {
                "id": "DEB-00112",
                "type": "DEBRIS",
                "r": {"x": 7000.0, "y": 1000.0, "z": 300.0},
                "v": {"x": -1.25, "y": 6.84, "z": 3.12}
            }
        ]
    }
    try:
        resp = requests.post(f"{BASE_URL}/api/telemetry", json=payload)
        print(f"Status: {resp.status_code}")
        print(f"Response: {json.dumps(resp.json(), indent=2)}")
        return resp.status_code == 200
    except Exception as e:
        print(f"Failed: {e}")
        return False

def test_simulation():
    print_section("3. SIMULATION STEP")
    payload = {"step_seconds": 60}
    try:
        resp = requests.post(f"{BASE_URL}/api/simulate/step", json=payload)
        print(f"Status: {resp.status_code}")
        data = resp.json()
        print(f"Status Key: {data.get('status')}")
        print(f"Collisions Detected: {data.get('collisions_detected')}")
        print(f"Maneuvers Executed: {data.get('maneuvers_executed')}")
        # Check for required keys per NSH Spec
        required_keys = ["status", "new_timestamp", "collisions_detected", "maneuvers_executed"]
        if all(k in data for k in required_keys):
            print("✅ API Contract Valid")
        else:
            print("❌ Missing Required Keys")
        return resp.status_code == 200
    except Exception as e:
        print(f"Failed: {e}")
        return False

def test_visualization():
    print_section("4. VISUALIZATION SNAPSHOT")
    try:
        resp = requests.get(f"{BASE_URL}/api/visualization/snapshot")
        print(f"Status: {resp.status_code}")
        data = resp.json()
        print(f"Timestamp: {data.get('timestamp')}")
        print(f"Satellites Count: {len(data.get('satellites', []))}")
        print(f"Debris Count: {len(data.get('debris_cloud', []))}")
        
        # Check Debris Format [ID, Lat, Lon, Alt]
        if data.get('debris_cloud'):
            sample = data['debris_cloud'][0]
            print(f"Debris Sample: {sample}")
            if len(sample) == 4:
                print("✅ Debris Format Valid")
            else:
                print("❌ Debris Format Invalid")
        
        # Check Satellite Format
        if data.get('satellites'):
            sample = data['satellites'][0]
            print(f"Sat Sample: {sample}")
            if 'lat' in sample and 'lon' in sample and 'fuel_kg' in sample:
                print("✅ Satellite Format Valid")
            else:
                print("❌ Satellite Format Invalid")
                
        return resp.status_code == 200
    except Exception as e:
        print(f"Failed: {e}")
        return False

def test_maneuvers():
    print_section("3. MANEUVER SCHEDULING")
    payload = {
        "satelliteId": "SAT-Alpha-04",
        "maneuver_sequence": [
            {
                "burn_id": "BURN-EVADE-01",
                # Scheduled 15 seconds into the future (Beats the 10s latency rule)
                "burnTime": "2026-03-12T08:00:15.000Z", 
                "deltaV_vector": {"x": 0.0, "y": 0.01, "z": 0.0} # 10 m/s
            }
        ]
    }
    try:
        resp = requests.post(f"{BASE_URL}/api/maneuver/schedule", json=payload)
        print(f"Status: {resp.status_code}")
        data = resp.json()
        print(f"Status: {data.get('status')}")
        
        # Verify the validation block exists
        if "validation" in data:
            print("✅ Maneuver Validation Schema Valid")
        else:
            print("❌ Maneuver Validation Schema Invalid")
            
        return resp.status_code == 202
    except Exception as e:
        print(f"Failed: {e}")
        return False
    
if __name__ == "__main__":
    print("🚀 Starting NSH 2026 Backend Validation...")
    time.sleep(2) # Wait for server to be ready
    
    results = []
    results.append(("Health", test_health()))
    results.append(("Telemetry", test_telemetry()))
    results.append(("Simulation", test_simulation()))
    results.append(("Maneuvers", test_maneuvers()))
    results.append(("Visualization", test_visualization()))
    
    print_section("FINAL RESULTS")
    passed = sum(1 for _, r in results if r)
    total = len(results)
    print(f"Passed: {passed}/{total}")
    
    if passed == total:
        print("🎉 ALL TESTS PASSED. READY FOR SUBMISSION.")
    else:
        print("⚠️ SOME TESTS FAILED. CHECK LOGS.")