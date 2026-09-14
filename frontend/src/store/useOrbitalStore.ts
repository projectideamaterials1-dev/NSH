// src/store/useOrbitalStore.ts
// Zustand store – Crimson Nebula
// Live snapshots (stream/poll via telemetryClient), operations data (conjunctions, events, metrics,
// autopilot), selected-satellite insights, replay history, simulation controls and operator actions.

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { createSelector } from 'reselect';
import { apiFetch, apiJson } from '../api/http';
import telemetryClient from '../api/telemetryClient';
import { snapshotToBinaryBuffers } from './snapshotBuffers';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type SatelliteStatus = 'NOMINAL' | 'WARNING' | 'CRITICAL' | 'CRITICAL_FUEL' | 'EOL';

export interface Satellite {
  id: string;
  lat: number;
  lon: number;
  alt?: number;
  fuel_kg: number;
  status: SatelliteStatus;
}

export type ManeuverType =
  | 'PHASING_PROGRADE' | 'PHASING_RETROGRADE' | 'RADIAL_SHUNT' | 'RECOVERY' | 'EOL_GRAVEYARD'
  | 'MANUAL' | 'EXTERNAL' | 'PLANE_CHANGE';

export interface ManeuverEvent {
  burn_id: string;
  satellite_id: string;
  burnTime: string;
  deltaV_vector: { x: number; y: number; z: number };
  maneuver_type: ManeuverType;
  duration_seconds: number;
  cooldown_start: string;
  cooldown_end: string;
  delta_v_magnitude: number;
  fuel_consumed_kg?: number;
  lat?: number;
  lon?: number;
  status?: 'pending' | 'executed';
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

export interface BurnCommand {
  burn_id: string;
  burnTime: string;
  deltaV_vector: { x: number; y: number; z: number };
}

export interface ManeuverScheduleResult {
  status: string;
  validation: {
    ground_station_los: boolean;
    sufficient_fuel: boolean;
    projected_mass_remaining_kg: number;
  };
}

export type SatelliteMode = 'NOMINAL' | 'BURN_QUEUED' | 'EVADING' | 'RECOVERING' | 'GRAVEYARD';

export interface SatelliteDetail {
  id: string;
  lat: number;
  lon: number;
  alt_km: number;
  fuel_kg: number;
  status: SatelliteStatus;
  mode: SatelliteMode;
  drift_km: number;
  in_box: boolean;
  cooldown_s: number;
  in_contact: boolean;
  threat: 'CRITICAL' | 'WARNING' | 'WATCH' | null;
  queued_burns: number;
}

export type RiskLevel = 'CRITICAL' | 'WARNING' | 'WATCH';
export type CdmStatus = 'ACTIVE' | 'MITIGATED' | 'CLEARED' | 'RESOLVED' | 'COLLIDED';

export interface Conjunction {
  cdm_id: string;
  satellite_id: string;
  object_id: string;
  object_type: 'DEBRIS' | 'SATELLITE';
  tca: string;
  tca_ts: number;
  miss_distance_km: number;
  min_predicted_miss_km: number;
  initial_miss_km: number;
  relative_velocity_kms: number;
  approach_angle_deg: number;
  risk: RiskLevel;
  peak_risk: RiskLevel;
  status: CdmStatus;
  mitigation_burn_ids: string[];
  detected_at: string;
  updated_at: string;
}

export interface OpsEvent {
  id: number;
  sim_time: string | null;
  wall_time: string;
  level: 'info' | 'ok' | 'warn' | 'crit';
  category: string;
  message: string;
  satellite_id: string | null;
  data: Record<string, unknown>;
}

export interface MissionMetrics {
  sim_time: string | null;
  sim_seconds_elapsed: number;
  satellites: number;
  debris: number;
  collisions_detected: number;
  collisions_avoided: number;
  conjunctions: {
    by_status: Record<string, number>;
    open_by_risk: Record<RiskLevel, number>;
    avoided: number;
    total: number;
  };
  burns_executed: number;
  burns_rejected: number;
  avoidance_burns_executed: number;
  fuel_used_kg: number;
  fuel_per_avoidance_kg: number | null;
  fleet_fuel_remaining_kg: number;
  station_keeping: {
    uptime_percentage: number;
    time_weighted_uptime_percentage: number;
    satellites_outside_box: number;
    box_radius_km?: number;
  };
  eol_satellites: number;
  last_screen: Record<string, any> | null;
}

export interface AutopilotInfo {
  enabled: boolean;
  strategy: 'Auto' | 'TriShunt' | 'RadialOverride';
  strategies: { name: string; description: string }[];
}

export interface TrackPoint { t: string; offset_s: number; lat: number; lon: number; alt_km: number }

export interface GroundPass {
  station_id: string;
  station_name: string;
  start: string;
  end: string;
  duration_s: number;
  max_elevation_deg: number;
  in_progress: boolean;
}

export interface SimConfigDto {
  dryMass: number;
  initialFuel: number;
  stationKeepingRadius: number;
  maxDeltaV: number;
  cooldownSeconds: number;
  eolFuelThreshold: number;
  lowFuelWarning: number;
  autopilotEnabled: boolean;
  avoidanceStrategy: string;
  cdmWarningKm: number;
  cdmHorizonSeconds: number;
  cdmScreenIntervalSeconds: number;
}

export interface ManualBurnInput {
  offset_s: number;
  frame: 'RTN' | 'ECI';
  dv_mps: Record<string, number>;
}

export interface ManualPlanResult {
  status: string;
  validation: ManeuverScheduleResult['validation'];
  fuel_needed_kg: number;
  available_fuel_kg: number;
  burns: { burn_id: string; ts: number; delta_v_mps: number; fuel_kg?: number; maneuver_type: string; violation?: string }[];
  checks: { ground_station_los: boolean; cooldown: boolean; max_delta_v: boolean; fuel: boolean };
  dry_run: boolean;
  scheduled: boolean;
  burns_eci: { burn_id: string; burnTime: string; deltaV_vector: { x: number; y: number; z: number }; delta_v_mps: number }[];
  orbit_before: Record<string, number>;
  orbit_after: Record<string, number>;
}

// ── Real-world data (CelesTrak catalog, live mode, NOAA space weather) ───────

export interface CatalogSource {
  key: string;
  label: string;
  role: 'fleet' | 'objects';
  description: string;
  cache: { fetched_at: string; count: number; stale: boolean } | null;
}

export interface CatalogLoadRequest {
  fleet: string[];
  objects: string[];
  norad_ids: number[];
  max_satellites: number;
  max_objects: number;
  replace: boolean;
  live: boolean;
  force_refresh?: boolean;
}

export interface RealWorldStatus {
  live: boolean;
  loaded: boolean;
  request: (Omit<CatalogLoadRequest, 'live'>) | null;
  satellites: number;
  tracked_objects: number;
  sources: Record<string, { fetched_at?: string; cached?: boolean; stale?: boolean; count?: number; error?: string }>;
  warnings: string[];
  skipped: { stale: number; propagation: number; duplicate: number };
  element_age_hours: { median: number; max: number } | null;
  loaded_at: string | null;
  last_resync: string | null;
  last_refresh: string | null;
  next_refresh: string | null;
  clock_lag_s: number | null;
  last_error: string | null;
  propagator: string;
  data_source: string;
}

export interface CatalogObjectInfo {
  id: string;
  kind: 'satellite' | 'tracked_object';
  norad_id: number;
  name: string;
  intl_designator: string;
  source: string;
  source_label: string;
  epoch: string;
  element_age_hours: number;
  maneuvered_since_anchor?: boolean | null;
  elements: {
    inclination_deg: number; eccentricity: number; raan_deg: number; arg_perigee_deg: number; mean_anomaly_deg: number;
    mean_motion_rev_day: number; period_min: number; semi_major_axis_km: number; perigee_alt_km: number; apogee_alt_km: number;
    bstar: number;
  };
}

export interface SpaceWeather {
  source: string;
  kp: number | null;
  kp_time: string | null;
  kp_level: string;
  f107_sfu: number | null;
  f107_time: string | null;
  scales: Record<'G' | 'S' | 'R', { scale: number; text: string }> | null;
  errors?: string[] | null;
}

/** One replayable snapshot (positions only; ids are stable per frame). */
export interface ReplayFrame {
  timestamp: string;
  satIds: string[];
  satPositions: Float32Array;
  satFuels: Float32Array;
  satStatuses: string[];
  debrisPositions: Float32Array;
  debrisLength: number;
}

interface SimulationInfo {
  status: 'idle' | 'running' | 'paused' | 'error';
  stepsRun: number;
  collisionsDetected: number;
  maneuversExecuted: number;
  lastStepResponse: SimulationStepResponse | null;
  error: string | null;
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

