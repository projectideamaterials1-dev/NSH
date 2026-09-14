from datetime import datetime, timezone

import numpy as np

from satellite_api.coordinates import convert_states_to_lla, datetime_to_julian
from satellite_api.timeutils import iso_z, parse_iso_utc


def test_julian_date_j2000():
    assert datetime_to_julian(datetime(2000, 1, 1, 12, tzinfo=timezone.utc)) == 2451545.0


def test_iso_z_is_valid_iso8601():
    s = iso_z(datetime(2026, 1, 1, 0, 0, 10, 123456, tzinfo=timezone.utc))
    assert s == "2026-01-01T00:00:10.123Z"
    assert parse_iso_utc(s).timestamp() == datetime(2026, 1, 1, 0, 0, 10, 123000, tzinfo=timezone.utc).timestamp()


def test_naive_timestamps_are_utc():
    assert parse_iso_utc("2026-01-01T00:00:00").tzinfo is not None
    assert parse_iso_utc("2026-01-01T00:00:00") == parse_iso_utc("2026-01-01T00:00:00Z")


def test_lla_altitude_and_latitude():
    t = datetime(2026, 1, 1, tzinfo=timezone.utc)
    lla = convert_states_to_lla(np.array([[0.0, 0.0, 7000.0]]), t)
    _, lat, _, alt = lla[0]
    assert abs(lat - 90.0) < 1e-6
    assert abs(alt - (7000.0 - 6356.752)) < 0.01
