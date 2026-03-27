// src/workers/telemetryWorker.ts
// Crimson Nebula Telemetry Worker – Zero‑Copy Binary Pipeline with Request Correlation
// Extremely Optimized for V8 JIT Compilation (100k+ objects at 60Hz)

/// <reference lib="webworker" />

// ============================================================================
// TYPE DEFINITIONS (Matches Backend API)
// ============================================================================

interface SatelliteData {
  id: string;
  lat: number;
  lon: number;
  alt?: number;           // backend may omit, default 400km
  fuel_kg: number;        // backend sends fuel_kg, not fuel
  status: 'NOMINAL' | 'WARNING' | 'CRITICAL' | 'EOL';
}

interface TelemetrySnapshot {
  timestamp: string;
  satellites: SatelliteData[];
  debris_cloud: [string, number, number, number][]; // exactly 4‑element tuple
}

interface WorkerRequest {
  requestId: string;
  type: 'PARSE_SNAPSHOT' | 'PING';
  payload?: TelemetrySnapshot;
  timestamp?: string;
}

interface WorkerResponse {
  requestId: string;
  type: 'DEBRIS_UPDATE' | 'ERROR' | 'INIT_COMPLETE';  // ✅ matches client expectation
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
// CRIMSON NEBULA COLOR PALETTE (GPU-Optimized)
// ============================================================================

const COLOR = {
  // Debris risk colors (RGBA)
  CRITICAL: [255, 0, 51, 180] as const,   // Laser red
  WARNING: [255, 191, 0, 180] as const,   // Amber
  NOMINAL: [139, 0, 0, 120] as const,     // Dark red (Crimson Nebula)

  // Satellite status colors
  SAT_NOMINAL: [0, 255, 255, 255] as const,   // Plasma cyan
  SAT_WARNING: [255, 191, 0, 255] as const,   // Amber
  SAT_CRITICAL: [255, 0, 51, 255] as const,   // Laser red
  SAT_EOL: [128, 128, 128, 255] as const,     // Muted gray

  // Thresholds
  RISK_CRITICAL: 0.8,
  RISK_WARNING: 0.5,
  FUEL_CRITICAL: 5.0,    // kg
  FUEL_WARNING: 15.0,    // kg
} as const;

// ============================================================================
// PARSING FUNCTIONS – Heavily optimized for 100k+ arrays
// ============================================================================

function parseDebrisCloud(debrisArray: [string, number, number, number][]) {
  const count = debrisArray.length;
  const positions = new Float32Array(count * 3);   // [lon, lat, alt] * count
  const colors = new Uint8ClampedArray(count * 4);
  const riskScores = new Float32Array(count);
  const ids: string[] = new Array(count);
  let highRiskCount = 0;

  const nominalColor = COLOR.NOMINAL;

  // Unrolled loop with direct indexing for speed
  for (let i = 0; i < count; i++) {
    const row = debrisArray[i];
    const lon = row[2];
    const lat = row[1];
    const alt = row[3] * 1000;   // km → meters

    positions[i * 3]     = lon;
    positions[i * 3 + 1] = lat;
    positions[i * 3 + 2] = alt;
    ids[i] = row[0];
    riskScores[i] = 0.1;   // risk not provided by backend, default safe
    colors.set(nominalColor, i * 4);
    // No high risk because riskScore is always 0.1
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

  const cEol = COLOR.SAT_EOL;
  const cCritical = COLOR.SAT_CRITICAL;
  const cWarning = COLOR.SAT_WARNING;
  const cNominal = COLOR.SAT_NOMINAL;
  const fCrit = COLOR.FUEL_CRITICAL;
  const fWarn = COLOR.FUEL_WARNING;

  for (let i = 0; i < count; i++) {
    const sat = satellites[i];
    positions[i * 3] = sat.lon;
    positions[i * 3 + 1] = sat.lat;
    positions[i * 3 + 2] = (sat.alt ?? 400) * 1000;
    
    const fuel = sat.fuel_kg ?? 50.0;
    fuels[i] = fuel;
    ids[i] = sat.id;
    statuses[i] = sat.status;

    if (sat.status === 'EOL' || fuel <= fCrit) {
      colors.set(cEol, i * 4);
    } else if (sat.status === 'CRITICAL' || fuel <= fWarn) {
      colors.set(cCritical, i * 4);
    } else if (sat.status === 'WARNING') {
      colors.set(cWarning, i * 4);
    } else {
      colors.set(cNominal, i * 4);
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
      type: 'DEBRIS_UPDATE',          // ✅ corrected to match client
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

    // Transfer all typed arrays (zero‑copy)
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