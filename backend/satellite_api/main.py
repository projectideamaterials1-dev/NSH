import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse
from fastapi.staticfiles import StaticFiles

from satellite_api.logging_config import setup_logging
from satellite_api.middleware.auth import APIKeyMiddleware, LeaderGateMiddleware, RateLimitMiddleware

setup_logging()

# ─── Modular Routers ─────────────────────────────────────────────────────────
from satellite_api.routers import telemetry, simulation, visualization, maneuvers, maneuver_history, export, operations, realworld
# ─── Global State Manager ────────────────────────────────────────────────────
from satellite_api.state import get_state
from satellite_api.state_redis import RedisStateManager
from satellite_api.physics_engine import ENGINE_NAME, engine_info
from satellite_api.config import CONFIG, save_config
from satellite_api.db import MissionArchive, archive_enabled
from satellite_api.realworld.live import get_service as get_realworld_service
from satellite_api import observability
from satellite_api.audit import AUDIT
from satellite_api.feed_health import FeedMonitor, assess as assess_feeds

logger = logging.getLogger(__name__)


async def _autoload_catalog(service, conjunction_service):
    """REALWORLD_FLEET / REALWORLD_OBJECTS (comma-separated source keys) load real data on startup;
    REALWORLD_LIVE=0 keeps the clock paused afterwards. A mission restored from Redis is updated in place,
    keeping the fleet size last chosen in the dashboard (POST /api/catalog/resize)."""
    fleet = [k.strip() for k in os.environ.get("REALWORLD_FLEET", "").split(",") if k.strip()]
    if not fleet:
        return
    objects = [k.strip() for k in os.environ.get("REALWORLD_OBJECTS", "").split(",") if k.strip()]
    restored = service.state.is_ready()
    max_satellites = (restored and service.restored_max_satellites) or int(os.environ.get("REALWORLD_MAX_SATELLITES", "60"))
    try:
        await service.load(fleet=fleet, objects=objects, norad_ids=[], replace=not restored,
                           max_satellites=max_satellites,
                           max_objects=int(os.environ.get("REALWORLD_MAX_OBJECTS", "5000")),
                           live=os.environ.get("REALWORLD_LIVE", "1") != "0", conjunction_service=conjunction_service)
        logger.info(f"Loaded real-world catalog on startup: fleet={fleet} objects={objects}")
    except Exception as e:  # never block startup on the network
        logger.error(f"Startup catalog load failed: {e}")


def _require_durable_state() -> bool:
    return os.environ.get("REQUIRE_DURABLE_STATE", "0").strip().lower() not in ("0", "", "false", "off", "no")


def _create_state():
    """Redis-backed state when REDIS_URL or REDIS_SENTINELS is set, otherwise the in-memory StateManager.

    REQUIRE_DURABLE_STATE=1 makes an unavailable/misconfigured Redis a hard startup failure
    instead of a silent fallback to in-memory state - for a system that can command real
    maneuvers, losing durability unnoticed is worse than refusing to start.
    """
    from satellite_api import redis_conn
    redis_url = os.environ.get("REDIS_URL", "").strip()
    if redis_conn.configured():
        try:
            # REDIS_SENTINELS (HA) takes precedence over REDIS_URL - see redis_conn.py.
            client = redis_conn.async_client() if redis_conn.sentinel_hosts() else None
            return RedisStateManager(redis_url=redis_url or redis_conn.describe(), client=client)
        except RuntimeError as e:
            if _require_durable_state():
                raise RuntimeError(f"REQUIRE_DURABLE_STATE is set but Redis state init failed: {e}") from e
            logger.error(f"{e}; falling back to in-memory state")
    elif _require_durable_state():
        raise RuntimeError("REQUIRE_DURABLE_STATE is set but REDIS_URL is not configured")
    return get_state()


