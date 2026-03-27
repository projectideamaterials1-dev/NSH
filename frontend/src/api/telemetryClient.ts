// src/api/telemetryClient.ts
// Production-Ready Telemetry Client with Worker Correlation & Backend Sync

import type { Satellite, DebrisBinaryData, SatelliteBinaryData } from '../store/useOrbitalStore';

// ============================================================================
// TYPE DEFINITIONS (Matching Worker Responses)
// ============================================================================

export interface TelemetrySnapshot {
  timestamp: string;
  satellites: Satellite[];
  debris_cloud: (string | number)[];
}

export interface WorkerRequest {
  requestId: string;
  type: 'PARSE_DEBRIS' | 'PING';
  payload?: { debris_cloud: (string | number)[] };
  timestamp?: string;
}

export interface WorkerResponse {
  requestId: string;
  type: 'DEBRIS_UPDATE' | 'ERROR' | 'INIT_COMPLETE';
  timestamp?: string;
  debris?: {
    positions: Float32Array;
    colors: Uint8ClampedArray;
    ids: string[];
    riskScores: Float32Array;
    length: number;
  };
  error?: string;
  metrics?: {
    parseTimeMs: number;
    debrisCount: number;
    highRiskCount: number;
  };
}

export interface ConnectionState {
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  lastSuccessfulFetch: number | null;
  consecutiveFailures: number;
  latencyMs: number | null;
  error: string | null;
}

export interface TelemetryMetrics {
  totalFetches: number;
  successfulFetches: number;
  failedFetches: number;
  avgLatencyMs: number;
  lastLatencyMs: number | null;
  workerParseTimeMs: number | null;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  API_BASE_URL: '/api',
  SNAPSHOT_ENDPOINT: '/api/visualization/snapshot',
  POLLING_INTERVAL_MS: 1000,
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 500,
  RETRY_BACKOFF_MULTIPLIER: 2,
  REQUEST_TIMEOUT_MS: 5000,
  WORKER_TIMEOUT_MS: 3000,
} as const;

// ============================================================================
// REQUEST CORRELATOR
// ============================================================================

class RequestCorrelator {
  private pendingRequests = new Map<string, {
    resolve: (response: WorkerResponse) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }>();

