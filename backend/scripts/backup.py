"""
Mission-state backup / restore / verify (see satellite_api/backup.py and docs/RUNBOOKS.md).

    python scripts/backup.py backup  --out /backups/acm-$(date +%Y%m%dT%H%M%S)
    python scripts/backup.py verify  --from /backups/acm-20260101T000000
    python scripts/backup.py restore --from /backups/acm-20260101T000000 [--force]
    python scripts/backup.py schedule --out-dir /app/data/backups --every 6h --keep 28 [--once]

Connection settings default to the backend's own: REDIS_URL or REDIS_SENTINELS, ACM_DB_PATH (or DATA_DIR/acm_archive.db)
and DATA_DIR/config.json. Inside the compose stack:

    docker compose -f docker-compose.prod.yml exec backend python scripts/backup.py backup --out /app/data/backups/now
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from satellite_api.backup import BackupError, backup, parse_interval, restore, run_once, verify  # noqa: E402
from satellite_api.timeutils import data_dir  # noqa: E402


def _redis():
    from satellite_api import redis_conn
    return redis_conn.sync_client() if redis_conn.configured() else None


def _schedule(args) -> int:
    interval = parse_interval(args.every)
    while True:
        started = time.monotonic()
        status = run_once(args.out_dir, _redis(), args.db, args.config, args.keep)
        print(json.dumps({k: status.get(k) for k in ("time", "name", "ok", "error", "pruned")}), flush=True)
        if args.once:
            return 0 if status["ok"] else 1
        time.sleep(max(60.0, interval - (time.monotonic() - started)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backup")
    b.add_argument("--out", type=Path, required=True)
    v = sub.add_parser("verify")
    v.add_argument("--from", dest="src", type=Path, required=True)
    r = sub.add_parser("restore")
    r.add_argument("--from", dest="src", type=Path, required=True)
    r.add_argument("--force", action="store_true", help="replace an existing Redis snapshot")
    sc = sub.add_parser("schedule", help="back up + verify + prune on an interval (the `backup` compose service)")
    sc.add_argument("--out-dir", type=Path, required=True)
    sc.add_argument("--every", default="6h", help="interval, e.g. 30m, 6h, 1d")
    sc.add_argument("--keep", type=int, default=28, help="how many scheduled backups to keep locally")
    sc.add_argument("--once", action="store_true", help="run a single cycle and exit")
    for p in (b, r, sc):
        p.add_argument("--db", type=Path, default=Path(os.environ.get("ACM_DB_PATH") or data_dir() / "acm_archive.db"))
        p.add_argument("--config", type=Path, default=data_dir() / "config.json")
    args = parser.parse_args()
    try:
        if args.cmd == "backup":
            result = backup(args.out, _redis(), args.db, args.config)
        elif args.cmd == "verify":
            result = verify(args.src)
        elif args.cmd == "schedule":
            return _schedule(args)
        else:
            result = restore(args.src, _redis(), args.db, args.config, force=args.force)
    except BackupError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
