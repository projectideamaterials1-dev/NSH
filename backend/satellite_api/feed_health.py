"""
feed_health.py
--------------
Health of the external data feeds the engine depends on. Neither CelesTrak nor NOAA SWPC has
an SLA, and stale or corrupt input degrades screening accuracy silently, so each feed gets an
explicit status:

    ok        fresh data, last fetch succeeded
    degraded  data usable but the last fetch failed or a corrupt download was rejected (the
              cached copy is in use)
    stale     data older than its freshness budget - predictions are drifting
    error     no usable data
    idle      feed not in use (e.g. no real-world catalog loaded)

FeedMonitor runs in the background: it refreshes NOAA space weather (which also feeds the drag
model) and emits an event whenever a feed changes status, so operators see "CelesTrak stale"
in the alert feed instead of discovering it later. Thresholds are environment-configurable.
"""
import asyncio
import logging
import os
import statistics
import time
from datetime import datetime, timezone
from typing import Dict, Optional

from satellite_api.realworld import catalog, space_weather, spacetrack
from satellite_api.timeutils import iso_z

logger = logging.getLogger(__name__)

CELESTRAK_STALE_S = float(os.environ.get("FEED_CELESTRAK_STALE_S", str(6 * 3600)))
ELEMENT_STALE_DAYS = float(os.environ.get("FEED_ELEMENT_STALE_DAYS", "3"))
NOAA_STALE_S = float(os.environ.get("FEED_NOAA_STALE_S", str(2 * 3600)))
KP_STALE_S = float(os.environ.get("FEED_KP_STALE_S", str(6 * 3600)))
CHECK_INTERVAL_S = float(os.environ.get("FEED_CHECK_INTERVAL_S", "60"))
WEATHER_REFRESH_S = float(os.environ.get("FEED_WEATHER_REFRESH_S", str(space_weather.CACHE_TTL_S)))

STATUS_RANK = {"idle": 0, "ok": 0, "degraded": 1, "stale": 2, "error": 3}


def _age(ts: Optional[float], now: float) -> Optional[float]:
    return None if ts is None else max(0.0, now - ts)


