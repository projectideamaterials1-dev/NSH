// src/store/types.ts
// Data shapes exchanged with the backend and the store state/action interfaces.

import type { StoreApi } from 'zustand';
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
  /** Probability of collision (2-D short-encounter model); absent when no TCA states were available. */
  pc?: number;
  peak_pc?: number | null;
  initial_pc?: number | null;
  hbr_m?: number;
  /** Miss distance at which Pc falls a decade below the maneuver threshold. */
  safe_miss_km?: number;
  propagator?: string;
  encounter_plane?: EncounterPlane;
  /** "time-scaled RTN model", or "CDM <originator> <message id>" when a measured covariance was used. */
  covariance_model?: string;
  covariance_measured?: boolean;
  /** Matching external CDM (uploaded CCSDS CDM or Space-Track cdm_public), for comparison. */
  external?: ExternalCdmSummary;
}

export interface ExternalCdmSummary {
  message_id: string;
  originator: string;
  created: string | null;
  tca: string;
  miss_km: number | null;
  pc: number | null;
  pc_method: string | null;
  has_covariance: boolean;
  source: string;
}

export interface CdmImportResult {
  matched: (ExternalCdmSummary & { satellite_id: string; object_id: string })[];
  unmatched: (ExternalCdmSummary & { objects: string[] })[];
}

export interface EncounterPlane {
  miss_x_km: number;
  miss_y_km: number;
  sigma_major_km: number;
  sigma_minor_km: number;
  ellipse_angle_deg: number;
  mahalanobis: number;
}

export interface TradeSpaceCell {
  burn_offset_s: number;
  dv_mps: number;
  miss_km: number;
  pc: number;
  tca_offset_s: number;
  fuel_kg: number;
}

export interface TradeSpace {
  cdm_id: string;
  satellite_id: string;
  object_id: string;
  computed_at: string;
  tca: string;
  axis: 'T' | 'R' | 'N';
  burn_offsets_s: number[];
  dv_mps: number[];
  grid: TradeSpaceCell[];
  pc_threshold: number;
  baseline: { miss_km: number; pc: number | null };
  planned_burn: { burn_id: string; burn_offset_s: number; dv_mps: number } | null;
}

export interface VerificationRow {
  object_id: string;
  object_type: 'DEBRIS' | 'SATELLITE';
  tca_ts: number;
  miss_distance_km: number;
  pc: number | null;
  needs_action: boolean;
}

export interface DecisionCandidate {
  label: string;
  n_burns: number;
  total_dv_mps: number;
  fuel_kg: number;
  first_burn_s: number;
  clean: boolean | null;
  chosen: boolean;
  verification?: { primary: VerificationRow[]; secondary: VerificationRow[]; clean: boolean; objects_screened: number };
}

export type DecisionKind = 'EVASION' | 'STATION_KEEPING' | 'EOL';

export interface DecisionBurn { burn_id: string; burn_time: string; ts: number; delta_v_mps: number; maneuver_type: string }

export interface Decision {
  decision_id: string;
  sim_time: string | null;
  satellite_id: string;
  kind: DecisionKind;
  outcome: 'SCHEDULED' | 'PROPOSED' | 'REJECTED' | 'APPROVED' | 'FAILED' | 'EXPIRED' | 'REJECTED_BY_OPERATOR';
  rationale: string;
  reason?: string | null;
  cdm_ids?: string[];
  candidates?: DecisionCandidate[];
  burns?: DecisionBurn[];
  fuel_kg?: number;
  proposal_id?: string;
  actor: string;
}

export interface Proposal {
  proposal_id: string;
  satellite_id: string;
  kind: DecisionKind;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'FAILED';
  created_ts: number;
  created_at: string;
  expires_ts: number;
  expires_at: string;
  timeout_action: 'DISCARD' | 'EXECUTE';
  rationale: string;
  cdm_ids: string[];
  candidates: DecisionCandidate[];
  burns: DecisionBurn[];
  fuel_kg: number;
  answered_at?: string;
  answered_by?: string;
  reason?: string | null;
}

export interface PhysicsModel {
  engine: string;
  force_model: string;
  integrator: string;
  drag: { enabled: boolean; ballistic_m2_per_kg: number; density_scale: number; f107_sfu: number | null;
          kp: number | null; native_support: boolean; atmosphere: string };
  collision_probability: { method: string; covariance: string; maneuver_threshold: number; hard_body_radius_m: number;
                           covariance_scale: number };
  certification: string;
}

export interface PredictionEvent {
  kind: 'TCA' | 'BURN';
  timestamp: string;
  ts: number;
  satellite_id: string;
  label: string;
  risk: RiskLevel | null;
  cdm_id?: string;
}