  // operations
  satelliteDetails: Record<string, SatelliteDetail>;
  conjunctions: Conjunction[];
  events: OpsEvent[];
  lastEventId: number;
  metrics: MissionMetrics | null;
  autopilot: AutopilotInfo | null;
  config: SimConfigDto | null;
  selectedTrack: TrackPoint[] | null;
  selectedPasses: GroundPass[] | null;
  screening: boolean;

  // real-world data
  realWorld: RealWorldStatus | null;
  catalogSources: CatalogSource[] | null;
  spaceWeather: SpaceWeather | null;
  selectedCatalog: CatalogObjectInfo | null;
  dataSourcesOpen: boolean;

  // replay & view
  history: ReplayFrame[];
  replayIndex: number | null;
  viewMode: '2d' | '3d';

  simulation: SimulationInfo;
  /** Simulated seconds advanced per real second while the simulation is running. */
  simulationSpeed: number;
  isSimulationRunning: boolean;

  selectedSatelliteId: string | null;
  hoveredSatelliteId: string | null;
  _autoSyncInterval: ReturnType<typeof setInterval> | null;
  _maneuverInterval: ReturnType<typeof setInterval> | null;
  _opsInterval: ReturnType<typeof setInterval> | null;
  _insightInterval: ReturnType<typeof setInterval> | null;
  _simInterval: ReturnType<typeof setInterval> | null;
  _weatherInterval: ReturnType<typeof setInterval> | null;
  _stopStream: (() => void) | null;
  _stepInFlight: boolean;

