// src/store/slices/telemetry.ts
// Snapshot ingestion (stream/poll), polling lifecycle, selection, replay cursor and view.

import { apiFetch, apiJson } from '../../api/http';
import telemetryClient from '../../api/telemetryClient';
import { snapshotToBinaryBuffers } from '../snapshotBuffers';
import { CONSTANTS, appendTrails, pushReplayFrame, toReplayFrame } from '../frames';
import type { GetState, Prediction, ReplayFrame, SetState, TelemetryActions } from '../types';

const PREDICT_HORIZON_S = 3 * 3600;
const PREDICT_STEP_S = 300;

export const createTelemetryActions = (set: SetState, get: GetState): TelemetryActions => ({
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
      set({ replayIndex: null, predictIndex: null });
      return;
    }
    const clamped = Math.max(0, Math.min(history.length - 1, index));
    set({ replayIndex: clamped === history.length - 1 && index >= history.length - 1 ? null : clamped, predictIndex: null });
  },

  fetchPrediction: async () => {
    if (get().predicting) return;
    set({ predicting: true });
    try {
      const data = await apiJson<{ start: string; step_s: number; satellite_ids: string[];
        frames: { timestamp: string; positions: [number, number, number][] }[]; events: Prediction['events'] }>(
        `/api/predict?horizon_s=${PREDICT_HORIZON_S}&step_s=${PREDICT_STEP_S}`);
      const live = get().satellites;
      const fuelById = new Map<string, number>();
      const statusById = new Map<string, string>();
      if (live) {
        for (let i = 0; i < live.length; i++) {
          fuelById.set(live.ids[i], live.fuels[i]);
          statusById.set(live.ids[i], live.statuses[i]);
        }
      }
      const ids = data.satellite_ids;
      const satFuels = Float32Array.from(ids, id => fuelById.get(id) ?? 0);
      const satStatuses = ids.map(id => statusById.get(id) ?? 'NOMINAL');
      const frames: ReplayFrame[] = data.frames.map(f => {
        const satPositions = new Float32Array(ids.length * 3);
        f.positions.forEach(([lon, lat, altKm], i) => {
          satPositions[i * 3] = lon;
          satPositions[i * 3 + 1] = lat;
          satPositions[i * 3 + 2] = altKm * 1000;
        });
        return { timestamp: f.timestamp, satIds: ids, satPositions, satFuels, satStatuses,
                 debrisPositions: new Float32Array(0), debrisLength: 0, predicted: true };
      });
      const { predictIndex } = get();
      set({
        prediction: { start: data.start, step_s: data.step_s, frames, events: data.events, fetchedAt: Date.now() },
        predictIndex: predictIndex === null ? null : Math.min(predictIndex, frames.length - 1),
      });
    } catch {
      set({ prediction: null, predictIndex: null });
    } finally {
      set({ predicting: false });
    }
  },

  setPredictIndex: (index) => {
    const frames = get().prediction?.frames.length ?? 0;
    if (index === null || frames === 0) {
      set({ predictIndex: null });
      return;
    }
    set({ predictIndex: Math.max(0, Math.min(frames - 1, index)), replayIndex: null });
  },

  setViewMode: (mode) => set({ viewMode: mode }),

  setRightTab: (tab) => set({ rightTab: tab }),

  togglePerfHud: () => set(s => ({ showPerfHud: !s.showPerfHud })),

  setShowShortcuts: (open) => set({ showShortcuts: open }),
});
