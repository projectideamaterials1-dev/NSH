"""
middleware/identity.py
----------------------
Named users with hashed, expiring, revocable API keys - so the audit trail says *who* acted
("user:alice"), not which shared secret was used.

Users live in a JSON file (API_USERS_FILE, default <DATA_DIR>/api_users.json), managed with
scripts/apikeys.py and re-read automatically when it changes (rotation needs no restart):

    {"users": [{"user": "alice", "role": "operator", "keys": [
        {"id": "3f9a1c2e", "sha256": "<hex>", "created": "2026-10-10T12:00:00Z",
         "expires": "2027-01-01T00:00:00Z", "revoked": false}]}]}

A key is issued once as `acm_<id>_<secret>`; only sha256(secret) is stored. Lookup is by the
public id, then a constant-time compare of the hash. Rotation = issue a new key, deploy it to
the client, then revoke (or let expire) the old one; both work during the overlap.
"""
import hashlib
import json
import os
import re
import secrets
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional

from satellite_api.timeutils import data_dir

ROLES = ("operator", "readonly")
KEY_RE = re.compile(r"^acm_([0-9a-f]{8})_([A-Za-z0-9_-]{20,})$")


def users_file() -> Path:
    return Path(os.environ.get("API_USERS_FILE") or data_dir() / "api_users.json")


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@dataclass
class Identity:
    user: str
    role: str
    key_id: str

    @property
    def actor(self) -> str:
        return f"user:{self.user}"


class UserStore:
    """Thread-safe, mtime-cached view of the users file."""

    def __init__(self, path: Optional[Path] = None):
        self._path = path
        self._lock = threading.Lock()
        self._mtime: Optional[float] = None
        self._by_key_id: Dict[str, tuple] = {}
        self._data: dict = {"users": []}

    @property
    def path(self) -> Path:
        return self._path or users_file()

    def _reload(self):
        try:
            mtime = self.path.stat().st_mtime
        except OSError:
            self._mtime, self._by_key_id, self._data = None, {}, {"users": []}
            return
        if mtime == self._mtime:
            return
        data = json.loads(self.path.read_text())
        index = {}
        for u in data.get("users", []):
            if u.get("role") not in ROLES:
                continue
            for k in u.get("keys", []):
                index[k["id"]] = (u["user"], u["role"], k)
        self._mtime, self._by_key_id, self._data = mtime, index, data

    def enabled(self) -> bool:
        with self._lock:
            self._reload()
            return bool(self._by_key_id)

    def authenticate(self, presented: str) -> Optional[Identity]:
        m = KEY_RE.match(presented or "")
        if not m:
            return None
        key_id, secret = m.groups()
        with self._lock:
            self._reload()
            entry = self._by_key_id.get(key_id)
        if entry is None:
            secrets.compare_digest(_hash(secret), "0" * 64)       # same work for unknown ids
            return None
        user, role, key = entry
        if not secrets.compare_digest(_hash(secret), key["sha256"]):
            return None
        if key.get("revoked"):
            return None
        expires = _parse_time(key.get("expires"))
        if expires is not None and expires <= _now():
            return None
        return Identity(user=user, role=role, key_id=key_id)


# ── management (used by scripts/apikeys.py) ─────────────────────────────────────
def load(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {"users": []}


def save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
    try:
        os.chmod(tmp, 0o600)                 # hashes only, but still not world-readable
    except OSError:
        pass
    os.replace(tmp, path)


def _user(data: dict, name: str) -> Optional[dict]:
    return next((u for u in data["users"] if u["user"] == name), None)


def add_user(data: dict, name: str, role: str) -> dict:
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,64}", name):
        raise ValueError("user names: letters, digits and _ . @ - (max 64)")
    if _user(data, name):
        raise ValueError(f"user {name} already exists")
    u = {"user": name, "role": role, "keys": []}
    data["users"].append(u)
    return u


def issue_key(data: dict, name: str, expires_days: Optional[float] = 90) -> str:
    """Adds a key to the user and returns the plaintext (shown once)."""
    u = _user(data, name)
    if u is None:
        raise ValueError(f"no user {name}")
    existing = {k["id"] for user in data["users"] for k in user["keys"]}
    key_id = secrets.token_hex(4)
    while key_id in existing:
        key_id = secrets.token_hex(4)
    secret = secrets.token_urlsafe(32)
    now = _now()
    u["keys"].append({
        "id": key_id, "sha256": _hash(secret), "created": now.isoformat().replace("+00:00", "Z"),
        "expires": (now + timedelta(days=expires_days)).isoformat().replace("+00:00", "Z") if expires_days else None,
        "revoked": False,
    })
    return f"acm_{key_id}_{secret}"


def revoke_key(data: dict, key_id: str) -> str:
    for u in data["users"]:
        for k in u["keys"]:
            if k["id"] == key_id:
                k["revoked"] = True
                k["revoked_at"] = _now().isoformat().replace("+00:00", "Z")
                return u["user"]
    raise ValueError(f"no key {key_id}")


def rotate(data: dict, name: str, overlap_days: float = 7, expires_days: Optional[float] = 90) -> str:
    """Issues a new key and schedules the user's other active keys to expire after `overlap_days`."""
    u = _user(data, name)
    if u is None:
        raise ValueError(f"no user {name}")
    cutoff = (_now() + timedelta(days=overlap_days)).isoformat().replace("+00:00", "Z")
    for k in u["keys"]:
        if not k.get("revoked") and (k.get("expires") is None or k["expires"] > cutoff):
            k["expires"] = cutoff
    return issue_key(data, name, expires_days)


def describe(data: dict) -> List[dict]:
    now = _now()
    rows = []
    for u in data["users"]:
        for k in u["keys"] or [{}]:
            exp = _parse_time(k.get("expires")) if k else None
            state = ("revoked" if k.get("revoked") else "expired" if exp and exp <= now else "active") if k else "no keys"
            rows.append({"user": u["user"], "role": u["role"], "key_id": k.get("id"), "created": k.get("created"),
                         "expires": k.get("expires"), "state": state})
    return rows


USERS = UserStore()