  // Actions
  ingestFrame: (timestamp: string, satellites: SatelliteBinaryData, debris: DebrisBinaryData, parseTimeMs: number, latencyMs?: number) => void;
  setConnectionStatus: (status: Partial<ConnectionStatus>) => void;
  addFuelMetric: (metric: FuelMetric) => void;
  selectSatellite: (id: string | null) => void;
  hoverSatellite: (id: string | null) => void;
  clearTrails: () => void;

  syncVisualizationSnapshot: () => Promise<boolean>;
  fetchManeuvers: () => Promise<void>;
  fetchOps: () => Promise<void>;
  fetchAutopilot: () => Promise<void>;
  fetchSelectedInsights: (id?: string | null) => Promise<void>;
  startAutoSync: (intervalMs?: number) => void;
  stopAutoSync: () => void;

  scheduleManeuver: (satelliteId: string, maneuverSequence: BurnCommand[]) => Promise<ManeuverScheduleResult>;
  cancelManeuver: (burnId: string) => Promise<void>;
  planManualBurn: (satelliteId: string, burns: ManualBurnInput[], dryRun: boolean) => Promise<ManualPlanResult>;
  setAutopilot: (update: { enabled?: boolean; strategy?: AutopilotInfo['strategy'] }) => Promise<void>;
  screenNow: () => Promise<void>;
  fetchConfig: () => Promise<SimConfigDto | null>;
  saveConfig: (config: Partial<SimConfigDto>) => Promise<void>;
  stepSimulation: (stepSeconds: number) => Promise<SimulationStepResponse | null>;
  setSimulationSpeed: (speed: number) => void;
  setSimulationRunning: (isRunning: boolean) => void;
  setReplayIndex: (index: number | null) => void;
  setViewMode: (mode: '2d' | '3d') => void;

