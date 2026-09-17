"""
realworld/space_weather.py
--------------------------
Current space weather from NOAA SWPC: planetary Kp index, 10.7 cm solar flux and the NOAA
geomagnetic storm (G), solar radiation (S) and radio blackout (R) scales. High Kp / F10.7 heat the
thermosphere and increase drag, which makes LEO predictions (and CDMs) less certain.
Results are cached for CACHE_TTL_S.
"""
import json
import logging
import os
import time
import urllib.request
from typing import Optional

logger = logging.getLogger(__name__)

SWPC_URL = os.environ.get("SWPC_URL", "https://services.swpc.noaa.gov")
CACHE_TTL_S = 600
_cache: dict = {"at": 0.0, "data": None}


def _get(path: str):
    req = urllib.request.Request(f"{SWPC_URL}{path}", headers={"User-Agent": "CrimsonNebula-ACM/1.1"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _float(value) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _kp_level(kp: Optional[float]) -> str:
    # NOAA's G-scale: G1 Minor=Kp5, G2 Moderate=Kp6, G3 Strong=Kp7,
    # G4 Severe=Kp8, G5 Extreme=Kp9. "Severe" is Kp>=8, not Kp>=7.
    if kp is None:
        return "unknown"
    if kp >= 8:
        return "severe storm"
    if kp >= 5:
        return "storm"
    if kp >= 4:
        return "active"
    return "quiet"


def fetch_space_weather(force: bool = False) -> dict:
    """Latest Kp, F10.7 and NOAA scales. Raises only when nothing was ever fetched."""
    now = time.time()
    if not force and _cache["data"] is not None and now - _cache["at"] < CACHE_TTL_S:
        return _cache["data"]
    errors = []
    data = {"source": "NOAA Space Weather Prediction Center", "kp": None, "kp_time": None, "kp_level": "unknown",
            "f107_sfu": None, "f107_time": None, "scales": None}
    try:
        rows = _get("/products/noaa-planetary-k-index.json")
        if rows and isinstance(rows[0], list):          # legacy format: header row + value rows
            rows = [dict(zip(rows[0], r)) for r in rows[1:]]
        latest = rows[-1]
        data["kp"] = _float(latest.get("Kp", latest.get("kp_index")))
        data["kp_time"] = str(latest.get("time_tag")) + "Z"
        data["kp_level"] = _kp_level(data["kp"])
    except Exception as e:
        errors.append(f"Kp: {e}")
    try:
        flux = _get("/json/f107_cm_flux.json")
        latest = max(flux, key=lambda r: r.get("time_tag", ""))
        data["f107_sfu"] = _float(latest.get("flux"))
        data["f107_time"] = str(latest.get("time_tag")) + "Z"
    except Exception as e:
        errors.append(f"F10.7: {e}")
    try:
        current = _get("/products/noaa-scales.json")["0"]
        data["scales"] = {k: {"scale": int(current[k]["Scale"] or 0), "text": current[k]["Text"]} for k in ("G", "S", "R")}
    except Exception as e:
        errors.append(f"scales: {e}")

    if len(errors) == 3:
        if _cache["data"] is not None:
            return {**_cache["data"], "stale": True}
        raise RuntimeError("; ".join(errors))
    if errors and _cache["data"] is not None:
        # Partial failure: keep whichever previous fields this round couldn't refresh,
        # instead of overwriting known-good cached values with None/"unknown".
        prev = _cache["data"]
        for key in ("kp", "kp_time", "kp_level", "f107_sfu", "f107_time", "scales"):
            if data.get(key) is None and prev.get(key) is not None:
                data[key] = prev[key]
        data["stale"] = True
    data["errors"] = errors or None
    data["fetched_at"] = now
    _cache.update(at=now, data=data)
    return data
