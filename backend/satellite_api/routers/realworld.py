"""
routers/realworld.py
--------------------
Real-world data API:

  GET  /api/catalog/sources              CelesTrak sources that can be loaded (fleet / tracked objects)
  POST /api/catalog/load                 fetch element sets, propagate with SGP4 and load them into the engine
  POST /api/catalog/refresh              re-fetch the loaded sources and re-anchor (fuel/burns are kept)
  POST /api/catalog/resize               grow/shrink the loaded fleet in place (the rest keep fuel/burns)
  GET  /api/catalog/status               what is loaded, element-set ages, live-sync state
  GET  /api/catalog/objects/{object_id}  NORAD id, designator, element-set epoch and orbital elements
  GET  /api/catalog/imagery[/{id}]       real photos of the loaded satellites (Wikimedia Commons)
  GET  /api/live | PUT /api/live         wall-clock live mode (simulation time = real UTC)
  GET  /api/space-weather                NOAA SWPC Kp, F10.7 and G/S/R scales
"""
import asyncio
import time
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from satellite_api.realworld import catalog, imagery
from satellite_api.realworld.catalog import CatalogError
from satellite_api.realworld.live import MAX_OBJECTS, MAX_SATELLITES, RealWorldService, get_service
from satellite_api.realworld.space_weather import fetch_space_weather
from satellite_api.timeutils import iso_z

router = APIRouter(tags=["Real-world data"])


def _norad_map(app) -> dict:
    service = getattr(app.state, "realworld", None)
    if service is None:
        return {}
    return {obj.norad_id: eid for table in (service.fleet, service.objects) for eid, obj in table.items()}


async def ingest_cdms(app, cdms: list) -> dict:
    """Matches parsed CDMs to engine pairs, stores them and asks for a re-screen. Returns a summary."""
    from satellite_api.realworld.cdm_ingest import external_summary, resolve_pair
    state = app.state.orbital_state
    norad = _norad_map(app)
    matched, unmatched = [], []
    async with state.lock:
        now_ts = state.now_ts if state.current_time else time.time()
        for cdm in cdms:
            pair = resolve_pair(cdm, state.sat_id_to_idx, list(state.debris_id_to_idx) + list(state.sat_id_to_idx), norad)
            rec = state.external_cdms.add(cdm, pair, now_ts)
            row = {**external_summary(rec), "satellite_id": rec["satellite_id"], "object_id": rec["object_id"],
                   "objects": [o["designator"] or o["name"] for o in cdm["objects"]]}
            (matched if pair else unmatched).append(row)
        state.external_cdms.prune(now_ts)
        if matched:
            state.telemetry_version += 1           # triggers a screening cycle that re-assesses Pc
            state.emit("info", "conjunction", f"{len(matched)} external CDM(s) ingested "
                       f"({sum(r['has_covariance'] for r in matched)} with covariance)")
    return {"matched": matched, "unmatched": unmatched}


def _service(request: Request) -> RealWorldService:
    return get_service(request.app, request.app.state.orbital_state)


def _conjunction_service(request: Request):
    from satellite_api.routers.operations import get_service as get_conjunction_service
    return get_conjunction_service(request)


@router.get("/api/catalog/sources")
async def catalog_sources():
    return {
        "provider": "CelesTrak (celestrak.org) — NORAD general-perturbations element sets",
        "cache_ttl_s": catalog.CACHE_TTL_S,
        "limits": {"max_satellites": MAX_SATELLITES, "max_objects": MAX_OBJECTS},
        "sources": [{
            "key": s.key, "label": s.label, "role": s.role, "description": s.description,
            "cache": catalog.cache_info(s.key),
        } for s in catalog.SOURCES.values()],
    }


class CatalogLoadRequest(BaseModel):
    fleet: List[str] = Field(default_factory=lambda: ["isro-eo"], description="Source keys operated as satellites")
    objects: List[str] = Field(default_factory=lambda: ["fengyun-1c-debris", "cosmos-2251-debris", "iridium-33-debris"],
                               description="Source keys tracked as debris / traffic")
    norad_ids: List[int] = Field(default_factory=list, max_length=25, description="Extra satellites by NORAD catalog number")
    max_satellites: int = Field(60, ge=1, le=MAX_SATELLITES)
    max_objects: int = Field(5000, ge=0, le=MAX_OBJECTS)
    replace: bool = Field(True, description="Replace everything currently tracked (resets fuel, burns and metrics)")
    live: Optional[bool] = Field(True, description="Lock the simulation clock to real UTC after loading")
    force_refresh: bool = Field(False, description="Bypass the 2 h cache (use sparingly: CelesTrak rate-limits)")


