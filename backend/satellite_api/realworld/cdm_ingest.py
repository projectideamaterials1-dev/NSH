"""
realworld/cdm_ingest.py
-----------------------
External Conjunction Data Messages: the authoritative cross-check for this engine's own
screening, and the source of *measured* covariance for Pc.

Accepted inputs
  * CCSDS CDM in KVN text (CCSDS 508.0-B-1/-B-2): header, relative metadata (TCA, miss
    distance, Pc) and two object segments, each with an RTN position covariance
    (CR_R, CT_R, CT_T, CN_R, CN_T, CN_N in m^2). This is what an operator receives for its own
    spacecraft (Space-Track `cdm` class, commercial SSA providers).
  * The same keywords as a JSON object (or a list of them).
  * Space-Track `cdm_public` records (TCA, MIN_RNG, PC, SAT_1_ID / SAT_2_ID): no covariance,
    but an authoritative Pc and miss distance to compare against.

Each message is matched to an engine pair (satellite, object) by NORAD id via the loaded
catalog, or by engine id / name. Screening then
  * uses the CDM's covariances for Pc when both objects carry one (ConjunctionIndex), and
  * attaches the external Pc / miss / TCA to the conjunction for side-by-side comparison.
"""
import json
import math
import re
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np

MATCH_TCA_S = 600.0          # an external CDM describes our predicted encounter if TCAs agree this well
MAX_EXTERNAL = 500

_COV_KEYS = ("CR_R", "CT_R", "CT_T", "CN_R", "CN_T", "CN_N")


class CDMParseError(ValueError):
    pass


def _num(value) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    text = re.sub(r"\s*\[.*?\]\s*$", "", text)          # strip KVN units, e.g. "4.1e+02 [m**2]"
    if not text:
        return None
    try:
        out = float(text)
    except ValueError:
        return None
    return out if math.isfinite(out) else None


def _ts(value) -> Optional[float]:
    if not value:
        return None
    text = str(value).strip().replace("Z", "")
    # CCSDS allows day-of-year epochs (2026-283T12:00:00); Space-Track uses calendar dates.
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%jT%H:%M:%S.%f", "%Y-%jT%H:%M:%S",
                "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
    return None


def _covariance(fields: Dict[str, str]) -> Optional[np.ndarray]:
    vals = [_num(fields.get(k)) for k in _COV_KEYS]
    if any(v is None for v in vals):
        return None
    rr, tr, tt, nr, nt, nn = (v / 1e6 for v in vals)     # m^2 -> km^2
    cov = np.array([[rr, tr, nr], [tr, tt, nt], [nr, nt, nn]])
    # Reject non-physical matrices (negative variances / not positive semi-definite).
    if np.any(np.diag(cov) < 0) or np.linalg.eigvalsh(cov).min() < -1e-12:
        return None
    return cov


def _normalise(header: Dict[str, str], objects: List[Dict[str, str]], source: str) -> dict:
    tca = _ts(header.get("TCA"))
    if tca is None:
        raise CDMParseError("CDM has no parseable TCA")
    if len(objects) != 2:
        raise CDMParseError(f"CDM must describe exactly two objects (found {len(objects)})")
    miss_m = _num(header.get("MISS_DISTANCE"))
    out_objects = []
    for o in objects:
        cov = _covariance(o)
        out_objects.append({
            "designator": str(o.get("OBJECT_DESIGNATOR", "")).strip(),
            "name": str(o.get("OBJECT_NAME", "")).strip(),
            "international_designator": str(o.get("INTERNATIONAL_DESIGNATOR", "")).strip(),
            "ref_frame": str(o.get("COVARIANCE_FRAME") or o.get("REF_FRAME") or "RTN").strip(),
            "covariance_rtn_km2": cov.tolist() if cov is not None else None,
        })
    return {
        "message_id": str(header.get("MESSAGE_ID") or header.get("CDM_ID") or f"{source}-{int(tca)}").strip(),
        "originator": str(header.get("ORIGINATOR") or source).strip(),
        "created": str(header.get("CREATION_DATE") or header.get("CREATED") or "").strip() or None,
        "tca_ts": tca,
        "miss_km": None if miss_m is None else miss_m / 1000.0,
        "pc": _num(header.get("COLLISION_PROBABILITY")),
        "pc_method": str(header.get("COLLISION_PROBABILITY_METHOD") or "").strip() or None,
        "objects": out_objects,
        "source": source,
    }


def parse_kvn(text: str) -> dict:
    """One CCSDS CDM in KVN form."""
    header: Dict[str, str] = {}
    objects: List[Dict[str, str]] = []
    current = header
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("COMMENT") or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        key = key.upper()
        if key == "OBJECT":
            current = {}
            objects.append(current)
            continue
        current[key] = value
    if "CCSDS_CDM_VERS" not in header and "TCA" not in header:
        raise CDMParseError("Not a CCSDS CDM (no CCSDS_CDM_VERS / TCA)")
    return _normalise(header, objects, "CCSDS CDM")


def parse_json_record(rec: dict) -> dict:
    """A CCSDS-keyword JSON CDM, or a Space-Track cdm_public record."""
    upper = {str(k).upper(): v for k, v in rec.items()}
    if "SAT_1_ID" in upper or "SAT1_ID" in upper:           # Space-Track cdm_public
        g = lambda *keys: next((upper[k] for k in keys if k in upper and upper[k] not in (None, "")), None)  # noqa: E731
        header = {"MESSAGE_ID": g("CDM_ID"), "CREATION_DATE": g("CREATED"), "TCA": g("TCA"),
                  "MISS_DISTANCE": g("MIN_RNG"), "COLLISION_PROBABILITY": g("PC"),
                  "ORIGINATOR": "Space-Track (18/19 SDS)"}
        objects = [{"OBJECT_DESIGNATOR": g("SAT_1_ID", "SAT1_ID"), "OBJECT_NAME": g("SAT_1_NAME", "SAT1_NAME")},
                   {"OBJECT_DESIGNATOR": g("SAT_2_ID", "SAT2_ID"), "OBJECT_NAME": g("SAT_2_NAME", "SAT2_NAME")}]
        return _normalise(header, objects, "Space-Track cdm_public")
    objects = upper.pop("OBJECTS", None)
    if objects is None:
        objects = [upper.pop(k) for k in ("OBJECT1", "OBJECT2") if k in upper]
    objects = [{str(k).upper(): v for k, v in o.items()} for o in objects or []]
    return _normalise(upper, objects, "CCSDS CDM (JSON)")


