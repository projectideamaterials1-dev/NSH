"""
realworld/catalog.py
--------------------
Real orbital data from CelesTrak (NORAD general-perturbations element sets as OMM JSON) with an
on-disk cache, and SGP4 propagation to state vectors.

CelesTrak publishes new element sets roughly every 2 hours and blocks clients that poll faster,
so every query is cached in data/catalog/ for CACHE_TTL_S and failed queries are not retried for
RETRY_AFTER_S. When CelesTrak is unreachable the last cached copy is used (flagged `stale`).

Frame: SGP4 outputs TEME. The engine's ECI frame is rotated to Earth-fixed with GMST alone
(coordinates.convert_states_to_lla), which is exactly the TEME -> pseudo-Earth-fixed rotation, so TEME
states are ingested unchanged and ground tracks match SGP4 to within polar motion (~10 m).
"""
import json
import logging
import math
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np
from sgp4 import omm
from sgp4.api import Satrec, SatrecArray, jday

from satellite_api.timeutils import data_dir, iso_z

logger = logging.getLogger(__name__)

CELESTRAK_URL = os.environ.get("CELESTRAK_URL", "https://celestrak.org/NORAD/elements/gp.php")
USER_AGENT = "CrimsonNebula-ACM/1.1 (autonomous constellation manager)"
CACHE_TTL_S = 2 * 3600
RETRY_AFTER_S = 600
HTTP_TIMEOUT_S = 30
MAX_ELEMENT_AGE_DAYS = 30        # older element sets are too inaccurate to screen against
MU_EARTH = 398600.4418
R_EARTH = 6378.137


class CatalogError(RuntimeError):
    pass


@dataclass(frozen=True)
class Source:
    key: str
    label: str
    role: str            # "fleet" (operated satellites) | "objects" (tracked debris / traffic)
    queries: Tuple[str, ...]
    description: str
    name_pattern: Optional[str] = None   # CelesTrak NAME= queries match substrings; keep only real matches


SOURCES: Dict[str, Source] = {s.key: s for s in (
    Source("isro-eo", "ISRO Earth observation", "fleet",
           ("NAME=CARTOSAT", "NAME=RESOURCESAT", "NAME=OCEANSAT", "NAME=RISAT", "NAME=EOS-0"),
           "Cartosat, Resourcesat, Oceansat, RISAT and EOS satellites",
           name_pattern=r"\b(CARTOSAT|RESOURCESAT|OCEANSAT|RISAT|EOS-0\d)"),
    Source("stations", "Space stations", "fleet", ("GROUP=stations",), "ISS, Tiangong and docked vehicles"),
    Source("planet", "Planet Labs", "fleet", ("GROUP=planet",), "Dove / SuperDove / SkySat imaging constellation"),
    Source("oneweb", "OneWeb", "fleet", ("GROUP=oneweb",), "OneWeb broadband constellation (~1,200 km)"),
    Source("starlink", "Starlink", "fleet", ("GROUP=starlink",), "SpaceX Starlink broadband constellation"),
    Source("gps-ops", "GPS (operational)", "fleet", ("GROUP=gps-ops",), "US GPS navigation satellites (MEO)"),
    Source("weather", "Weather", "fleet", ("GROUP=weather",), "NOAA, Meteosat, Himawari, INSAT and other weather satellites"),
    Source("resource", "Earth resources", "fleet", ("GROUP=resource",), "Landsat, Sentinel and other Earth-resources satellites"),
    Source("science", "Science", "fleet", ("GROUP=science",), "Hubble and other science missions"),
    Source("fengyun-1c-debris", "Fengyun-1C debris", "objects", ("GROUP=fengyun-1c-debris",),
           "Fragments from the 2007 Chinese anti-satellite test"),
    Source("cosmos-2251-debris", "Cosmos 2251 debris", "objects", ("GROUP=cosmos-2251-debris",),
           "Fragments from the 2009 Iridium–Cosmos collision"),
    Source("iridium-33-debris", "Iridium 33 debris", "objects", ("GROUP=iridium-33-debris",),
           "Fragments from the 2009 Iridium–Cosmos collision"),
    Source("cosmos-1408-debris", "Cosmos 1408 debris", "objects", ("GROUP=cosmos-1408-debris",),
           "Fragments from the 2021 Russian anti-satellite test"),
    Source("last-30-days", "Recent launches", "objects", ("GROUP=last-30-days",),
           "Objects launched in the last 30 days"),
)}


