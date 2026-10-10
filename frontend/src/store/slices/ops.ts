// src/store/slices/ops.ts
// Operations data (CDMs, events, metrics, maneuvers, decisions, proposals) and operator commands.

import { apiJson } from '../../api/http';
import { CONSTANTS } from '../frames';
import type {
  AutopilotInfo,
  CdmImportResult,
  CatalogObjectInfo,
  Conjunction,
  Decision,
  GetState,
  GroundPass,
  ManeuverEvent,
  ManeuverScheduleResult,
  ManualPlanResult,
  MissionMetrics,
  OpsActions,
  OpsEvent,
  OrbitalState,
  PhysicsModel,
  Proposal,
  SatelliteDetail,
  SetState,
  SimConfigDto,
  TrackPoint,
  TradeSpace,
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
    const [sats, cdms, events, metrics, proposals] = await Promise.allSettled([
      apiJson<{ satellites: SatelliteDetail[] }>('/api/satellites'),
      apiJson<{ conjunctions: Conjunction[] }>('/api/conjunctions?status=open'),
      apiJson<{ events: OpsEvent[]; last_id: number }>(`/api/events?after_id=${after}&limit=200`),
      apiJson<MissionMetrics>('/api/metrics'),
      apiJson<{ proposals: Proposal[] }>('/api/proposals?status=all'),
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
    if (proposals.status === 'fulfilled') patch.proposals = proposals.value.proposals.slice(0, 50);
    set(patch);
  },

  fetchDecisions: async () => {
    try {
      const { decisions } = await apiJson<{ decisions: Decision[] }>('/api/decisions?limit=60');
      set({ decisions });
    } catch {
      /* backend offline or older backend */
    }
  },

  answerProposal: async (proposalId, approve, reason) => {
    const proposal = await apiJson<Proposal>(
      `/api/proposals/${encodeURIComponent(proposalId)}/${approve ? 'approve' : 'reject'}`,
      { method: 'POST', body: JSON.stringify(approve ? {} : { reason: reason ?? null }) });
    await Promise.all([get().fetchOps(), get().fetchManeuvers(), get().fetchDecisions()]);
    return proposal;
  },

  fetchTradeSpace: (cdmId, axis) =>
    apiJson<TradeSpace>(`/api/conjunctions/${encodeURIComponent(cdmId)}/tradespace?axis=${axis}&n_times=8&n_dv=11`),

  fetchPhysics: async () => {
    try {
      set({ physics: await apiJson<PhysicsModel>('/api/physics') });
    } catch {
      /* older backend */
    }
  },

  openConjunction: (cdmId) => set({ conjunctionDetailId: cdmId }),

  importCdm: async (text) => {
    const result = await apiJson<CdmImportResult>('/api/cdm', {
      method: 'POST', body: text, headers: { 'Content-Type': 'text/plain' },
    });
    // The backend re-screens on its own once a CDM matches; refresh shortly after to show it.
    await get().fetchOps();
    setTimeout(() => { get().fetchOps(); }, 2500);
    return result;
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