def parse_any(payload) -> List[dict]:
    """KVN text (one or several CDMs separated by CCSDS_CDM_VERS), JSON text, a dict or a list."""
    if isinstance(payload, (bytes, bytearray)):
        payload = payload.decode("utf-8", errors="replace")
    if isinstance(payload, str):
        text = payload.strip()
        if text.startswith("{") or text.startswith("["):
            payload = json.loads(text)
        else:
            chunks = [c for c in re.split(r"(?=^\s*CCSDS_CDM_VERS\s*=)", text, flags=re.M) if c.strip()]
            return [parse_kvn(c) for c in chunks]
    if isinstance(payload, dict):
        payload = [payload]
    if not isinstance(payload, list):
        raise CDMParseError("Unsupported CDM payload")
    return [parse_json_record(r) for r in payload]


# ── matching + storage ─────────────────────────────────────────────────────────
def _engine_id(designator: str, name: str, norad_to_id: Dict[int, str], known: Iterable[str]) -> Optional[str]:
    known = set(known)
    digits = re.sub(r"\D", "", designator or "")
    if digits and int(digits) in norad_to_id:
        return norad_to_id[int(digits)]
    for candidate in (designator, name):
        if candidate and candidate in known:
            return candidate
    return None


def resolve_pair(cdm: dict, sat_ids: Iterable[str], object_ids: Iterable[str],
                 norad_to_id: Dict[int, str]) -> Optional[Tuple[str, str, int]]:
    """(satellite_id, object_id, index of the satellite in cdm['objects']) or None.

    The satellite is whichever CDM object is one of our tracked satellites (preferring
    OBJECT1, the conventional primary)."""
    sats = set(sat_ids)
    everything = sats | set(object_ids)
    ids = [_engine_id(o["designator"], o["name"], norad_to_id, everything) for o in cdm["objects"]]
    for i in (0, 1):
        other = 1 - i
        if ids[i] in sats and ids[other] is not None and ids[other] != ids[i]:
            return ids[i], ids[other], i
    return None


class ExternalCDMStore:
    """External CDMs matched to engine pairs; persisted in the Redis snapshot."""

    def __init__(self):
        self.items: Dict[str, dict] = {}

    def add(self, cdm: dict, pair: Optional[Tuple[str, str, int]], now_ts: float) -> dict:
        record = {**cdm, "received_at": now_ts, "satellite_id": None, "object_id": None,
                  "sat_object_index": None, "matched": pair is not None}
        if pair:
            record.update(satellite_id=pair[0], object_id=pair[1], sat_object_index=pair[2])
        self.items[record["message_id"]] = record
        if len(self.items) > MAX_EXTERNAL:
            for key in sorted(self.items, key=lambda k: self.items[k]["received_at"])[:len(self.items) - MAX_EXTERNAL]:
                self.items.pop(key)
        return record

    def prune(self, now_ts: float, keep_past_s: float = 86400.0):
        self.items = {k: v for k, v in self.items.items() if v["tca_ts"] > now_ts - keep_past_s}

    def index(self) -> Dict[Tuple[str, str], List[dict]]:
        """Matched CDMs by (satellite_id, object_id), newest first (a snapshot safe to use off-lock)."""
        out: Dict[Tuple[str, str], List[dict]] = {}
        for rec in sorted(self.items.values(), key=lambda r: r["received_at"], reverse=True):
            if rec["matched"]:
                out.setdefault((rec["satellite_id"], rec["object_id"]), []).append(rec)
        return out

    def to_list(self) -> List[dict]:
        return sorted(self.items.values(), key=lambda r: r["tca_ts"])

    def restore(self, items: List[dict]):
        self.items = {r["message_id"]: r for r in items or []}


def lookup(index: Dict[Tuple[str, str], List[dict]], sat_id: str, obj_id: str, tca_ts: float) -> Optional[dict]:
    """Newest external CDM for this pair whose TCA matches the predicted one."""
    for rec in index.get((sat_id, obj_id), []):
        if abs(rec["tca_ts"] - tca_ts) <= MATCH_TCA_S:
            return rec
    return None


def covariances_for(rec: dict) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    """(satellite covariance, object covariance) in km^2, or (None, None) unless both exist."""
    i = rec["sat_object_index"]
    if i is None:                                   # not matched to an engine pair
        return None, None
    sat_cov = rec["objects"][i]["covariance_rtn_km2"]
    obj_cov = rec["objects"][1 - i]["covariance_rtn_km2"]
    if sat_cov is None or obj_cov is None:
        return None, None
    return np.asarray(sat_cov), np.asarray(obj_cov)


def external_summary(rec: dict) -> dict:
    from satellite_api.timeutils import iso_z
    return {"message_id": rec["message_id"], "originator": rec["originator"], "created": rec["created"],
            "tca": iso_z(rec["tca_ts"]), "miss_km": rec["miss_km"], "pc": rec["pc"], "pc_method": rec["pc_method"],
            "has_covariance": covariances_for(rec)[0] is not None, "source": rec["source"]}