  createRequest(): { requestId: string; promise: Promise<WorkerResponse> } {
    const requestId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const promise = new Promise<WorkerResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Worker response timeout for request ${requestId}`));
      }, CONFIG.WORKER_TIMEOUT_MS);
      this.pendingRequests.set(requestId, { resolve, reject, timeoutId });
    });
    return { requestId, promise };
  }

  resolveResponse(response: WorkerResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pending.resolve(response);
      this.pendingRequests.delete(response.requestId);
    }
  }

  rejectAll(error: Error): void {
    this.pendingRequests.forEach(pending => {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    });
    this.pendingRequests.clear();
  }
}

// ============================================================================
// TELEMETRY CLIENT
// ============================================================================

export class TelemetryClient {
  private static worker: Worker | null = null;
  private static correlator = new RequestCorrelator();
  private static connectionState: ConnectionState = {
    state: 'disconnected',
    lastSuccessfulFetch: null,
    consecutiveFailures: 0,
    latencyMs: null,
    error: null,
  };
  private static metrics: TelemetryMetrics = {
    totalFetches: 0,
    successfulFetches: 0,
    failedFetches: 0,
    avgLatencyMs: 0,
    lastLatencyMs: null,
    workerParseTimeMs: null,
  };
  private static pollingInterval: ReturnType<typeof setInterval> | null = null;
  private static pollingCallback: ((
    timestamp: string,
    satellites: Satellite[],
    debris: DebrisBinaryData,
    satelliteBinary: SatelliteBinaryData,
    metrics?: { parseTimeMs: number; debrisCount: number; highRiskCount: number }
  ) => void) | null = null;

  // ============================================================================
  // WORKER INITIALIZATION
  // ============================================================================

  private static initWorker(): Worker {
    if (this.worker) return this.worker;

    this.worker = new Worker(new URL('../workers/telemetryWorker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      this.correlator.resolveResponse(e.data);
    };

    this.worker.onerror = (error) => {
      console.error('[TelemetryClient] Worker fatal error:', error);
      this.connectionState.state = 'error';
      this.connectionState.error = `Worker fatal: ${error.message}`;
      this.correlator.rejectAll(new Error('Worker crashed'));
    };

    console.log('[TelemetryClient] Worker initialized');
    return this.worker;
  }

  // ============================================================================
  // PUBLIC GETTERS
  // ============================================================================

  static getConnectionState(): ConnectionState {
    return { ...this.connectionState };
  }

  static getMetrics(): TelemetryMetrics {
    return { ...this.metrics };
  }

  static resetConnection(): void {
    this.connectionState = {
      state: 'disconnected',
      lastSuccessfulFetch: null,
      consecutiveFailures: 0,
      latencyMs: null,
      error: null,
    };
    this.metrics = {
      totalFetches: 0,
      successfulFetches: 0,
      failedFetches: 0,
      avgLatencyMs: 0,
      lastLatencyMs: null,
      workerParseTimeMs: null,
    };
  }

  // ============================================================================
  // FETCH SNAPSHOT (With Retries)
  // ============================================================================

  static async fetchSnapshot(): Promise<{
    timestamp: string;
    satellites: Satellite[];
    debris: DebrisBinaryData;
    satelliteBinary: SatelliteBinaryData;
    parseTimeMs: number;
  }> {
    const fetchStart = performance.now();
    this.metrics.totalFetches++;

    let lastError: Error | null = null;
    let retryDelay = CONFIG.RETRY_DELAY_MS;

    for (let attempt = 1; attempt <= CONFIG.MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        this.connectionState.state = 'connecting';

        const response = await fetch(CONFIG.SNAPSHOT_ENDPOINT, {
          method: 'GET',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data: TelemetrySnapshot = await response.json();

        // Validate structure
        if (!data.timestamp || !Array.isArray(data.satellites) || !Array.isArray(data.debris_cloud)) {
          throw new Error('Invalid snapshot structure');
        }

        // Send to worker with correlation ID
        const { requestId, promise } = this.correlator.createRequest();

        this.initWorker().postMessage({
          requestId,
          type: 'PARSE_DEBRIS',
          payload: { debris_cloud: data.debris_cloud },
          timestamp: data.timestamp,
        } as WorkerRequest);

        const workerResponse = await promise;

        // Handle worker error
        if (workerResponse.type === 'ERROR') {
          throw new Error(workerResponse.error ?? 'Worker parsing failed');
        }

        // Expect type 'DEBRIS_UPDATE'
        if (workerResponse.type !== 'DEBRIS_UPDATE' || !workerResponse.debris) {
          throw new Error(`Unexpected worker response type: ${workerResponse.type}`);
        }

        const latency = performance.now() - fetchStart;

        // Update connection state & metrics
        this.connectionState.state = 'connected';
        this.connectionState.lastSuccessfulFetch = Date.now();
        this.connectionState.consecutiveFailures = 0;
        this.connectionState.latencyMs = latency;
        this.connectionState.error = null;

        this.metrics.successfulFetches++;
        this.metrics.lastLatencyMs = latency;
        this.metrics.avgLatencyMs =
          (this.metrics.avgLatencyMs * (this.metrics.successfulFetches - 1) + latency) /
          this.metrics.successfulFetches;
        this.metrics.workerParseTimeMs = workerResponse.metrics?.parseTimeMs ?? null;

        // Convert satellites to binary format for Deck.gl
        const satelliteBinary = this.parseSatellitesToBinary(data.satellites);

        return {
          timestamp: data.timestamp,
          satellites: data.satellites,
          debris: {
            positions: workerResponse.debris.positions,
            colors: workerResponse.debris.colors,
            ids: workerResponse.debris.ids,
            riskScores: workerResponse.debris.riskScores,
            length: workerResponse.debris.length,
          },
          satelliteBinary,
          parseTimeMs: workerResponse.metrics?.parseTimeMs ?? 0,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
        this.connectionState.consecutiveFailures = attempt;
        this.connectionState.error = lastError.message;
        this.metrics.failedFetches++;

        console.warn(`[TelemetryClient] Attempt ${attempt} failed:`, lastError.message);

        if (attempt < CONFIG.MAX_RETRY_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          retryDelay *= CONFIG.RETRY_BACKOFF_MULTIPLIER;
        }
      }
    }

    this.connectionState.state = 'error';
    throw lastError ?? new Error('All fetch attempts failed');
  }

  // ============================================================================
  // SATELLITE BINARY PARSER
  // ============================================================================

  private static parseSatellitesToBinary(satellites: Satellite[]): SatelliteBinaryData {
    const count = satellites.length;
    const positions = new Float32Array(count * 3);
    const colors = new Uint8ClampedArray(count * 4);
    const fuels = new Float32Array(count);
    const ids: string[] = new Array(count);
    const statuses: string[] = new Array(count);

    for (let i = 0; i < count; i++) {
      const sat = satellites[i];
      // Use provided altitude (km) or default 400km
      const altMeters = (sat.alt ?? 400) * 1000;
      positions[i * 3] = sat.lon;
      positions[i * 3 + 1] = sat.lat;
      positions[i * 3 + 2] = altMeters;

      fuels[i] = sat.fuel_kg;
      ids[i] = sat.id;
      statuses[i] = sat.status;

      // Color based on status (Crimson Nebula theme)
      if (sat.status === 'CRITICAL') {
        colors.set([255, 0, 51, 255], i * 4);
      } else if (sat.status === 'WARNING') {
        colors.set([255, 191, 0, 255], i * 4);
      } else {
        colors.set([0, 255, 255, 255], i * 4);
      }
    }

    return { positions, colors, fuels, ids, statuses, length: count };
  }

  // ============================================================================
  // POLLING
  // ============================================================================

  static startPolling(
    callback: typeof TelemetryClient.pollingCallback extends null ? never : NonNullable<typeof TelemetryClient.pollingCallback>
  ): void {
    if (this.pollingInterval) {
      console.warn('[TelemetryClient] Polling already active');
      return;
    }

    this.pollingCallback = callback;
    this.initWorker();

    // Immediate first fetch
    this.pollOnce();

    this.pollingInterval = setInterval(() => this.pollOnce(), CONFIG.POLLING_INTERVAL_MS);
    console.log(`[TelemetryClient] Polling started @ ${CONFIG.POLLING_INTERVAL_MS}ms`);
  }

  static stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.pollingCallback = null;
    console.log('[TelemetryClient] Polling stopped');
  }

  private static async pollOnce(): Promise<void> {
    if (!this.pollingCallback) return;

    try {
      const result = await this.fetchSnapshot();
      this.pollingCallback(
        result.timestamp,
        result.satellites,
        result.debris,
        result.satelliteBinary,
        {
          parseTimeMs: result.parseTimeMs,
          debrisCount: result.debris.length,
          highRiskCount: 0, // Would need to compute from riskScores if needed
        }
      );
    } catch (error) {
      console.error('[TelemetryClient] Poll failed:', error);
      // Connection state already updated in fetchSnapshot
    }
  }

  // ============================================================================
  // WORKER HEALTH CHECK
  // ============================================================================

  static async pingWorker(): Promise<boolean> {
    return new Promise((resolve) => {
      const { requestId, promise } = this.correlator.createRequest();
      this.initWorker().postMessage({ requestId, type: 'PING' } as WorkerRequest);

      promise
        .then(res => {
          // Accept any non-error response as success
          resolve(res.type !== 'ERROR');
        })
        .catch(() => resolve(false));
    });
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  static cleanup(): void {
    this.stopPolling();
    this.correlator.rejectAll(new Error('Client cleanup'));
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    console.log('[TelemetryClient] Cleanup complete');
  }
}

// Auto-cleanup on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => TelemetryClient.cleanup());
}

export default TelemetryClient;