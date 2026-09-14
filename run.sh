#!/bin/bash
# Crimson Nebula - Local Development Launcher
#   ./run.sh           start backend (:8000) and dashboard (:3000)
#   ./run.sh --demo    also seed the demo mission and run the simulation (autopilot avoids planted threats)
#   ./run.sh --live    load real satellites and debris from CelesTrak and track them in real time (needs internet)
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

DEMO=0
LIVE=0
for arg in "$@"; do
    case "$arg" in
        --demo) DEMO=1 ;;
        --live) LIVE=1 ;;
        -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg (use --demo, --live or --help)"; exit 1 ;;
    esac
done

echo "🛰️  Starting Crimson Nebula on macOS..."

# Check Python dependencies
python3 -c "import fastapi, uvicorn, numpy, pydantic, pythonjsonlogger, orjson, sgp4" 2>/dev/null || {
    echo "📦 Installing required Python dependencies..."
    pip3 install -r requirements.txt
}

# Check if C++ native engine is built, if not compile it
python3 -c "import acm_engine; getattr(acm_engine, 'process_conjunctions')" 2>/dev/null || {
    echo "⚙️  Building native C++ physics engine (acm_engine)..."
    python3 setup.py build_ext --inplace || echo "⚠️ C++ build skipped, will use high-speed NumPy fallback."
}

# Demo mode needs `requests`; the dashboard needs node_modules
if [ "$DEMO" = "1" ]; then
    python3 -c "import requests" 2>/dev/null || pip3 install requests
fi
[ -d frontend/node_modules ] || { echo "📦 Installing frontend dependencies..."; (cd frontend && npm install); }

# Trap to kill all child background processes on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down Crimson Nebula services..."
    kill $(jobs -p) 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# 1. Start Backend
echo "🚀 Starting Backend on http://localhost:8000 ..."
if [ "$LIVE" = "1" ]; then
    export REALWORLD_FLEET="${REALWORLD_FLEET:-isro-eo,stations}"
    export REALWORLD_OBJECTS="${REALWORLD_OBJECTS:-fengyun-1c-debris,cosmos-2251-debris,iridium-33-debris}"
fi
python3 -m uvicorn satellite_api.main:app --host 127.0.0.1 --port 8000 &
BACKEND_PID=$!

# Wait for backend to be healthy
for _ in $(seq 1 60); do
    curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1 && break
    sleep 0.5
done

# 2. Start Frontend Dev Server
echo "💻 Starting Frontend on http://localhost:3000 ..."
(cd frontend && npm run dev) &
FRONTEND_PID=$!

echo ""
echo "=========================================================="
echo "✅ Crimson Nebula is running!"
echo "   - Web Dashboard:     http://localhost:3000"
echo "   - Backend API Docs:  http://localhost:8000/docs"
echo "   - Health Endpoint:   http://localhost:8000/health"
echo ""
if [ "$DEMO" = "1" ]; then
    echo "🎬 Demo mode: seeding 50 satellites, 10,000 debris and planted threats..."
elif [ "$LIVE" = "1" ]; then
    echo "🛰️  Live mode: real satellites ($REALWORLD_FLEET) tracked in real time against real debris"
else
    echo "📡 To populate the simulation:"
    echo "   Real satellites, real time: ./run.sh --live   or the dashboard's \"Load real satellites\" button"
    echo "   Demo mission (autopilot):   ./run.sh --demo   or   python3 scripts/demo.py"
    echo "   30-day stress test:         python3 test.py"
fi
echo "=========================================================="
echo "Press Ctrl+C to stop all services."
echo ""

if [ "$DEMO" = "1" ]; then
    python3 scripts/demo.py --url http://127.0.0.1:8000 &
fi

wait
