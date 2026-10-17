// src/lib/satMotion.ts
// Smooth satellite motion between telemetry frames. Frames arrive about once a second (live mode) or
// once per simulation tick, so drawing the raw positions makes every satellite jump. Between frames we
// dead-reckon each satellite along its last observed ground-track velocity, in *simulation* time: the
// sim-seconds-per-wall-second rate is measured from the frames themselves, so a paused clock stops
// motion and a 60x clock moves 60x as fast. When the next frame lands, the small difference between
// where we drew a satellite and where it really is fades out over CORRECTION_MS instead of snapping.

export interface MotionFrame {
  ids: readonly string[];
  /** [lon, lat, alt] per satellite (stride 3). */
  positions: ArrayLike<number>;
  length: number;
}

const CORRECTION_MS = 250;
/** Never extrapolate further than this many frame gaps past the last frame (stream stalls). */
const MAX_AHEAD_GAPS = 1.5;
const MAX_AHEAD_MS = 3000;
/** Frames further apart than this in sim time are a jump (replay, catalog reload), not motion. */
const MAX_VELOCITY_SPAN_S = 300;
/** A correction larger than this (degrees) is a teleport (manual edit, new orbit); snap instead. */
const MAX_CORRECTION_DEG = 2;

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
const dLon = (a: number, b: number) => wrapLon(a - b);

export class SatelliteMotion {
  private ids: readonly string[] = [];
  private base = new Float64Array(0);      // last frame's [lon, lat, alt]
  private vel = new Float64Array(0);       // per sim-second
  private offset = new Float64Array(0);    // correction faded out after a frame lands
  private simTs = NaN;                     // sim time of the last frame (s)
  private arrival = NaN;                   // wall time it arrived (ms)
  private rate = 0;                        // sim seconds per wall second
  private gapMs = 1000;                    // typical wall time between frames
  private out = new Float32Array(0);

  get moving(): boolean { return this.rate > 0 && this.ids.length > 0; }

  /** Feeds a new telemetry frame (simTsMs = the frame's simulation timestamp). */
  ingest(frame: MotionFrame, simTsMs: number, nowMs: number): void {
    const n = frame.length;
    const simTs = simTsMs / 1000;
    const prevIndex = new Map<string, number>();
    this.ids.forEach((id, i) => prevIndex.set(id, i));
    const dtSim = simTs - this.simTs;
    const dtWall = nowMs - this.arrival;
    const usable = Number.isFinite(dtSim) && dtSim > 0 && dtSim <= MAX_VELOCITY_SPAN_S;

    // Where each satellite is drawn right now, so the switch to the new frame is seamless.
    const shown = this.ids.length ? this.sample(nowMs) : null;

    const base = new Float64Array(n * 3);
    const vel = new Float64Array(n * 3);
    const offset = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      base[o] = frame.positions[o]; base[o + 1] = frame.positions[o + 1]; base[o + 2] = frame.positions[o + 2];
      const j = prevIndex.get(frame.ids[i]);
      if (j === undefined) continue;
      const p = j * 3;
      if (usable) {
        vel[o] = dLon(base[o], this.base[p]) / dtSim;
        vel[o + 1] = (base[o + 1] - this.base[p + 1]) / dtSim;
        vel[o + 2] = (base[o + 2] - this.base[p + 2]) / dtSim;
      }
      if (shown) {
        const ox = dLon(shown[p], base[o]);
        const oy = shown[p + 1] - base[o + 1];
        if (Math.abs(ox) < MAX_CORRECTION_DEG && Math.abs(oy) < MAX_CORRECTION_DEG) {
          offset[o] = ox; offset[o + 1] = oy; offset[o + 2] = shown[p + 2] - base[o + 2];
        }
      }
    }

    if (Number.isFinite(dtWall) && dtWall > 0) {
      // A paused clock (dtSim = 0) or a jump stops motion at once; otherwise smooth out network jitter.
      const measured = usable ? dtSim / (dtWall / 1000) : 0;
      this.rate = !usable ? 0 : this.rate ? this.rate * 0.5 + measured * 0.5 : measured;
      this.gapMs = this.gapMs * 0.7 + Math.min(dtWall, MAX_AHEAD_MS) * 0.3;
    }
    if (!usable) offset.fill(0);

    this.ids = frame.ids;
    this.base = base;
    this.vel = vel;
    this.offset = offset;
    this.simTs = simTs;
    this.arrival = nowMs;
    if (this.out.length !== n * 3) this.out = new Float32Array(n * 3);
  }

  /** Positions to draw at wall time nowMs ([lon, lat, alt] stride 3, same order as the last frame). */
  sample(nowMs: number): Float32Array {
    const n = this.ids.length;
    if (this.out.length !== n * 3) this.out = new Float32Array(n * 3);
    const elapsed = Math.max(0, nowMs - this.arrival);
    const ahead = (Math.min(elapsed, this.gapMs * MAX_AHEAD_GAPS, MAX_AHEAD_MS) / 1000) * this.rate;
    const fade = elapsed >= CORRECTION_MS * 4 ? 0 : Math.exp(-elapsed / CORRECTION_MS * 2.5);
    for (let o = 0; o < n * 3; o += 3) {
      this.out[o] = wrapLon(this.base[o] + this.vel[o] * ahead + this.offset[o] * fade);
      this.out[o + 1] = Math.max(-90, Math.min(90, this.base[o + 1] + this.vel[o + 1] * ahead + this.offset[o + 1] * fade));
      this.out[o + 2] = this.base[o + 2] + this.vel[o + 2] * ahead + this.offset[o + 2] * fade;
    }
    return this.out;
  }

  /** Clock paused: stop at once and ease every satellite back onto its last real position. */
  pause(nowMs: number): void {
    if (!this.ids.length || this.rate === 0) return;
    const shown = this.sample(nowMs);
    for (let o = 0; o < this.base.length; o += 3) {
      this.offset[o] = dLon(shown[o], this.base[o]);
      this.offset[o + 1] = shown[o + 1] - this.base[o + 1];
      this.offset[o + 2] = shown[o + 2] - this.base[o + 2];
    }
    this.vel.fill(0);
    this.rate = 0;
    this.arrival = nowMs;
  }

  /** On-screen speed on a Web Mercator map, in map-degrees per wall-clock second, of the satellite at
   *  the given percentile (0.9 = faster than 90 % of the fleet). Sizes the animation frame rate: a
   *  percentile, not the maximum, so a few polar passes racing along the map's top edge don't force
   *  full-rate redraws of the whole map. */
  speedDegPerSec(percentile = 0.9): number {
    const n = this.vel.length / 3;
    if (!n || !this.rate) return 0;
    const speeds = new Float64Array(n);
    for (let i = 0, o = 0; i < n; i++, o += 3) {
      const lat = Math.min(85, Math.abs(this.base[o + 1])) * Math.PI / 180;
      speeds[i] = Math.hypot(this.vel[o], this.vel[o + 1] / Math.cos(lat));   // Mercator stretches y by 1/cos(lat)
    }
    speeds.sort();
    return speeds[Math.min(n - 1, Math.floor(n * percentile))] * this.rate;
  }

  /** True while a correction is still fading or the clock runs: the view needs animation frames. */
  animating(nowMs: number): boolean {
    return this.moving || nowMs - this.arrival < CORRECTION_MS * 4;
  }
}
