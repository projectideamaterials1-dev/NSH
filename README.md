# Satellite Collision Avoidance API

A real-time telemetry ingestion and orbital simulation API with collision detection and maneuver scheduling capabilities. This project is built using FastAPI and implements orbital mechanics using a Runge-Kutta 4th order (RK4) integrator with J2 perturbations.

## 🚀 Features

- **Telemetry Ingestion**: Ingests real-time position and velocity data for satellites and space debris.
- **Orbital Propagation**: Simulates the movement of space objects over time using RK4 integration accounting for Earth's J2 oblateness perturbation.
- **Collision Screening**: Two-stage collision detection (coarse bounding box + precise Time to Closest Approach).
- **Maneuver Scheduling**: Allows scheduling of impulse burns (delta-V maneuvers) to avoid collisions out in the future. Validates line-of-sight to ground stations and computes fuel consumption.

---

## 📂 Project Structure

### Root Files
- **`README.md`**: This file. Documentation on how to run and understand the project.
- **`data/ground_stations.csv`**: Contains the configured ground stations data (Latitude, Longitude, Altitude, Min Elevation) used to compute line-of-sight (LOS) communications during maneuver schedules.

### `satellite_api/` (Core Application)
- **`main.py`**: The entry point for the FastAPI application. It wires together the routers, initializes the shared application state, and handles CORS setup.
- **`models.py`**: Contains all the Pydantic data models used for validating incoming HTTP requests and typing outgoing HTTP responses. (e.g., `SpaceObject`, `SimulationTickRequest`, `ManeuverScheduleRequest`).
- **`physics.py`**: The orbital mechanics engine. Contains functions for two-body gravity simulation, J2 perturbation, the RK4 integrator (`rk4_step`), separation algorithms, and `time_to_closest_approach`.
- **`collision.py`**: The collision detection service. Implements a fast coarse bounding-box filter followed by a precise TCA-based closest approach measurement (`run_collision_screening`).
- **`state.py`**: The thread-safe in-memory data store (`AppState`) used to keep track of the current simulation time (`epoch`, `current_time`), space objects states, fuel levels, and scheduled maneuvers.
- **`ground_stations.py`**: Contains helper methods to load the ground stations from the dataset, calculate Greenwich Mean Sidereal Time (GMST), execute Geodetic-to-ECI coordinate conversions, and compute elevation angles to establish Line of Sight.
- **`test_api.py`**: A quick python integration script employing standard `urllib` to test telemetry ingestion and simulation endpoints without requiring external tools.
- **`requirements.txt`**: The pip dependency file.

### `satellite_api/routers/` (API Endpoints)
- **`telemetry.py`**: Exposes `POST /api/telemetry` to receive incoming space object vectors and sync them with the in-memory application state.
- **`simulation.py`**: Exposes `POST /api/simulation/tick` to advance the simulation clock by a requested duration in seconds. It breaks down the duration into segments to accurately apply scheduled maneuver delta-Vs dynamically during orbit propagation.
- **`maneuver.py`**: Exposes `POST /api/maneuver/schedule`. Validates fuel consumption levels, Ground Station Line of Sight availability at requested execution times, and payload constraints before appending the action to the application's maneuver queue.

---

## 📡 API Endpoints & Request Examples

### 1. Telemetry Ingestion (`POST /api/telemetry`)
**Purpose**: Ingest initial satellite and debris states.
**Request Body**:
```json
{
  "timestamp": "2026-03-12T08:00:00.000Z",
  "objects": [
    {
      "id": "SAT-Alpha-04",
      "type": "SATELLITE",
      "r": {"x": 6578.0, "y": 0.0, "z": 0.0},
      "v": {"x": 0.0, "y": 7.784, "z": 0.0}
    },
    {
      "id": "DEB-001",
      "type": "DEBRIS",
      "r": {"x": 6579.0, "y": 0.5, "z": 0.1},
      "v": {"x": 0.001, "y": 7.780, "z": 0.002}
    }
  ]
}
```

### 2. Maneuver Scheduling (`POST /api/maneuver/schedule`)
**Purpose**: Schedule evasion and recovery burns for a satellite.
**Request Body** *(corrected Δv within 15 m/s limit)*:
```json
{
  "satelliteId": "SAT-Alpha-04",
  "maneuver_sequence": [
    {
      "burn_id": "EVASION_BURN_1",
      "burnTime": "2026-03-12T14:15:30.000Z",
      "deltaV_vector": {"x": 0.0015, "y": 0.014, "z": -0.0005}
    },
    {
      "burn_id": "RECOVERY_BURN_1",
      "burnTime": "2026-03-12T15:45:30.000Z",
      "deltaV_vector": {"x": -0.0019, "y": -0.014, "z": 0.001}
    }
  ]
}
```

### 3. Simulation Tick (`POST /api/simulation/tick`)
**Purpose**: Advance the simulation clock by a requested duration in seconds (1-3600).
**Request Body**:
```json
{
  "tick_duration_s": 60.0
}
```

---

## 🛠 Setup & Installation

**Prerequisites:** Python 3.11+ running in a standard virtual environment.

**1. Create & Activate a Virtual Environment**
```bash
python3 -m venv venv
source venv/bin/activate
```

**2. Install Dependencies**
```bash
pip install -r satellite_api/requirements.txt
```

---

## 💻 Running the Application

Start the FastAPI application via `uvicorn`. Ensure your terminal is in the project root directory alongside the `satellite_api` module.

```bash
uvicorn satellite_api.main:app --reload --port 8000
```
- The API will start on `http://127.0.0.1:8000`
- You can access the interactive Swagger UI dynamically generated by FastAPI at `http://127.0.0.1:8000/docs`.

---

## 🧪 Testing

A small integration script (`test_api.py`) is provided in the repository to simulate telemetry injection and to trigger some basic simulation chunks locally against the running HTTP server.

While the server is actively running in one terminal, open a new terminal tab and execute:
```bash
python3 satellite_api/test_api.py
```
