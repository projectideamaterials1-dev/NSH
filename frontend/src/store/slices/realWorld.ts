// src/store/slices/realWorld.ts
// Real-world catalog loading, live mode, space weather and satellite imagery.

import { apiJson } from '../../api/http';
import telemetryClient from '../../api/telemetryClient';
import { imageryKey } from '../frames';
import type {
  CatalogSource,
  GetState,
  RealWorldActions,
  RealWorldStatus,
  SatelliteImagery,
  SetState,
  SpaceWeather,
} from '../types';

export const createRealWorldActions = (set: SetState, get: GetState): RealWorldActions => ({
  fetchRealWorld: async () => {
    try {
      const status = await apiJson<RealWorldStatus>('/api/catalog/status');
      const wasLive = get().realWorld?.live;
      set({ realWorld: status });
      // The backend drives the clock in live mode: never step it from the browser at the same time.
      if (status.live && get().isSimulationRunning) get().setSimulationRunning(false);
      if (status.live && !wasLive) set({ replayIndex: null });
      const { _imageryFor, _imageryRetryAt } = get();
      if (status.loaded && (imageryKey(status) !== _imageryFor || (_imageryRetryAt && Date.now() > _imageryRetryAt))) {
        get().fetchImagery();
      }
    } catch {
      /* backend offline or older backend without the real-world API */
    }
  },

  fetchImagery: async () => {
    const key = imageryKey(get().realWorld);
    // Claim this fleet up front so the periodic status poll doesn't start a second request.
    set({ _imageryFor: key, _imageryRetryAt: 0 });
    try {
      const { items } = await apiJson<{ items: Record<string, SatelliteImagery | null> }>('/api/catalog/imagery');
      if (imageryKey(get().realWorld) !== key) return;   // the fleet changed meanwhile
      const unresolved = Object.values(items).some(v => v === null);
      set({ imagery: items, _imageryRetryAt: unresolved ? Date.now() + 60_000 : 0 });
    } catch {
      set({ _imageryRetryAt: Date.now() + 60_000 });
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
      set({ trails: {}, history: [], replayIndex: null, selectedSatelliteId: null, selectedTrack: null, selectedTrackBurns: null, selectedTrackCoast: null,
            selectedPasses: null, selectedCatalog: null, satelliteDetails: {}, conjunctions: [], imagery: {} });
    }
    set({ realWorld: status });
    get().fetchImagery();
    await telemetryClient.refresh();
    await Promise.all([get().fetchOps(), get().fetchManeuvers(), get().fetchCatalogSources()]);
    return status;
  },

  resizeFleet: async (maxSatellites) => {
    const result = await apiJson<{ added: string[]; removed: string[]; warnings: string[]; status: RealWorldStatus }>(
      '/api/catalog/resize', { method: 'POST', body: JSON.stringify({ max_satellites: maxSatellites }) });
    const { selectedSatelliteId, trails } = get();
    const removed = new Set(result.removed);
    set({
      realWorld: result.status,
      trails: Object.fromEntries(Object.entries(trails).filter(([id]) => !removed.has(id))),
      ...(selectedSatelliteId && removed.has(selectedSatelliteId)
        ? { selectedSatelliteId: null, selectedTrack: null, selectedTrackBurns: null, selectedTrackCoast: null, selectedPasses: null, selectedCatalog: null } : {}),
    });
    await telemetryClient.refresh();
    await Promise.all([get().fetchOps(), get().fetchManeuvers(), get().fetchImagery()]);
    return result;
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
});
