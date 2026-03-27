// src/lib/constants.ts
// Static Configuration for Crimson Nebula Dashboard

export const GROUND_STATIONS = [
  { id: 'GS-001', name: 'ISTRAC_Bengaluru', coordinates: [77.5167, 13.0333], minElevationAngle: 5.0 },
  { id: 'GS-002', name: 'Svalbard_Sat_Station', coordinates: [15.4077, 78.2297], minElevationAngle: 5.0 },
  { id: 'GS-003', name: 'Goldstone_Tracking', coordinates: [-116.8900, 35.4266], minElevationAngle: 10.0 },
  { id: 'GS-004', name: 'Punta_Arenas', coordinates: [-70.9167, -53.1500], minElevationAngle: 5.0 },
  { id: 'GS-005', name: 'IIT_Delhi_Ground_Node', coordinates: [77.1926, 28.5450], minElevationAngle: 15.0 },
  { id: 'GS-006', name: 'McMurdo_Station', coordinates: [166.6682, -77.8463], minElevationAngle: 5.0 },
] as const;

export const VIS_CONFIG = {
  TRAIL_HISTORY_MINUTES: 90,
  TRAIL_HISTORY_POINTS: 5400,
  DEBRIS_RISK_CRITICAL: 0.8,
  DEBRIS_RISK_WARNING: 0.5,
  FUEL_INITIAL_KG: 50.0,
  FUEL_EOL_KG: 2.5,
  COOLDOWN_SECONDS: 600,
  MAP_STYLE: 'https://demotiles.maplibre.org/style.json',
} as const;

export const THEME = {
  COLORS: {
    VOID_BLACK: '#000000',
    NEBULA_MAROON: '#1A0000',
    PLASMA_CYAN: '#00FFFF',
    LASER_RED: '#FF0033',
    VERMILLION: '#F85149',
    AMBER: '#D29922',
    NOMINAL_GREEN: '#238636',
    MUTED_GRAY: '#888888',
  },
  OPACITY: {
    DEBRIS_NOMINAL: 0.6,
    DEBRIS_CRITICAL: 0.9,
    SATELLITE: 1.0,
    TERMINATOR: 0.5,
  },
} as const;