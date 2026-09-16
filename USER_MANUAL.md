# Crimson Nebula – User Manual

## 1. Prerequisites
- Docker (20.10+) — or Python 3.10+ for running the backend directly
- Node.js 22+ (only for frontend development)
- Modern browser with WebGL (Chrome, Firefox, Edge)

## 2. Quick Start
### Option A: One command (local)
```bash
./run.sh --demo
```
Starts the backend (:8000) and dashboard (:3000), seeds 50 satellites, 10,000 debris and a handful of
planted collision threats, and runs the simulation at 60×. Open http://localhost:3000 and watch the
autopilot detect and avoid the threats. Use `./run.sh` without `--demo` to start with an empty sky.

Use `./run.sh --live` instead to track **real satellites in real time**: ISRO Earth-observation satellites and
the space stations, screened against real debris fields (needs internet; see *Real-world data* below).

### Option B: Docker (API + dashboard on one port)
```bash
docker build -t crimson-nebula .
docker run -d -p 8000:8000 --name nebula crimson-nebula
backend/.venv/bin/python backend/scripts/demo.py --url http://localhost:8000
```
Open http://localhost:8000. For persistence across restarts use `docker compose -f docker-compose.prod.yml up`
(adds Redis snapshots and keeps the SQLite archive in `./backend/data`).

### Option C: Manual development setup
Backend dependencies are isolated in `backend/.venv` (never installed globally):
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt && pip install .
uvicorn satellite_api.main:app --port 8000
cd ../frontend && npm install && npm run dev          # second terminal
cd ../backend && python scripts/demo.py               # third terminal (or python test.py)
```

## 3. Using the Dashboard

### Header
- **Simulation time (UTC)** and mission KPIs: satellites, open threats, station-keeping (SK) uptime,
  collisions avoided and collisions.
- **Threat level**: Low / Guarded / Elevated / Severe, derived from open conjunctions and collisions.
- **Autopilot switch**: when on, avoidance, station-keeping return and end-of-life burns are planned and
  scheduled automatically; when off, threats are only reported.
- **Settings** (gear): dry mass, Δv limit, cooldown, station-keeping box, fuel thresholds, avoidance strategy
  and screening parameters. Changes apply immediately and are saved.
- **Link status**: Live (with latency), No telemetry, or Link error.

### Map (centre)
- **3D Earth** (default) / **2D map** toggle. The 3D Earth is a photorealistic globe (NASA Blue Marble imagery,
  city lights on the night side, terrain relief, clouds and atmosphere) lit by the real sun position for the
  simulation time; satellites and debris are drawn at their real altitude.
- 3D controls: drag to rotate, scroll to zoom. Zooming in streams high-resolution satellite imagery and terrain
  relief (needs internet; offline, the bundled imagery is used). **Clouds** toggles the cloud layer (clouds also
  fade out automatically close to the surface).
- Click a satellite to select it; **Follow** keeps the camera on it; **World / Reset** re-frames the view.
- Selected satellite: blue trail (history), dashed white line (predicted next orbit), green lines to ground
  stations currently in contact. Red/amber rings mark satellites with critical/warning conjunctions.
- Orange dots are executed burns; the night side is shaded on the 2D map and unlit (city lights) on the 3D Earth.

### Left panel – Satellite
- Propellant, position, altitude, drift from the nominal slot, cooldown and total Δv.
- **Ground contact**: whether the satellite can be commanded now, and the next passes (station, time until,
  duration, maximum elevation).
- **Queued burns** with **Cancel**.
- **Burn**: plan a manual burn (prograde/retrograde/radial/normal presets or custom RTN components, execution
  time). Every rule is checked live — contact, Δv limit, cooldown, propellant — and the resulting perigee,
  apogee, period and inclination are shown before you schedule it.
- **Fuel**: propellant and cumulative Δv chart with the burn log. **Plan**: maneuver timeline.
- **Conjunction bullseye**: distance from the centre is time to closest approach (15 min / 1 h / 3 h rings),
  angle is the direction the object approaches from, colour is risk; a white outline means avoidance is
  planned. With no satellite selected it shows the whole fleet.

### Right panel
- **Fleet**: search, sort (priority, threat, fuel, ID), mode (Evading / Recovering / Burn queued / Retired),
  contact indicator and fuel; switch to the **fuel heatmap** grid.
- **Threats**: predicted conjunctions — risk, miss distance, TCA and time remaining, relative speed and
  response (Monitoring, Avoidance planned, Cleared). **Screen now** runs screening immediately.
- **Alerts**: event feed (critical, warning, resolved, info) — detections, burns, rejections, fuel,
  station-keeping and end-of-life events. Click a satellite ID to select it.
- **Score**: collisions avoided, safety rate, avoidance burns, propellant used, fuel per avoidance,
  time-weighted station-keeping uptime and conjunction counts.

### Bottom bar
- **Run / Pause**, **+60 s** step and **speed** (1×, 10×, 60×, 600× simulated seconds per second).
  Don't run these while `test.py` or `scripts/demo.py` is also stepping the simulation.
- **Replay scrubber**: drag back through recently received snapshots; **Live** (or *Back to live*) returns.
- **Timeline**: Gantt chart of burns by type with cooldown bands, conflicts and cancellation.
- **CSV**: download current satellite positions, altitude, fuel, mode, drift and contact.
- **Live UTC**: lock simulation time to real UTC (Run, +60 s and speed are disabled while it is on).
- **Data**: the *Real-world data* dialog.

### Real-world data
- **Load real satellites (live)** on the empty globe, or **Data** in the bottom bar, loads NORAD element sets from
  CelesTrak and propagates them with SGP4. Choose the **operated fleet** (ISRO Earth observation, space stations,
  Planet, OneWeb, Starlink, GPS, weather, Earth resources, science, or NORAD numbers) and the **tracked objects**
  they are screened against (Fengyun-1C, Cosmos 2251, Iridium 33, Cosmos 1408 debris, recent launches).
- Fleet satellites get simulated propellant, station-keeping slots and autopilot avoidance, exactly like
  simulated ones. Burns are simulated only; a satellite that burns follows its simulated orbit from then on.
- The dialog shows element-set age, the next refresh (every 2 h), live status and NOAA space weather (Kp, F10.7,
  G/S/R scales). Selecting a real satellite adds a **Catalog** card (NORAD/COSPAR ids, orbit, element-set age).
- Conjunctions from real data are refined with SGP4. Vehicles docked to a station share its orbit and are not
  reported as collisions.

## 4. API Examples
### Snapshot with bounding box (full debris cloud by default)
```bash
curl "http://localhost:8000/api/visualization/snapshot?bbox=-180,-90,180,90"
```

### Real satellites in real time
```bash
curl "http://localhost:8000/api/catalog/sources"
curl -X POST http://localhost:8000/api/catalog/load -H "Content-Type: application/json" \
  -d '{"fleet": ["isro-eo", "stations"], "objects": ["fengyun-1c-debris", "cosmos-2251-debris"], "norad_ids": [25544], "live": true}'
