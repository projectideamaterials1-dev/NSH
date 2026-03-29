// src/store/useOrbitalStore.ts
// Production-Ready Zustand Store – Crimson Nebula v10
// ✅ FIXED: Initial state now includes all required properties (no TypeScript errors)
// ✅ Fuel metrics added to syncVisualizationSnapshot
// ✅ Trail arrays recreated on each update (triggers React re-render)
// ✅ Burn tracking with lat/lon
// ✅ Full sync with DeckGLMap

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { createSelector } from 'reselect';

// ============================================================================
// TYPE DEFINITIONS (unchanged)
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
  lat?: number;
  lon?: number;
}

export interface FuelMetric {
  timestamp: string;
  totalFuelKg: number;
  avgFuelKg: number;
  collisionsAvoided: number;
  maneuversExecuted: number;
  _updateTime?: number;
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

interface OrbitalState {
  debris: DebrisBinaryData | null;
  satellites: SatelliteBinaryData | null;
  timestamp: string | null;
  lastUpdate: number | null;
  parseTimeMs: number | null;
  highRiskDebrisCount: number;

  trails: Record<string, SatelliteTrail>;
  connectionStatus: ConnectionStatus;
  fuelHistory: FuelMetric[];
  maneuvers: ManeuverEvent[];

  simulation: {
    status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
    currentStep: number;
    totalSteps: number;
    collisionsDetected: number;
    maneuversExecuted: number;
    lastStepResponse: SimulationStepResponse | null;
    error: string | null;
  };

  selectedSatelliteId: string | null;
  hoveredSatelliteId: string | null;
  _autoSyncInterval: NodeJS.Timeout | null;

  // Actions
  updateTelemetry: (debris: DebrisBinaryData, satellites: SatelliteBinaryData, timestamp: string, parseTimeMs: number) => void;
  setConnectionStatus: (status: Partial<ConnectionStatus>) => void;
  addFuelMetric: (metric: FuelMetric) => void;
  addManeuvers: (maneuvers: ManeuverEvent[]) => void;
  clearManeuvers: () => void;
  selectSatellite: (id: string | null) => void;
  hoverSatellite: (id: string | null) => void;
  clearTrails: () => void;
  resetStore: () => void;

  scheduleManeuver: (satelliteId: string, maneuverSequence: Array<any>) => Promise<boolean>;
  stepSimulation: (stepSeconds: number) => Promise<SimulationStepResponse>;
  setSimulationRunning: (isRunning: boolean) => void;
  resetSimulation: () => void;

  syncVisualizationSnapshot: () => Promise<boolean>;
  startAutoSync: (intervalMs?: number) => void;
  stopAutoSync: () => void;

