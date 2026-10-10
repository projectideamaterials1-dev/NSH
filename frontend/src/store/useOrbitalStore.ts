// src/store/useOrbitalStore.ts
// Zustand store – Crimson Nebula
// Live snapshots (stream/poll via telemetryClient), operations data (conjunctions, events, metrics,
// autopilot), selected-satellite insights, replay history, simulation controls and operator actions.
// State and action types live in ./types, pure helpers in ./frames, selectors in ./selectors and the
// actions in ./slices/*.

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { INITIAL_SIMULATION } from './frames';
import { createOpsActions } from './slices/ops';
import { createRealWorldActions } from './slices/realWorld';
import { createSimulationActions } from './slices/simulation';
import { createTelemetryActions } from './slices/telemetry';
import type { CatalogLoadRequest, OrbitalState } from './types';

export * from './types';
export * from './selectors';
export { pushReplayFrame, toReplayFrame } from './frames';

/** Default real-world scenario: every fleet source (shared fairly up to max_satellites) against three major debris fields. */
export const DEFAULT_CATALOG_REQUEST: CatalogLoadRequest = {
  fleet: ['isro-eo', 'stations', 'planet', 'oneweb', 'starlink', 'gps-ops', 'weather', 'resource', 'science'],
  objects: ['fengyun-1c-debris', 'cosmos-2251-debris', 'iridium-33-debris'],
  norad_ids: [],
  max_satellites: 150,
  max_objects: 5000,
  replace: true,
  live: true,
};

export const useOrbitalStore = create<OrbitalState>()(
  subscribeWithSelector((set, get) => ({
    debris: null,
    satellites: null,
    timestamp: null,
    lastUpdate: null,
    parseTimeMs: null,
    highRiskDebrisCount: 0,
    trails: {},
    connectionStatus: {
      state: 'disconnected',
      lastSuccessfulFetch: null,
      consecutiveFailures: 0,
      latencyMs: null,
      error: null,
    },
    fuelHistory: [],
    maneuvers: [],
    satelliteDetails: {},
    conjunctions: [],
    events: [],
    lastEventId: 0,
    metrics: null,
    autopilot: null,
    config: null,
    selectedTrack: null,
    selectedPasses: null,
    screening: false,
    realWorld: null,
    catalogSources: null,
    spaceWeather: null,
    selectedCatalog: null,
    dataSourcesOpen: false,
    imagery: {},
    _imageryFor: null,
    _imageryRetryAt: 0,
    history: [],
    replayIndex: null,
    viewMode: '3d',
    simulation: INITIAL_SIMULATION,
    simulationSpeed: 60,
    isSimulationRunning: false,
    selectedSatelliteId: null,
    hoveredSatelliteId: null,
    _autoSyncInterval: null,
    _maneuverInterval: null,
    _opsInterval: null,
    _insightInterval: null,
    _simInterval: null,
    _weatherInterval: null,
    _stopStream: null,
    _stepInFlight: false,

    ...createTelemetryActions(set, get),
    ...createOpsActions(set, get),
    ...createSimulationActions(set, get),
    ...createRealWorldActions(set, get),
  }))
);

export default useOrbitalStore;
