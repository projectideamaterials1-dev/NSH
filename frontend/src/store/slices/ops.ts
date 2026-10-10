// src/store/slices/ops.ts
// Operations data (CDMs, events, metrics, maneuvers, decisions, proposals) and operator commands.

import { apiJson } from '../../api/http';
import { CONSTANTS } from '../frames';
import type {
  AutopilotInfo,
  CatalogObjectInfo,
  Conjunction,
  GetState,
  GroundPass,
  ManeuverEvent,
  ManeuverScheduleResult,
  ManualPlanResult,
  MissionMetrics,
  OpsActions,
  OpsEvent,
  OrbitalState,
  SatelliteDetail,
  SetState,
  SimConfigDto,
  TrackPoint,
} from '../types';

export const createOpsActions = (set: SetState, get: GetState): OpsActions => ({
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
});