@asynccontextmanager
async def lifespan(app: FastAPI):
    state = app.state.orbital_state
    operations_service = None
    live_service = None
    background_enabled = os.environ.get("ACM_BACKGROUND", "1") != "0"
    feed_monitor = FeedMonitor(app) if background_enabled else None
    app.state.feed_monitor = feed_monitor
    if background_enabled:
        # Created before restore() so the autopilot's planner-lock snapshot hook (registered
        # below) is in place in time to be populated by the restore itself.
        operations_service = operations.get_service_for_state(app, state)
        live_service = get_realworld_service(app, state)
    if isinstance(state, RedisStateManager):
        if operations_service is not None:
            state.register_snapshot_hook(
                "autopilot_brain", operations_service.autopilot.snapshot_brain, operations_service.autopilot.restore_brain
            )
            state.register_snapshot_hook("realworld_settings", live_service.snapshot_settings, live_service.restore_settings)
        try:
            await state.restore()
            state.start_autosave(float(os.environ.get("REDIS_SAVE_INTERVAL_S", "10")))
        except Exception as e:
            if _require_durable_state():
                raise RuntimeError(f"REQUIRE_DURABLE_STATE is set but Redis restore/autosave failed: {e}") from e
            logger.error(f"Redis unavailable ({e}); continuing without persistence")
        if operations_service is not None:
            # Multiple replicas may point at the same Redis; only the elected leader may run
            # the autopilot/screening loops (see state_redis.py) - every other replica keeps
            # serving reads from the shared, Redis-backed state but must not plan/schedule burns.
            async def _on_gain():
                operations_service.start()
                live_service.start()
                feed_monitor.start()
                await _autoload_catalog(live_service, operations_service)

            async def _on_lose():
                await operations_service.stop()
                await live_service.stop()
                await feed_monitor.stop()

            state.start_leader_election(
                ttl_s=float(os.environ.get("LEADER_LOCK_TTL_S", "15")),
                interval_s=float(os.environ.get("LEADER_RENEW_INTERVAL_S", "5")),
                on_gain=_on_gain, on_lose=_on_lose,
            )
    elif operations_service is not None:
        # No shared state across processes is possible without Redis, so a single in-memory
        # instance is always safe to run its own loops directly (no leader election needed).
        operations_service.start()
        live_service.start()
        feed_monitor.start()
        await _autoload_catalog(live_service, operations_service)
    yield
    if feed_monitor:
        await feed_monitor.stop()
    service = getattr(app.state, "conjunction_service", None)
    if service:
        await service.stop()
    live_service = getattr(app.state, "realworld", None)
    if live_service:
        await live_service.stop()
    if isinstance(state, RedisStateManager):
        await state.stop_leader_election()
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
# ALLOWED_ORIGINS unset -> same-origin only (the bundled dashboard is served from this same
# port/origin, so it needs no CORS grant at all); set it to a comma-separated allow-list for
# a dashboard hosted on a different origin. "*" is intentionally not a supported value here -
# combined with the X-API-Key header this app authenticates with, a wildcard origin would let
# any third-party page drive every /api/* endpoint (including maneuver commands) from a
# victim's browser if that browser happens to have the key cached/embedded anywhere reachable.
_allowed_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]

# Innermost: checked last, only for requests that already passed auth/rate-limit.
app.add_middleware(LeaderGateMiddleware, get_state=lambda: app.state.orbital_state)
app.add_middleware(APIKeyMiddleware)
app.add_middleware(RateLimitMiddleware, calls_per_minute=int(os.environ.get("RATE_LIMIT_PER_MINUTE", "0") or 0))
if _allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_allowed_origins,
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
app.state.unreconciled_maneuvers = []
if archive_enabled():
    try:
        app.state.archive = MissionArchive().attach(app.state.orbital_state)
        AUDIT.sinks.append(lambda entry: app.state.archive.handle("audit", entry))
        app.state.unreconciled_maneuvers = app.state.archive.reconcile_on_startup()
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
observability.install(app)

# ============================================================================
# HEALTH PROBE
# ============================================================================
def _redis_mode():
    from satellite_api import redis_conn
    return redis_conn.describe() if isinstance(app.state.orbital_state, RedisStateManager) else None


def _status():
    return {
        "status": "online",
        "system": "Autonomous Constellation Manager API v1.0",
        "engine": ENGINE_NAME,
        "gpu": engine_info()["gpu"],
        "engine_ready": app.state.orbital_state.is_ready(),
        "autopilot": CONFIG.autopilotEnabled,
        "persistence": "redis" if isinstance(app.state.orbital_state, RedisStateManager) else "memory",
        "redis": _redis_mode(),
        "is_leader": (app.state.orbital_state.is_leader if isinstance(app.state.orbital_state, RedisStateManager)
                     else True),
        "archive": app.state.archive is not None,
        "live": bool(getattr(getattr(app.state, "realworld", None), "live", False)),
        "unreconciled_maneuvers": len(getattr(app.state, "unreconciled_maneuvers", [])),
        "feeds": {name: info["status"] for name, info in assess_feeds(getattr(app.state, "realworld", None)).items()},
    }


@app.get("/api/audit", tags=["Admin"])
async def audit_trail(request: Request, actor: Optional[str] = None, limit: int = 200):
    """Who changed what: mutating requests and rejected keys (operator role only)."""
    if getattr(request.state, "role", "operator") != "operator":
        return ORJSONResponse(status_code=403, content={"detail": "The audit trail requires an operator key"})
    limit = max(1, min(limit, 2000))
    archive = app.state.archive
    if archive is not None:
        archive.flush(timeout=2.0)
        return {"source": "archive", "entries": await asyncio.to_thread(archive.audit, actor, limit)}
    return {"source": "memory", "entries": AUDIT.recent(limit, actor)}


@app.get("/api/feeds", tags=["Health"])
async def data_feeds():
    """Status of the external data feeds (CelesTrak element sets, NOAA space weather)."""
    return assess_feeds(getattr(app.state, "realworld", None))


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