@router.post("/api/catalog/load")
async def load_catalog(body: CatalogLoadRequest, request: Request):
    service = _service(request)
    try:
        return await service.load(
            fleet=body.fleet, objects=body.objects, norad_ids=body.norad_ids,
            max_satellites=body.max_satellites, max_objects=body.max_objects, replace=body.replace,
            live=body.live, force=body.force_refresh, conjunction_service=_conjunction_service(request),
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except CatalogError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/api/catalog/refresh")
async def refresh_catalog(request: Request, force: bool = Query(False, description="Bypass the 2 h cache")):
    service = _service(request)
    try:
        result = await service.refresh(force=force)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {**result, "status": service.status()}


class FleetResize(BaseModel):
    max_satellites: int = Field(..., ge=1, le=MAX_SATELLITES)


@router.post("/api/catalog/resize")
async def resize_fleet(body: FleetResize, request: Request):
    """Add or remove satellites from the loaded fleet; the rest keep their fuel, burns and history."""
    try:
        return await _service(request).resize(body.max_satellites, conjunction_service=_conjunction_service(request))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except CatalogError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/api/catalog/status")
async def catalog_status(request: Request):
    return _service(request).status()


@router.get("/api/catalog/objects/{object_id:path}")
async def catalog_object(object_id: str, request: Request):
    state = request.app.state.orbital_state
    async with state.lock:
        info = _service(request).object_info(object_id)
    if info is None:
        raise HTTPException(status_code=404, detail=f"{object_id} was not loaded from the catalog")
    return info


@router.get("/api/catalog/imagery")
async def fleet_imagery(request: Request):
    """Wikimedia photos for every loaded real-world satellite, keyed by engine satellite id."""
    state = request.app.state.orbital_state
    async with state.lock:
        fleet = {sid: (obj.norad_id, obj.name) for sid, obj in _service(request).fleet.items()}
    photos = await asyncio.to_thread(imagery.lookup, fleet.values())
    return {"provider": "Wikimedia Commons via Wikidata / Wikipedia",
            "items": {sid: photos.get(norad) for sid, (norad, _) in fleet.items()}}


@router.get("/api/catalog/imagery/{object_id:path}")
async def object_imagery(object_id: str, request: Request):
    state = request.app.state.orbital_state
    async with state.lock:
        service = _service(request)
        obj = service.fleet.get(object_id) or service.objects.get(object_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"{object_id} was not loaded from the catalog")
    entry = (await asyncio.to_thread(imagery.lookup, [(obj.norad_id, obj.name)])).get(obj.norad_id)
    if entry is None:
        raise HTTPException(status_code=502, detail="Wikimedia unavailable")
    return entry


class LiveUpdate(BaseModel):
    enabled: bool


@router.get("/api/live")
async def live_status(request: Request):
    service = _service(request)
    state = request.app.state.orbital_state
    return {"enabled": service.live, "sim_time": iso_z(state.current_time) if state.current_time else None,
            "clock_lag_s": service.status()["clock_lag_s"], "last_error": service.last_error}


@router.put("/api/live")
async def set_live(update: LiveUpdate, request: Request):
    service = _service(request)
    try:
        await service.set_live(update.enabled)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return await live_status(request)


@router.get("/api/space-weather")
async def space_weather(force: bool = Query(False)):
    try:
        return await asyncio.to_thread(fetch_space_weather, force)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"NOAA SWPC unavailable: {e}")


# ============================================================================
# external conjunction data messages
# ============================================================================
@router.post("/api/cdm", tags=["Operations"])
async def upload_cdm(request: Request):
    """Ingests external CDMs: CCSDS KVN text (one or several messages), CCSDS-keyword JSON, or
    Space-Track `cdm_public` JSON. Messages carrying both objects' RTN covariance make Pc use the
    measured covariance; all of them are shown next to this engine's own assessment."""
    from satellite_api.realworld.cdm_ingest import CDMParseError, parse_any
    body = await request.body()
    if not body.strip():
        raise HTTPException(status_code=400, detail="Empty body: send CDM text or JSON")
    if len(body) > 5_000_000:
        raise HTTPException(status_code=413, detail="CDM payload too large (5 MB max)")
    try:
        cdms = parse_any(body)
    except (CDMParseError, ValueError) as e:
        raise HTTPException(status_code=422, detail=f"Could not parse CDM: {e}")
    return await ingest_cdms(request.app, cdms)


@router.get("/api/cdm", tags=["Operations"])
async def list_external_cdms(request: Request, matched: Optional[bool] = None):
    """External CDMs received (uploaded or polled from Space-Track), newest TCA last."""
    from satellite_api.realworld.cdm_ingest import external_summary
    state = request.app.state.orbital_state
    async with state.lock:
        items = state.external_cdms.to_list()
    rows = [{**external_summary(r), "satellite_id": r["satellite_id"], "object_id": r["object_id"],
             "matched": r["matched"], "objects": [o["designator"] or o["name"] for o in r["objects"]]}
            for r in items if matched is None or r["matched"] == matched]
    return {"cdms": rows}
