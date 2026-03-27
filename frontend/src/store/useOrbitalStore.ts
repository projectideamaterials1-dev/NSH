// src/store/useOrbitalStore.ts
// Production‑Ready Zustand Store – Crimson Nebula v3
// Binary buffers | Batched trails | Zero GC churn | Full simulation control

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

// ============================================================================
// TYPE DEFINITIONS (Match backend /worker)
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
  burnTime: string;
  deltaV_vector: { x: number; y: number; z: number };
  maneuver_type: 'PHASING_PROGRADE' | 'RADIAL_SHUNT' | 'RECOVERY' | 'PLANE_CHANGE';
  duration_seconds: number;
  cooldown_start: string;
  cooldown_end: string;
  delta_v_magnitude: number;
  fuel_consumed_kg?: number;
}

export interface FuelMetric {
  timestamp: string;
  totalFuelKg: number;
  avgFuelKg: number;
  collisionsAvoided: number;
  maneuversExecuted: number;
  _updateTime?: number; // internal throttling
}

export interface ConnectionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  lastSuccessfulFetch: number | null;
  consecutiveFailures: number;
  latencyMs: number | null;
  error: string | null;
}

export interface DebrisBinaryData {
  positions: Float32Array;
  colors: Uint8ClampedArray;
  ids: string[];
  riskScores: Float32Array;
  length: number;
}

export interface SatelliteBinaryData {
  positions: Float32Array;
  colors: Uint8ClampedArray;
  fuels: Float32Array;
  ids: string[];
  statuses: string[];
  length: number;
}

export interface SatelliteTrail {
  satelliteId: string;
  positions: [number, number, number][];
  timestamps: string[];
}

export interface SimulationStepResponse {
  status: string;
  new_timestamp: string;
  collisions_detected: number;
  maneuvers_executed: number;
}

// ============================================================================
// ORBITAL STATE INTERFACE
// ============================================================================

interface OrbitalState {
  // Binary buffers (direct GPU access)
  debris: DebrisBinaryData | null;
  satellites: SatelliteBinaryData | null;
  timestamp: string | null;
  lastUpdate: number | null;
  parseTimeMs: number | null;
  highRiskDebrisCount: number;

  // Trails (only for selected/hovered)
  trails: Record<string, SatelliteTrail>;

  // Connection & metrics
  connectionStatus: ConnectionStatus;
  fuelHistory: FuelMetric[];
  maneuvers: ManeuverEvent[];

  // Simulation (tracked locally)
  simulation: {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  currentStep: number;
  totalSteps: number;
  collisionsDetected: number;
  maneuversExecuted: number;
  lastStepResponse: SimulationStepResponse | null;
  error: string | null;
};

  // UI selection
  selectedSatelliteId: string | null;
  hoveredSatelliteId: string | null;

  // Actions
  updateTelemetry: (
    debris: DebrisBinaryData,
    satellites: SatelliteBinaryData,
    timestamp: string,
    parseTimeMs: number
  ) => void;

  setConnectionStatus: (status: Partial<ConnectionStatus>) => void;
  addFuelMetric: (metric: FuelMetric) => void;
  addManeuvers: (maneuvers: ManeuverEvent[]) => void;
  clearManeuvers: () => void;
  selectSatellite: (id: string | null) => void;
  hoverSatellite: (id: string | null) => void;
  clearTrails: () => void;
  resetStore: () => void;

  // API Actions
  scheduleManeuver: (
    satelliteId: string,
    maneuverSequence: Array<{
      burn_id: string;
      burnTime: string;
      deltaV_vector: { x: number; y: number; z: number };
    }>
  ) => Promise<boolean>;

