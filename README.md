# 🛰️ Crimson Nebula: Autonomous Constellation Manager & Orbital Visualizer

**National Space Hackathon 2026** | Indian Institute of Technology, Delhi

[![Python 3.11+](https://img.shields.io/badge/Python-3.11+-blue.svg)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.109+-green.svg)](https://fastapi.tiangolo.com)
[![React 19](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev)
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
| **Backend** | Python 3.10+, FastAPI, Uvicorn, NumPy, Pydantic, C++20 physics engine (pybind11 + OpenMP) |
| **Real-world data** | CelesTrak NORAD element sets, SGP4 (`sgp4`), NOAA SWPC space weather |
| **Frontend** | React 19, TypeScript, Vite, Zustand, Three.js, Deck.gl, MapLibre, Tailwind CSS |
| **DevOps** | Docker (ubuntu:22.04) |

---

## 📂 Project Structure

```
crimson-nebula/
├── Dockerfile                     # ubuntu:22.04, serves API + dashboard on port 8000
├── docker-compose.prod.yml        # backend + Redis persistence + optional nginx edge proxy
├── run.sh                         # local launcher (--demo seeds and runs the demo mission)
├── backend/                       # Backend (FastAPI) — deps isolated in backend/.venv
│   ├── pyproject.toml · setup.py  # package + acm_engine C++ extension build
│   ├── requirements.txt / requirements-dev.txt
│   ├── test.py                    # 30‑day stress test script
│   ├── scripts/
│   │   └── demo.py                # demo mission: constellation, debris and planted threats
│   ├── acm_engine/
│   │   └── physics_rk4.cpp        # RK4 + J2 propagation, spatial hash + CCD (OpenMP)
│   ├── data/
│   │   └── ground_stations.csv    # 6 ground stations (PS Section 5.5.1)
│   ├── tests/                     # pytest unit / integration / regression suites
│   └── satellite_api/
│       ├── main.py                # app, lifespan (screening service, persistence), routers, static UI
│       ├── models.py              # Pydantic schemas (PS endpoints)
│       ├── state.py               # zero‑copy state, stepping, CDM registry, events, metrics
│       ├── state_redis.py         # Redis-backed state manager (snapshot save/restore)
│       ├── db.py                  # SQLite mission archive (maneuvers + events)
│       ├── config.py              # live simulation settings (/api/config)
│       ├── physics_engine.py      # C++ engine loader with NumPy fallback
│       ├── gravity.py             # zonal harmonics J2…J6 / EGM coefficient files
│       ├── ground_stations.py     # station catalogue + vectorised visibility
│       ├── coordinates.py · timeutils.py
│       ├── middleware/auth.py     # optional API key + rate limiting
│       ├── acm/
│       │   ├── brain.py           # evasion, recovery, station-keeping, EOL planning
│       │   ├── plugins.py         # avoidance strategies: Auto, TriShunt, RadialOverride
│       │   ├── conjunctions.py    # predictive screening + CDM lifecycle
│       │   ├── autopilot.py       # screen → decide → schedule service
│       │   ├── scheduler.py       # shared burn validation (LOS, Δv, cooldown, fuel)
│       │   └── scenario.py        # encounter builders for tests and the demo
│       ├── realworld/
│       │   ├── catalog.py         # CelesTrak element sets (cached) + SGP4 propagation
│       │   ├── live.py            # catalog loading, live UTC clock, SGP4 re-anchoring & conjunction refinement
│       │   └── space_weather.py   # NOAA SWPC Kp, F10.7, G/S/R scales
│       └── routers/
│           ├── telemetry.py · simulation.py · maneuvers.py · visualization.py   # PS endpoints
│           ├── maneuver_history.py    # GET /api/maneuvers, DELETE /api/maneuver/{id}
│           ├── operations.py          # conjunctions, events, metrics, autopilot, satellites, planner, archive
│           ├── realworld.py           # /api/catalog/*, /api/live, /api/space-weather
│           └── export.py              # GET /api/export/czml
└── frontend/                      # React + Vite
    ├── e2e/dashboard.spec.ts      # Playwright end-to-end tests
    ├── playwright.config.ts · vitest.config.ts
    └── src/
        ├── App.tsx · main.tsx
        ├── api/                   # http helper, telemetryClient (SSE + polling)
        ├── workers/               # telemetryWorker (JSON parsing off the main thread)
        ├── store/                 # Zustand store, snapshot buffers, replay history
        ├── lib/                   # format, geo, world geometry, constants
        ├── __tests__/             # Vitest unit tests
        └── components/
            ├── DashboardLayout.tsx     # layout shell
            ├── Header.tsx              # clock, KPIs, threat level, autopilot, settings
            ├── LeftPanel.tsx           # satellite details, passes, queued burns, bullseye
            ├── DeckGLMap.tsx           # view shell: 3D Earth / 2D map, toolbar, legend
            ├── EarthGlobe.tsx          # photorealistic 3D Earth (Three.js scene in lib/earthScene.ts)
            ├── RightPanel.tsx          # Fleet · Threats · Alerts · Score tabs
            ├── FleetPanel.tsx · ThreatsPanel.tsx · AlertsPanel.tsx · ScorecardPanel.tsx
            ├── ManualBurnModal.tsx     # RTN burn planner with live validation
            ├── ManeuverTimeline.tsx    # Gantt: burns, cooldowns, cancellation
            ├── ResourcesModal.tsx      # fuel / Δv charts and burn log
            ├── SettingsModal.tsx       # live simulation settings
            ├── SimulationControls.tsx  # run / step / speed / replay / export
            └── ui.tsx                  # shared UI primitives
```

---

## 🧠 Backend Architecture & Mathematical Foundations

The backend is engineered to handle high‑throughput telemetry and real‑time collision prediction. Propagation and collision screening run in a **C++20 extension** (`acm_engine`, pybind11 + OpenMP) that mutates the NumPy state buffers in place; if the extension is not built, an equivalent vectorised **NumPy fallback** is used automatically (`GET /health` reports which engine is active).

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

- **Coarse filter:** spatial hash grid (80 km cells, 5 s sub‑intervals) so only nearby pairs are tested.
- **Precise stage:** continuous collision detection – time of closest approach (TCA) for each candidate pair within the sub‑interval.

$$t_{CA} = -\frac{\Delta\vec{r} \cdot \Delta\vec{v}}{\|\Delta\vec{v}\|^2}$$

- **Collision threshold:** 100 m (reported as `collisions_detected`). The dashboard radar colours objects CRITICAL (<1 km), WARNING (<5 km), SAFE.

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

### 5. Autonomy loop (detect → decide → act → prove)

1. **Predict.** A background service screens the whole catalogue every `cdmScreenIntervalSeconds` of simulation time (default 600 s) over a **3‑hour look‑ahead** (1 h on the NumPy fallback). The engine finds every pair entering a 5 km sphere; each candidate is then refined with pair‑wise RK4 + linear CCD at 2 s resolution to obtain the true **TCA, miss distance, relative speed and approach angle**. Results become Conjunction Data Messages (CDMs) risk‑ranked CRITICAL (< 100 m), WARNING (< 1 km) or WATCH (< 5 km).
2. **Decide.** The autopilot (`acm/autopilot.py`) feeds open CDMs to `AutonomousBrain` using the selected **avoidance plugin** — `Auto` (transverse tri‑shunt unless the drift would leave the station‑keeping box, then radial), `TriShunt` or `RadialOverride`. It also plans **station‑keeping returns** (drift > 6 km) and **end‑of‑life graveyard** burns at the fuel threshold. Between screens the planner re‑runs every 20 s of simulation time, so burns are uplinked as soon as a threatened satellite enters ground contact.
3. **Act.** Every sequence passes the same validator as `POST /api/maneuver/schedule` (LOS, Δv limit, cooldown, Tsiolkovsky fuel) before it is queued; steps are split at burn epochs so each burn executes on time.
4. **Prove.** CDMs move through `ACTIVE → MITIGATED → CLEARED → RESOLVED | COLLIDED`; the event feed, the **mission scorecard** (`GET /api/metrics`: collisions avoided, fuel per avoidance, time‑weighted station‑keeping uptime) and the SQLite archive record the outcome.

Demo result (`scripts/demo.py`, 50 satellites, 10,000 debris, 6 planted 46–70 m threats): **6/6 avoided, 0 collisions, 0.37 kg propellant, 100 % uptime**. With the autopilot disabled, planted encounters collide (covered by the test suite).

---

## 🚀 Setup & Deployment

### 1. Backend (Python / FastAPI)

Backend dependencies are isolated in `backend/.venv` and never touch the system Python (use `./run.sh` from the repo root to set this up and start backend + frontend together automatically):

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
pip install .                      # optional: builds the C++ engine (needs a C++20 compiler)
uvicorn satellite_api.main:app --host 0.0.0.0 --port 8000
```

On macOS, `brew install libomp` enables multithreading in the C++ engine; without it the engine builds single‑threaded. If the extension isn't built, the NumPy fallback engine is used.

API interactive docs: http://localhost:8000/docs

### 2. Frontend (React / Vite)

```bash
cd frontend
npm install
npm run dev
```

Dashboard: http://localhost:3000 (the Vite dev server proxies `/api` to port 8000)

### 3. Demo mission (recommended)

```bash
./run.sh --demo                        # starts backend + dashboard, seeds the demo and runs it at 60×
# or, with services already running:
backend/.venv/bin/python backend/scripts/demo.py    # --no-step to seed only, --speed 120, --threats 8, --url http://host:8000
```

### 4. Real satellites in real time

```bash
./run.sh --live            # ISRO Earth-observation satellites + space stations vs. real debris fields, clock = real UTC
```

Or click **Load real satellites (live)** / **Data** in the dashboard. Element sets come from CelesTrak (NORAD GP data,
cached 2 h to respect its rate limits, last copy used when offline) and are propagated with SGP4 (TEME, rotated to
Earth-fixed with GMST like the rest of the engine; ISS position checked against an independent tracker to <1 km).
In live mode the backend steps the engine to "now" every second, re-anchors unmanoeuvred objects to SGP4 every
5 min (engine vs SGP4 drift ≈ 10 m over that interval), re-fetches elements every 2 h, and refines every
screened conjunction with SGP4 (J₂-only would drift 1–5 km over the 3 h horizon). Docked vehicles, which NORAD
publishes with their station's elements, are detected and excluded from collision checks. Burns planned by the
autopilot or operator are simulated; the real spacecraft are not commanded.

### 5. Inject Test Telemetry

While the backend is running:

```bash
backend/.venv/bin/python backend/test.py
```

This runs a 30‑day simulation with 50 satellites and 10,000 debris objects, logging evasions, fuel consumption, and drift peaks. Set `ACM_BASE_URL` to target another host.

---

## 🐳 Docker Deployment (Required by PS)

```bash
# Build image
docker build -t crimson-nebula:latest .

# Run container
docker run -d --name crimson-nebula -p 8000:8000 crimson-nebula:latest
```

The Dockerfile builds the frontend in a `node:22-alpine` stage, then uses `ubuntu:22.04` to compile the C++ engine and run Uvicorn on `0.0.0.0:8000`, which serves both the API and the dashboard (http://localhost:8000).

### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `API_KEY` | *(unset)* | When set, `/api/*` requires header `X-API-Key`. Build the dashboard with `VITE_API_KEY` to match. |
| `RATE_LIMIT_PER_MINUTE` | `0` (off) | Per‑IP request limit on `/api/*`. |
| `LOG_LEVEL` | `INFO` | Python log level. |
| `DATA_DIR` | `./data` | Location of `ground_stations.csv` and saved config. |
| `FRONTEND_DIST` | `frontend/dist` | Built dashboard served at `/` when present. |
| `AUTOPILOT` | `1` | Autonomous avoidance on/off (also switchable live in the dashboard). |
| `CDM_HORIZON_S` · `CDM_SCREEN_INTERVAL_S` · `CDM_WARNING_KM` | `10800` · `600` · `5` | Conjunction screening look‑ahead, cadence and warning radius. |
| `ACM_BACKGROUND` | `1` | Run the background screening/autopilot service. |
| `REDIS_URL` | *(unset)* | Use the Redis‑backed state manager (mission state restored after restarts). |
| `REDIS_SAVE_INTERVAL_S` | `10` | Redis snapshot cadence. |
| `ACM_ARCHIVE` · `ACM_DB_PATH` | `1` · `data/acm_archive.db` | SQLite archive of maneuvers and events. |
| `REALWORLD_FLEET` · `REALWORLD_OBJECTS` | *(unset)* | Comma-separated CelesTrak source keys loaded on startup (e.g. `isro-eo,stations` · `fengyun-1c-debris,cosmos-2251-debris`). |
| `REALWORLD_LIVE` · `REALWORLD_MAX_SATELLITES` · `REALWORLD_MAX_OBJECTS` | `1` · `60` · `5000` | Start in live mode; load limits. |
| `CELESTRAK_URL` · `SWPC_URL` | public endpoints | Override for a mirror or proxy. |

All spacecraft and screening parameters (dry mass, Δv limit, cooldown, box radius, thresholds, strategy) can also be changed at runtime from **Settings** in the dashboard (`POST /api/config`); they apply immediately and persist to `data/config.json`.

---

## 📡 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/telemetry` | POST | Ingest initial satellite/debris state vectors |
| `/api/maneuver/schedule` | POST | Schedule evasion/recovery burn (Δv, burn time) |
| `/api/simulate/step` | POST | Advance simulation by `step_seconds` |
| `/api/visualization/snapshot` | GET | Optimised snapshot for frontend (lat/lon/fuel); optional `bbox`, `per_page`, `page` |
| `/api/maneuvers` | GET | Pending, executed and rejected burns (`?satellite_id=&status=`) |
| `/api/maneuver/{burn_id}` | DELETE | Cancel a pending burn |
| `/api/stream/snapshot` | GET | Server‑Sent Events snapshot stream |
| `/api/export/czml` | GET | Predicted tracks in Cesium CZML (`?start=&end=&step_seconds=`) |
| `/api/conjunctions` | GET | Predicted conjunctions (CDMs) with TCA, miss distance, risk and status |
| `/api/conjunctions/screen` | POST | Run screening (and autopilot planning) now (`?horizon_s=&plan=`) |
| `/api/events` | GET | Operator event feed (`?after_id=`) |
| `/api/metrics` | GET | Mission scorecard: avoided, collisions, fuel, station‑keeping uptime |
| `/api/autopilot` | GET / PUT | Autopilot state and avoidance strategy |
| `/api/avoidance/strategies` | GET | Available avoidance plugins |
| `/api/satellites` | GET | Per‑satellite altitude, mode, drift, cooldown, contact and threat |
| `/api/satellites/{id}/track` | GET | Predicted ground track (`?minutes=&step_s=&model=J2\|J4\|J6`) |
| `/api/satellites/{id}/passes` | GET | Ground‑station contact windows (`?hours=`) |
| `/api/maneuver/manual` | POST | Plan (dry run) or schedule RTN/ECI burns with full validation |
| `/api/config` | GET / POST | Live simulation settings |
| `/api/archive/maneuvers` · `/api/archive/events` | GET | Persisted history (SQLite) |
| `/api/catalog/sources` | GET | CelesTrak sources that can be loaded (operated fleet / tracked objects) with cache state |
| `/api/catalog/load` | POST | Fetch element sets, propagate with SGP4, load into the engine (`fleet`, `objects`, `norad_ids`, limits, `replace`, `live`) |
| `/api/catalog/refresh` | POST | Re-fetch loaded element sets and re-anchor (fuel, burns and history kept) |
| `/api/catalog/status` | GET | Loaded counts, element-set ages, docked pairs, live clock lag, warnings |
| `/api/catalog/objects/{id}` | GET | NORAD id, COSPAR id, element-set epoch/age and orbital elements |
| `/api/live` | GET / PUT | Live mode: simulation time locked to real UTC (manual `/api/simulate/step` returns 409 while on) |
| `/api/space-weather` | GET | NOAA SWPC planetary Kp, F10.7 solar flux and G/S/R scales |
| `/health` | GET | Liveness + active physics engine |

Detailed schemas are available at `/docs` when the server is running.

---

## 🖥️ Frontend Visualisation Modules

| Module | Implementation |
|--------|----------------|
| **3D Earth / Ground Track Map** | Three.js Earth with NASA Blue Marble/Black Marble imagery, GEBCO relief, clouds, atmosphere and real sun lighting, streaming Esri imagery + terrain tiles when zoomed in (3D, real altitudes); Deck.gl + MapLibre (2D); trails, dashed predicted orbit, contact lines, threat rings |
| **Conjunction Bullseye** | Polar plot: radius = time to closest approach, angle = approach direction, colour = risk |
| **Resource Heatmaps** | Fleet fuel heatmap + per‑satellite propellant / Δv charts and burn log |
| **Maneuver Gantt** | Burns by type, cooldown bands, conflict detection, cancel queued burns |
| **Threats · Alerts · Score** | CDM table with response status, event feed with level filters, mission scorecard |
| **Operator tools** | RTN burn planner with live validation and orbit preview, autopilot switch, live settings, replay scrubber, CSV export |

---

## 🧪 Testing & Validation

- **Backend tests:** `pytest` — physics engines, gravity model, plugins, screening accuracy, CDM lifecycle, autopilot avoidance end to end, EOL, planner, config, Redis restore and SQLite archive.
- **Frontend unit tests:** `cd frontend && npm test` (Vitest).
- **End‑to‑end tests:** `cd frontend && npm run test:e2e` (Playwright starts its own backend + dashboard; `PW_CHANNEL=chrome` uses a local Chrome).
- **Stress test:** `test.py` runs a 30‑day simulation and reports fuel use, evasions, and drift.
- **Frontend performance:** Locked 60+ FPS on 50 satellites + 10,000 debris.

---

## 📄 License & Submission

This project is submitted for the **National Space Hackathon 2026** at IIT Delhi. All code is original and adheres to the competition’s rules and constraints.

---

**Built for reliability, performance, and physical accuracy.** 🚀