  fetchRealWorld: () => Promise<void>;
  fetchCatalogSources: () => Promise<CatalogSource[] | null>;
  loadCatalog: (request: CatalogLoadRequest) => Promise<RealWorldStatus>;
  refreshCatalog: () => Promise<void>;
  setLiveMode: (enabled: boolean) => Promise<void>;
  fetchSpaceWeather: () => Promise<void>;
  setDataSourcesOpen: (open: boolean) => void;
}

/** Default real-world scenario: ISRO Earth-observation fleet + space stations against three major debris fields. */
export const DEFAULT_CATALOG_REQUEST: CatalogLoadRequest = {
  fleet: ['isro-eo', 'stations'],
  objects: ['fengyun-1c-debris', 'cosmos-2251-debris', 'iridium-33-debris'],
  norad_ids: [],
  max_satellites: 60,
  max_objects: 5000,
  replace: true,
  live: true,
};

// ============================================================================
// CONSTANTS
// ============================================================================

const CONSTANTS = {
  MAX_TRAIL_POINTS: 5400,
  MAX_FUEL_HISTORY: 720,
  MAX_MANEUVERS: 500,
  MAX_EVENTS: 400,
  MAX_REPLAY_FRAMES: 240,
  FUEL_UPDATE_INTERVAL_MS: 60000,
  SIM_TICK_MS: 1000,
  OPS_INTERVAL_MS: 2500,
  SPACE_WEATHER_INTERVAL_MS: 10 * 60 * 1000,
  INSIGHT_INTERVAL_MS: 30000,
} as const;

// ============================================================================
// HELPERS
// ============================================================================

function appendTrails(stateTrails: Record<string, SatelliteTrail>, satellites: SatelliteBinaryData, timestamp: string) {
  const newTrails: Record<string, SatelliteTrail> = {};

  for (let i = 0; i < satellites.length; i++) {
    const id = satellites.ids[i];
    const newPos: [number, number, number] = [
      satellites.positions[i * 3],
      satellites.positions[i * 3 + 1],
      satellites.positions[i * 3 + 2],
    ];

    const trail = stateTrails[id] ?? { satelliteId: id, positions: [], timestamps: [] };
    const lastPos = trail.positions[trail.positions.length - 1];
    const isDifferent =
      !lastPos || lastPos[0] !== newPos[0] || lastPos[1] !== newPos[1] || lastPos[2] !== newPos[2];

    if (isDifferent) {
      trail.positions.push(newPos);
      trail.timestamps.push(timestamp);
      if (trail.positions.length > CONSTANTS.MAX_TRAIL_POINTS) {
        trail.positions.shift();
        trail.timestamps.shift();
      }
    }
    newTrails[id] = trail;
  }
  return newTrails;
}

export function toReplayFrame(timestamp: string, satellites: SatelliteBinaryData, debris: DebrisBinaryData): ReplayFrame {
  const debrisPositions = new Float32Array(debris.length * 2);
  for (let i = 0; i < debris.length; i++) {
    debrisPositions[i * 2] = debris.positions[i * 3];
    debrisPositions[i * 2 + 1] = debris.positions[i * 3 + 1];
  }
  return {
    timestamp,
    satIds: satellites.ids,
    satPositions: satellites.positions,
    satFuels: satellites.fuels,
    satStatuses: satellites.statuses,
    debrisPositions,
    debrisLength: debris.length,
  };
}

/** Appends a frame, skipping duplicate timestamps and keeping the replay cursor on the same frame. */
export function pushReplayFrame(history: ReplayFrame[], frame: ReplayFrame, replayIndex: number | null, max: number) {
  if (history.length && history[history.length - 1].timestamp === frame.timestamp) {
    return { history, replayIndex };
  }
  const next = [...history, frame];
  let index = replayIndex;
  if (next.length > max) {
    next.splice(0, next.length - max);
    if (index !== null) index = Math.max(0, index - 1);
  }
  return { history: next, replayIndex: index };
}

const INITIAL_SIMULATION: SimulationInfo = {
  status: 'idle',
  stepsRun: 0,
  collisionsDetected: 0,
  maneuversExecuted: 0,
  lastStepResponse: null,
  error: null,
};

// ============================================================================
// ZUSTAND STORE
// ============================================================================

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

    // ==========================================================================
    // SNAPSHOTS
    // ==========================================================================

