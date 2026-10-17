"""Named users, key rotation/revocation/expiry and the audit trail."""
import json
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from satellite_api.audit import AUDIT
from satellite_api.middleware import identity
from satellite_api.middleware.auth import APIKeyMiddleware


@pytest.fixture
def users(tmp_path, monkeypatch):
    path = tmp_path / "api_users.json"
    monkeypatch.setenv("API_USERS_FILE", str(path))
    data = {"users": []}
    identity.add_user(data, "alice", "operator")
    identity.add_user(data, "bob", "readonly")
    keys = {"alice": identity.issue_key(data, "alice"), "bob": identity.issue_key(data, "bob")}
    identity.save(path, data)
    yield path, keys


def _app():
    from fastapi import FastAPI, Request
    app = FastAPI()

    @app.get("/api/thing")
    async def read(request: Request):
        return {"actor": request.state.actor, "role": request.state.role}

    @app.post("/api/thing")
    async def write(request: Request):
        return {"actor": request.state.actor}

    app.add_middleware(APIKeyMiddleware, operator_keys=frozenset(), readonly_keys=frozenset(),
                       users=identity.UserStore())
    return app


async def _call(method, key=None):
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url="http://t") as c:
        headers = {"X-API-Key": key} if key else {}
        return await c.request(method, "/api/thing", headers=headers)


@pytest.mark.asyncio
async def test_named_users_are_authenticated_and_audited(users):
    _, keys = users
    AUDIT.entries.clear()
    ok = await _call("POST", keys["alice"])
    assert ok.status_code == 200 and ok.json()["actor"] == "user:alice"
    assert (await _call("GET", keys["bob"])).json() == {"actor": "user:bob", "role": "readonly"}
    assert (await _call("POST", keys["bob"])).status_code == 403
    assert (await _call("POST")).status_code == 401
    assert (await _call("GET", keys["alice"][:-1] + "x")).status_code == 401

    trail = AUDIT.recent()
    outcomes = [(e["actor"], e["method"], e["status"], e["outcome"]) for e in trail]
    assert ("user:alice", "POST", 200, "ok") in outcomes
    assert ("user:bob", "POST", 403, "read-only key") in outcomes
    assert ("unauthenticated", "POST", 401, "missing key") in outcomes
    assert ("unauthenticated", "GET", 401, "rejected key") in outcomes
    assert not any(e["method"] == "GET" and e["status"] == 200 for e in trail)     # reads are not audited
    assert all(keys["alice"] not in json.dumps(e) for e in trail)                   # secrets never logged


@pytest.mark.asyncio
async def test_rotation_revocation_and_expiry_apply_without_restart(users):
    path, keys = users
    data = identity.load(path)
    new_key = identity.rotate(data, "alice", overlap_days=7)
    identity.save(path, data)
    # During the overlap both keys work.
    assert (await _call("POST", keys["alice"])).status_code == 200
    assert (await _call("POST", new_key)).status_code == 200

    old_id = identity.KEY_RE.match(keys["alice"]).group(1)
    identity.revoke_key(data, old_id)
    identity.save(path, data)
    assert (await _call("POST", keys["alice"])).status_code == 401
    assert (await _call("POST", new_key)).status_code == 200

    new_id = identity.KEY_RE.match(new_key).group(1)
    for u in data["users"]:
        for k in u["keys"]:
            if k["id"] == new_id:
                k["expires"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    identity.save(path, data)
    assert (await _call("POST", new_key)).status_code == 401
    states = {r["key_id"]: r["state"] for r in identity.describe(identity.load(path))}
    assert states[old_id] == "revoked" and states[new_id] == "expired"


def test_cli_issue_and_list(tmp_path, capsys):
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("apikeys", Path(__file__).resolve().parents[2] / "scripts" / "apikeys.py")
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    f = str(tmp_path / "u.json")
    assert cli.main(["--file", f, "add-user", "carol", "--role", "operator"]) == 0
    assert cli.main(["--file", f, "issue", "carol", "--expires-days", "30"]) == 0
    # The key line, not just the last line: background threads (archive writer, stall detector) log JSON
    # to stdout too and can interleave with the CLI's output.
    key = next((line for line in reversed(capsys.readouterr().out.strip().splitlines())
                if identity.KEY_RE.match(line)), "")
    assert identity.KEY_RE.match(key)
    stored = json.loads((tmp_path / "u.json").read_text())
    assert key.split("_")[2] not in json.dumps(stored)                              # only the hash is stored
    assert cli.main(["--file", f, "add-user", "carol", "--role", "operator"]) == 1   # duplicate
    assert cli.main(["--file", f, "list"]) == 0


@pytest.mark.asyncio
async def test_audit_endpoint_and_decision_archive(client, tmp_path):
    from satellite_api.db import MissionArchive
    from satellite_api.main import app
    archive = MissionArchive(str(tmp_path / "a.db")).attach(app.state.orbital_state)
    app.state.archive = archive
    AUDIT.sinks.append(lambda e: archive.handle("audit", e))
    try:
        await client.post("/api/config", json={"maxDeltaV": 14})
        entries = (await client.get("/api/audit")).json()
        assert entries["source"] == "archive"
        assert any(e["path"] == "/api/config" and e["method"] == "POST" for e in entries["entries"])
        app.state.orbital_state.record_decision(satellite_id="S", kind="EVASION", outcome="SCHEDULED",
                                                rationale="test", actor="autopilot")
        archive.flush()
        rows = [tuple(r) for r in archive._reader().execute("SELECT outcome, rationale FROM decisions").fetchall()]
        assert ("SCHEDULED", "test") in rows
    finally:
        AUDIT.sinks.clear()
        app.state.archive = None
        archive.close()