  stepSimulation: (stepSeconds: number) => Promise<SimulationStepResponse>;
  setSimulationRunning: (isRunning: boolean) => void;
  resetSimulation: () => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CONSTANTS = {
  MAX_TRAIL_POINTS: 5400,
  MAX_FUEL_HISTORY: 720,
  MAX_MANEUVERS: 200,
  FUEL_UPDATE_INTERVAL_MS: 60000,
} as const;

// ============================================================================
// HELPERS
// ============================================================================

function computeHighRiskCount(riskScores: Float32Array): number {
  let count = 0;
  for (let i = 0; i < riskScores.length; i++) {
    if (riskScores[i] > 0.8) count++;
  }
  return count;
}

// ============================================================================
// INITIAL STATE (data only)
// ============================================================================

const INITIAL_CONNECTION_STATUS: ConnectionStatus = {
  state: 'disconnected',
  lastSuccessfulFetch: null,
  consecutiveFailures: 0,
  latencyMs: null,
  error: null,
};

const INITIAL_SIMULATION = {
  status: 'idle' as const,
  currentStep: 0,
  totalSteps: 43200,
  collisionsDetected: 0,
  maneuversExecuted: 0,
  lastStepResponse: null,
  error: null,
};

const INITIAL_STATE = {
  debris: null,
  satellites: null,
  timestamp: null,
  lastUpdate: null,
  parseTimeMs: null,
  highRiskDebrisCount: 0,
  trails: {},
  connectionStatus: INITIAL_CONNECTION_STATUS,
  fuelHistory: [] as FuelMetric[],
  maneuvers: [] as ManeuverEvent[],
  simulation: INITIAL_SIMULATION,
  selectedSatelliteId: null,
  hoveredSatelliteId: null,
};

// ============================================================================
// ZUSTAND STORE
// ============================================================================

export const useOrbitalStore = create<OrbitalState>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL_STATE,

    // ==========================================================================
    // TELEMETRY UPDATE (from Web Worker)
    // ==========================================================================

    updateTelemetry: (debris, satellites, timestamp, parseTimeMs) => {
      const state = get();
      const now = Date.now();
      const highRiskCount = computeHighRiskCount(debris.riskScores);

      // Dynamic trail tracking (only for selected/hovered)
      const activeIds = [state.selectedSatelliteId, state.hoveredSatelliteId].filter(Boolean) as string[];
      let newTrails = state.trails;

      if (activeIds.length > 0) {
        newTrails = { ...state.trails };
        for (const id of activeIds) {
          const idx = satellites.ids.indexOf(id);
          if (idx !== -1) {
            const pos: [number, number, number] = [
              satellites.positions[idx * 3],
              satellites.positions[idx * 3 + 1],
              satellites.positions[idx * 3 + 2],
            ];
            const existing = newTrails[id] || { satelliteId: id, positions: [], timestamps: [] };
            const updatedPositions = [...existing.positions, pos];
            const updatedTimestamps = [...existing.timestamps, timestamp];
            if (updatedPositions.length > CONSTANTS.MAX_TRAIL_POINTS) {
              updatedPositions.shift();
              updatedTimestamps.shift();
            }
            newTrails[id] = { satelliteId: id, positions: updatedPositions, timestamps: updatedTimestamps };
          }
        }
      }

      set({
        debris,
        satellites,
        trails: newTrails,
        timestamp,
        lastUpdate: now,
        parseTimeMs,
        highRiskDebrisCount: highRiskCount,
        connectionStatus: {
          ...state.connectionStatus,
          state: 'connected',
          lastSuccessfulFetch: now,
          consecutiveFailures: 0,
          error: null,
        },
      });

      // Fuel history
      const lastMetric = state.fuelHistory[state.fuelHistory.length - 1];
      const lastUpdateTime = lastMetric?._updateTime ?? 0;
      if (now - lastUpdateTime >= CONSTANTS.FUEL_UPDATE_INTERVAL_MS && satellites.length > 0) {
        const fuels = satellites.fuels;
        let totalFuel = 0;
        for (let i = 0; i < fuels.length; i++) totalFuel += fuels[i];
        get().addFuelMetric({
          timestamp,
          totalFuelKg: totalFuel,
          avgFuelKg: totalFuel / fuels.length,
          collisionsAvoided: 0,
          maneuversExecuted: state.maneuvers.length,
          _updateTime: now,
        });
      }
    },

    // ==========================================================================
    // CONNECTION & METRICS
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

    addFuelMetric: (metric) => {
      set((state) => ({
        fuelHistory: [...state.fuelHistory.slice(-(CONSTANTS.MAX_FUEL_HISTORY - 1)), metric],
      }));
    },

