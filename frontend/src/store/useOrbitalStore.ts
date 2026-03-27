// src/store/useOrbitalStore.ts
// Production-Ready Zustand Store for Crimson Nebula Dashboard
// Binary Buffer Support | Zero Re-renders | Backend API Sync

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

// ============================================================================
// TYPE DEFINITIONS (Strict Backend Sync with /api/visualization/snapshot)
// ============================================================================

export interface Satellite {
  id: string;
  lat: number;
  lon: number;
  alt?: number;
  fuel_kg: number;
  status: 'NOMINAL' | 'WARNING' | 'CRITICAL' | 'EOL';
}

export interface ManeuverEvent {
  burn_id: string;
  satellite_id: string;
  burnTime: string; // ISO 8601 with milliseconds
  deltaV_vector: { x: number; y: number; z: number };
  maneuver_type: 'PHASING_PROGRADE' | 'RADIAL_SHUNT' | 'RECOVERY' | 'PLANE_CHANGE';
  duration_seconds: number;
  cooldown_start: string;
  cooldown_end: string; // burnTime + duration + 600s mandatory cooldown
  delta_v_magnitude: number;
  fuel_consumed_kg?: number;
}

export interface FuelMetric {
  timestamp: string;
  totalFuelKg: number;
  avgFuelKg: number;
  collisionsAvoided: number;
  maneuversExecuted: number;
  _updateTime?: number; // internal use for throttling
}

export interface ConnectionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  lastSuccessfulFetch: number | null;
  consecutiveFailures: number;
  latencyMs: number | null;
  error: string | null;
}

// Binary buffer types from Web Worker (zero-copy transfer)
export interface DebrisBinaryData {
  positions: Float32Array; // [lon, lat, alt, lon, lat, alt, ...]
  colors: Uint8ClampedArray; // [r, g, b, a, r, g, b, a, ...]
  ids: string[];
  riskScores: Float32Array;
  length: number;
}

export interface SatelliteBinaryData {
  positions: Float32Array; // [lon, lat, alt, lon, lat, alt, ...]
  colors: Uint8ClampedArray; // [r, g, b, a, r, g, b, a, ...]
  fuels: Float32Array;
  ids: string[];
  statuses: string[];
  length: number;
}

// Historical trail data (90-minute comet tails) – stored only for selected/hovered
export interface SatelliteTrail {
  satelliteId: string;
  positions: [number, number, number][]; // [lon, lat, alt] per point
  timestamps: string[];
}

// ============================================================================
// ORBITAL STATE INTERFACE
// ============================================================================

interface OrbitalState {
  // Binary Buffers (Direct Deck.gl Access - No React Re-rend ers)
  debris: DebrisBinaryData | null;
  satellites: SatelliteBinaryData | null;
  
  // Human-Readable Satellite Data (For UI Panels)
  satelliteDetails: Record<string, Satellite>;
  
  // Metadata
  timestamp: string | null;
  lastUpdate: number | null;
  parseTimeMs: number | null;
  
  // Derived stats (cached for performance)
  highRiskDebrisCount: number;
  
  // Historical Trails (90-minute comet tails) – only for selected/hovered
  trails: Record<string, SatelliteTrail>;
  
  // Connection State
  connectionStatus: ConnectionStatus;
  
  // Historical Metrics (For Charts)
  fuelHistory: FuelMetric[];
  
  // Maneuvers (For Gantt Timeline)
  maneuvers: ManeuverEvent[];
  
  // Selection State (For Bullseye + LOS Arcs)
  selectedSatelliteId: string | null;
  hoveredSatelliteId: string | null;
  
  // Actions
  updateTelemetry: (
    debris: DebrisBinaryData,
    satellites: SatelliteBinaryData,
    satelliteDetails: Record<string, Satellite>,
    timestamp: string,
    parseTimeMs: number
  ) => void;
  
  setConnectionStatus: (status: Partial<ConnectionStatus>) => void;
  
  addFuelMetric: (metric: FuelMetric) => void;
  
  addManeuvers: (maneuvers: ManeuverEvent[]) => void;
  clearManeuvers: () => void;
  
  selectSatellite: (id: string | null) => void;
  hoverSatellite: (id: string | null) => void;
  
  updateTrail: (satelliteId: string, position: [number, number, number], timestamp: string) => void;
  clearTrails: () => void;
  
  resetStore: () => void;
}

// ============================================================================
// CONSTANTS (Matches PS Section 5.1 & Backend Config)
// ============================================================================

