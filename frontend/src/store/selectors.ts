// src/store/selectors.ts
// Memoized selectors over the orbital store.

import { createSelector } from 'reselect';
import type { OrbitalState, SatelliteStatus } from './types';

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