@dataclass
class CatalogObject:
    norad_id: int
    name: str
    intl_designator: str
    epoch: datetime
    source: str
    fields: dict = field(repr=False)
    satrec: Satrec = field(repr=False)

    def age_days(self, at: Optional[datetime] = None) -> float:
        at = at or datetime.now(timezone.utc)
        return (at - self.epoch).total_seconds() / 86400.0

    def elements(self) -> dict:
        n_rad_s = float(self.fields["MEAN_MOTION"]) * 2 * math.pi / 86400.0
        a = (MU_EARTH / n_rad_s ** 2) ** (1 / 3)
        e = float(self.fields["ECCENTRICITY"])
        return {
            "inclination_deg": float(self.fields["INCLINATION"]),
            "eccentricity": e,
            "raan_deg": float(self.fields["RA_OF_ASC_NODE"]),
            "arg_perigee_deg": float(self.fields["ARG_OF_PERICENTER"]),
            "mean_anomaly_deg": float(self.fields["MEAN_ANOMALY"]),
            "mean_motion_rev_day": float(self.fields["MEAN_MOTION"]),
            "period_min": round(1440.0 / float(self.fields["MEAN_MOTION"]), 3),
            "semi_major_axis_km": round(a, 3),
            "perigee_alt_km": round(a * (1 - e) - R_EARTH, 1),
            "apogee_alt_km": round(a * (1 + e) - R_EARTH, 1),
            "bstar": float(self.fields.get("BSTAR", 0.0)),
        }

    def to_dict(self, at: Optional[datetime] = None) -> dict:
        return {
            "norad_id": self.norad_id,
            "name": self.name,
            "intl_designator": self.intl_designator,
            "source": self.source,
            "source_label": SOURCES[self.source].label if self.source in SOURCES else self.source,
            "epoch": iso_z(self.epoch),
            "element_age_hours": round(self.age_days(at) * 24.0, 2),
            "elements": self.elements(),
        }


# ============================================================================
# fetching + cache
# ============================================================================
_last_failure: Dict[str, float] = {}


def _cache_path(cache_key: str):
    return data_dir() / "catalog" / f"{re.sub(r'[^A-Za-z0-9_.-]', '_', cache_key)}.json"


def _read_cache(cache_key: str) -> Optional[dict]:
    path = _cache_path(cache_key)
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _write_cache(cache_key: str, records: list) -> None:
    path = _cache_path(cache_key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"fetched_at": time.time(), "records": records}))
        tmp.replace(path)
    except OSError as e:  # read-only filesystem: keep working without a cache
        logger.warning(f"Could not cache {cache_key}: {e}")


