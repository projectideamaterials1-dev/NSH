// src/api/telemetryClient.ts
// Live snapshot pipeline: Server-Sent Events (/api/stream/snapshot) with automatic fallback to
// polling (/api/visualization/snapshot). Raw JSON text is handed to a Web Worker, which parses it
// and builds binary buffers off the main thread; request correlation guards against stale replies.

import type { ConnectionStatus, DebrisBinaryData, SatelliteBinaryData } from '../store/useOrbitalStore';
import { apiFetch, hasApiKey } from './http';

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
  type: 'PARSE_SNAPSHOT' | 'PARSE_TEXT' | 'PING';
  payload?: TelemetrySnapshot;
  raw?: string;
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
  transport: 'sse' | 'poll' | 'idle';
}

export type TelemetryCallback = (
  timestamp: string,
  satellites: SatelliteBinaryData,
  debris: DebrisBinaryData,
  metrics: { parseTimeMs: number; latencyMs: number }
) => void;

export type StatusCallback = (status: Partial<ConnectionStatus>) => void;

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  SNAPSHOT_ENDPOINT: '/api/visualization/snapshot',
  STREAM_ENDPOINT: '/api/stream/snapshot',
  POLLING_INTERVAL_MS: 2000,
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 500,
  RETRY_BACKOFF_MULTIPLIER: 2,
  WORKER_TIMEOUT_MS: 5000,
  SSE_MAX_FAILURES: 2,
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
  private workerBroken = false;
  private correlator = new RequestCorrelator();
  private isProcessing = false;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private eventSource: EventSource | null = null;
  private sseFailures = 0;
  private pendingFrame: string | null = null;
  private lastTimestampMs = -Infinity;

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
    transport: 'idle',
  };

  private initWorker() {
    if (typeof window === 'undefined' || typeof Worker === 'undefined' || this.worker || this.workerBroken) return;
    try {
      this.worker = new Worker(new URL('../workers/telemetryWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.correlator.resolveResponse(e.data);
      this.worker.onerror = (error) => {
        console.error('[TelemetryClient] Worker fatal error:', error);
        this.correlator.rejectAll(new Error('Worker crashed'));
        this.worker?.terminate();
        this.worker = null;
        this.workerBroken = true; // fall back to main-thread parsing
      };
    } catch (err) {
      this.workerBroken = true;
    }
  }

  private updateStatus(status: Partial<ConnectionStatus>) {
    this.connectionState = { ...this.connectionState, ...status };
    this.onStatusCb?.(this.connectionState);
  }

  public onStatusChange(callback: StatusCallback) {
    this.onStatusCb = callback;
  }

  // ============================================================================
  // PARSING
  // ============================================================================

  private async parse(raw: string): Promise<WorkerResponse> {
    this.initWorker();
    if (this.worker) {
      const { requestId, promise } = this.correlator.createRequest();
      this.worker.postMessage({ requestId, type: 'PARSE_TEXT', raw } as WorkerRequest);
      return promise;
    }
    // Main-thread fallback (no Worker support)
    const { snapshotToBinaryBuffers } = await import('../store/snapshotBuffers');
    const start = performance.now();
    const parsed = snapshotToBinaryBuffers(JSON.parse(raw));
    return {
      requestId: 'main', type: 'DEBRIS_UPDATE', timestamp: parsed.timestamp,
      debris: parsed.debris, satellites: parsed.satellites,
      metrics: { parseTimeMs: performance.now() - start, debrisCount: parsed.debris.length, satelliteCount: parsed.satellites.length, highRiskCount: 0 },
    };
  }

  private async deliver(raw: string, started: number) {
    const response = await this.parse(raw);
    if (response.type === 'ERROR') throw new Error(response.error ?? 'Worker parsing failed');
    if (response.type !== 'DEBRIS_UPDATE' || !response.debris || !response.satellites || !response.timestamp) {
      throw new Error('Worker returned incomplete or unexpected response');
    }
    // Never move the dashboard backwards in time (frames from the stream and from polling can
    // finish out of order). A jump back of more than 6 h means the backend was reset: accept it.
    const tsMs = Date.parse(response.timestamp);
    if (tsMs < this.lastTimestampMs && this.lastTimestampMs - tsMs < 6 * 3600 * 1000) return;
    this.lastTimestampMs = tsMs;
    const latency = performance.now() - started;
    this.metrics.successfulFetches++;
    this.metrics.lastLatencyMs = latency;
    this.metrics.avgLatencyMs =
      (this.metrics.avgLatencyMs * (this.metrics.successfulFetches - 1) + latency) / this.metrics.successfulFetches;
    this.metrics.workerParseTimeMs = response.metrics?.parseTimeMs ?? null;
    this.updateStatus({ state: 'connected', lastSuccessfulFetch: Date.now(), consecutiveFailures: 0, latencyMs: latency, error: null });
    this.onTelemetryCb?.(response.timestamp, response.satellites, response.debris, {
      parseTimeMs: response.metrics?.parseTimeMs ?? 0,
      latencyMs: latency,
    });
  }

  // ============================================================================
  // SSE TRANSPORT
  // ============================================================================

  private startStream(): boolean {
    if (typeof EventSource === 'undefined' || hasApiKey()) return false; // EventSource cannot send X-API-Key
    this.eventSource = new EventSource(CONFIG.STREAM_ENDPOINT);
    this.metrics.transport = 'sse';
    this.eventSource.onopen = () => {
      this.sseFailures = 0;
      if (this.connectionState.state !== 'connected') this.updateStatus({ state: 'connecting', error: null });
    };
    this.eventSource.onmessage = (e: MessageEvent<string>) => {
      this.metrics.totalFetches++;
      // Latest-frame-wins: if the pipeline is busy, keep only the newest frame.
      if (this.isProcessing) {
        this.pendingFrame = e.data;
        return;
      }
      this.pendingFrame = null; // anything parked is older than this frame
      this.processStreamFrame(e.data);
    };
    this.eventSource.onerror = () => {
      this.sseFailures++;
      if (this.sseFailures >= CONFIG.SSE_MAX_FAILURES) {
        console.warn('[TelemetryClient] Stream unavailable, switching to polling.');
        this.stopStream();
        this.startPollingLoop();
      }
    };
    return true;
  }

  private async processStreamFrame(raw: string) {
    this.isProcessing = true;
    try {
      await this.deliver(raw, performance.now());
    } catch (error) {
      this.metrics.failedFetches++;
      console.warn('[TelemetryClient] Stream frame failed:', (error as Error).message);
    } finally {
      this.isProcessing = false;
      this.drainPending();
    }
  }

  private stopStream() {
    this.eventSource?.close();
    this.eventSource = null;
  }

  // ============================================================================
  // POLLING TRANSPORT
  // ============================================================================

  private async fetchAndParse(): Promise<void> {
    if (this.isProcessing) return; // anti-choke lock: previous frame still in flight
    this.isProcessing = true;
    const fetchStart = performance.now();
    this.metrics.totalFetches++;
    let retryDelay = CONFIG.RETRY_DELAY_MS;

    try {
      for (let attempt = 1; attempt <= CONFIG.MAX_RETRY_ATTEMPTS; attempt++) {
        try {
          const response = await apiFetch(CONFIG.SNAPSHOT_ENDPOINT, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
          if (response.status === 400) {
            this.updateStatus({ state: 'connecting', error: 'Awaiting telemetry (POST /api/telemetry)' });
            return;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await this.deliver(await response.text(), fetchStart);
          return;
        } catch (error) {
          if (attempt === CONFIG.MAX_RETRY_ATTEMPTS) {
            this.metrics.failedFetches++;
            this.updateStatus({
              state: 'error',
              error: (error as Error).message,
              consecutiveFailures: this.connectionState.consecutiveFailures + 1,
            });
            return;
          }
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          retryDelay *= CONFIG.RETRY_BACKOFF_MULTIPLIER;
        }
      }
    } finally {
      this.isProcessing = false;
      this.drainPending();
    }
  }

  /** Processes a stream frame that arrived while another frame was in flight. */
  private drainPending() {
    const next = this.pendingFrame;
    this.pendingFrame = null;
    if (next) this.processStreamFrame(next);
  }

  private startPollingLoop(intervalMs: number = CONFIG.POLLING_INTERVAL_MS) {
    if (this.pollingInterval) return;
    this.metrics.transport = 'poll';
    this.fetchAndParse();
    this.pollingInterval = setInterval(() => this.fetchAndParse(), intervalMs);
  }

  // ============================================================================
  // PUBLIC CONTROLS
  // ============================================================================

  /** Starts live updates (SSE when possible, polling otherwise). Returns a stop function. */
  public start(callback: TelemetryCallback, options: { intervalMs?: number; preferStream?: boolean } = {}): () => void {
    this.onTelemetryCb = callback;
    this.stop();
    const streaming = options.preferStream !== false && this.startStream();
    if (!streaming) this.startPollingLoop(options.intervalMs);
    // Fetch one snapshot immediately so the dashboard is populated before the first stream event.
    if (streaming) this.fetchAndParse();
    return () => this.stop();
  }

  /** Polling-only mode (kept for callers that do not want a stream). */
  public startPolling(callback: TelemetryCallback, intervalMs?: number): () => void {
    return this.start(callback, { intervalMs, preferStream: false });
  }

  /** One-off refresh through the same parse pipeline. */
  public refresh(): Promise<void> {
    return this.fetchAndParse();
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  public stop(): void {
    this.stopPolling();
    this.stopStream();
    this.metrics.transport = 'idle';
  }

  public cleanup(): void {
    this.stop();
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