const CONSTANTS = {
  MAX_TRAIL_POINTS: 5400,            // 90 minutes @ 1 point/second
  MAX_FUEL_HISTORY: 720,             // 12 hours @ 1 point/minute
  MAX_MANEUVERS: 200,                // Keep last 200 maneuvers in memory
  FUEL_INITIAL_KG: 50.0,             // PS Section 5.1
  FUEL_EOL_KG: 2.5,                  // PS Section 5.1 (graveyard threshold)
  COOLDOWN_SECONDS: 600,             // PS Section 5.1 (mandatory thermal cooldown)
  FUEL_UPDATE_INTERVAL_MS: 60000,    // 1 minute
} as const;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function computeHighRiskCount(riskScores: Float32Array): number {
  let count = 0;
  for (let i = 0; i < riskScores.length; i++) {
    if (riskScores[i] > 0.8) count++;
  }
  return count;
}

// ============================================================================
// INITIAL STATE
// ============================================================================

const INITIAL_CONNECTION_STATUS: ConnectionStatus = {
  state: 'disconnected',
  lastSuccessfulFetch: null,
  consecutiveFailures: 0,
  latencyMs: null,
  error: null,
};

const INITIAL_STATE: OrbitalState = {
  debris: null,
  satellites: null,
  satelliteDetails: {},
  timestamp: null,
  lastUpdate: null,
  parseTimeMs: null,
  highRiskDebrisCount: 0,
  trails: {},
  connectionStatus: INITIAL_CONNECTION_STATUS,
  fuelHistory: [],
  maneuvers: [],
  selectedSatelliteId: null,
  hoveredSatelliteId: null,
};

// ============================================================================
// ZUSTAND STORE CREATION
// ============================================================================

export const useOrbitalStore = create<OrbitalState>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL_STATE,
    
    // ==========================================================================
    // TELEMETRY UPDATE (Called from telemetryClient.ts after Worker parsing)
    // ==========================================================================
    
    updateTelemetry: (
      debris,
      satellites,
      satelliteDetails,
      timestamp,
      parseTimeMs
    ) => {
      // Compute high-risk count once
      const highRiskCount = computeHighRiskCount(debris.riskScores);
      
      // Update core state
      set({
        debris,
        satellites,
        satelliteDetails,
        timestamp,
        lastUpdate: Date.now(),
        parseTimeMs,
        highRiskDebrisCount: highRiskCount,
        connectionStatus: {
          ...get().connectionStatus,
          state: 'connected',
          lastSuccessfulFetch: Date.now(),
          consecutiveFailures: 0,
          error: null,
        },
      });
      
      // Fuel history update (throttled using real time, not snapshot timestamps)
      const now = Date.now();
      const lastMetric = get().fuelHistory[get().fuelHistory.length - 1];
      const lastUpdateTime = lastMetric?._updateTime ?? 0;
      
      if (now - lastUpdateTime >= CONSTANTS.FUEL_UPDATE_INTERVAL_MS) {
        const totalFuel = Object.values(satelliteDetails).reduce(
          (sum, sat) => sum + sat.fuel_kg,
          0
        );
        const avgFuel = totalFuel / Object.keys(satelliteDetails).length;
        
        get().addFuelMetric({
          timestamp,
          totalFuelKg: totalFuel,
          avgFuelKg: avgFuel,
          collisionsAvoided: 0, // TODO: replace with actual value from backend
          maneuversExecuted: get().maneuvers.length,
          _updateTime: now,
        });
      }
    },
    
    // ==========================================================================
    // CONNECTION STATE MANAGEMENT
    // ==========================================================================
    
    setConnectionStatus: (status) => {
      set((state) => ({
        connectionStatus: {
          ...state.connectionStatus,
          ...status,
          state: status.state ?? state.connectionStatus.state,
        },
      }));
    },
    
    // ==========================================================================
    // FUEL HISTORY (For Delta-V Cost Analysis Chart)
    // ==========================================================================
    
    addFuelMetric: (metric) => {
      set((state) => ({
        fuelHistory: [
          ...state.fuelHistory.slice(-(CONSTANTS.MAX_FUEL_HISTORY - 1)),
          metric,
        ],
      }));
    },
    
    // ==========================================================================
    // MANEUVER MANAGEMENT (For Gantt Timeline)
    // ==========================================================================
    
    addManeuvers: (maneuvers) => {
      set((state) => {
        const existingIds = new Set(state.maneuvers.map(m => m.burn_id));
        const newManeuvers = maneuvers.filter(m => !existingIds.has(m.burn_id));
        return {
          maneuvers: [
            ...state.maneuvers,
            ...newManeuvers,
          ].slice(-CONSTANTS.MAX_MANEUVERS),
        };
      });
    },
    
    clearManeuvers: () => {
      set({ maneuvers: [] });
    },
    
    // ==========================================================================
    // SATELLITE SELECTION (For Bullseye Plot + LOS Arcs)
    // ==========================================================================
    
    selectSatellite: (id) => {
      set({ 
        selectedSatelliteId: id,
        // Clear hover when selecting
        hoveredSatelliteId: id ? null : get().hoveredSatelliteId,
      });
    },
    
    hoverSatellite: (id) => {
      set({ hoveredSatelliteId: id });
    },
    
    // ==========================================================================
    // SATELLITE TRAILS (90-Minute Comet Tails) – Only for Selected/Hovered
    // ==========================================================================
    
    updateTrail: (satelliteId, position, timestamp) => {
      // Only store trails for the currently selected or hovered satellite
      const { selectedSatelliteId, hoveredSatelliteId } = get();
      if (satelliteId !== selectedSatelliteId && satelliteId !== hoveredSatelliteId) {
        return;
      }
      
      set((state) => {
        const existingTrail = state.trails[satelliteId];
        
        if (!existingTrail) {
          return {
            trails: {
              ...state.trails,
              [satelliteId]: {
                satelliteId,
                positions: [position],
                timestamps: [timestamp],
              },
            },
          };
        }
        
        // Append new point
        let newPositions = [...existingTrail.positions, position];
        let newTimestamps = [...existingTrail.timestamps, timestamp];
        
        // Trim to max trail length (90 minutes)
        if (newPositions.length > CONSTANTS.MAX_TRAIL_POINTS) {
          const start = newPositions.length - CONSTANTS.MAX_TRAIL_POINTS;
          newPositions = newPositions.slice(start);
          newTimestamps = newTimestamps.slice(start);
        }
        
        return {
          trails: {
            ...state.trails,
            [satelliteId]: {
              satelliteId,
              positions: newPositions,
              timestamps: newTimestamps,
            },
          },
        };
      });
    },
    
    clearTrails: () => {
      set({ trails: {} });
    },
    
    // ==========================================================================
    // STORE RESET (For Reconnection / Error Recovery)
    // ==========================================================================
    
    resetStore: () => {
      set(INITIAL_STATE);
    },
  }))
);