def _parse_iso(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def celestrak_status(realworld, now: Optional[float] = None) -> dict:
    now = time.time() if now is None else now
    feed = catalog.FEED
    loaded = bool(realworld is not None and realworld.request)
    if not loaded:
        return {"feed": "celestrak", "status": "idle", "issues": [], "detail": "no real-world catalog loaded"}
    last_fetch = max(filter(None, [feed["last_success"], realworld.last_refresh_wall, realworld.loaded_at]), default=None)
    epochs = [o.age_days() for o in list(realworld.fleet.values()) + list(realworld.objects.values())]
    median_age_days = statistics.median(epochs) if epochs else None
    issues = []
    status = "ok"
    fetch_age = _age(last_fetch, now)
    if fetch_age is not None and fetch_age > CELESTRAK_STALE_S:
        status = "stale"
        issues.append(f"no successful refresh for {fetch_age / 3600:.1f} h")
    if median_age_days is not None and median_age_days > ELEMENT_STALE_DAYS:
        status = "stale"
        issues.append(f"median element-set age {median_age_days:.1f} d")
    for key, info in (realworld.source_info or {}).items():
        if info.get("stale"):
            issues.append(f"{key}: using cached copy")
            status = status if STATUS_RANK[status] >= STATUS_RANK["degraded"] else "degraded"
    if feed["last_rejected_at"] and (last_fetch is None or feed["last_rejected_at"] > last_fetch):
        issues.append(f"rejected corrupt download ({feed['last_rejected']})")
        status = status if STATUS_RANK[status] >= STATUS_RANK["degraded"] else "degraded"
    if feed["last_error_at"] and (last_fetch is None or feed["last_error_at"] > last_fetch):
        issues.append(f"last fetch failed: {feed['last_error']}")
        status = status if STATUS_RANK[status] >= STATUS_RANK["degraded"] else "degraded"
    if not epochs:
        status = "error"
        issues.append("no element sets loaded")
    return {
        "feed": "celestrak", "status": status, "issues": issues,
        "last_success": iso_z(last_fetch) if last_fetch else None, "age_s": fetch_age,
        "median_element_age_days": round(median_age_days, 2) if median_age_days is not None else None,
        "objects": len(epochs),
    }


def noaa_status(now: Optional[float] = None) -> dict:
    now = time.time() if now is None else now
    feed = space_weather.FEED
    data = space_weather.cached()
    if data is None:
        if feed["last_error_at"]:
            return {"feed": "noaa_swpc", "status": "error", "issues": [f"never fetched: {feed['last_error']}"],
                    "last_success": None, "age_s": None}
        return {"feed": "noaa_swpc", "status": "idle", "issues": [], "detail": "not fetched yet", "last_success": None,
                "age_s": None}
    issues = []
    status = "ok"
    fetch_age = _age(feed["last_success"], now)
    if fetch_age is not None and fetch_age > NOAA_STALE_S:
        status = "stale"
        issues.append(f"no successful fetch for {fetch_age / 3600:.1f} h")
    kp_age = _age(_parse_iso(data.get("kp_time")), now)
    if kp_age is not None and kp_age > KP_STALE_S:
        status = "stale"
        issues.append(f"latest Kp is {kp_age / 3600:.1f} h old")
    if data.get("errors"):
        issues.extend(data["errors"])
        status = status if STATUS_RANK[status] >= STATUS_RANK["degraded"] else "degraded"
    if data.get("kp") is None and data.get("f107_sfu") is None:
        status = "error"
        issues.append("no Kp or F10.7 available (drag uses reference conditions)")
    return {"feed": "noaa_swpc", "status": status, "issues": issues,
            "last_success": iso_z(feed["last_success"]) if feed["last_success"] else None, "age_s": fetch_age,
            "kp": data.get("kp"), "f107_sfu": data.get("f107_sfu")}


def spacetrack_status(now: Optional[float] = None) -> dict:
    now = time.time() if now is None else now
    feed = spacetrack.FEED
    if not spacetrack.credentials():
        return {"feed": "space_track", "status": "idle", "issues": [],
                "detail": "SPACETRACK_IDENTITY / SPACETRACK_PASSWORD not set", "age_s": None}
    age = _age(feed["last_success"], now)
    issues, status = [], "ok"
    if feed["last_error_at"] and (feed["last_success"] is None or feed["last_error_at"] >= feed["last_success"]):
        issues.append(f"last fetch failed: {feed['last_error']}")
        status = "error" if feed["last_success"] is None else "degraded"
    if age is not None and age > 3 * spacetrack.POLL_S:
        issues.append(f"no successful fetch for {age / 3600:.1f} h")
        status = "stale"
    if feed["last_success"] is None and status == "ok":
        status, issues = "idle", ["first poll pending"]
    return {"feed": "space_track", "status": status, "issues": issues, "age_s": age,
            "last_success": iso_z(feed["last_success"]) if feed["last_success"] else None,
            "cdms_last_poll": feed["last_count"]}


def assess(realworld) -> Dict[str, dict]:
    now = time.time()
    return {"celestrak": celestrak_status(realworld, now), "noaa_swpc": noaa_status(now),
            "space_track": spacetrack_status(now)}


class FeedMonitor:
    """Background refresh of space weather + status-change events."""

    def __init__(self, app):
        self.app = app
        self.last: Dict[str, str] = {}
        self._task: Optional[asyncio.Task] = None
        self._last_weather = 0.0
        self.spacetrack = spacetrack.SpaceTrackPoller()

    async def check(self) -> Dict[str, dict]:
        if time.monotonic() - self._last_weather >= WEATHER_REFRESH_S:
            self._last_weather = time.monotonic()
            try:
                await asyncio.to_thread(space_weather.fetch_space_weather)
            except Exception as e:     # nothing ever fetched: reported as an error status below
                logger.warning(f"Space weather refresh failed: {e}")
        await self._poll_spacetrack()
        feeds = assess(getattr(self.app.state, "realworld", None))
        state = self.app.state.orbital_state
        for name, info in feeds.items():
            previous = self.last.get(name)
            current = info["status"]
            self.last[name] = current
            if previous is None or previous == current or current == "idle":
                continue
            label = {"celestrak": "CelesTrak element sets", "noaa_swpc": "NOAA space weather",
                     "space_track": "Space-Track CDMs"}[name]
            if current == "ok":
                level, message = "ok", f"{label} feed recovered"
            else:
                level = "crit" if current == "error" else "warn"
                message = f"{label} feed {current}: " + "; ".join(info["issues"][:3])
            async with state.lock:
                state.emit(level, "data_feed", message, feed=name, status=current)
        return feeds

    async def _poll_spacetrack(self):
        """Public CDMs for the loaded fleet (needs Space-Track credentials and a real catalog)."""
        realworld = getattr(self.app.state, "realworld", None)
        if not self.spacetrack.due() or realworld is None or not realworld.fleet:
            return
        from satellite_api.realworld.cdm_ingest import parse_json_record
        from satellite_api.routers.realworld import ingest_cdms
        norad_ids = [obj.norad_id for obj in realworld.fleet.values()]
        try:
            records = await asyncio.to_thread(self.spacetrack.fetch, norad_ids)
        except Exception:
            return                                  # reported through spacetrack_status
        cdms = []
        for rec in records:
            try:
                cdms.append(parse_json_record(rec))
            except ValueError:
                continue
        if cdms:
            await ingest_cdms(self.app, cdms)

    async def _loop(self):
        while True:
            try:
                await self.check()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"Feed health check failed: {e}", exc_info=True)
            await asyncio.sleep(CHECK_INTERVAL_S)

    def start(self):
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
