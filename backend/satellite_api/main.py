import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse
from fastapi.staticfiles import StaticFiles

from satellite_api.logging_config import setup_logging
from satellite_api.middleware.auth import APIKeyMiddleware, RateLimitMiddleware

setup_logging()

# ─── Modular Routers ─────────────────────────────────────────────────────────
from satellite_api.routers import telemetry, simulation, visualization, maneuvers, maneuver_history, export, operations, realworld
# ─── Global State Manager ────────────────────────────────────────────────────
from satellite_api.state import get_state
from satellite_api.state_redis import RedisStateManager
from satellite_api.physics_engine import ENGINE_NAME
from satellite_api.config import CONFIG, save_config
from satellite_api.db import MissionArchive, archive_enabled
from satellite_api.realworld.live import get_service as get_realworld_service

logger = logging.getLogger(__name__)


async def _autoload_catalog(service, conjunction_service):
    """REALWORLD_FLEET / REALWORLD_OBJECTS (comma-separated source keys) load real data on startup;
    REALWORLD_LIVE=0 keeps the clock paused afterwards. A mission restored from Redis is updated in place."""
    fleet = [k.strip() for k in os.environ.get("REALWORLD_FLEET", "").split(",") if k.strip()]
    if not fleet:
        return
    objects = [k.strip() for k in os.environ.get("REALWORLD_OBJECTS", "").split(",") if k.strip()]
    try:
        await service.load(fleet=fleet, objects=objects, norad_ids=[], replace=not service.state.is_ready(),
                           max_satellites=int(os.environ.get("REALWORLD_MAX_SATELLITES", "60")),
                           max_objects=int(os.environ.get("REALWORLD_MAX_OBJECTS", "5000")),
                           live=os.environ.get("REALWORLD_LIVE", "1") != "0", conjunction_service=conjunction_service)
        logger.info(f"Loaded real-world catalog on startup: fleet={fleet} objects={objects}")
    except Exception as e:  # never block startup on the network
        logger.error(f"Startup catalog load failed: {e}")


def _create_state():
    """Redis-backed state when REDIS_URL is set, otherwise the in-memory StateManager."""
    redis_url = os.environ.get("REDIS_URL", "").strip()
    if redis_url:
        try:
            return RedisStateManager(redis_url=redis_url)
        except RuntimeError as e:
            logger.error(f"{e}; falling back to in-memory state")
    return get_state()


@asynccontextmanager
async def lifespan(app: FastAPI):
    state = app.state.orbital_state
    if isinstance(state, RedisStateManager):
        try:
            await state.restore()
            state.start_autosave(float(os.environ.get("REDIS_SAVE_INTERVAL_S", "10")))
        except Exception as e:
            logger.error(f"Redis unavailable ({e}); continuing without persistence")
    if os.environ.get("ACM_BACKGROUND", "1") != "0":
        operations_service = operations.get_service_for_state(app, state)
        operations_service.start()
        live_service = get_realworld_service(app, state)
        live_service.start()
        await _autoload_catalog(live_service, operations_service)
    yield
    service = getattr(app.state, "conjunction_service", None)
    if service:
        await service.stop()
    live_service = getattr(app.state, "realworld", None)
    if live_service:
        await live_service.stop()
    if isinstance(state, RedisStateManager):
        await state.stop_autosave(final_save=True)
    archive = getattr(app.state, "archive", None)
    if archive:
        archive.close()

# ============================================================================
# APP INITIALIZATION
# ============================================================================

# ORJSON is the default response class for fast serialization of large snapshots.
app = FastAPI(
    title="Autonomous Constellation Manager (NSH 2026)",
    description="High-performance SDA engine with zero-copy C++ physics integration.",
    version="1.1.0",
    default_response_class=ORJSONResponse,
    lifespan=lifespan,
)

# ============================================================================
# MIDDLEWARE (last added = outermost; CORS must wrap auth so 401s carry CORS headers)
# ============================================================================
app.add_middleware(APIKeyMiddleware)
app.add_middleware(RateLimitMiddleware, calls_per_minute=int(os.environ.get("RATE_LIMIT_PER_MINUTE", "0") or 0))
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Total-Count", "X-Page", "X-Per-Page"],
)

# ============================================================================
# GLOBAL STATE BINDING
# ============================================================================
# Zero-copy state manager (run with a single uvicorn worker); Redis-backed when REDIS_URL is set.
app.state.orbital_state = _create_state()
app.state.archive = None
if archive_enabled():
    try:
        app.state.archive = MissionArchive().attach(app.state.orbital_state)
    except Exception as e:  # read-only filesystem etc.
        logger.warning(f"Mission archive disabled: {e}")

# ============================================================================
# ROUTER MOUNTING
# ============================================================================
app.include_router(telemetry.router, tags=["Telemetry"])
app.include_router(simulation.router, tags=["Simulation"])
app.include_router(visualization.router, tags=["Visualization"])
app.include_router(maneuvers.router, tags=["Maneuvers"])
app.include_router(maneuver_history.router, tags=["Maneuvers"])
app.include_router(export.router, tags=["Export"])
app.include_router(operations.router)
app.include_router(realworld.router)

# ============================================================================
# HEALTH PROBE
# ============================================================================
def _status():
    return {
        "status": "online",
        "system": "Autonomous Constellation Manager API v1.0",
        "engine": ENGINE_NAME,
        "engine_ready": app.state.orbital_state.is_ready(),
        "autopilot": CONFIG.autopilotEnabled,
        "persistence": "redis" if isinstance(app.state.orbital_state, RedisStateManager) else "memory",
        "archive": app.state.archive is not None,
        "live": bool(getattr(getattr(app.state, "realworld", None), "live", False)),
    }


@app.get("/health", tags=["Health"])
async def health_check():
    """Dedicated endpoint for Docker HEALTHCHECK."""
    return _status()


@app.get("/api/config", tags=["Admin"])
async def get_config():
    """Current live simulation configuration."""
    return CONFIG.to_dict()


@app.post("/api/config", tags=["Admin"])
async def update_config(config: dict):
    """Validates and applies configuration immediately (fuel model, cooldown, box radius, Δv limit,
    autopilot and screening parameters) and persists it to data/config.json."""
    try:
        CONFIG.update(config)
    except ValueError as e:
        return ORJSONResponse(status_code=422, content={"detail": str(e)})
    save_config(CONFIG)
    state = app.state.orbital_state
    async with state.lock:
        state.emit("info", "system", f"Configuration updated: {', '.join(sorted(config)) or 'no changes'}")
    return {"status": "ACK", "message": "Configuration applied and saved to config.json", "config": CONFIG.to_dict()}


# ============================================================================
# FRONTEND (optional): serve the built dashboard from the same port
# ============================================================================
_frontend_dist = Path(os.environ.get("FRONTEND_DIST", Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"))
if (_frontend_dist / "index.html").is_file():
    app.mount("/", StaticFiles(directory=_frontend_dist, html=True), name="frontend")
else:
    @app.get("/", tags=["Health"])
    async def root():
        """Root liveness probe (used when no frontend build is present)."""
        return _status()
