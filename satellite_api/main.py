import os
import sys
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, ORJSONResponse
from fastapi.middleware.cors import CORSMiddleware

from satellite_api.logging_config import setup_logging
from satellite_api.middleware.auth import API_KEY, RateLimitMiddleware

setup_logging()

# ─── Modular Routers ─────────────────────────────────────────────────────────
from satellite_api.routers import telemetry, simulation, visualization, maneuvers, maneuver_history, export
# ─── Global State Manager ────────────────────────────────────────────────────
from satellite_api.state import get_state

# ============================================================================
# APP INITIALIZATION
# ============================================================================

# Initialize FastAPI with ORJSON globally for blistering serialization speeds.
# This ensures every single endpoint defaults to the C-optimized JSON parser,
# completely bypassing standard Python JSON encoding overhead.
app = FastAPI(
    title="Autonomous Constellation Manager (NSH 2026)",
    description="High-performance SDA engine with zero-copy C++ physics integration.",
    version="1.0.0",
    default_response_class=ORJSONResponse
)

# ============================================================================
# MIDDLEWARE
# ============================================================================

# CORS Middleware: Absolutely critical for the frontend UI (Cesium/Three.js) 
# to communicate with the API without browser security blocks.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(RateLimitMiddleware, calls_per_minute=60)

@app.middleware("http")
async def authenticate(request: Request, call_next):
    if request.url.path.startswith("/api") and request.url.path != "/health":
        api_key = request.headers.get("X-API-Key")
        if not api_key or api_key != API_KEY:
            return JSONResponse(status_code=401, content={"detail": "Invalid or missing API Key"})
    return await call_next(request)

# ============================================================================
# GLOBAL STATE BINDING
# ============================================================================

# Attach the Redis State Manager to the app state.
from satellite_api.state_redis import RedisStateManager
app.state.orbital_state = RedisStateManager(redis_url=os.getenv("REDIS_URL", "redis://localhost:6379"))

# ============================================================================
# ROUTER MOUNTING
app.include_router(telemetry.router, tags=["Telemetry"])
app.include_router(simulation.router, tags=["Simulation"])
app.include_router(visualization.router, tags=["Visualization"])
app.include_router(maneuvers.router, tags=["Maneuvers"])
app.include_router(maneuver_history.router, tags=["Maneuvers"])
app.include_router(export.router, tags=["Export"])

# ============================================================================
# HEALTH PROBE
# ============================================================================
@app.get("/", tags=["Health"])
async def root():
    """Root liveness probe."""
    return {
        "status": "online",
        "system": "Autonomous Constellation Manager API v1.0",
        "engine_ready": app.state.orbital_state.is_ready()
    }

@app.get("/health", tags=["Health"])
async def health_check():
    """Dedicated endpoint for Docker HEALTHCHECK."""
    return {
        "status": "online",
        "engine_ready": app.state.orbital_state.is_ready()
    }

@app.post("/api/config", tags=["Admin"])
async def update_config(request: Request, config: dict):
    """Updates global simulation parameters."""
    import json
    with open("data/config.json", "w") as f:
        json.dump(config, f)
    # The simulation should pick up these changes on the next step or reload.
    return {"status": "ACK", "message": "Configuration saved to data/config.json"}