# Crimson Nebula – User Manual

## 1. Prerequisites
- Docker (20.10+)
- Node.js 22+
- Python 3.11+
- Modern browser (Chrome, Firefox, Edge)

## 2. Quick Start
### Start Backend (Docker)
```bash
docker build -t crimson-nebula .
docker run -d -p 8000:8000 --name nebula crimson-nebula
```

### Start Frontend
```bash
cd frontend
npm install
npm run dev
```

### Inject Test Data
```bash
python test.py
```

Open http://localhost:3000

## 3. Using the Dashboard
- **Satellite Cards**: Click to select, view fuel, status. Click METRICS for Δv history, GANTT for maneuver timeline.
- **Bullseye Radar**: Shows nearby debris threats (distance, TCA). Red = critical (<1km).
- **Time Controls**: Pause, step, change speed (1×, 10×, 60×).
- **Export Data**: Click "Export CSV" to download satellite positions.

## 4. API Examples
### Get snapshot with bounding box
```bash
curl "http://localhost:8000/api/visualization/snapshot?bbox=-180,-90,180,90&per_page=1000"
```

### Schedule a burn (immediate)
```bash
curl -X POST http://localhost:8000/api/maneuver/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "satelliteId": "SAT-001",
    "maneuver_sequence": [{
      "burn_id": "burn1",
      "burnTime": "2026-01-01T00:00:15.000Z",
      "deltaV_vector": {"x":0,"y":0.0075,"z":0}
    }]
  }'
```

## 5. Troubleshooting
| Issue | Solution |
|-------|----------|
| Engine not ready | Run `test.py` to send initial telemetry. |
| Port conflict | Change port in `docker run -p 8001:8000`. |
| WebGL errors | Update browser, ensure hardware acceleration enabled. |

## 6. Advanced Configuration
- **Environment variables**: `API_KEY`, `REDIS_URL`, `LOG_LEVEL`.
- **Ground stations**: Edit `data/ground_stations.csv`.
