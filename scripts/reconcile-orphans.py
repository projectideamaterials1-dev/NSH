"""Closes mission-archive burns that were accepted but never got an outcome and are no longer queued.

Such "orphans" appear when the queue is lost without recording what happened to its burns (a crash, or the
saved mission state being cleared). They are marked cancelled with reason RECONCILED_ORPHAN; burns that are
still in the live queue are left alone. The archive is backed up first (SQLite online backup).

Run inside the backend container (it reads the live queue from the backend's own API):
    docker compose -f docker-compose.prod.yml exec -T backend python - < scripts/reconcile-orphans.py
Add DRY_RUN=1 (docker compose exec -e DRY_RUN=1 ...) to only list what would change.
"""
import datetime
import json
import os
import sqlite3
import urllib.request

from satellite_api.db import DB_PATH

DRY_RUN = os.environ.get("DRY_RUN", "0") not in ("0", "", "false")
now = datetime.datetime.now(datetime.timezone.utc)

key = next((k.strip() for var in ("API_KEYS_READONLY", "API_KEYS_OPERATOR")
            for k in os.environ.get(var, "").split(",") if k.strip()), "")
req = urllib.request.Request("http://127.0.0.1:8000/api/maneuvers?status=pending", headers={"X-API-Key": key})
queued = {m["burn_id"] for m in json.load(urllib.request.urlopen(req, timeout=300))["maneuvers"]}

conn = sqlite3.connect(DB_PATH, timeout=30)
rows = conn.execute("""
    SELECT p.burn_id, p.sat_id, p.ts, p.dvx, p.dvy, p.dvz FROM pending_maneuvers p
    WHERE NOT EXISTS (SELECT 1 FROM maneuver_history h
                      WHERE h.burn_id = p.burn_id AND h.status IN ('executed', 'rejected', 'cancelled'))
""").fetchall()
orphans = [r for r in rows if r[0] not in queued]
print(f"{len(rows)} burn(s) without an outcome: {len(rows) - len(orphans)} still queued (kept), {len(orphans)} orphaned")
for r in orphans:
    print(f"  {r[0]}")

if DRY_RUN or not orphans:
    print("Dry run: nothing changed." if DRY_RUN else "Nothing to do.")
else:
    backup = os.path.join(os.path.dirname(DB_PATH), "backups", f"acm_archive.pre-reconcile-{now:%Y%m%dT%H%M%S}.db")
    os.makedirs(os.path.dirname(backup), exist_ok=True)
    dst = sqlite3.connect(backup)
    conn.backup(dst)
    dst.close()
    print(f"Backup: {backup}")
    with conn:
        for burn_id, sat_id, ts, dvx, dvy, dvz in orphans:
            conn.execute("""
                INSERT OR REPLACE INTO maneuver_history
                (burn_id, satellite_id, burnTime, dvx, dvy, dvz, status, reason, actor, recorded_at)
                VALUES (?, ?, ?, ?, ?, ?, 'cancelled', 'RECONCILED_ORPHAN', 'operator reconcile', ?)
            """, (burn_id, sat_id, ts, dvx, dvy, dvz, now.isoformat()))
            conn.execute("DELETE FROM pending_maneuvers WHERE burn_id = ?", (burn_id,))
    print(f"Marked {len(orphans)} orphaned burn(s) cancelled.")
conn.close()