def _http_query(query: str) -> list:
    url = f"{CELESTRAK_URL}?{query}&FORMAT=json"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise CatalogError(f"CelesTrak returned HTTP {e.code} for {query}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise CatalogError(f"CelesTrak unreachable ({getattr(e, 'reason', e)})") from e
    text = body.strip()
    if not text or text.startswith("No GP data found"):
        return []
    try:
        data = json.loads(text)
    except ValueError as e:
        raise CatalogError(f"Unexpected CelesTrak response for {query}: {text[:120]}") from e
    if not isinstance(data, list):
        raise CatalogError(f"Unexpected CelesTrak response for {query}")
    return data


def fetch_query(cache_key: str, queries: Iterable[str], force: bool = False) -> Tuple[list, dict]:
    """Records for one cache entry (a source or a NORAD id). Returns (records, info)."""
    cached = _read_cache(cache_key)
    now = time.time()
    fresh = cached is not None and now - cached.get("fetched_at", 0) < CACHE_TTL_S
    if fresh and not force:
        return cached["records"], {"fetched_at": iso_z(cached["fetched_at"]), "cached": True, "stale": False}
    if not force and now - _last_failure.get(cache_key, 0) < RETRY_AFTER_S:
        if cached is not None:
            return cached["records"], {"fetched_at": iso_z(cached["fetched_at"]), "cached": True, "stale": True}
        raise CatalogError("CelesTrak was unreachable recently; retrying later")
    try:
        records: list = []
        for q in queries:
            records.extend(_http_query(q))
    except CatalogError:
        _last_failure[cache_key] = now
        if cached is not None:
            logger.warning(f"Using cached {cache_key} after CelesTrak failure")
            return cached["records"], {"fetched_at": iso_z(cached["fetched_at"]), "cached": True, "stale": True}
        raise
    _last_failure.pop(cache_key, None)
    _write_cache(cache_key, records)
    return records, {"fetched_at": iso_z(now), "cached": False, "stale": False}


def cache_info(cache_key: str) -> Optional[dict]:
    cached = _read_cache(cache_key)
    if cached is None:
        return None
    age = time.time() - cached.get("fetched_at", 0)
    records = cached.get("records", [])
    source = SOURCES.get(cache_key)
    if source and source.name_pattern:
        pattern = re.compile(source.name_pattern)
        records = [r for r in records if pattern.search(str(r.get("OBJECT_NAME", "")))]
    return {"fetched_at": iso_z(cached["fetched_at"]), "count": len(records),
            "stale": age >= CACHE_TTL_S}


def fetch_source(key: str, force: bool = False) -> Tuple[List[CatalogObject], dict]:
    source = SOURCES.get(key)
    if source is None:
        raise CatalogError(f"Unknown source {key!r}")
    records, info = fetch_query(key, source.queries, force)
    if source.name_pattern:
        pattern = re.compile(source.name_pattern)
        records = [r for r in records if pattern.search(str(r.get("OBJECT_NAME", "")))]
    return parse_records(records, key), {**info, "count": len(records)}


def fetch_norad_ids(ids: Iterable[int], force: bool = False) -> Tuple[List[CatalogObject], List[str]]:
    objects, errors = [], []
    for norad in ids:
        try:
            records, _ = fetch_query(f"catnr-{norad}", (f"CATNR={int(norad)}",), force)
        except CatalogError as e:
            errors.append(f"NORAD {norad}: {e}")
            continue
        if not records:
            errors.append(f"NORAD {norad}: no element set found (decayed or unknown)")
        objects.extend(parse_records(records, "norad"))
    return objects, errors


def parse_records(records: list, source: str) -> List[CatalogObject]:
    out = []
    for rec in records:
        try:
            sat = Satrec()
            omm.initialize(sat, rec)
            epoch = datetime.fromisoformat(str(rec["EPOCH"])).replace(tzinfo=timezone.utc)
            out.append(CatalogObject(
                norad_id=int(rec["NORAD_CAT_ID"]), name=str(rec.get("OBJECT_NAME", "")).strip() or str(rec["NORAD_CAT_ID"]),
                intl_designator=str(rec.get("OBJECT_ID", "")), epoch=epoch, source=source, fields=rec, satrec=sat,
            ))
        except (KeyError, ValueError, TypeError) as e:
            logger.debug(f"Skipping malformed element set: {e}")
    return out


# ============================================================================
# propagation
# ============================================================================
def propagate(objects: List[CatalogObject], when: datetime) -> Tuple[np.ndarray, np.ndarray]:
    """SGP4 states (N, 6) [km, km/s, TEME] at `when`, and a mask of objects that propagated cleanly."""
    if not objects:
        return np.empty((0, 6)), np.empty(0, dtype=bool)
    when = when.astimezone(timezone.utc)
    jd, fr = jday(when.year, when.month, when.day, when.hour, when.minute, when.second + when.microsecond / 1e6)
    err, r, v = SatrecArray([o.satrec for o in objects]).sgp4(np.array([jd]), np.array([fr]))
    states = np.concatenate([r[:, 0, :], v[:, 0, :]], axis=1)
    ok = (err[:, 0] == 0) & np.isfinite(states).all(axis=1)
    ok &= np.linalg.norm(states[:, :3], axis=1) > R_EARTH + 80.0     # decayed / re-entering
    return states, ok


def assign_ids(objects: List[CatalogObject], taken: Iterable[str] = ()) -> List[str]:
    """Readable, unique engine IDs: the catalog name, with the NORAD number when the name repeats."""
    counts: Dict[str, int] = {}
    for o in objects:
        counts[o.name] = counts.get(o.name, 0) + 1
    used = set(taken)
    ids = []
    for o in objects:
        candidate = o.name if counts[o.name] == 1 and o.name not in used else f"{o.name} #{o.norad_id}"
        used.add(candidate)
        ids.append(candidate)
    return ids