    ingestFrame: (timestamp, satellites, debris, parseTimeMs, latencyMs) => {
      const state = get();
      const now = Date.now();
      const replay = pushReplayFrame(state.history, toReplayFrame(timestamp, satellites, debris), state.replayIndex,
        CONSTANTS.MAX_REPLAY_FRAMES);

      set({
        debris,
        satellites,
        trails: appendTrails(state.trails, satellites, timestamp),
        timestamp,
        lastUpdate: now,
        parseTimeMs,
        history: replay.history,
        replayIndex: replay.replayIndex,
        connectionStatus: {
          state: 'connected',
          lastSuccessfulFetch: now,
          consecutiveFailures: 0,
          latencyMs: latencyMs ?? state.connectionStatus.latencyMs,
          error: null,
        },
      });

      const lastMetric = state.fuelHistory[state.fuelHistory.length - 1];
      if (now - (lastMetric?._updateTime ?? 0) >= CONSTANTS.FUEL_UPDATE_INTERVAL_MS && satellites.length > 0) {
        let totalFuel = 0;
        for (let i = 0; i < satellites.fuels.length; i++) totalFuel += satellites.fuels[i];
        get().addFuelMetric({
          timestamp,
          totalFuelKg: totalFuel,
          avgFuelKg: totalFuel / satellites.fuels.length,
          collisionsAvoided: state.metrics?.collisions_avoided ?? 0,
          maneuversExecuted: state.maneuvers.filter(m => m.status === 'executed').length,
          _updateTime: now,
        });
      }
    },

    syncVisualizationSnapshot: async () => {
      const started = performance.now();
      try {
        const response = await apiFetch('/api/visualization/snapshot');
        if (response.status === 400) {
          get().setConnectionStatus({ state: 'connecting', error: 'Awaiting telemetry (POST /api/telemetry)' });
          return false;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data.timestamp || !Array.isArray(data.satellites) || !Array.isArray(data.debris_cloud)) {
          throw new Error('Invalid snapshot structure');
        }
        const parseStart = performance.now();
        const { debris, satellites, timestamp } = snapshotToBinaryBuffers(data);
        get().ingestFrame(timestamp, satellites, debris, performance.now() - parseStart, performance.now() - started);
        return true;
      } catch (error) {
        get().setConnectionStatus({
          state: 'error',
          consecutiveFailures: get().connectionStatus.consecutiveFailures + 1,
          error: error instanceof Error ? error.message : 'Sync failed',
        });
        return false;
      }
    },

    // ==========================================================================
    // OPERATIONS DATA
    // ==========================================================================

    fetchManeuvers: async () => {
      try {
        const data = await apiJson<{ maneuvers: any[] }>('/api/maneuvers');
        const maneuvers: ManeuverEvent[] = data.maneuvers
          .filter(m => m.status === 'pending' || m.status === 'executed')
          .map(m => ({
            burn_id: m.burn_id,
            satellite_id: m.satellite_id,
            burnTime: m.burnTime,
            deltaV_vector: m.deltaV_vector,
            maneuver_type: m.maneuver_type === 'UNKNOWN' ? 'EXTERNAL' : m.maneuver_type,
            duration_seconds: m.duration_seconds,
            cooldown_start: m.cooldown_start,
            cooldown_end: m.cooldown_end,
            delta_v_magnitude: m.delta_v_magnitude,
            fuel_consumed_kg: m.fuel_consumed_kg ?? undefined,
            lat: m.lat ?? undefined,
            lon: m.lon ?? undefined,
            status: m.status,
          }));
        set({ maneuvers: maneuvers.slice(-CONSTANTS.MAX_MANEUVERS) });
      } catch {
        // Expected before telemetry is ingested; the next poll retries.
      }
    },

    fetchOps: async () => {
      const after = get().lastEventId;
      const [sats, cdms, events, metrics] = await Promise.allSettled([
        apiJson<{ satellites: SatelliteDetail[] }>('/api/satellites'),
        apiJson<{ conjunctions: Conjunction[] }>('/api/conjunctions?status=open'),
        apiJson<{ events: OpsEvent[]; last_id: number }>(`/api/events?after_id=${after}&limit=200`),
        apiJson<MissionMetrics>('/api/metrics'),
      ]);
      const patch: Partial<OrbitalState> = {};
      if (sats.status === 'fulfilled') {
        const byId: Record<string, SatelliteDetail> = {};
        for (const s of sats.value.satellites) byId[s.id] = s;
        patch.satelliteDetails = byId;
      }
      if (cdms.status === 'fulfilled') patch.conjunctions = cdms.value.conjunctions;
      if (events.status === 'fulfilled') {
        const { events: fresh, last_id } = events.value;
        if (last_id < after) {
          // backend restarted: reset the feed
          patch.events = fresh.slice(-CONSTANTS.MAX_EVENTS);
        } else if (fresh.length) {
          patch.events = [...get().events, ...fresh].slice(-CONSTANTS.MAX_EVENTS);
        }
        patch.lastEventId = last_id;
      }
      if (metrics.status === 'fulfilled') patch.metrics = metrics.value;
      set(patch);
    },

