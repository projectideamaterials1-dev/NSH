#!/usr/bin/env python3
"""
Crimson Nebula demo mission
===========================
Seeds a running backend with a Walker-style constellation and a debris field, plants a handful
of genuine collision threats (debris placed on a ~50 m miss trajectory, timed so the target has
ground-station contact before closest approach), then advances the simulation so the autopilot
can be watched detecting, avoiding and resolving them in the dashboard.

    python3 scripts/demo.py                      # seed + run until Ctrl+C
    python3 scripts/demo.py --no-step            # seed only (use the dashboard's Run button)
    python3 scripts/demo.py --url http://host:8000 --threats 8 --speed 120
"""
import argparse
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import requests

# Windows consoles default stdout to the system codepage (e.g. cp1252), which cannot
# encode the arrow character used below and crashes the run right after seeding.
# reconfigure() (Python 3.7+) is a no-op failure-mode-safe way to force UTF-8 everywhere.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from satellite_api.acm.scenario import make_threat  # noqa: E402

MU, RE = 398600.4418, 6378.137


def orbit_state(alt_km: float, inc_deg: float, raan: float, u: float) -> np.ndarray:
    r = RE + alt_km
    v = math.sqrt(MU / r)
    i = math.radians(inc_deg)
    pos = np.array([math.cos(raan) * math.cos(u) - math.sin(raan) * math.sin(u) * math.cos(i),
                    math.sin(raan) * math.cos(u) + math.cos(raan) * math.sin(u) * math.cos(i),
                    math.sin(u) * math.sin(i)]) * r
    vel = np.array([-math.cos(raan) * math.sin(u) - math.sin(raan) * math.cos(u) * math.cos(i),
                    -math.sin(raan) * math.sin(u) + math.cos(raan) * math.cos(u) * math.cos(i),
                    math.cos(u) * math.sin(i)]) * v
    return np.concatenate([pos, vel])