  addManeuverManually: (maneuver: ManeuverEvent) => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CONSTANTS = {
  MAX_TRAIL_POINTS: 5400,
  MAX_FUEL_HISTORY: 720,
  MAX_MANEUVERS: 200,
  FUEL_UPDATE_INTERVAL_MS: 60000,
  DRY_MASS_KG: 500,
  I_SP: 300.0,
  G0: 9.80665,
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

function appendTrails(stateTrails: Record<string, SatelliteTrail>, satellites: SatelliteBinaryData, timestamp: string) {
  const newTrails: Record<string, SatelliteTrail> = {};
  for (let i = 0; i < satellites.length; i++) {
    const id = satellites.ids[i];
    const pos: [number, number, number] = [
      satellites.positions[i * 3],
      satellites.positions[i * 3 + 1],
      satellites.positions[i * 3 + 2],
    ];
    const existing = stateTrails[id];
    // Optional log to confirm trail creation
    // if (!existing) console.log(`[Store] Created trail for ${id}`);
    const updatedPositions = existing ? [...existing.positions, pos] : [pos];
    const updatedTimestamps = existing ? [...existing.timestamps, timestamp] : [timestamp];
    if (updatedPositions.length > CONSTANTS.MAX_TRAIL_POINTS) {
      updatedPositions.shift();
      updatedTimestamps.shift();
    }
    newTrails[id] = {
      satelliteId: id,
      positions: updatedPositions,
      timestamps: updatedTimestamps,
    };
  }
  return newTrails;
}

function computeDeltaVFromFuelConsumption(initialWetMass: number, finalWetMass: number): number {
  if (initialWetMass <= 0 || finalWetMass <= 0) return 0;
  return CONSTANTS.I_SP * CONSTANTS.G0 * Math.log(initialWetMass / finalWetMass);
}

function inferManeuverFromFuelDrop(
  satelliteId: string,
  oldFuel: number,
  newFuel: number,
  timestamp: string,
  lat: number,
  lon: number
): ManeuverEvent | null {
  const fuelUsed = oldFuel - newFuel;
  if (fuelUsed <= 0.001) return null;

  const dryMass = CONSTANTS.DRY_MASS_KG;
  const deltaV = computeDeltaVFromFuelConsumption(dryMass + oldFuel, dryMass + newFuel);
  const burnTimeMs = new Date(timestamp).getTime();

  return {
    burn_id: `INFERRED_${satelliteId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    satellite_id: satelliteId,
    burnTime: timestamp,
    deltaV_vector: { x: 0, y: deltaV, z: 0 },
    maneuver_type: 'RECOVERY',
    duration_seconds: 1,
    cooldown_start: new Date(burnTimeMs).toISOString(),
    cooldown_end: new Date(burnTimeMs + 600 * 1000).toISOString(),
    delta_v_magnitude: deltaV,
    fuel_consumed_kg: fuelUsed,
    lat,
    lon,
  };
}

// src/store/useOrbitalStore.ts
// (full file as above, but with logging added – I'll show only the modified sections)

// ============================================================================
// DETECT MANEUVERS (with logging)
// ============================================================================

function detectManeuvers(
  oldSatellites: SatelliteBinaryData | null,
  newSatellites: SatelliteBinaryData,
  timestamp: string,
  existingManeuvers: ManeuverEvent[]
): ManeuverEvent[] {
  if (!oldSatellites || oldSatellites.length !== newSatellites.length) {
    console.log('[Store] detectManeuvers: old or new satellites missing/length mismatch', {
      oldLength: oldSatellites?.length,
      newLength: newSatellites.length,
    });
    return [];
  }

  const newManeuvers: ManeuverEvent[] = [];
  for (let i = 0; i < newSatellites.length; i++) {
    const id = newSatellites.ids[i];
    const oldFuel = oldSatellites.fuels[i];
    const newFuel = newSatellites.fuels[i];
    const diff = oldFuel - newFuel;
    if (diff > 0.001) {
      console.log(`[Store] Fuel drop for ${id}: ${oldFuel.toFixed(4)} -> ${newFuel.toFixed(4)} kg (Δ = ${diff.toFixed(4)} kg)`);
      const lon = newSatellites.positions[i * 3];
      const lat = newSatellites.positions[i * 3 + 1];
      const inferred = inferManeuverFromFuelDrop(id, oldFuel, newFuel, timestamp, lat, lon);
      if (inferred) {
        // check duplicate
        const exists = existingManeuvers.some(
          m =>
            m.satellite_id === id &&
            Math.abs(m.delta_v_magnitude - inferred.delta_v_magnitude) < 0.001 &&
            Math.abs(new Date(m.burnTime).getTime() - new Date(timestamp).getTime()) < 5000
        );
        if (!exists) {
          console.log(`[Store] ✅ Inferred new maneuver for ${id}`, inferred);
          newManeuvers.push(inferred);
        } else {
          console.log(`[Store] ⚠️ Duplicate maneuver for ${id} ignored`);
        }
      } else {
        console.log(`[Store] inferManeuverFromFuelDrop returned null for ${id} (diff=${diff})`);
      }
    }
  }
  return newManeuvers;
}

function snapshotToBinaryBuffers(data: any): {
  debris: DebrisBinaryData;
  satellites: SatelliteBinaryData;
  timestamp: string;
} {
  const satCount = data.satellites.length;
  const satPositions = new Float32Array(satCount * 3);
  const satColors = new Uint8ClampedArray(satCount * 4);
  const satFuels = new Float32Array(satCount);
  const satIds: string[] = new Array(satCount);
  const satStatuses: string[] = new Array(satCount);

  for (let i = 0; i < satCount; i++) {
    const s = data.satellites[i];
    satPositions[i * 3] = s.lon;
    satPositions[i * 3 + 1] = s.lat;
    satPositions[i * 3 + 2] = (s.alt ?? 400) * 1000;
    satFuels[i] = s.fuel_kg;
    satIds[i] = s.id;
    satStatuses[i] = s.status;

    if (s.status === 'CRITICAL') satColors.set([255, 0, 51, 255], i * 4);
    else if (s.status === 'WARNING') satColors.set([255, 191, 0, 255], i * 4);
    else satColors.set([0, 255, 255, 255], i * 4);
  }

  const debrisCount = data.debris_cloud.length;
  const debrisPositions = new Float32Array(debrisCount * 3);
  const debrisColors = new Uint8ClampedArray(debrisCount * 4);
  const debrisRisk = new Float32Array(debrisCount);
  const debrisIds: string[] = new Array(debrisCount);

  for (let i = 0; i < debrisCount; i++) {
    const d = data.debris_cloud[i];
    debrisPositions[i * 3] = d[2];
    debrisPositions[i * 3 + 1] = d[1];
    debrisPositions[i * 3 + 2] = d[3] * 1000;
    debrisIds[i] = d[0];
    debrisRisk[i] = 0;
    debrisColors.set([139, 0, 0, 120], i * 4);
  }

  return {
    debris: {
      positions: debrisPositions,
      colors: debrisColors,
      ids: debrisIds,
      riskScores: debrisRisk,
      length: debrisCount,
    },
    satellites: {
      positions: satPositions,
      colors: satColors,
      fuels: satFuels,
      ids: satIds,
      statuses: satStatuses,
      length: satCount,
    },
    timestamp: data.timestamp,
  };
}

// ============================================================================
// INITIAL STATE (now includes all properties)
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

// Stub implementations for all methods
const stubUpdateTelemetry = () => {};
const stubSetConnectionStatus = () => {};
const stubAddFuelMetric = () => {};
const stubAddManeuvers = () => {};
const stubClearManeuvers = () => {};
const stubSelectSatellite = () => {};
const stubHoverSatellite = () => {};
const stubClearTrails = () => {};
const stubResetStore = () => {};
const stubScheduleManeuver = async () => false;
const stubStepSimulation = async () => ({ status: '', new_timestamp: '', collisions_detected: 0, maneuvers_executed: 0 });
const stubSetSimulationRunning = () => {};
const stubResetSimulation = () => {};
const stubSyncVisualizationSnapshot = async () => false;
const stubStartAutoSync = () => {};
const stubStopAutoSync = () => {};
const stubAddManeuverManually = () => {};

const INITIAL_STATE: OrbitalState = {
  debris: null,
  satellites: null,
  timestamp: null,
  lastUpdate: null,
  parseTimeMs: null,
  highRiskDebrisCount: 0,
  trails: {},
  connectionStatus: INITIAL_CONNECTION_STATUS,
  fuelHistory: [],
  maneuvers: [],
  simulation: INITIAL_SIMULATION,
  selectedSatelliteId: null,
  hoveredSatelliteId: null,
  _autoSyncInterval: null,

  updateTelemetry: stubUpdateTelemetry,
  setConnectionStatus: stubSetConnectionStatus,
  addFuelMetric: stubAddFuelMetric,
  addManeuvers: stubAddManeuvers,
  clearManeuvers: stubClearManeuvers,
  selectSatellite: stubSelectSatellite,
  hoverSatellite: stubHoverSatellite,
  clearTrails: stubClearTrails,
  resetStore: stubResetStore,
  scheduleManeuver: stubScheduleManeuver,
  stepSimulation: stubStepSimulation,
  setSimulationRunning: stubSetSimulationRunning,
  resetSimulation: stubResetSimulation,
  syncVisualizationSnapshot: stubSyncVisualizationSnapshot,
  startAutoSync: stubStartAutoSync,
  stopAutoSync: stubStopAutoSync,
  addManeuverManually: stubAddManeuverManually,
};

// ============================================================================
// ZUSTAND STORE
// ============================================================================

export const useOrbitalStore = create<OrbitalState>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL_STATE,

    // ==========================================================================
    // TELEMETRY UPDATE (from Web Worker / WebSocket)
    // ==========================================================================

    updateTelemetry: (debris, satellites, timestamp, parseTimeMs) => {
      const state = get();
      const now = Date.now();
      const highRiskCount = computeHighRiskCount(debris.riskScores);

      // 1. Detect maneuvers from fuel changes
      const newManeuvers = detectManeuvers(state.satellites, satellites, timestamp, state.maneuvers);
      if (newManeuvers.length > 0) get().addManeuvers(newManeuvers);

      // 2. Update trails
      const newTrails = appendTrails(state.trails, satellites, timestamp);

      // 3. Update state
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

      // 4. Fuel history (throttled)
      const lastMetric = state.fuelHistory[state.fuelHistory.length - 1];
      const lastUpdateTime = lastMetric?._updateTime ?? 0;
      if (now - lastUpdateTime >= CONSTANTS.FUEL_UPDATE_INTERVAL_MS && satellites.length > 0) {
        let totalFuel = 0;
        for (let i = 0; i < satellites.fuels.length; i++) totalFuel += satellites.fuels[i];
        get().addFuelMetric({
          timestamp,
          totalFuelKg: totalFuel,
          avgFuelKg: totalFuel / satellites.fuels.length,
          collisionsAvoided: 0,
          maneuversExecuted: state.maneuvers.length,
          _updateTime: now,
        });
      }
    },


    // ==========================================================================
    // SNAPSHOT POLLING (with logging)
    // ==========================================================================

    syncVisualizationSnapshot: async () => {
      try {
        console.log('[Store] Fetching /api/visualization/snapshot...');
        const response = await fetch('/api/visualization/snapshot');
        if (!response.ok) {
          if (response.status === 404) return false;
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        console.log('[Store] Snapshot received:', {
          timestamp: data.timestamp,
          satelliteCount: data.satellites.length,
          firstSat: data.satellites[0],
        });

        if (!data.timestamp || !Array.isArray(data.satellites) || !Array.isArray(data.debris_cloud))
          throw new Error('Invalid snapshot structure');

        const { debris, satellites, timestamp } = snapshotToBinaryBuffers(data);
        const state = get();
        const now = Date.now();

        // Log fuels from old state (if any)
        if (state.satellites) {
          console.log('[Store] Old fuel samples:', Array.from(state.satellites.fuels).slice(0, 5).map(f => f.toFixed(4)));
        } else {
          console.log('[Store] No previous satellites state (first snapshot)');
        }
        console.log('[Store] New fuel samples:', Array.from(satellites.fuels).slice(0, 5).map(f => f.toFixed(4)));

        // 1. Detect maneuvers (fuel drops)
        const newManeuvers = detectManeuvers(state.satellites, satellites, timestamp, state.maneuvers);
        if (newManeuvers.length > 0) {
          console.log(`[Store] 🔥 Adding ${newManeuvers.length} new maneuvers`);
          get().addManeuvers(newManeuvers);
        } else {
          console.log('[Store] No new maneuvers detected');
        }

        // 2. Update trails
        const newTrails = appendTrails(state.trails, satellites, timestamp);

        // 3. Update state
        set({
          debris,
          satellites,
          trails: newTrails,
          timestamp,
          lastUpdate: now,
          connectionStatus: {
            ...state.connectionStatus,
            state: 'connected',
            lastSuccessfulFetch: now,
            consecutiveFailures: 0,
            error: null,
          },
        });

        // 4. Add fuel metric (throttled)
        const lastMetric = state.fuelHistory[state.fuelHistory.length - 1];
        const lastUpdateTime = lastMetric?._updateTime ?? 0;
        if (now - lastUpdateTime >= CONSTANTS.FUEL_UPDATE_INTERVAL_MS && satellites.length > 0) {
          let totalFuel = 0;
          for (let i = 0; i < satellites.fuels.length; i++) totalFuel += satellites.fuels[i];
          get().addFuelMetric({
            timestamp,
            totalFuelKg: totalFuel,
            avgFuelKg: totalFuel / satellites.fuels.length,
            collisionsAvoided: 0,
            maneuversExecuted: state.maneuvers.length,
            _updateTime: now,
          });
          console.log('[Store] Added fuel metric:', { timestamp, totalFuelKg: totalFuel.toFixed(2), avg: (totalFuel / satellites.fuels.length).toFixed(2) });
        }

        return true;
      } catch (error) {
        console.error('[Store] syncVisualizationSnapshot failed:', error);
        get().setConnectionStatus({
          state: 'error',
          error: error instanceof Error ? error.message : 'Sync failed',
        });
        return false;
      }
    },
    // ==========================================================================
    // SIMPLE SETTERS
    // ==========================================================================

    setConnectionStatus: (status) =>
      set((state) => ({
        connectionStatus: {
          ...state.connectionStatus,
          ...status,
          state: status.state ?? state.connectionStatus.state,
        },
      })),

    addFuelMetric: (metric) =>
      set((state) => ({
        fuelHistory: [...state.fuelHistory.slice(-(CONSTANTS.MAX_FUEL_HISTORY - 1)), metric],
      })),

    addManeuvers: (maneuvers) =>
      set((state) => {
        const existingIds = new Set(state.maneuvers.map((m) => m.burn_id));
        const newManeuvers = maneuvers.filter((m) => !existingIds.has(m.burn_id));
        return {
          maneuvers: [...state.maneuvers, ...newManeuvers].slice(-CONSTANTS.MAX_MANEUVERS),
        };
      }),

    clearManeuvers: () => set({ maneuvers: [] }),

    selectSatellite: (id) =>
      set({
        selectedSatelliteId: id,
        hoveredSatelliteId: id ? null : get().hoveredSatelliteId,
      }),

    hoverSatellite: (id) => set({ hoveredSatelliteId: id }),

    clearTrails: () => set({ trails: {} }),

    resetStore: () => set(INITIAL_STATE),

    // ==========================================================================
    // API STUBS (for completeness)
    // ==========================================================================

    scheduleManeuver: async () => false,
    stepSimulation: async () => ({ status: '', new_timestamp: '', collisions_detected: 0, maneuvers_executed: 0 }),
    setSimulationRunning: (isRunning) =>
      set((state) => ({
        simulation: { ...state.simulation, status: isRunning ? 'running' : 'paused' },
      })),
    resetSimulation: () => set({ simulation: { ...INITIAL_SIMULATION } }),

    // ==========================================================================
    // AUTO-SYNC
    // ==========================================================================

    startAutoSync: (intervalMs = 2000) => {
      const { _autoSyncInterval, syncVisualizationSnapshot, stopAutoSync } = get();
      if (_autoSyncInterval) stopAutoSync();
      const interval = setInterval(() => {
        syncVisualizationSnapshot();
      }, intervalMs);
      set({ _autoSyncInterval: interval });
    },

    stopAutoSync: () => {
      const { _autoSyncInterval } = get();
      if (_autoSyncInterval) {
        clearInterval(_autoSyncInterval);
        set({ _autoSyncInterval: null });
      }
    },

    addManeuverManually: (maneuver) => {
      get().addManeuvers([maneuver]);
    },
  }))
);

// ============================================================================
// MEMOIZED SELECTORS (unchanged)
// ============================================================================

const selectSatellites = (state: OrbitalState) => state.satellites;
const selectSelectedSatelliteId = (state: OrbitalState) => state.selectedSatelliteId;
const selectHoveredSatelliteId = (state: OrbitalState) => state.hoveredSatelliteId;
const selectTrails = (state: OrbitalState) => state.trails;
const selectManeuvers = (state: OrbitalState) => state.maneuvers;

export const selectSelectedSatellite = createSelector(
  [selectSatellites, selectSelectedSatelliteId],
  (satellites, id) => {
    if (!satellites || !id) return null;
    const idx = satellites.ids.indexOf(id);
    if (idx === -1) return null;
    return {
      id: satellites.ids[idx],
      lon: satellites.positions[idx * 3],
      lat: satellites.positions[idx * 3 + 1],
      alt: satellites.positions[idx * 3 + 2],
      fuel_kg: satellites.fuels[idx],
      status: satellites.statuses[idx] as Satellite['status'],
    };
  }
);

export const selectHoveredSatellite = createSelector(
  [selectSatellites, selectHoveredSatelliteId],
  (satellites, id) => {
    if (!satellites || !id) return null;
    const idx = satellites.ids.indexOf(id);
    if (idx === -1) return null;
    return {
      id: satellites.ids[idx],
      lon: satellites.positions[idx * 3],
      lat: satellites.positions[idx * 3 + 1],
      alt: satellites.positions[idx * 3 + 2],
    };
  }
);

export const selectSelectedSatelliteTrail = createSelector(
  [selectSelectedSatellite, selectTrails],
  (selected, trails) => {
    if (!selected) return null;
    return trails[selected.id] || null;
  }
);

export const selectManeuversForSatellite = createSelector(
  [selectManeuvers, (_, satelliteId: string | null) => satelliteId],
  (maneuvers, satelliteId) =>
    !satelliteId ? maneuvers : maneuvers.filter((m) => m.satellite_id === satelliteId)
);

export const selectDebrisCount = (state: OrbitalState) => state.debris?.length ?? 0;
export const selectSatelliteCount = (state: OrbitalState) => state.satellites?.length ?? 0;
export const selectHighRiskDebrisCount = (state: OrbitalState) => state.highRiskDebrisCount;
export const selectConnectionState = (state: OrbitalState) => state.connectionStatus.state;
export const selectLatestFuelMetric = (state: OrbitalState) =>
  state.fuelHistory.length > 0 ? state.fuelHistory[state.fuelHistory.length - 1] : null;
export const selectSimulationState = (state: OrbitalState) => state.simulation;
export const selectSimulationTime = (state: OrbitalState) => state.timestamp;
export const selectTimestamp = (state: OrbitalState) => state.timestamp;

// ============================================================================
// UTILITY
// ============================================================================

export const formatSimulationTime = (timestamp: string | null): string => {
  if (!timestamp) return '--:--:--';
  const date = new Date(timestamp);
  return date.toISOString().replace('T', ' ').substring(0, 19) + 'Z';
};

export default useOrbitalStore;