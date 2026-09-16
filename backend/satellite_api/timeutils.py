"""
timeutils.py
------------
Shared helpers for ISO-8601 parsing/formatting and data-file resolution.
"""
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Union


def parse_iso_utc(value: str) -> datetime:
    """Parses an ISO-8601 string (with or without 'Z') into an aware UTC datetime.

    Naive timestamps are interpreted as UTC rather than local time.
    """
    dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso_z(value: Union[datetime, float], millis: bool = True) -> str:
    """Formats a datetime or POSIX timestamp as 'YYYY-MM-DDTHH:MM:SS.sssZ'."""
    if not isinstance(value, datetime):
        value = datetime.fromtimestamp(value, tz=timezone.utc)
    elif value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc)
    if millis:
        return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def data_dir() -> Path:
    """Locates the project data directory.

    Order: $DATA_DIR, <repo>/data (source checkout), ./data (working directory).
    """
    env = os.environ.get("DATA_DIR")
    if env:
        return Path(env)
    repo_data = Path(__file__).resolve().parent.parent / "data"
    if repo_data.is_dir():
        return repo_data
    return Path.cwd() / "data"
