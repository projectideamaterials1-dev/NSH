"""
Propagator validation report: engine (RK4 + J2, with and without drag) vs SGP4.

    python scripts/validate_propagation.py            # uses tests/fixtures/celestrak_sample.json
    python scripts/validate_propagation.py --out ../docs/validation

Writes propagation_vs_sgp4.csv and propagation_vs_sgp4.svg (a dependency-free line chart).
"""
import argparse
import csv
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from satellite_api.realworld.catalog import parse_records  # noqa: E402
from satellite_api.realworld.validation import DEFAULT_HOURS, compare_with_sgp4  # noqa: E402

FIXTURE = HERE.parent / "tests" / "fixtures" / "celestrak_sample.json"
TARGETS = [("stations", "ISS (ZARYA)"), ("stations", "CSS (TIANHE)"), ("cosmos-2251-debris", "COSMOS 2251")]
COLORS = ["#2a78d6", "#d6732a", "#3b9b4f"]


def run(fixture: Path):
    records = json.loads(fixture.read_text())
    rows = []
    for source, name in TARGETS:
        obj = next(o for o in parse_records(records[source], source) if o.name == name)
        for drag in (True, False):
            for r in compare_with_sgp4(obj.satrec, DEFAULT_HOURS, drag=drag):
                rows.append({"object": name, "drag": drag, **r})
    return rows


def svg_chart(rows) -> str:
    w, h, left, right, top, bottom = 760, 420, 64, 200, 24, 48
    max_err = max(r["error_km"] for r in rows) * 1.08
    max_h = max(DEFAULT_HOURS)

    def x(hours):
        return left + (w - left - right) * hours / max_h

    def y(err):
        return top + (h - top - bottom) * (1 - err / max_err)

    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" font-family="system-ui,sans-serif" '
             f'font-size="12"><rect width="{w}" height="{h}" fill="#fff"/>']
    for k in range(6):
        err = max_err * k / 5
        parts.append(f'<line x1="{left}" x2="{w - right}" y1="{y(err):.1f}" y2="{y(err):.1f}" stroke="#e5e7eb"/>'
                     f'<text x="{left - 8}" y="{y(err) + 4:.1f}" text-anchor="end" fill="#555">{err:.1f}</text>')
    for hours in (0, 6, 12, 18, 24):
        parts.append(f'<text x="{x(hours):.1f}" y="{h - bottom + 18}" text-anchor="middle" fill="#555">{hours} h</text>')
    parts.append(f'<text x="14" y="{top + (h - top - bottom) / 2}" transform="rotate(-90 14 {top + (h - top - bottom) / 2})" '
                 f'text-anchor="middle" fill="#333">position error vs SGP4 (km)</text>')
    legend_y = top + 6
    for color, (_, name) in zip(COLORS, TARGETS):
        for drag in (True, False):
            series = [r for r in rows if r["object"] == name and r["drag"] == drag]
            pts = " ".join([f"{x(0):.1f},{y(0):.1f}"] + [f"{x(r['hours']):.1f},{y(r['error_km']):.1f}" for r in series])
            dash = "" if drag else ' stroke-dasharray="5 4"'
            parts.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2"{dash}/>')
            label = f"{name} {'(drag)' if drag else '(no drag)'}"
            parts.append(f'<line x1="{w - right + 14}" x2="{w - right + 36}" y1="{legend_y}" y2="{legend_y}" '
                         f'stroke="{color}" stroke-width="2"{dash}/><text x="{w - right + 42}" y="{legend_y + 4}" '
                         f'fill="#333">{label}</text>')
            legend_y += 20
    parts.append("</svg>")
    return "".join(parts)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    parser.add_argument("--out", type=Path, default=HERE.parent.parent / "docs" / "validation")
    args = parser.parse_args()
    rows = run(args.fixture)
    args.out.mkdir(parents=True, exist_ok=True)
    with open(args.out / "propagation_vs_sgp4.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["object", "drag", "hours", "error_km"])
        writer.writeheader()
        writer.writerows({**r, "error_km": round(r["error_km"], 4)} for r in rows)
    (args.out / "propagation_vs_sgp4.svg").write_text(svg_chart(rows))
    for r in rows:
        if r["hours"] in (6, 24):
            print(f"{r['object']:<14} drag={str(r['drag']):<5} {r['hours']:>4.0f} h  {r['error_km']:.3f} km")


if __name__ == "__main__":
    main()