    fetchAutopilot: async () => {
      try {
        set({ autopilot: await apiJson<AutopilotInfo>('/api/autopilot') });
      } catch {
        /* backend offline */
      }
    },

    fetchSelectedInsights: async (id = get().selectedSatelliteId) => {
      if (!id) {
        set({ selectedTrack: null, selectedPasses: null, selectedCatalog: null });
        return;
      }
      const [track, passes, catalog] = await Promise.allSettled([
        apiJson<{ points: TrackPoint[] }>(`/api/satellites/${encodeURIComponent(id)}/track?minutes=95&step_s=60`),
        apiJson<{ passes: GroundPass[] }>(`/api/satellites/${encodeURIComponent(id)}/passes?hours=6`),
        get().realWorld?.loaded
          ? apiJson<CatalogObjectInfo>(`/api/catalog/objects/${encodeURIComponent(id)}`)
          : Promise.reject(new Error('no catalog')),
      ]);
      if (get().selectedSatelliteId !== id) return; // selection changed meanwhile
      set({
        selectedTrack: track.status === 'fulfilled' ? track.value.points : null,
        selectedPasses: passes.status === 'fulfilled' ? passes.value.passes : null,
        selectedCatalog: catalog.status === 'fulfilled' ? catalog.value : null,
      });
    },

    startAutoSync: (intervalMs = 2000) => {
      const state = get();
      state.stopAutoSync();
      const stopStream = telemetryClient.start(
        (timestamp, satellites, debris, m) => get().ingestFrame(timestamp, satellites, debris, m.parseTimeMs, m.latencyMs),
        { intervalMs }
      );
      telemetryClient.onStatusChange(status => {
        // A stream that is open but idle is "awaiting telemetry" until the first frame arrives.
        if (status.state === 'connected' || !get().satellites || status.state === 'error') get().setConnectionStatus(status);
      });
      state.fetchManeuvers();
      state.fetchOps();
      state.fetchAutopilot();
      state.fetchConfig();
      state.fetchRealWorld();
      state.fetchSpaceWeather();
      set({
        _weatherInterval: setInterval(() => get().fetchSpaceWeather(), CONSTANTS.SPACE_WEATHER_INTERVAL_MS),
        _stopStream: stopStream,
        _maneuverInterval: setInterval(() => get().fetchManeuvers(), 4000),
        _opsInterval: setInterval(() => {
          get().fetchRealWorld();
          get().fetchOps().then(() => {
            if (!get().satellites && Object.keys(get().satelliteDetails).length === 0 && get().connectionStatus.state !== 'error') {
              get().setConnectionStatus({ state: 'connecting', error: 'Awaiting telemetry (POST /api/telemetry)' });
            }
          });
        }, CONSTANTS.OPS_INTERVAL_MS),
        _autoSyncInterval: setInterval(() => get().fetchAutopilot(), 15000),
        _insightInterval: setInterval(() => get().fetchSelectedInsights(), CONSTANTS.INSIGHT_INTERVAL_MS),
      });
    },

    stopAutoSync: () => {
      const { _autoSyncInterval, _maneuverInterval, _opsInterval, _insightInterval, _weatherInterval, _stopStream } = get();
      [_autoSyncInterval, _maneuverInterval, _opsInterval, _insightInterval, _weatherInterval].forEach(i => i && clearInterval(i));
      _stopStream?.();
      set({ _autoSyncInterval: null, _maneuverInterval: null, _opsInterval: null, _insightInterval: null, _weatherInterval: null, _stopStream: null });
    },

    // ==========================================================================
    // SIMPLE SETTERS
    // ==========================================================================

    setConnectionStatus: (status) =>
      set((state) => ({ connectionStatus: { ...state.connectionStatus, ...status } })),

    addFuelMetric: (metric) =>
      set((state) => ({
        fuelHistory: [...state.fuelHistory.slice(-(CONSTANTS.MAX_FUEL_HISTORY - 1)), metric],
      })),

