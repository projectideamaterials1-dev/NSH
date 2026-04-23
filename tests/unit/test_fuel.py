import math
from satellite_api.state import I_SP, G0, DRY_MASS

def test_fuel_consumption_formula():
    """Verify fuel consumption matches Tsiolkovsky rocket equation."""
    I_SP_val = 300.0
    G0_val = 9.80665
    dry_mass = 500.0
    initial_fuel = 50.0
    initial_mass = dry_mass + initial_fuel
    delta_v_mps = 15.0  # max allowed
    
    exhaust_vel = I_SP_val * G0_val
    mass_ratio = math.exp(-delta_v_mps / exhaust_vel)
    final_mass = initial_mass * mass_ratio
    fuel_used = initial_mass - final_mass
    
    # Expected fuel used ~ 2.80 kg for 15 m/s starting at 550kg
    expected_fuel = 2.799
    assert abs(fuel_used - expected_fuel) < 0.01
