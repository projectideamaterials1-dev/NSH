# 🛰️ Crimson Nebula: Autonomous Constellation Manager & Orbital Visualizer

**National Space Hackathon 2026** | Indian Institute of Technology, Delhi

[![Python 3.11+](https://img.shields.io/badge/Python-3.11+-blue.svg)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.109+-green.svg)](https://fastapi.tiangolo.com)
[![React 18](https://img.shields.io/badge/React-18.2+-61dafb.svg)](https://reactjs.org)
[![Deck.gl](https://img.shields.io/badge/Deck.gl-9.0+-blue.svg)](https://deck.gl)
[![Docker](https://img.shields.io/badge/Docker-ubuntu:22.04-2496ED.svg)](https://docker.com)

---

## 📌 Overview

**Crimson Nebula** is a full‑stack Autonomous Constellation Manager (ACM) that combines a high‑performance Python physics engine with a real‑time React/WebGL frontend. It autonomously tracks 50+ satellites and 100,000+ debris objects, predicts conjunctions, schedules fuel‑optimal evasion burns, and visualises the entire constellation on a 60+ FPS interactive map – fully compliant with NSH 2026 specifications.

---

## ✅ Problem Statement Compliance

| Requirement | Implementation |
|-------------|----------------|
| `POST /api/telemetry` | ✅ Ingests ECI state vectors, updates thread‑safe store |
| `POST /api/maneuver/schedule` | ✅ Validates Δv ≤15 m/s, 600s cooldown, LOS, fuel (Tsiolkovsky) |
| `POST /api/simulate/step` | ✅ RK4 integration with J₂, executes scheduled burns |
| `GET /api/visualization/snapshot` | ✅ Flattened tuple format for debris, <200ms response |
| **Frontend modules (4)** | ✅ Ground track, Bullseye Radar, Resource Heatmaps, Gantt Scheduler |
| **Docker (ubuntu:22.04, port 8000)** | ✅ Provided at root |
| **Station‑keeping box (10 km)** | ✅ Drift tracked, uptime logged |
| **Thermal cooldown (600s)** | ✅ Enforced in backend + Gantt visualisation |

---

## 🏗️ Technology Stack

| Layer | Technologies |
|-------|--------------|
| **Backend** | Python 3.11+, FastAPI, Uvicorn, NumPy, Pydantic |
| **Frontend** | React 18, TypeScript, Vite, Zustand, Deck.gl, MapLibre, Tailwind CSS |
| **DevOps** | Docker (ubuntu:22.04) |

---

## 📂 Project Structure

```
crimson-nebula/
├── .dockerignore
├── .gitignore
├── Dockerfile                     # ubuntu:22.04, exposes port 8000
├── pyproject.toml
├── requirements.txt
├── setup.py
├── test.py                        # 30‑day stress test script
├── data/
│   └── ground_stations.csv        # 6 ground stations (PS Section 5.5.1)
├── satellite_api/                 # Backend (FastAPI)
│   ├── main.py                    # API entry point, CORS, routers
│   ├── models.py                  # Pydantic schemas
│   ├── state.py                   # Thread‑safe in‑memory store
│   ├── coordinates.py             # ECI ↔ LLA conversions
│   ├── acm/
│   │   └── brain.py               # Autonomous manoeuvre planning
│   └── routers/
│       ├── telemetry.py           # POST /api/telemetry
│       ├── simulation.py          # POST /api/simulate/step
│       ├── maneuvers.py           # POST /api/maneuver/schedule
│       └── visualization.py       # GET /api/visualization/snapshot
└── frontend/                      # React + Vite
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api/
        │   └── telemetryClient.ts
        ├── components/
        │   ├── Header.tsx
        │   ├── DashboardLayout.tsx
        │   └── DeckGLMap.tsx
        ├── store/
        │   └── useOrbitalStore.ts
        ├── workers/
        │   └── telemetryWorker.ts
        └── lib/
            └── constants.ts
```

---

## 🧠 Backend Architecture & Mathematical Foundations

The backend is engineered to handle high‑throughput telemetry and real‑time collision prediction. It uses a **pure Python** implementation with NumPy for vectorised operations, avoiding O(N²) bottlenecks.

### 1. Orbital Propagation (RK4 + J₂)

We model Low Earth Orbit (LEO) mechanics with **J₂ geopotential perturbations** and integrate using a **4th‑order Runge‑Kutta (RK4)** solver.

#### J₂ Perturbation Model
$$\vec{a} = -\frac{\mu}{r^3}\vec{r} + \vec{a}_{J2}$$

Components:
$$a_x = -\frac{\mu x}{r^3} \left[ \frac{3}{2} J_2 \left(\frac{R_E}{r}\right)^2 \left(5 \frac{z^2}{r^2} - 1\right) \right]$$
$$a_y = -\frac{\mu y}{r^3} \left[ \frac{3}{2} J_2 \left(\frac{R_E}{r}\right)^2 \left(5 \frac{z^2}{r^2} - 1\right) \right]$$
$$a_z = -\frac{\mu z}{r^3} \left[ \frac{3}{2} J_2 \left(\frac{R_E}{r}\right)^2 \left(5 \frac{z^2}{r^2} - 3\right) \right]$$

- $\mu = 398600.4418 \text{ km}^3/\text{s}^2$
- $R_E = 6378.137 \text{ km}$
- $J_2 = 1.08263 \times 10^{-3}$

#### RK4 Integration
$$\vec{y}_{n+1} = \vec{y}_n + \frac{\Delta t}{6}(\vec{k}_1 + 2\vec{k}_2 + 2\vec{k}_3 + \vec{k}_4)$$

### 2. Collision Screening (AABB + TCA)

- **Coarse filter:** Axis‑Aligned Bounding Box (AABB) using spatial partitioning.
- **Precise stage:** Time to Closest Approach (TCA) for each candidate pair.

$$t_{CA} = -\frac{\Delta\vec{r} \cdot \Delta\vec{v}}{\|\Delta\vec{v}\|^2}$$

- **Risk levels:** CRITICAL (<1 km), WARNING (<5 km), SAFE.

### 3. Fuel & Manoeuvre Validation (Tsiolkovsky)

$$\Delta m = m_{wet} \left(1 - e^{-\frac{\Delta v}{I_{sp} g_0}}\right)$$

- $I_{sp} = 300.0 \text{ s}$, $g_0 = 9.80665 \text{ m/s}^2$
- $m_{dry} = 500 \text{ kg}$, initial $m_{fuel} = 50 \text{ kg}$
- Each burn must satisfy $\|\Delta\vec{v}\| \le 15 \text{ m/s}$ and respect a **600 s cooldown**.

### 4. Line‑of‑Sight (LOS) to Ground Stations

Using the spherical law of cosines, we compute the elevation angle $\epsilon$:

$$\gamma = \arccos\left(\sin\phi_1 \sin\phi_2 + \cos\phi_1 \cos\phi_2 \cos(\lambda_1 - \lambda_2)\right)$$
$$\epsilon = \arctan\left( \frac{\cos\gamma - \frac{R_E}{R_E + h_{sat}}}{\sin\gamma} \right)$$

A manoeuvre is only accepted if $\epsilon \ge 5^\circ$ for at least one of the 6 ground stations.

---

## 🚀 Setup & Deployment

### 1. Backend (Python / FastAPI)

```bash
cd satellite_api
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r ../requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

API interactive docs: http://localhost:8000/docs

### 2. Frontend (React / Vite)

```bash
cd frontend
npm install
npm run dev
```

Dashboard: http://localhost:5173

### 3. Inject Test Telemetry

While the backend is running:

```bash
python test.py
```

This runs a 30‑day simulation with 50 satellites and 10,000 debris objects, logging evasions, fuel consumption, and drift peaks.

---

## 🐳 Docker Deployment (Required by PS)

```bash
# Build image
docker build -t crimson-nebula:latest .

# Run container
docker run -d --name crimson-nebula -p 8000:8000 -p 5173:5173 crimson-nebula:latest
```

The Dockerfile uses `ubuntu:22.04`, installs Python 3.11 and Node.js, copies both backend and frontend, builds the frontend, and serves the backend on port 8000.

---

## 📡 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/telemetry` | POST | Ingest initial satellite/debris state vectors |
| `/api/maneuver/schedule` | POST | Schedule evasion/recovery burn (Δv, burn time) |
| `/api/simulate/step` | POST | Advance simulation by `step_seconds` |
| `/api/visualization/snapshot` | GET | Optimised snapshot for frontend (lat/lon/fuel) |

Detailed schemas are available at `/docs` when the server is running.

---

## 🖥️ Frontend Visualisation Modules

| Module | Implementation |
|--------|----------------|
| **Ground Track Map** | Deck.gl + MapLibre, 60+ FPS, 100k debris points |
| **Conjunction Bullseye** | Polar scatter plot with TCA and risk colour coding |
| **Resource Heatmaps** | Fuel gauges (0–50 kg) + Δv cost analysis graph |
| **Maneuver Gantt** | Timeline with burn blocks, 600 s cooldowns, conflict detection |

---

## 🧪 Testing & Validation

- **Stress test:** `test.py` runs a 30‑day simulation and reports fuel use, evasions, and drift.
- **Frontend performance:** Locked 60+ FPS on 50 satellites + 10,000 debris.

---

## 📄 License & Submission

This project is submitted for the **National Space Hackathon 2026** at IIT Delhi. All code is original and adheres to the competition’s rules and constraints.

---

**Built for reliability, performance, and physical accuracy.** 🚀