export interface Prediction {
  start: string;
  step_s: number;
  frames: ReplayFrame[];
  events: PredictionEvent[];
  /** Wall-clock ms when fetched. */
  fetchedAt: number;
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
  pcManeuverThreshold: number;
  hardBodyRadiusM: number;
  covarianceScale: number;
  atmosphericDrag: boolean;
  ballisticCoefficient: number;
  autopilotMode: 'AUTONOMOUS' | 'APPROVAL';
  approvalTimeoutSeconds: number;
  approvalTimeoutAction: 'DISCARD' | 'EXECUTE';
  verifyManeuvers: boolean;
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

export interface SatellitePhoto {
  image_url: string;
  full_url: string | null;
  page_url: string | null;
  credit: string | null;
  license: string | null;
  caption: string | null;
}

/** Wikimedia imagery for a real satellite; `match` says how the Wikipedia page was found (null: not found).
 * 'family' is a representative photo of the constellation (Starlink, Flock, ...), not of this satellite. */
export interface SatelliteImagery {
  norad_id: number;
  match: 'norad' | 'name' | 'family' | null;
  title: string;
  description: string | null;
  article_url: string | null;
  /** Constellation article a representative photo came from (match 'family'). */
  family?: string | null;
  photo: SatellitePhoto | null;
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
  /** Look-ahead frame from /api/predict (satellites only, queued burns applied). */
  predicted?: boolean;
}

export interface SimulationInfo {
  status: 'idle' | 'running' | 'paused' | 'error';
  stepsRun: number;
  collisionsDetected: number;
  maneuversExecuted: number;
  lastStepResponse: SimulationStepResponse | null;
  error: string | null;
}

export interface OrbitalData {
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
  /** Satellite id -> photo info for the loaded real-world fleet (null entry: Wikimedia unreachable). */
  imagery: Record<string, SatelliteImagery | null>;
  _imageryFor: string | null;
  _imageryRetryAt: number;

  // replay & view
  history: ReplayFrame[];
  replayIndex: number | null;
  /** Look-ahead frames for the scrubber; predictIndex selects one (null: not previewing the future). */
  prediction: Prediction | null;
  predictIndex: number | null;
  predicting: boolean;

  // decision support
  decisions: Decision[];
  proposals: Proposal[];
  physics: PhysicsModel | null;
  conjunctionDetailId: string | null;
  rightTab: 'fleet' | 'threats' | 'decisions' | 'alerts' | 'score';
  showPerfHud: boolean;
  showShortcuts: boolean;
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
}

/** Snapshot stream, selection, replay and view. */
export interface TelemetryActions {
  setRightTab: (tab: OrbitalData['rightTab']) => void;
  togglePerfHud: () => void;
  setShowShortcuts: (open: boolean) => void;
  fetchPrediction: () => Promise<void>;
  setPredictIndex: (index: number | null) => void;
  ingestFrame: (timestamp: string, satellites: SatelliteBinaryData, debris: DebrisBinaryData, parseTimeMs: number, latencyMs?: number) => void;
  syncVisualizationSnapshot: () => Promise<boolean>;
  startAutoSync: (intervalMs?: number) => void;
  stopAutoSync: () => void;
  setConnectionStatus: (status: Partial<ConnectionStatus>) => void;
  addFuelMetric: (metric: FuelMetric) => void;
  selectSatellite: (id: string | null) => void;
  hoverSatellite: (id: string | null) => void;
  clearTrails: () => void;
  setReplayIndex: (index: number | null) => void;
  setViewMode: (mode: '2d' | '3d') => void;
}

/** Operations data and operator commands. */
export interface OpsActions {
  importCdm: (text: string) => Promise<CdmImportResult>;
  fetchDecisions: () => Promise<void>;
  answerProposal: (proposalId: string, approve: boolean, reason?: string) => Promise<Proposal>;
  fetchTradeSpace: (cdmId: string, axis: 'T' | 'R' | 'N') => Promise<TradeSpace>;
  fetchPhysics: () => Promise<void>;
  openConjunction: (cdmId: string | null) => void;
  fetchManeuvers: () => Promise<void>;
  fetchOps: () => Promise<void>;
  fetchAutopilot: () => Promise<void>;
  fetchSelectedInsights: (id?: string | null) => Promise<void>;
  scheduleManeuver: (satelliteId: string, maneuverSequence: BurnCommand[]) => Promise<ManeuverScheduleResult>;
  cancelManeuver: (burnId: string) => Promise<void>;
  planManualBurn: (satelliteId: string, burns: ManualBurnInput[], dryRun: boolean) => Promise<ManualPlanResult>;
  setAutopilot: (update: { enabled?: boolean; strategy?: AutopilotInfo['strategy'] }) => Promise<void>;
  screenNow: () => Promise<void>;
  fetchConfig: () => Promise<SimConfigDto | null>;
  saveConfig: (config: Partial<SimConfigDto>) => Promise<void>;
}

/** Browser-driven simulation clock. */
export interface SimulationActions {
  stepSimulation: (stepSeconds: number) => Promise<SimulationStepResponse | null>;
  setSimulationSpeed: (speed: number) => void;
  setSimulationRunning: (isRunning: boolean) => void;
}

/** Real-world catalog, live mode, space weather and imagery. */
export interface RealWorldActions {
  fetchRealWorld: () => Promise<void>;
  fetchImagery: () => Promise<void>;
  fetchCatalogSources: () => Promise<CatalogSource[] | null>;
  loadCatalog: (request: CatalogLoadRequest) => Promise<RealWorldStatus>;
  resizeFleet: (maxSatellites: number) => Promise<{ added: string[]; removed: string[]; warnings: string[] }>;
  refreshCatalog: () => Promise<void>;
  setLiveMode: (enabled: boolean) => Promise<void>;
  fetchSpaceWeather: () => Promise<void>;
  setDataSourcesOpen: (open: boolean) => void;
}

export type OrbitalState = OrbitalData & TelemetryActions & OpsActions & SimulationActions & RealWorldActions;

export type SetState = StoreApi<OrbitalState>['setState'];
export type GetState = () => OrbitalState;
