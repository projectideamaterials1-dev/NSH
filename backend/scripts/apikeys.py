"""
API users and keys (see satellite_api/middleware/identity.py).

    python scripts/apikeys.py add-user  alice --role operator
    python scripts/apikeys.py issue     alice [--expires-days 90]     # prints the key ONCE
    python scripts/apikeys.py rotate    alice [--overlap-days 7]      # new key; old ones expire after the overlap
    python scripts/apikeys.py revoke    <key-id>
    python scripts/apikeys.py list

The backend re-reads the users file on change, so issuing, rotating and revoking take effect
without a restart. File: API_USERS_FILE or <DATA_DIR>/api_users.json. Inside the compose stack:

    docker compose -f docker-compose.prod.yml exec backend python3 scripts/apikeys.py list
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from satellite_api.middleware import identity  # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--file", type=Path, default=None, help="users file (default: API_USERS_FILE / data dir)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add-user")
    a.add_argument("user")
    a.add_argument("--role", choices=identity.ROLES, required=True)
    i = sub.add_parser("issue")
    i.add_argument("user")
    i.add_argument("--expires-days", type=float, default=90.0, help="0 = never expires")
    r = sub.add_parser("rotate")
    r.add_argument("user")
    r.add_argument("--overlap-days", type=float, default=7.0)
    r.add_argument("--expires-days", type=float, default=90.0)
    v = sub.add_parser("revoke")
    v.add_argument("key_id")
    sub.add_parser("list")
    args = parser.parse_args(argv)

    path = args.file or identity.users_file()
    data = identity.load(path)
    try:
        if args.cmd == "add-user":
            identity.add_user(data, args.user, args.role)
            print(f"added {args.user} ({args.role}); issue a key with: apikeys.py issue {args.user}")
        elif args.cmd == "issue":
            key = identity.issue_key(data, args.user, args.expires_days or None)
            print(key)
            print("Store this key now - it cannot be shown again.", file=sys.stderr)
        elif args.cmd == "rotate":
            key = identity.rotate(data, args.user, args.overlap_days, args.expires_days or None)
            print(key)
            print(f"New key issued; the previous keys of {args.user} stop working in {args.overlap_days:g} days.",
                  file=sys.stderr)
        elif args.cmd == "revoke":
            print(f"revoked {args.key_id} (user {identity.revoke_key(data, args.key_id)})")
        else:
            print(json.dumps(identity.describe(data), indent=2))
            return 0
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    identity.save(path, data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
