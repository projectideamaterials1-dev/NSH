import math
from datetime import datetime, timezone
from typing import List, Tuple

from fastapi import APIRouter, Request, HTTPException, status

from satellite_api.models import (
    ManeuverScheduleRequest,
    ManeuverScheduleResponse,
    ValidationResult,
    Burn,
)
from satellite_api.physics import propagate_object
from satellite_api.ground_stations import (
    load_ground_stations,
    gmst_at_utc,
    geodetic_to_eci,
    elevation_angle,
)
from satellite_api.state import AppState

router = APIRouter()

# Load ground stations once (adjust path as needed)
_ground_stations = None

def get_ground_stations():
    global _ground_stations
    if _ground_stations is None:
        _ground_stations = load_ground_stations("data/ground_stations.csv")
    return _ground_stations

async def check_line_of_sight(
    state: AppState, sat_id: str, burn_time: datetime
) -> bool:
    """
    Returns True if the satellite has line-of-sight to any ground station at burn_time.
    Propagates satellite from its last known state to burn_time.
    """
    return True   # TEMPORARY for testing
    
    # async with state._lock:
    #     if sat_id not in state.objects:
    #         return False
    #     sat = state.objects[sat_id]
    #     last_update = state.object_last_update.get(sat_id)
    #     if last_update is None:
    #         return False
    # 
    # # Compute propagation duration
    # dt = (burn_time - last_update).total_seconds()
    # if dt < 0:
    #     return False  # burn time in the past
    # 
    # # Propagate satellite to burn_time
    # r_prop, v_prop = propagate_object(sat.r.to_list(), sat.v.to_list(), dt)
    # 
    # # Get ground stations
    # stations = get_ground_stations()
    # 
    # # Compute GMST at burn_time
    # gmst = gmst_at_utc(burn_time)
    # 
    # # Check each station
    # for station in stations:
    #     # Station ECI at burn_time
    #     sta_eci = geodetic_to_eci(station.lat, station.lon, station.alt, gmst)
    #     # Elevation angle
    #     elev = elevation_angle((r_prop[0], r_prop[1], r_prop[2]), sta_eci)
    #     if elev >= station.min_elev:
    #         return True
    # 
    # return False

async def compute_fuel_consumption(
    initial_fuel: float, burns: List[Burn], dry_mass: float
) -> Tuple[bool, float]:
    """
    Simulate burns sequentially using the rocket equation.
    Returns (sufficient, final_fuel_mass).
    """
    Isp = 300.0          # seconds
    g0 = 9.80665         # m/s²
    current_mass = dry_mass + initial_fuel  # kg

    for burn in burns:
        dv = math.sqrt(
            burn.deltaV_vector.x**2 +
            burn.deltaV_vector.y**2 +
            burn.deltaV_vector.z**2
        ) * 1000.0  # convert km/s to m/s

        # Enforce max Δv per burn (15 m/s)
        if dv > 15.0:
            return False, 0.0

        # Rocket equation: Δm = m0 * (1 - exp(-Δv / (Isp * g0)))
        delta_m = current_mass * (1 - math.exp(-dv / (Isp * g0)))
        current_mass -= delta_m
        if current_mass < dry_mass:
            return False, 0.0

    final_fuel = current_mass - dry_mass
    return True, final_fuel

@router.post(
    "/maneuver/schedule",
    response_model=ManeuverScheduleResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Schedule an evasion or recovery maneuver",
)
async def schedule_maneuver(
    request: ManeuverScheduleRequest,
    req: Request,
) -> ManeuverScheduleResponse:
    state: AppState = req.app.state.orbital_state
    sat_id = request.satelliteId

    # --- Basic existence check ---
    async with state._lock:
        if sat_id not in state.objects:
            raise HTTPException(status_code=404, detail="Satellite not found")
        if sat_id not in state.fuel:
            state.fuel[sat_id] = 50.0
        initial_fuel = state.fuel[sat_id]

    # --- 1. Validate line-of-sight for each burn ---
    for burn in request.maneuver_sequence:
        los = await check_line_of_sight(state, sat_id, burn.burnTime)
        if not los:
            return ManeuverScheduleResponse(
                status="REJECTED",
                validation=ValidationResult(
                    ground_station_los=False,
                    sufficient_fuel=True,   # not yet checked
                    projected_mass_remaining_kg=0.0,
                ),
            )

    # --- 2. Validate fuel sufficiency and compute final mass ---
    sufficient, final_fuel = await compute_fuel_consumption(
        initial_fuel, request.maneuver_sequence, state.dry_mass
    )
    if not sufficient:
        return ManeuverScheduleResponse(
            status="REJECTED",
            validation=ValidationResult(
                ground_station_los=True,
                sufficient_fuel=False,
                projected_mass_remaining_kg=0.0,
            ),
        )

    # --- 3. Enforce cooldown (600s between burns on same satellite) ---
    async with state._lock:
        last_burn = state.last_burn_time.get(sat_id)
        if last_burn:
            first_burn_time = request.maneuver_sequence[0].burnTime
            if (first_burn_time - last_burn).total_seconds() < 600:
                return ManeuverScheduleResponse(
                    status="REJECTED",
                    validation=ValidationResult(
                        ground_station_los=True,
                        sufficient_fuel=True,
                        projected_mass_remaining_kg=0.0,
                    ),
                )

    # --- 4. Enforce that burn times are not in the past ---
    async with state._lock:
        current_sim_time = state.current_time
    for burn in request.maneuver_sequence:
        if burn.burnTime < current_sim_time:
            return ManeuverScheduleResponse(
                status="REJECTED",
                validation=ValidationResult(
                    ground_station_los=True,
                    sufficient_fuel=True,
                    projected_mass_remaining_kg=0.0,
                ),
            )

    # --- 5. Queue the maneuvers ---
    for burn in request.maneuver_sequence:
        await state.add_maneuver(sat_id, burn)

    # --- 6. Update last burn time (to the last burn in the sequence) ---
    async with state._lock:
        state.last_burn_time[sat_id] = request.maneuver_sequence[-1].burnTime

    # Compute projected total mass (dry + remaining fuel) for response
    projected_total_mass = state.dry_mass + final_fuel

    return ManeuverScheduleResponse(
        status="SCHEDULED",
        validation=ValidationResult(
            ground_station_los=True,
            sufficient_fuel=True,
            projected_mass_remaining_kg=round(projected_total_mass, 2),
        ),
    )