    addManeuvers: (maneuvers) => {
      set((state) => {
        const existingIds = new Set(state.maneuvers.map((m) => m.burn_id));
        const newManeuvers = maneuvers.filter((m) => !existingIds.has(m.burn_id));
        return {
          maneuvers: [...state.maneuvers, ...newManeuvers].slice(-CONSTANTS.MAX_MANEUVERS),
        };
      });
    },

    clearManeuvers: () => set({ maneuvers: [] }),

    // ==========================================================================
    // UI SELECTION
    // ==========================================================================

    selectSatellite: (id) => {
      set({
        selectedSatelliteId: id,
        hoveredSatelliteId: id ? null : get().hoveredSatelliteId,
      });
    },

    hoverSatellite: (id) => set({ hoveredSatelliteId: id }),

    clearTrails: () => set({ trails: {} }),

    resetStore: () => set(INITIAL_STATE),

    // ==========================================================================
    // API ACTIONS
    // ==========================================================================

    scheduleManeuver: async (satelliteId, maneuverSequence) => {
      try {
        const response = await fetch('/api/maneuver/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            satelliteId,
            maneuver_sequence: maneuverSequence.map((b) => ({
              burn_id: b.burn_id,
              burnTime: b.burnTime,
              deltaV_vector: b.deltaV_vector,
            })),
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.status === 'SCHEDULED') {
          const newManeuvers: ManeuverEvent[] = maneuverSequence.map((burn) => {
            const burnTimeMs = new Date(burn.burnTime).getTime();
            const dvMag = Math.hypot(burn.deltaV_vector.x, burn.deltaV_vector.y, burn.deltaV_vector.z);
            return {
              burn_id: burn.burn_id,
              satellite_id: satelliteId,
              burnTime: burn.burnTime,
              deltaV_vector: burn.deltaV_vector,
              maneuver_type: 'RECOVERY', // default; could be determined by logic
              duration_seconds: 0,
              cooldown_start: new Date(burnTimeMs).toISOString(),
              cooldown_end: new Date(burnTimeMs + 600 * 1000).toISOString(),
              delta_v_magnitude: dvMag,
            };
          });
          get().addManeuvers(newManeuvers);
          return true;
        }
        console.warn('[Store] Maneuver rejected:', data.status);
        return false;
      } catch (error) {
        console.error('[Store] Failed to schedule maneuver:', error);
        return false;
      }
    },

    stepSimulation: async (stepSeconds) => {
    try {
      const response = await fetch('/api/simulate/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step_seconds: stepSeconds }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: SimulationStepResponse = await response.json();
      set((state) => ({
        simulation: {
          ...state.simulation,
          currentStep: state.simulation.currentStep + 1,
          collisionsDetected: data.collisions_detected,
          maneuversExecuted: data.maneuvers_executed,
          lastStepResponse: data,
          status: 'running',
          error: null,
        },
      }));
      return data;
    } catch (error) {
      set((state) => ({
        simulation: {
          ...state.simulation,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      }));
      throw error;
    }
  },

    setSimulationRunning: (isRunning) => {
      set((state) => ({
        simulation: {
          ...state.simulation,
          status: isRunning ? 'running' : 'paused',
        },
      }));
    },
    resetSimulation: () => {
      set({ simulation: { ...INITIAL_SIMULATION } });
    },
  }))
);

// ============================================================================
// SELECTORS (All access binary arrays directly)
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
    fuel_kg: state.satellites.fuels[idx],
    status: state.satellites.statuses[idx] as Satellite['status'],
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

export const selectSatelliteTrail = (state: OrbitalState, satelliteId: string) =>
  state.trails[satelliteId] || null;

export const selectConnectionState = (state: OrbitalState) => state.connectionStatus.state;

export const selectLatestFuelMetric = (state: OrbitalState) =>
  state.fuelHistory.length > 0 ? state.fuelHistory[state.fuelHistory.length - 1] : null;

export const selectManeuversForSatellite = (state: OrbitalState, satelliteId: string | null) =>
  !satelliteId ? state.maneuvers : state.maneuvers.filter((m) => m.satellite_id === satelliteId);

export const selectSimulationState = (state: OrbitalState) => state.simulation;

export default useOrbitalStore;