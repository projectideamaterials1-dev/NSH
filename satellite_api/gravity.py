import numpy as np
from pathlib import Path

class GravityModel:
    """
    Supports different gravity models (EGM2008, J2, etc.)
    Extensible for higher-fidelity orbital propagation.
    """
    def __init__(self, model_path: str = None):
        self.harmonics = {}  # {(n,m): (Cnm, Snm)}
        if model_path and Path(model_path).exists():
            self.load_egm2008(model_path)
        else:
            # default J2 only
            self.set_default()
    
    def set_default(self):
        """Sets standard J2 coefficient for Earth."""
        self.harmonics = {(2,0): (1.08263e-3, 0.0)}
    
    def load_egm2008(self, path):
        """Load EGM2008 coefficient file (format: n,m,Cnm,Snm)."""
        with open(path) as f:
            for line in f:
                if line.startswith('#'): continue
                parts = line.strip().split()
                if len(parts) >= 4:
                    try:
                        n, m = int(parts[0]), int(parts[1])
                        C = float(parts[2])
                        S = float(parts[3])
                        self.harmonics[(n,m)] = (C, S)
                    except ValueError:
                        continue
    
    def acceleration(self, x, y, z, mu=398600.4418, R=6378.137):
        """
        Compute gravitational acceleration including harmonics.
        Placeholder for full spherical harmonic expansion.
        """
        r2 = x*x + y*y + z*z
        r = np.sqrt(r2)
        if r < 1e-10:
            return 0.0, 0.0, 0.0
            
        # Two-body point mass acceleration
        ax = -mu * x / r**3
        ay = -mu * y / r**3
        az = -mu * z / r**3
        
        # J2 Perturbation (if only J2 is present in harmonics)
        if (2,0) in self.harmonics and len(self.harmonics) == 1:
            J2_val = self.harmonics[(2,0)][0]
            j2_factor = 1.5 * J2_val * mu * R**2 / r**5
            z2_r2 = (z**2) / r2
            
            ax += x * j2_factor * (5.0 * z2_r2 - 1.0)
            ay += y * j2_factor * (5.0 * z2_r2 - 1.0)
            az += z * j2_factor * (5.0 * z2_r2 - 3.0)
            
        return ax, ay, az
