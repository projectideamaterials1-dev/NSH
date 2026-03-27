// src/api/telemetryClient.ts
// Production-Ready Telemetry Client with Worker Correlation & Anti-Choke Lock
// Uses Vite proxy, aligns with worker response 'DEBRIS_UPDATE', and passes binary buffers directly.

import type { ConnectionStatus, DebrisBinaryData, SatelliteBinaryData } from '../store/useOrbitalStore';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface TelemetrySnapshot {
  timestamp: string;
  satellites: any[];
  debris_cloud: [string, number, number, number][];
}

export interface WorkerRequest {
  requestId: string;
  type: 'PARSE_SNAPSHOT' | 'PING';
  payload?: TelemetrySnapshot;
  timestamp?: string;
}

export interface WorkerResponse {
  requestId: string;
  type: 'DEBRIS_UPDATE' | 'ERROR' | 'INIT_COMPLETE'; // matches worker
  timestamp?: string;
  debris?: DebrisBinaryData;
  satellites?: SatelliteBinaryData;
  error?: string;
  metrics?: {
    parseTimeMs: number;
    debrisCount: number;
    satelliteCount: number;
    highRiskCount: number;
  };
}

export interface TelemetryMetrics {
  totalFetches: number;
  successfulFetches: number;
  failedFetches: number;
  avgLatencyMs: number;
  lastLatencyMs: number | null;
  workerParseTimeMs: number | null;
}

export type TelemetryCallback = (
  timestamp: string,
  satellites: SatelliteBinaryData,
  debris: DebrisBinaryData,
  metrics: { parseTimeMs: number }
) => void;

export type StatusCallback = (status: Partial<ConnectionStatus>) => void;

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  SNAPSHOT_ENDPOINT: '/api/visualization/snapshot', // uses Vite proxy
  POLLING_INTERVAL_MS: 1000,
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 500,
  RETRY_BACKOFF_MULTIPLIER: 2,
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
// TELEMETRY CLIENT (Singleton)
// ============================================================================

class TelemetryClientManager {
  private worker: Worker | null = null;
  private correlator = new RequestCorrelator();
  private isProcessing = false;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  private onTelemetryCb: TelemetryCallback | null = null;
  private onStatusCb: StatusCallback | null = null;

  private connectionState: ConnectionStatus = {
    state: 'disconnected',
    lastSuccessfulFetch: null,
    consecutiveFailures: 0,
    latencyMs: null,
    error: null,
  };

  private metrics: TelemetryMetrics = {
    totalFetches: 0,
    successfulFetches: 0,
    failedFetches: 0,
    avgLatencyMs: 0,
    lastLatencyMs: null,
    workerParseTimeMs: null,
  };

  constructor() {
    this.initWorker();
  }

  private initWorker() {
    if (typeof window !== 'undefined' && !this.worker) {
      this.worker = new Worker(new URL('../workers/telemetryWorker.ts', import.meta.url), {
        type: 'module',
      });

      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        this.correlator.resolveResponse(e.data);
      };

      this.worker.onerror = (error) => {
        console.error('[TelemetryClient] Worker fatal error:', error);
        this.updateStatus({ state: 'error', error: `Worker fatal: ${error.message}` });
        this.correlator.rejectAll(new Error('Worker crashed'));
      };
    }
  }

  private updateStatus(status: Partial<ConnectionStatus>) {
    this.connectionState = { ...this.connectionState, ...status };
    if (this.onStatusCb) {
      this.onStatusCb(this.connectionState);
    }
  }

  public onStatusChange(callback: StatusCallback) {
    this.onStatusCb = callback;
  }

  // ============================================================================
  // FETCH & PARSE PIPELINE
  // ============================================================================

  private async fetchAndParse(): Promise<void> {
    // Anti-choke lock: skip if previous fetch is still processing
    if (this.isProcessing) {
      console.warn('[TelemetryClient] Dropping frame: pipeline blocked.');
      return;
    }

    this.isProcessing = true;
    const fetchStart = performance.now();
    this.metrics.totalFetches++;

    let attempt = 1;
    let retryDelay = CONFIG.RETRY_DELAY_MS;

    while (attempt <= CONFIG.MAX_RETRY_ATTEMPTS) {
      try {
        if (this.connectionState.state !== 'connected') {
          this.updateStatus({ state: 'connecting' });
        }

        const response = await fetch(CONFIG.SNAPSHOT_ENDPOINT, {
          method: 'GET',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data: TelemetrySnapshot = await response.json();

        // Ensure worker is alive
        this.initWorker();
        if (!this.worker) throw new Error('Worker not initialized');

        // Create correlation lock
        const { requestId, promise } = this.correlator.createRequest();

        // Offload parsing to the worker
        this.worker.postMessage({
          requestId,
          type: 'PARSE_SNAPSHOT',
          payload: data,
          timestamp: data.timestamp,
        } as WorkerRequest);

        // Wait for binary buffers
        const workerResponse = await promise;

        if (workerResponse.type === 'ERROR') {
          throw new Error(workerResponse.error ?? 'Worker parsing failed');
        }

        if (workerResponse.type !== 'DEBRIS_UPDATE' || !workerResponse.debris || !workerResponse.satellites) {
          throw new Error('Worker returned incomplete or unexpected response');
        }

        const latency = performance.now() - fetchStart;

        // Update metrics
        this.metrics.successfulFetches++;
        this.metrics.lastLatencyMs = latency;
        this.metrics.avgLatencyMs =
          (this.metrics.avgLatencyMs * (this.metrics.successfulFetches - 1) + latency) /
          this.metrics.successfulFetches;
        this.metrics.workerParseTimeMs = workerResponse.metrics?.parseTimeMs ?? null;

        this.updateStatus({
          state: 'connected',
          lastSuccessfulFetch: Date.now(),
          consecutiveFailures: 0,
          latencyMs: latency,
          error: null,
        });

        // Fire callback with binary data
        if (this.onTelemetryCb && workerResponse.timestamp) {
          this.onTelemetryCb(
            workerResponse.timestamp,
            workerResponse.satellites,
            workerResponse.debris,
            { parseTimeMs: workerResponse.metrics?.parseTimeMs ?? 0 }
          );
        }

        this.isProcessing = false;
        return; // success, exit retry loop

      } catch (error) {
        console.warn(`[TelemetryClient] Attempt ${attempt} failed:`, (error as Error).message);

        if (attempt === CONFIG.MAX_RETRY_ATTEMPTS) {
          this.metrics.failedFetches++;
          this.updateStatus({
            state: 'error',
            error: (error as Error).message,
            consecutiveFailures: attempt,
          });
          this.isProcessing = false;
          return;
        }

        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retryDelay *= CONFIG.RETRY_BACKOFF_MULTIPLIER;
        attempt++;
      }
    }
    this.isProcessing = false;
  }

  // ============================================================================
  // PUBLIC CONTROLS
  // ============================================================================

  public startPolling(callback: TelemetryCallback): () => void {
    this.onTelemetryCb = callback;
    if (!this.pollingInterval) {
      this.initWorker();
      this.fetchAndParse(); // immediate first fetch
      this.pollingInterval = setInterval(() => this.fetchAndParse(), CONFIG.POLLING_INTERVAL_MS);
    }
    return () => this.stopPolling();
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  public cleanup(): void {
    this.stopPolling();
    this.correlator.rejectAll(new Error('Client cleanup'));
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  public getConnectionState(): ConnectionStatus {
    return { ...this.connectionState };
  }

  public getMetrics(): TelemetryMetrics {
    return { ...this.metrics };
  }
}

export default new TelemetryClientManager();