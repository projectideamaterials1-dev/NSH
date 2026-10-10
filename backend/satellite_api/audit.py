"""
audit.py
--------
Append-only audit trail of who changed what: every mutating API request (with its outcome)
and every rejected authentication attempt. Kept in memory for GET /api/audit and, when the
mission archive is enabled, persisted to its `audit_log` table (db.py).
"""
import time
from collections import deque
from typing import Callable, List, Optional

from satellite_api.timeutils import iso_z

MAX_IN_MEMORY = 2000


class AuditLog:
    def __init__(self):
        self.entries: deque = deque(maxlen=MAX_IN_MEMORY)
        self.sinks: List[Callable[[dict], None]] = []
        self._seq = 0

    def record(self, *, actor: str, role: Optional[str], key_id: Optional[str], method: str, path: str,
               status: int, client_ip: str, duration_ms: float, outcome: str) -> dict:
        self._seq += 1
        now = time.time()
        entry = {"seq": self._seq, "ts": now, "time": iso_z(now), "actor": actor, "role": role, "key_id": key_id,
                 "method": method, "path": path, "status": status, "client_ip": client_ip,
                 "duration_ms": round(duration_ms, 1), "outcome": outcome}
        self.entries.append(entry)
        for sink in self.sinks:
            try:
                sink(entry)
            except Exception:       # an archive hiccup must never fail the request being audited
                pass
        return entry

    def recent(self, limit: int = 200, actor: Optional[str] = None) -> List[dict]:
        rows = [e for e in reversed(self.entries) if actor is None or e["actor"] == actor]
        return rows[:limit]


AUDIT = AuditLog()
