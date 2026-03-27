// src/workers/telemetryWorker.ts
// Crimson Nebula Telemetry Worker – Zero‑Copy Binary Pipeline with Request Correlation

/// <reference lib="webworker" />

// ============================================================================
// TYPE DEFINITIONS (With requestId for Correlation)
// ============================================================================

interface SatelliteData {
  id: string;
  lat: number;
  lon: number;
  alt: number;
  fuel: number;
  status: 'NOMINAL' | 'WARNING' | 'CRITICAL' | 'EOL';
}

interface TelemetrySnapshot {
  timestamp: string;
  satellites: SatelliteData[];
  debris_cloud: (string | number)[];
}

interface WorkerRequest {
  requestId: string;
  type: 'PARSE_SNAPSHOT' | 'PING';
  payload?: TelemetrySnapshot;
  timestamp?: string;
}

interface WorkerResponse {
  requestId: string;
  type: 'DEBRIS_UPDATE' | 'SATELLITE_UPDATE' | 'ERROR' | 'INIT_COMPLETE';
  timestamp: string;
  debris?: {
    positions: Float32Array;
    colors: Uint8ClampedArray;
    ids: string[];
    riskScores: Float32Array;
    length: number;
  };
  satellites?: {
    positions: Float32Array;
    colors: Uint8ClampedArray;
    fuels: Float32Array;
    ids: string[];
    statuses: string[];
    length: number;
  };
  error?: string;
  metrics?: {
    parseTimeMs: number;
    debrisCount: number;
    satelliteCount: number;
    highRiskCount: number;
  };
}

// ============================================================================
// COLOR PALETTE (Unchanged)
// ============================================================================

const COLOR = {
  CRITICAL: [255, 0, 51, 180] as const,
  WARNING: [255, 191, 0, 180] as const,
  NOMINAL: [139, 0, 0, 120] as const,
  SAT_NOMINAL: [0, 255, 255, 255] as const,
  SAT_WARNING: [255, 191, 0, 255] as const,
  SAT_CRITICAL: [255, 0, 51, 255] as const,
  SAT_EOL: [128, 128, 128, 255] as const,
  RISK_CRITICAL: 0.8,
  RISK_WARNING: 0.5,
  FUEL_CRITICAL: 5.0,
  FUEL_WARNING: 15.0,
} as const;

// ============================================================================
// PARSING FUNCTIONS (Unchanged)
// ============================================================================

function parseDebrisCloud(flattened: (string | number)[]) {
  const TUPLE_SIZE = 5;
  const count = Math.floor(flattened.length / TUPLE_SIZE);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8ClampedArray(count * 4);
  const riskScores = new Float32Array(count);
  const ids: string[] = new Array(count);
  let highRiskCount = 0;
  let srcIdx = 0;

  for (let i = 0; i < count; i++) {
    const id = String(flattened[srcIdx] ?? 'unknown');
    const lat = Number(flattened[srcIdx + 1]) || 0;
    const lon = Number(flattened[srcIdx + 2]) || 0;
    const alt = (Number(flattened[srcIdx + 3]) || 400) * 1000;
    const risk = Number(flattened[srcIdx + 4]) || 0;

    positions[i * 3] = lon;
    positions[i * 3 + 1] = lat;
    positions[i * 3 + 2] = alt;
    riskScores[i] = risk;
    ids[i] = id;

    if (risk > COLOR.RISK_CRITICAL) {
      colors.set(COLOR.CRITICAL, i * 4);
      highRiskCount++;
    } else if (risk > COLOR.RISK_WARNING) {
      colors.set(COLOR.WARNING, i * 4);
    } else {
      colors.set(COLOR.NOMINAL, i * 4);
    }
    srcIdx += TUPLE_SIZE;
  }

  return { positions, colors, ids, riskScores, count, highRiskCount };
}

function parseSatellites(satellites: SatelliteData[]) {
  const count = satellites.length;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8ClampedArray(count * 4);
  const fuels = new Float32Array(count);
  const ids: string[] = new Array(count);
  const statuses: string[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const sat = satellites[i];
    positions[i * 3] = sat.lon;
    positions[i * 3 + 1] = sat.lat;
    positions[i * 3 + 2] = (sat.alt ?? 400) * 1000;
    fuels[i] = sat.fuel ?? 50;
    ids[i] = sat.id;
    statuses[i] = sat.status;

    if (sat.fuel <= COLOR.FUEL_CRITICAL || sat.status === 'EOL') {
      colors.set(COLOR.SAT_EOL, i * 4);
    } else if (sat.fuel <= COLOR.FUEL_WARNING || sat.status === 'CRITICAL') {
      colors.set(COLOR.SAT_CRITICAL, i * 4);
    } else if (sat.status === 'WARNING') {
      colors.set(COLOR.SAT_WARNING, i * 4);
    } else {
      colors.set(COLOR.SAT_NOMINAL, i * 4);
    }
  }

  return { positions, colors, fuels, ids, statuses, count };
}

// ============================================================================
// WORKER MESSAGE HANDLER (With Request Correlation)
// ============================================================================

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { requestId, type, payload, timestamp } = e.data;

  try {
    // Health check
    if (type === 'PING') {
      self.postMessage({
        requestId,
        type: 'INIT_COMPLETE',
        timestamp: timestamp ?? new Date().toISOString(),
        metrics: { parseTimeMs: 0, debrisCount: 0, satelliteCount: 0, highRiskCount: 0 },
      } as WorkerResponse);
      return;
    }

    // Validate snapshot request
    if (type !== 'PARSE_SNAPSHOT' || !payload) {
      throw new Error('Invalid message type or missing payload');
    }

    const start = performance.now();

    const debris = parseDebrisCloud(payload.debris_cloud);
    const satellites = parseSatellites(payload.satellites);

    const parseTime = performance.now() - start;

    const response: WorkerResponse = {
      requestId,
      type: 'DEBRIS_UPDATE',
      timestamp: payload.timestamp,
      debris: {
        positions: debris.positions,
        colors: debris.colors,
        ids: debris.ids,
        riskScores: debris.riskScores,
        length: debris.count,
      },
      satellites: {
        positions: satellites.positions,
        colors: satellites.colors,
        fuels: satellites.fuels,
        ids: satellites.ids,
        statuses: satellites.statuses,
        length: satellites.count,
      },
      metrics: {
        parseTimeMs: parseTime,
        debrisCount: debris.count,
        satelliteCount: satellites.count,
        highRiskCount: debris.highRiskCount,
      },
    };

    // Transfer all typed arrays
    self.postMessage(response, [
      debris.positions.buffer,
      debris.colors.buffer,
      debris.riskScores.buffer,
      satellites.positions.buffer,
      satellites.colors.buffer,
      satellites.fuels.buffer,
    ]);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    self.postMessage({
      requestId,
      type: 'ERROR',
      timestamp: new Date().toISOString(),
      error: `Worker Parse Error: ${errorMsg}`,
    } as WorkerResponse);
    console.error('[TelemetryWorker] Critical error:', error);
  }
};

console.log('[TelemetryWorker] 🌌 Crimson Nebula Worker Ready with Request Correlation');