"""
compute/planning.py
-------------------
Runs the autopilot planner (AutonomousBrain.plan_evasion) in a worker process - see compute/pool.py.
The planner keeps state between cycles (which satellites are mid-sequence, the station-keeping cursor):
it travels with the job and comes back with the plans, and the caller copies it into its own brain.
"""


def plan(brain, *args, **kwargs):
    """Returns (brain after planning, plans)."""
    plans = brain.plan_evasion(*args, **kwargs)
    return brain, plans
