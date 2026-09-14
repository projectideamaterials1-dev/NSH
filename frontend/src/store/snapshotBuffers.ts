// src/store/snapshotBuffers.ts
// Main-thread snapshot -> binary buffer conversion (used when a Web Worker is unavailable, and in tests).

import type { DebrisBinaryData, SatelliteBinaryData } from './useOrbitalStore';

export const SAT_COLORS: Record<string, [number, number, number, number]> = {
  NOMINAL: [0, 255, 255, 255],
  WARNING: [255, 191, 0, 255],
  CRITICAL: [255, 0, 51, 255],
  CRITICAL_FUEL: [255, 0, 51, 255],
  EOL: [128, 128, 128, 255],
};

export function snapshotToBinaryBuffers(data: any): {
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
    satColors.set(SAT_COLORS[s.status] ?? SAT_COLORS.NOMINAL, i * 4);
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
    debrisColors.set([139, 0, 0, 120], i * 4);
  }

  return {
    debris: { positions: debrisPositions, colors: debrisColors, ids: debrisIds, riskScores: debrisRisk, length: debrisCount },
    satellites: { positions: satPositions, colors: satColors, fuels: satFuels, ids: satIds, statuses: satStatuses, length: satCount },
    timestamp: data.timestamp,
  };
}
