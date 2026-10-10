// src/store/frames.ts
// Store constants and pure helpers: trails, replay frames, imagery cache key.

import type { DebrisBinaryData, ReplayFrame, SatelliteBinaryData, SatelliteTrail, SimulationInfo } from './types';

/** Photos are fetched once per fleet: a new catalog or a resize (different size) triggers a new lookup. */
export const imageryKey = (rw: { loaded_at: string | null; satellites: number } | null): string | null =>
  rw?.loaded_at ? `${rw.loaded_at}:${rw.satellites}` : null;

export const CONSTANTS = {
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

export function appendTrails(stateTrails: Record<string, SatelliteTrail>, satellites: SatelliteBinaryData, timestamp: string) {
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

export const INITIAL_SIMULATION: SimulationInfo = {
  status: 'idle',
  stepsRun: 0,
  collisionsDetected: 0,
  maneuversExecuted: 0,
  lastStepResponse: null,
  error: null,
};
