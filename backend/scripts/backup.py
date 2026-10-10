"""
Mission-state backup / restore / verify (see satellite_api/backup.py and docs/RUNBOOKS.md).

    python scripts/backup.py backup  --out /backups/acm-$(date +%Y%m%dT%H%M%S)
    python scripts/backup.py verify  --from /backups/acm-20260101T000000
    python scripts/backup.py restore --from /backups/acm-20260101T000000 [--force]

Connection settings default to the backend's own: REDIS_URL, ACM_DB_PATH (or DATA_DIR/acm_archive.db)
and DATA_DIR/config.json. Inside the compose stack:

    docker compose -f docker-compose.prod.yml exec backend python scripts/backup.py backup --out /app/data/backups/now
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from satellite_api.backup import BackupError, backup, restore, verify  # noqa: E402
from satellite_api.timeutils import data_dir  # noqa: E402


def _redis():
    url = os.environ.get("REDIS_URL")
    if not url:
        return None
    import redis
    return redis.Redis.from_url(url, decode_responses=False)


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
    for p in (b, r):
        p.add_argument("--db", type=Path, default=Path(os.environ.get("ACM_DB_PATH") or data_dir() / "acm_archive.db"))
        p.add_argument("--config", type=Path, default=data_dir() / "config.json")
    args = parser.parse_args()
    try:
        if args.cmd == "backup":
            result = backup(args.out, _redis(), args.db, args.config)
        elif args.cmd == "verify":
            result = verify(args.src)
        else:
            result = restore(args.src, _redis(), args.db, args.config, force=args.force)
    except BackupError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
