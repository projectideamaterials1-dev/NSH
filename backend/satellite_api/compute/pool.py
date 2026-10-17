"""
compute/pool.py
---------------
Worker processes for the autopilot's CPU-heavy, self-contained work: planning, post-burn verification of
avoidance plans and collision probability.

Why processes: the backend is one Python process, and Python runs one thread of Python code at a time, so
planning and verification competed with the clock tick, the telemetry stream and every API call for a
single core. With the whole active catalog as the fleet that showed up as multi-second pauses. Each worker
is a separate process on its own core.

Workers are started with "spawn" (a fresh interpreter, not a copy of this process, which holds the CUDA
context) and run CPU-only, so they never compete for the GPU's memory. Every job carries a snapshot of the
physics context - the live CONFIG and drag model - so a worker computes with exactly the settings this
process uses, even after runtime changes. That context is also where a non-Earth central body's parameters
will travel when other bodies are added.

The functions submitted here take and return plain data, so this layer can later become a separate
service (a queue in front of the same functions) without changing them.

ACM_WORKERS sets the number of processes (default: CPU cores - 2, at most 6); 0 runs everything in
threads in this process instead.
"""

import asyncio
import json
import logging
import multiprocessing
import os
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

_pool: Optional[ProcessPoolExecutor] = None
_disabled_reason: Optional[str] = None


def worker_count() -> int:
    raw = os.environ.get("ACM_WORKERS")
    if raw is not None and raw.strip() != "":
        return max(0, int(raw))
    return max(0, min(6, (os.cpu_count() or 2) - 2))


def _init_worker():
    # Before any satellite_api physics module is imported in this process: CPU engine only.
    os.environ["ACM_ENGINE"] = "cpp"
    os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
    os.environ["ACM_STALL_LOG_S"] = "0"


def _get_pool() -> Optional[ProcessPoolExecutor]:
    global _pool
    if _pool is None and _disabled_reason is None and worker_count() > 0:
        _pool = ProcessPoolExecutor(max_workers=worker_count(), mp_context=multiprocessing.get_context("spawn"),
                                    initializer=_init_worker)
        logger.info(f"Compute pool: {worker_count()} worker process(es)")
    return _pool


def physics_context() -> dict:
    """What a worker needs to compute exactly like this process: live CONFIG and the drag model."""
    from satellite_api.config import CONFIG
    from satellite_api.physics_engine import _drag
    return {"config": CONFIG.to_dict(), "drag": dict(_drag)}


_applied_key: Optional[str] = None


def _apply_context(ctx: dict) -> None:
    global _applied_key
    key = json.dumps(ctx, sort_keys=True, default=str)
    if key == _applied_key:
        return
    from satellite_api.config import CONFIG
    from satellite_api.physics_engine import configure_drag
    for name, value in ctx["config"].items():      # copied, not re-validated: it was valid where it came from
        if hasattr(CONFIG, name):
            setattr(CONFIG, name, value)
    drag = ctx["drag"]
    configure_drag(drag["enabled"], drag["ballistic"], drag["scale"])
    _applied_key = key


def _call(fn: Callable, ctx: dict, args: tuple, kwargs: dict) -> Any:
    _apply_context(ctx)
    return fn(*args, **kwargs)


async def run(fn: Callable, *args, **kwargs) -> Any:
    """Runs fn(*args, **kwargs) in a worker process (in a thread when the pool is off or broken)."""
    global _pool, _disabled_reason
    pool = _get_pool()
    if pool is None:
        return await asyncio.to_thread(fn, *args, **kwargs)
    try:
        return await asyncio.get_running_loop().run_in_executor(pool, _call, fn, physics_context(), args, kwargs)
    except BrokenProcessPool as e:
        # A worker died (e.g. killed for memory): keep the autopilot running in threads instead.
        _disabled_reason = f"worker process died ({e})"
        logger.error(f"Compute pool disabled, falling back to threads: {_disabled_reason}")
        _pool = None
        return await asyncio.to_thread(fn, *args, **kwargs)


def info() -> dict:
    return {"workers": worker_count() if _disabled_reason is None else 0, "started": _pool is not None,
            "disabled_reason": _disabled_reason}


def shutdown() -> None:
    global _pool
    if _pool is not None:
        _pool.shutdown(wait=False, cancel_futures=True)
        _pool = None