    selectSatellite: (id) => {
      set({
        selectedSatelliteId: id,
        hoveredSatelliteId: id ? null : get().hoveredSatelliteId,
        selectedTrack: null,
        selectedPasses: null,
      });
      if (id) get().fetchSelectedInsights(id);
    },

    hoverSatellite: (id) => set({ hoveredSatelliteId: id }),

    clearTrails: () => set({ trails: {} }),

    setReplayIndex: (index) => {
      const { history } = get();
      if (index === null || history.length === 0) {
        set({ replayIndex: null });
        return;
      }
      const clamped = Math.max(0, Math.min(history.length - 1, index));
      set({ replayIndex: clamped === history.length - 1 && index >= history.length - 1 ? null : clamped });
    },

    setViewMode: (mode) => set({ viewMode: mode }),

    // ==========================================================================
    // BACKEND COMMANDS
    // ==========================================================================

    scheduleManeuver: async (satelliteId, maneuverSequence) => {
      const result = await apiJson<ManeuverScheduleResult>('/api/maneuver/schedule', {
        method: 'POST',
        body: JSON.stringify({ satelliteId, maneuver_sequence: maneuverSequence }),
      });
      await Promise.all([get().fetchManeuvers(), get().fetchOps()]);
      return result;
    },

    cancelManeuver: async (burnId) => {
      await apiJson(`/api/maneuver/${encodeURIComponent(burnId)}`, { method: 'DELETE' });
      await Promise.all([get().fetchManeuvers(), get().fetchOps()]);
    },

    planManualBurn: async (satelliteId, burns, dryRun) => {
      const result = await apiJson<ManualPlanResult>('/api/maneuver/manual', {
        method: 'POST',
        body: JSON.stringify({ satelliteId, burns, dry_run: dryRun }),
      });
      if (!dryRun) await Promise.all([get().fetchManeuvers(), get().fetchOps()]);
      return result;
    },

    setAutopilot: async (update) => {
      const autopilot = await apiJson<AutopilotInfo>('/api/autopilot', { method: 'PUT', body: JSON.stringify(update) });
      set({ autopilot });
      get().fetchOps();
    },

    screenNow: async () => {
      set({ screening: true });
      try {
        await apiJson('/api/conjunctions/screen', { method: 'POST' });
        await Promise.all([get().fetchOps(), get().fetchManeuvers()]);
      } finally {
        set({ screening: false });
      }
    },

    fetchConfig: async () => {
      try {
        const config = await apiJson<SimConfigDto>('/api/config');
        set({ config });
        return config;
      } catch {
        return null;
      }
    },

    saveConfig: async (config) => {
      const result = await apiJson<{ config: SimConfigDto }>('/api/config', { method: 'POST', body: JSON.stringify(config) });
      set({ config: result.config });
      await Promise.all([get().fetchAutopilot(), get().fetchOps()]);
    },

    stepSimulation: async (stepSeconds) => {
      if (get()._stepInFlight) return null; // never overlap steps
      set({ _stepInFlight: true });
      try {
        const result = await apiJson<SimulationStepResponse>('/api/simulate/step', {
          method: 'POST',
          body: JSON.stringify({ step_seconds: stepSeconds }),
        });
        set((state) => ({
          simulation: {
            ...state.simulation,
            stepsRun: state.simulation.stepsRun + 1,
            collisionsDetected: state.simulation.collisionsDetected + result.collisions_detected,
            maneuversExecuted: state.simulation.maneuversExecuted + result.maneuvers_executed,
            lastStepResponse: result,
            error: null,
          },
        }));
        // The stream pushes the new frame too; refreshing here makes the step feel immediate.
        await telemetryClient.refresh();
        if (result.maneuvers_executed > 0) await get().fetchManeuvers();
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Step failed';
        get().setSimulationRunning(false);
        set((state) => ({ simulation: { ...state.simulation, status: 'error', error: message } }));
        return null;
      } finally {
        set({ _stepInFlight: false });
      }
    },

    setSimulationSpeed: (speed) => set({ simulationSpeed: speed }),

    // ==========================================================================
    // REAL-WORLD DATA
    // ==========================================================================

    fetchRealWorld: async () => {
      try {
        const status = await apiJson<RealWorldStatus>('/api/catalog/status');
        const wasLive = get().realWorld?.live;
        set({ realWorld: status });
        // The backend drives the clock in live mode: never step it from the browser at the same time.
        if (status.live && get().isSimulationRunning) get().setSimulationRunning(false);
        if (status.live && !wasLive) set({ replayIndex: null });
      } catch {
        /* backend offline or older backend without the real-world API */
      }
    },