// ============================================================================
// MEMOIZED SELECTORS (Performance-Optimized Access)
// ============================================================================

export const selectDebrisCount = (state: OrbitalState) => state.debris?.length ?? 0;

export const selectSatelliteCount = (state: OrbitalState) => state.satellites?.length ?? 0;

export const selectHighRiskDebrisCount = (state: OrbitalState) => state.highRiskDebrisCount;

export const selectSelectedSatellite = (state: OrbitalState) => {
  if (!state.selectedSatelliteId || !state.satellites) return null;
  const idx = state.satellites.ids.indexOf(state.selectedSatelliteId);
  if (idx === -1) return null;
  return {
    id: state.satellites.ids[idx],
    lon: state.satellites.positions[idx * 3],
    lat: state.satellites.positions[idx * 3 + 1],
    alt: state.satellites.positions[idx * 3 + 2],
    fuel: state.satellites.fuels[idx],
    status: state.satellites.statuses[idx] as Satellite['status'],
    details: state.satelliteDetails[state.selectedSatelliteId] || null,
  };
};

export const selectHoveredSatellite = (state: OrbitalState) => {
  if (!state.hoveredSatelliteId || !state.satellites) return null;
  const idx = state.satellites.ids.indexOf(state.hoveredSatelliteId);
  if (idx === -1) return null;
  return {
    id: state.satellites.ids[idx],
    lon: state.satellites.positions[idx * 3],
    lat: state.satellites.positions[idx * 3 + 1],
    alt: state.satellites.positions[idx * 3 + 2],
  };
};

export const selectSatelliteTrail = (state: OrbitalState, satelliteId: string) => {
  return state.trails[satelliteId] || null;
};

export const selectConnectionState = (state: OrbitalState) => state.connectionStatus.state;

export const selectLatestFuelMetric = (state: OrbitalState) => {
  return state.fuelHistory.length > 0 
    ? state.fuelHistory[state.fuelHistory.length - 1] 
    : null;
};

export const selectManeuversForSatellite = (state: OrbitalState, satelliteId: string | null) => {
  if (!satelliteId) return state.maneuvers;
  return state.maneuvers.filter(m => m.satellite_id === satelliteId);
};

// ============================================================================
// EXPORT DEFAULT
// ============================================================================

export default useOrbitalStore;