curl "http://localhost:8000/api/catalog/objects/ISS%20(ZARYA)"
curl -X PUT http://localhost:8000/api/live -H "Content-Type: application/json" -d '{"enabled": false}'
curl  http://localhost:8000/api/space-weather
```

### Predicted conjunctions and mission scorecard
```bash
curl "http://localhost:8000/api/conjunctions?status=open"
curl -X POST "http://localhost:8000/api/conjunctions/screen?horizon_s=10800"
curl  http://localhost:8000/api/metrics
```

### Schedule a burn (PS format; requires ground-station contact)
```bash
curl -X POST http://localhost:8000/api/maneuver/schedule \
  -H "Content-Type: application/json" \
  -d '{"satelliteId": "SAT-001", "maneuver_sequence": [{"burn_id": "burn1",
       "burnTime": "2026-01-01T00:00:15.000Z", "deltaV_vector": {"x":0,"y":0.0075,"z":0}}]}'
```

### Preview a 1 m/s prograde burn in 60 s (RTN frame), then schedule it
```bash
curl -X POST http://localhost:8000/api/maneuver/manual -H "Content-Type: application/json" \
  -d '{"satelliteId": "SAT-001", "burns": [{"offset_s": 60, "frame": "RTN", "dv_mps": {"t": 1.0}}], "dry_run": true}'
# repeat with "dry_run": false to queue it
```

### Autopilot, passes, predicted track, cancel
```bash
curl -X PUT http://localhost:8000/api/autopilot -H "Content-Type: application/json" -d '{"enabled": true, "strategy": "TriShunt"}'
curl "http://localhost:8000/api/satellites/SAT-001/passes?hours=6"
curl "http://localhost:8000/api/satellites/SAT-001/track?minutes=95&model=J4"
curl -X DELETE http://localhost:8000/api/maneuver/burn1
```

## 5. Troubleshooting
| Issue | Solution |
|-------|----------|
| "Waiting for telemetry" / "No telemetry" | Click **Load real satellites (live)**, or run `./run.sh --live`, `./run.sh --demo`, `backend/.venv/bin/python backend/scripts/demo.py` or `backend/.venv/bin/python backend/test.py`. |
| Real data fails to load (502) | CelesTrak is unreachable and nothing is cached yet; check internet access or set `CELESTRAK_URL`. Cached data is used automatically when available. |
| `409` from `/api/simulate/step` | Live mode is on; turn off **Live UTC** (or `PUT /api/live {"enabled": false}`) to step manually. |
| `REJECTED: NO_LINE_OF_SIGHT` | The satellite is not visible from any ground station; check its next pass in the Satellite panel. |
| A threat stays "Monitoring" | The autopilot acts on predicted misses under 150 m; wider conjunctions are watched. |
| No avoidance happened | Autopilot switched off, or the satellite had no ground contact before closest approach. |
| Port conflict | Change port in `docker run -p 8001:8000`. |
| 401 Invalid or missing API Key | The backend has `API_KEY` set; send `X-API-Key` (and build the dashboard with `VITE_API_KEY`). |
| WebGL errors / blank map | Update the browser and enable hardware acceleration. |

## 6. Advanced Configuration
- **Environment variables**: `API_KEY`, `RATE_LIMIT_PER_MINUTE`, `LOG_LEVEL`, `DATA_DIR`, `FRONTEND_DIST`,
  `AUTOPILOT`, `CDM_HORIZON_S`, `CDM_SCREEN_INTERVAL_S`, `CDM_WARNING_KM`, `ACM_BACKGROUND`,
  `REDIS_URL`, `REDIS_SAVE_INTERVAL_S`, `ACM_ARCHIVE`, `ACM_DB_PATH`, `REALWORLD_FLEET`, `REALWORLD_OBJECTS`,
  `REALWORLD_LIVE`, `REALWORLD_MAX_SATELLITES`, `REALWORLD_MAX_OBJECTS`, `CELESTRAK_URL`, `SWPC_URL`.
- **Ground stations**: Edit `data/ground_stations.csv` (restart the backend to reload).
- **Gravity model for predictions**: `model=J2|J4|J6` on the track endpoint; `satellite_api.gravity.GravityModel`
  also loads EGM-style coefficient files.
- **Tests**: `pytest` (backend), `cd frontend && npm test` (unit), `npm run test:e2e` (end to end).
