"""
observability.py
----------------
Prometheus metrics at GET /metrics (text exposition format).

* Request metrics come from a middleware: count and latency by method, route template and
  status class.
* Event metrics are recorded where things happen (screening-cycle duration histogram).
* Mission state is read from the live StateManager at scrape time by a custom collector, so
  gauges are always current and never double-count: fleet size, open conjunctions by risk,
  collisions, propellant, station-keeping uptime, screening health, pending proposals, feed
  health and leadership.

/metrics is outside /api, so the API-key middleware does not cover it. Set METRICS_TOKEN to
require `Authorization: Bearer <token>` (Prometheus `authorization:` scrape setting); nginx.conf
also refuses /metrics from outside the compose network.
"""
import hmac
import os
import time
from pathlib import Path
from typing import Iterable

from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Histogram, generate_latest
from prometheus_client.core import GaugeMetricFamily, CounterMetricFamily
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

REGISTRY = CollectorRegistry()

HTTP_REQUESTS = Counter("acm_http_requests_total", "HTTP requests", ["method", "route", "status"], registry=REGISTRY)
HTTP_LATENCY = Histogram("acm_http_request_duration_seconds", "HTTP request latency", ["method", "route"],
                         buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10), registry=REGISTRY)
SCREEN_DURATION = Histogram("acm_screen_duration_seconds", "Conjunction screening cycle wall time",
                            buckets=(0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300), registry=REGISTRY)


def _route(request: Request) -> str:
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    if path:
        return path
    return "static" if not request.url.path.startswith("/api") else "unmatched"


class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        start = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            route = _route(request)
            if route != "/metrics":
                HTTP_REQUESTS.labels(request.method, route, f"{status // 100}xx").inc()
                HTTP_LATENCY.labels(request.method, route).observe(time.perf_counter() - start)


def _backup_status():
    """Status written by the scheduled backup service (scripts/backup.py schedule) on the shared volume."""
    from satellite_api.backup import read_status
    from satellite_api.timeutils import data_dir
    return read_status(Path(os.environ.get("BACKUP_DIR") or data_dir() / "backups"))


class MissionCollector:
    """Reads the live state at scrape time (no lock: a scrape tolerates a torn read of counters)."""

    def __init__(self, app):
        self.app = app

    def collect(self) -> Iterable:
        from satellite_api.feed_health import STATUS_RANK, assess
        from satellite_api.physics_engine import ENGINE_NAME, drag_settings, engine_info

        state = self.app.state.orbital_state

        def gauge(name, doc, value, labels=None):
            g = GaugeMetricFamily(name, doc, labels=list(labels or {}))
            g.add_metric(list((labels or {}).values()), float(value))
            return g

        yield gauge("acm_info", "Engine build info", 1, {"engine": ENGINE_NAME, "gpu": engine_info()["gpu"] or "none"})
        yield gauge("acm_is_leader", "1 if this replica runs the autopilot loops", float(getattr(state, "is_leader", True)))
        yield gauge("acm_satellites", "Tracked satellites", state.sat_count)
        yield gauge("acm_debris_objects", "Tracked debris / other objects", state.debris_count)
        if state.current_time is not None:
            yield gauge("acm_sim_time_seconds", "Simulation clock (POSIX seconds)", state.now_ts)

        counts = state.cdms.counts()
        open_cdm = GaugeMetricFamily("acm_conjunctions_open", "Open conjunctions by risk", labels=["risk"])
        for risk, n in counts["open_by_risk"].items():
            open_cdm.add_metric([risk], n)
        yield open_cdm
        yield CounterMetricFamily("acm_collisions", "Collisions detected", value=state.total_collisions)
        yield CounterMetricFamily("acm_collisions_avoided", "Threats passed safely after avoidance", value=counts["avoided"])
        yield CounterMetricFamily("acm_burns_executed", "Burns executed", value=state.burns_executed)
        yield CounterMetricFamily("acm_burns_rejected", "Burns rejected at execution", value=state.burns_rejected)
        yield CounterMetricFamily("acm_fuel_used_kg", "Propellant consumed", value=state.total_fuel_used_kg)
        n = state.sat_count
        if n:
            yield gauge("acm_fuel_min_kg", "Lowest propellant in the fleet", float(state.sat_fuel[:n].min()))
        sk = state.station_keeping_summary()
        yield gauge("acm_station_keeping_uptime_ratio", "Time-weighted share inside the box",
                    sk.get("time_weighted_uptime_percentage", 0.0) / 100.0)
        yield gauge("acm_maneuvers_queued", "Burns waiting to execute", len(state.maneuver_queue))
        proposals = getattr(state, "proposals", {})
        yield gauge("acm_proposals_pending", "Maneuver proposals awaiting an operator",
                    sum(1 for p in proposals.values() if p["status"] == "PENDING"))

        screen = state.last_screen or {}
        if screen:
            yield gauge("acm_screen_last_duration_seconds", "Duration of the last screening cycle", screen.get("duration_s", 0))
            yield gauge("acm_screen_overrun_ratio", "Last screen duration / screening cadence", screen.get("overrun_ratio", 0))
            yield gauge("acm_screen_falling_behind", "1 while screening is over budget", float(bool(screen.get("falling_behind"))))

        drag = drag_settings()
        yield gauge("acm_drag_density_scale", "Atmospheric density multiplier from space weather", drag["scale"])

        feeds = assess(getattr(self.app.state, "realworld", None))
        status = GaugeMetricFamily("acm_feed_status", "Feed status: 0 ok/idle, 1 degraded, 2 stale, 3 error", labels=["feed"])
        age = GaugeMetricFamily("acm_feed_age_seconds", "Seconds since the feed last fetched successfully", labels=["feed"])
        for name, info in feeds.items():
            status.add_metric([name], STATUS_RANK[info["status"]])
            if info.get("age_s") is not None:
                age.add_metric([name], info["age_s"])
        yield status
        yield age
        backup = _backup_status()
        if backup is not None:
            yield gauge("acm_backup_last_ok", "1 if the most recent scheduled backup succeeded", float(bool(backup.get("ok"))))
            last = backup.get("last_success")
            if last:
                from datetime import datetime
                yield gauge("acm_backup_last_success_timestamp_seconds", "When the last good scheduled backup finished",
                            datetime.fromisoformat(last).timestamp())
        yield gauge("acm_unreconciled_maneuvers", "Pending maneuvers without a recorded outcome after a crash",
                    len(getattr(self.app.state, "unreconciled_maneuvers", [])))


def install(app) -> None:
    REGISTRY.register(MissionCollector(app))
    app.add_middleware(MetricsMiddleware)

    @app.get("/metrics", include_in_schema=False)
    async def metrics(request: Request) -> Response:
        token = os.environ.get("METRICS_TOKEN", "")
        if token:
            supplied = request.headers.get("Authorization", "")
            if not hmac.compare_digest(supplied.encode(), f"Bearer {token}".encode()):
                return Response("Unauthorized", status_code=401, headers={"WWW-Authenticate": "Bearer"})
        return Response(generate_latest(REGISTRY), media_type=CONTENT_TYPE_LATEST)
