// src/lib/motionSmoother.ts
// Smooth on-screen motion for objects whose positions arrive in discrete updates (telemetry
// snapshots ~2x per second; a LEO satellite moves ~4 km between them). On each update every object
// starts gliding from where it is currently drawn to its newly reported position, over the measured
// interval between updates - so motion is continuous instead of a twice-a-second hop.

export type Vec3 = [number, number, number];

const JUMP = 0.03;          // world units (~190 km): farther than this is a jump (replay scrub, reload) - snap
const HEADING_MAX = 0.05;   // a report-to-report step longer than this is not a usable direction of travel
// Minimum sideways (horizontal) movement (~640 m) for a direction of travel. Altitude arrives on a separate,
// slower feed than latitude/longitude, so some updates move a satellite only up or down: those carry no
// direction, and treating the leftover rounding noise as one made models swing to random headings.
// Geostationary satellites barely move over the Earth (a few hundred m per update, the size of the position
// rounding), so they stay below this and keep a steady orientation; LEO moves ~4 km+, GPS ~1.5 km per update.
const HEADING_MIN = 1e-4;

export class MotionSmoother {
  ids: string[] = [];
  private from = new Float64Array(0);
  private to = new Float64Array(0);
  private start = 0;
  private lastUpdate = 0;
  /** Glide duration: an exponential average of the time between position updates. */
  duration = 500;

  /**
   * New reported positions (`positions` holds n x/y/z triples, in `ids` order). Objects matched by id;
   * new ones appear in place. Calls with unchanged positions (e.g. only colours changed) don't restart
   * the glide. Returns the horizontal direction of travel of every object that moved sideways.
   */
  update(ids: string[], positions: ArrayLike<number>, now: number): Map<string, Vec3> {
    const n = ids.length;
    const prev = new Map(this.ids.map((id, i) => [id, i]));
    const headings = new Map<string, Vec3>();
    let moved = false;
    for (let i = 0; i < n; i++) {
      const j = prev.get(ids[i]);
      if (j === undefined) continue;
      const dx = positions[i * 3] - this.to[j * 3];
      const dy = positions[i * 3 + 1] - this.to[j * 3 + 1];
      const dz = positions[i * 3 + 2] - this.to[j * 3 + 2];
      const step = Math.hypot(dx, dy, dz);
      if (step > 1e-9) {
        moved = true;
        if (step < HEADING_MAX) {
          // Keep only the horizontal part of the step (remove the component along the local vertical).
          const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
          const r = Math.hypot(px, py, pz) || 1;
          const along = (dx * px + dy * py + dz * pz) / r;
          const hx = dx - along * px / r, hy = dy - along * py / r, hz = dz - along * pz / r;
          const h = Math.hypot(hx, hy, hz);
          if (h > HEADING_MIN) headings.set(ids[i], [hx / h, hy / h, hz / h]);
        }
      }
    }
    if (moved) {
      const interval = now - this.lastUpdate;
      if (this.lastUpdate && interval > 60 && interval < 3000) this.duration = 0.7 * this.duration + 0.3 * interval;
      this.lastUpdate = now;
    }

    const t = this.progress(now);
    const from = new Float64Array(n * 3);
    const to = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const j = prev.get(ids[i]);
      for (let k = 0; k < 3; k++) {
        const o = i * 3 + k;
        if (j === undefined) {                       // new object: appears where reported
          from[o] = to[o] = positions[o];
        } else if (!moved) {                         // same data: carry on gliding
          from[o] = this.from[j * 3 + k];
          to[o] = this.to[j * 3 + k];
        } else {                                     // glide from where it is drawn now
          from[o] = this.from[j * 3 + k] + (this.to[j * 3 + k] - this.from[j * 3 + k]) * t;
          to[o] = positions[o];
        }
      }
      if (j !== undefined && moved
        && Math.hypot(to[i * 3] - from[i * 3], to[i * 3 + 1] - from[i * 3 + 1], to[i * 3 + 2] - from[i * 3 + 2]) > JUMP) {
        from.set(to.subarray(i * 3, i * 3 + 3), i * 3);
      }
    }
    if (moved) this.start = now;
    this.ids = ids;
    this.from = from;
    this.to = to;
    return headings;
  }

  /** 0 → 1 through the current glide. */
  progress(now: number): number {
    return Math.min(1, Math.max(0, (now - this.start) / this.duration));
  }

  /** True once the current glide has finished (nothing moves until the next update). */
  settled(now: number): boolean {
    return now - this.start > this.duration + 32;
  }

  /** Positions as drawn at `now`, written into `out` (n x/y/z triples). */
  sample(now: number, out: { [i: number]: number }) {
    const t = this.progress(now);
    for (let o = 0; o < this.ids.length * 3; o++) out[o] = this.from[o] + (this.to[o] - this.from[o]) * t;
  }
}
