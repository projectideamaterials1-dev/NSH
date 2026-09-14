import math
from pathlib import Path
from typing import Dict, Tuple

import numpy as np

MU_EARTH = 398600.4418
R_EARTH = 6378.137

# Unnormalised zonal coefficients J_n (EGM2008 / WGS-84 values)
ZONAL_J = {
    2: 1.08262668e-3,
    3: -2.53265649e-6,
    4: -1.61962159e-6,
    5: -2.27296083e-7,
    6: 5.40681239e-7,
}
PRESETS = {"J2": 2, "J4": 4, "J6": 6}


class GravityModel:
    """
    Earth gravity with zonal spherical harmonics (J2 … Jn).

    Presets: "J2" (default, matches the simulation engine), "J4", "J6"; or pass
    `model_path` to an EGM-style coefficient file with rows `n m C S`
    (fully normalised C̄nm by default). Only zonal terms (m = 0) are used; tesseral
    terms are parsed and kept in `harmonics` but not applied.
    """
    def __init__(self, model_path: str = None, preset: str = "J2", normalized: bool = True):
        self.harmonics: Dict[Tuple[int, int], Tuple[float, float]] = {}  # {(n,m): (Cnm, Snm)}; zonal stored as (J_n, 0)
        self.name = preset
        if model_path and Path(model_path).exists():
            self.load_egm2008(model_path, normalized=normalized)
            self.name = Path(model_path).name
        elif preset in PRESETS:
            self.set_default(PRESETS[preset])
        else:
            raise ValueError(f"Unknown gravity preset '{preset}'. Use one of {sorted(PRESETS)} or a coefficient file.")

    def set_default(self, max_degree: int = 2):
        """Standard zonal coefficients up to `max_degree` (J2 only by default)."""
        self.harmonics = {(n, 0): (ZONAL_J[n], 0.0) for n in range(2, max_degree + 1)}

    def load_egm2008(self, path, normalized: bool = True, max_degree: int = 20):
        """Load a coefficient file (format: n m Cnm Snm; '#' comments; Fortran 'D' exponents ok)."""
        self.harmonics = {}
        with open(path) as f:
            for line in f:
                if line.startswith('#') or not line.strip():
                    continue
                parts = line.replace("D", "E").replace(",", " ").split()
                if len(parts) < 4:
                    continue
                try:
                    n, m = int(parts[0]), int(parts[1])
                    C, S = float(parts[2]), float(parts[3])
                except ValueError:
                    continue
                if n < 2 or n > max_degree:
                    continue
                if m == 0:
                    # J_n = -C_n0 (unnormalised); normalised C̄n0 = C_n0 / sqrt(2n+1)
                    j_n = -C * math.sqrt(2 * n + 1) if normalized else -C
                    self.harmonics[(n, 0)] = (j_n, 0.0)
                else:
                    self.harmonics[(n, m)] = (C, S)
        if not any(m == 0 for (_, m) in self.harmonics):
            raise ValueError(f"No zonal (m=0) coefficients found in {path}")

    @property
    def zonal(self) -> Dict[int, float]:
        return {n: c for (n, m), (c, _) in self.harmonics.items() if m == 0}

    def acceleration_vec(self, r: np.ndarray, mu: float = MU_EARTH, R: float = R_EARTH) -> np.ndarray:
        """Acceleration [km/s²] for an (N, 3) array of ECI/ECEF positions [km].

        For each zonal term T_n = -mu J_n R^n r^-(n+1) P_n(u), u = z/r:
            ∇T_n = mu J_n R^n / r^(n+2) · [((n+1) P_n + u P_n') r̂ − P_n' ẑ]
        """
        r = np.asarray(r, dtype=np.float64).reshape(-1, 3)
        rn = np.linalg.norm(r, axis=1)
        safe = rn > 1e-10
        rn_s = np.where(safe, rn, 1.0)
        rhat = r / rn_s[:, None]
        u = rhat[:, 2]

        acc = -mu * rhat / (rn_s ** 2)[:, None]
        zonal = self.zonal
        if zonal:
            n_max = max(zonal)
            P = [np.ones_like(u), u.copy()]
            dP = [np.zeros_like(u), np.ones_like(u)]
            for n in range(2, n_max + 1):
                P.append(((2 * n - 1) * u * P[n - 1] - (n - 1) * P[n - 2]) / n)
                dP.append(dP[n - 2] + (2 * n - 1) * P[n - 1])
            for n, j_n in zonal.items():
                scale = mu * j_n * R ** n / rn_s ** (n + 2)
                radial = (n + 1) * P[n] + u * dP[n]
                acc += scale[:, None] * radial[:, None] * rhat
                acc[:, 2] -= scale * dP[n]
        acc[~safe] = 0.0
        return acc

    def acceleration(self, x, y, z, mu=398600.4418, R=6378.137):
        """
        Compute gravitational acceleration including zonal harmonics.
        Accepts scalars (returns a tuple of floats) or equal-length arrays (returns arrays).
        """
        scalar = np.isscalar(x)
        a = self.acceleration_vec(np.column_stack([np.atleast_1d(x), np.atleast_1d(y), np.atleast_1d(z)]), mu, R)
        if scalar:
            return float(a[0, 0]), float(a[0, 1]), float(a[0, 2])
        return a[:, 0], a[:, 1], a[:, 2]

    def propagate(self, states: np.ndarray, dt_seconds: float, max_step: float = 10.0) -> None:
        """RK4-propagates an (N, 6) state array in place with this gravity model."""
        if dt_seconds <= 0.0 or len(states) == 0:
            return
        steps = max(1, int(math.ceil(dt_seconds / max_step)))
        h = dt_seconds / steps
        r = states[:, 0:3]
        v = states[:, 3:6]
        for _ in range(steps):
            a1 = self.acceleration_vec(r)
            v2 = v + 0.5 * h * a1
            a2 = self.acceleration_vec(r + 0.5 * h * v)
            v3 = v + 0.5 * h * a2
            a3 = self.acceleration_vec(r + 0.5 * h * v2)
            v4 = v + h * a3
            a4 = self.acceleration_vec(r + h * v3)
            r += (h / 6.0) * (v + 2.0 * v2 + 2.0 * v3 + v4)
            v += (h / 6.0) * (a1 + 2.0 * a2 + 2.0 * a3 + a4)