def obj(obj_id: str, obj_type: str, vec: np.ndarray) -> dict:
    return {"id": obj_id, "type": obj_type, "r": dict(zip("xyz", map(float, vec[:3]))),
            "v": dict(zip("xyz", map(float, vec[3:])))}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default=os.environ.get("ACM_BASE_URL", "http://127.0.0.1:8000"))
    p.add_argument("--satellites", type=int, default=50)
    p.add_argument("--planes", type=int, default=5)
    p.add_argument("--debris", type=int, default=10000)
    p.add_argument("--threats", type=int, default=6)
    p.add_argument("--speed", type=float, default=60.0, help="simulated seconds per real second")
    p.add_argument("--tick", type=float, default=0.5, help="real seconds between steps")
    p.add_argument("--no-step", action="store_true", help="seed only; do not advance the simulation")
    p.add_argument("--seed", type=int, default=2026)
    args = p.parse_args()

    http = requests.Session()
    if os.environ.get("API_KEY"):
        http.headers["X-API-Key"] = os.environ["API_KEY"]
    base = args.url.rstrip("/")
    rng = np.random.default_rng(args.seed)

    try:
        health = http.get(f"{base}/health", timeout=5).json()
    except requests.RequestException:
        sys.exit(f"Backend not reachable at {base}. Start it with: uvicorn satellite_api.main:app --port 8000")
    print(f"Backend online · engine={health.get('engine')} · autopilot={health.get('autopilot')}")

    t0 = datetime.now(timezone.utc).replace(microsecond=0)
    t0_iso = t0.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    # ── constellation + debris ────────────────────────────────────────────────
    per_plane = max(1, args.satellites // args.planes)
    sats = {}
    for plane in range(args.planes):
        for k in range(per_plane):
            sid = f"SAT-{len(sats):03d}"
            sats[sid] = orbit_state(550.0, 53.0, 2 * math.pi * plane / args.planes,
                                    2 * math.pi * k / per_plane + plane * math.pi / (args.planes * per_plane))
    objects = [obj(sid, "SATELLITE", vec) for sid, vec in sats.items()]
    for d in range(args.debris):
        vec = orbit_state(rng.uniform(420, 880), rng.uniform(0, 100), rng.uniform(0, 2 * math.pi), rng.uniform(0, 2 * math.pi))
        objects.append(obj(f"DEB-{d:05d}", "DEBRIS", vec))

    t = time.perf_counter()
    ack = http.post(f"{base}/api/telemetry", json={"timestamp": t0_iso, "objects": objects}, timeout=120)
    ack.raise_for_status()
    print(f"Ingested {len(sats)} satellites + {args.debris} debris in {time.perf_counter() - t:.1f}s")

    # ── plant threats on satellites that will be in contact before closest approach ─
    candidates = []
    for sid in sats:
        passes = http.get(f"{base}/api/satellites/{sid}/passes", params={"hours": 1.5}, timeout=30).json()["passes"]
        first = next((ps for ps in passes if not ps["in_progress"]), None)
        if first:
            start = datetime.fromisoformat(first["start"].replace("Z", "+00:00"))
            lead = (start - t0).total_seconds()
            if 120 <= lead <= 3600:
                candidates.append((lead, sid, first["station_name"]))
    rng.shuffle(candidates)
    threats = []
    for lead, sid, station in sorted(candidates[: args.threats]):
        tca_s = lead + rng.uniform(900, 1500)            # contact first, closest approach 15–25 min later
        miss = rng.uniform(0.02, 0.08)
        vec = make_threat(sats[sid], tca_s, miss, rng.uniform(60, 150))
        threat_id = f"DEB-THREAT-{len(threats) + 1:02d}"
        threats.append(obj(threat_id, "DEBRIS", vec))
        print(f"  threat {threat_id} → {sid}: {miss * 1000:.0f} m miss at "
              f"{(t0 + timedelta(seconds=tca_s)).strftime('%H:%M:%S')}Z (contact via {station.replace('_', ' ')} "
              f"in {lead / 60:.0f} min)")
    if threats:
        http.post(f"{base}/api/telemetry", json={"timestamp": t0_iso, "objects": threats}, timeout=30).raise_for_status()
    screen = http.post(f"{base}/api/conjunctions/screen", timeout=300).json()
    print(f"Initial screen: {screen.get('predictions', 0)} predictions, {screen.get('new', 0)} new CDMs "
          f"({screen.get('duration_s', '?')}s)")

    if args.no_step:
        print("Seeded. Press Run in the dashboard to start the simulation.")
        return

    # ── run ───────────────────────────────────────────────────────────────────
    step_s = args.speed * args.tick
    print(f"Running at {args.speed:g}× ({step_s:g} s per step every {args.tick:g}s). Ctrl+C to stop.")
    last_event = 0
    try:
        while True:
            started = time.perf_counter()
            http.post(f"{base}/api/simulate/step", json={"step_seconds": step_s}, timeout=60).raise_for_status()
            events = http.get(f"{base}/api/events", params={"after_id": last_event}, timeout=10).json()
            for e in events["events"]:
                if e["level"] in ("crit", "warn", "ok") and e["category"] in ("conjunction", "autopilot", "collision", "eol"):
                    print(f"  [{(e['sim_time'] or '')[11:19]}] {e['level'].upper():4} {e['satellite_id'] or '':8} {e['message']}")
            last_event = events["last_id"]
            time.sleep(max(0.0, args.tick - (time.perf_counter() - started)))
    except KeyboardInterrupt:
        m = http.get(f"{base}/api/metrics", timeout=10).json()
        print(f"\nStopped. Avoided {m['collisions_avoided']} · collisions {m['collisions_detected']} · "
              f"fuel used {m['fuel_used_kg']:.3f} kg · uptime {m['station_keeping']['time_weighted_uptime_percentage']:.2f}%")


if __name__ == "__main__":
    main()