    fetchCatalogSources: async () => {
      try {
        const { sources } = await apiJson<{ sources: CatalogSource[] }>('/api/catalog/sources');
        set({ catalogSources: sources });
        return sources;
      } catch {
        return null;
      }
    },

    loadCatalog: async (request) => {
      get().setSimulationRunning(false);
      const status = await apiJson<RealWorldStatus>('/api/catalog/load', { method: 'POST', body: JSON.stringify(request) });
      if (request.replace) {
        // A new object set: drop trails, replay frames and the selection that belonged to the old one.
        set({ trails: {}, history: [], replayIndex: null, selectedSatelliteId: null, selectedTrack: null,
              selectedPasses: null, selectedCatalog: null, satelliteDetails: {}, conjunctions: [] });
      }
      set({ realWorld: status });
      await telemetryClient.refresh();
      await Promise.all([get().fetchOps(), get().fetchManeuvers(), get().fetchCatalogSources()]);
      return status;
    },

    refreshCatalog: async () => {
      const result = await apiJson<{ status: RealWorldStatus }>('/api/catalog/refresh', { method: 'POST' });
      set({ realWorld: result.status });
      await telemetryClient.refresh();
    },

    setLiveMode: async (enabled) => {
      if (enabled) get().setSimulationRunning(false);
      await apiJson('/api/live', { method: 'PUT', body: JSON.stringify({ enabled }) });
      // Switching live on can jump the clock to "now": trails from the old epoch would draw across the globe.
      if (enabled) set({ trails: {}, replayIndex: null });
      await get().fetchRealWorld();
      await telemetryClient.refresh();
    },

    fetchSpaceWeather: async () => {
      try {
        set({ spaceWeather: await apiJson<SpaceWeather>('/api/space-weather') });
      } catch {
        /* NOAA unreachable: keep the last value */
      }
    },

    setDataSourcesOpen: (open) => set({ dataSourcesOpen: open }),

    setSimulationRunning: (isRunning) => {
      const { _simInterval } = get();
      if (_simInterval) clearInterval(_simInterval);
      let interval: ReturnType<typeof setInterval> | null = null;
      if (get().realWorld?.live) isRunning = false; // the backend owns the clock in live mode
      if (isRunning) {
        interval = setInterval(() => {
          get().stepSimulation(get().simulationSpeed * (CONSTANTS.SIM_TICK_MS / 1000));
        }, CONSTANTS.SIM_TICK_MS);
      }
      set((state) => ({
        _simInterval: interval,
        isSimulationRunning: isRunning,
        replayIndex: isRunning ? null : state.replayIndex,
        simulation: {
          ...state.simulation,
          status: isRunning ? 'running' : state.simulation.status === 'error' ? 'error' : 'paused',
          error: isRunning ? null : state.simulation.error,
        },
      }));
    },
  }))
);

// ============================================================================
// MEMOIZED SELECTORS
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
      status: satellites.statuses[idx] as SatelliteStatus,
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
  (selected, trails) => (selected ? trails[selected.id] || null : null)
);

export const selectManeuversForSatellite = createSelector(
  [selectManeuvers, (_: OrbitalState, satelliteId: string | null) => satelliteId],
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
export const selectReplayFrame = (state: OrbitalState) =>
  state.replayIndex === null ? null : state.history[state.replayIndex] ?? null;
// Memoized: zustand v5 requires selectors to return a stable reference for unchanged input.
export const selectOpenThreatCounts = createSelector(
  [(state: OrbitalState) => state.conjunctions],
  (conjunctions) => {
    const counts = { CRITICAL: 0, WARNING: 0, WATCH: 0 };
    for (const c of conjunctions) if (c.status === 'ACTIVE' || c.status === 'MITIGATED') counts[c.risk]++;
    return counts;
  }
);

// ============================================================================
// UTILITY
// ============================================================================

export const formatSimulationTime = (timestamp: string | null): string => {
  if (!timestamp) return '--:--:--';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return '--:--:--';
  return date.toISOString().replace('T', ' ').substring(0, 19) + 'Z';
};

export default useOrbitalStore;
