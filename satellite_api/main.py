from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse

# ─── Modular Routers ─────────────────────────────────────────────────────────
from satellite_api.routers import telemetry, simulation, visualization, maneuvers
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
    allow_origins=["*"],  # Open for hackathon rapid development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================================
# GLOBAL STATE BINDING
# ============================================================================

# Attach the Singleton State Manager to the app state.
# This guarantees that all routers safely access the exact same memory buffers
# and threaded locks without instantiating duplicate memory allocations.
app.state.orbital_state = get_state()

# ============================================================================
# ROUTER MOUNTING
app.include_router(telemetry.router, tags=["Telemetry"])
app.include_router(simulation.router, tags=["Simulation"])
app.include_router(visualization.router, tags=["Visualization"])
app.include_router(maneuvers.router, tags=["Maneuvers"])

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