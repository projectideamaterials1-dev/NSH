"""CCSDS OEM export: predicted ephemeris with the queued burns applied, one segment per burn."""
import numpy as np
import pytest

from satellite_api.acm.scenario import circular_state_over
from satellite_api.ground_stations import STATIONS
from satellite_api.main import app
from satellite_api.state import _unpack_maneuver
from satellite_api.timeutils import iso_z
from tests.conftest import make_object

T0 = 1767225600.0


def _data_lines(text: str):
    return [l.split() for l in text.splitlines() if l[:4].isdigit()]


@pytest.mark.asyncio
async def test_oem_contains_the_post_burn_arc_in_its_own_segment(client):
    sat = circular_state_over(STATIONS[0].latitude, STATIONS[0].longitude, T0)
    r = await client.post("/api/telemetry", json={"timestamp": iso_z(T0),
                                                  "objects": [make_object("SAT-A", "SATELLITE", sat[:3], sat[3:])]})
    assert r.status_code == 200
    state = app.state.orbital_state
    async with state.lock:
        state.maneuver_queue.append(_unpack_maneuver((T0 + 1800.0, "SAT-A", 0.0, 0.0, 0.002, "BURN-1")))

    resp = await client.get("/api/export/oem/SAT-A", params={"hours": 1, "step_seconds": 300})
    assert resp.status_code == 200 and 'filename="SAT-A.oem"' in resp.headers["content-disposition"]
    text = resp.text
    assert text.startswith("CCSDS_OEM_VERS = 2.0")
    assert text.count("META_START") == 2 and "REF_FRAME = TEME" in text
    assert "Planned impulsive burn at 2026-01-01T00:30:00.000" in text and "(2.0000 m/s)" in text

    rows = _data_lines(text)
    # 0, 5, ..., 30 min in the first segment; 30, 35, ..., 60 min in the second.
    assert [row[0] for row in rows].count("2026-01-01T00:30:00.000") == 2
    first = np.array(rows[0][1:], dtype=float)
    assert first == pytest.approx(np.asarray(sat, dtype=float), abs=1e-6)
    pre, post = (np.array(row[1:], dtype=float) for row in rows if row[0] == "2026-01-01T00:30:00.000")
    assert post[:3] == pytest.approx(pre[:3], abs=1e-9)                 # same position at the boundary
    assert post[5] - pre[5] == pytest.approx(0.002, abs=1e-9)            # +2 m/s in z


@pytest.mark.asyncio
async def test_oem_unknown_satellite_is_404(client):
    sat = circular_state_over(0.0, 0.0, T0)
    await client.post("/api/telemetry", json={"timestamp": iso_z(T0),
                                              "objects": [make_object("SAT-A", "SATELLITE", sat[:3], sat[3:])]})
    assert (await client.get("/api/export/oem/NOPE")).status_code == 404
