import { describe, expect, it } from 'vitest';
import { MotionSmoother } from '../lib/motionSmoother';

// A satellite moving 0.001 world units (~6 km) along +x per 500 ms update.
const STEP = 0.001;
const pos = (k: number) => [1 + k * STEP, 0, 0];
const at = (s: MotionSmoother, now: number) => { const out = [0, 0, 0]; s.sample(now, out); return out[0]; };

describe('MotionSmoother', () => {
  it('glides continuously between updates instead of jumping', () => {
    const s = new MotionSmoother();
    let now = 0;
    for (let k = 0; k < 6; k++, now += 500) s.update(['A'], pos(k), now);   // warm up the interval estimate
    // Sample every 16 ms across several updates: no frame-to-frame step may be much bigger than
    // the steady-state per-frame motion, and the object never runs backwards.
    const xs: number[] = [];
    for (let k = 6; k < 12; k++, now += 500) {
      s.update(['A'], pos(k), now);
      for (let f = 0; f < 500; f += 16) xs.push(at(s, now + f));
    }
    const steps = xs.slice(1).map((x, i) => x - xs[i]);
    const perFrame = STEP * 16 / 500;
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(-1e-12);
    expect(Math.max(...steps)).toBeLessThan(perFrame * 2.5);   // a raw update would be a 31x bigger hop
  });

  it('does not restart the glide when positions are unchanged', () => {
    const s = new MotionSmoother();
    s.update(['A'], pos(0), 0);
    s.update(['A'], pos(1), 500);
    const mid = at(s, 750);
    s.update(['A'], pos(1), 750);            // same data again (e.g. a colour changed)
    expect(at(s, 750)).toBeCloseTo(mid, 12);
    expect(at(s, 1000)).toBeCloseTo(pos(1)[0], 12);
  });

  it('settles exactly on the last reported position when updates stop (e.g. paused)', () => {
    const s = new MotionSmoother();
    s.update(['A'], pos(0), 0);
    s.update(['A'], pos(1), 500);
    expect(s.settled(5000)).toBe(true);
    expect(at(s, 5000)).toBeCloseTo(pos(1)[0], 12);
  });

  it('snaps on jumps and places new objects immediately', () => {
    const s = new MotionSmoother();
    s.update(['A'], [1, 0, 0], 0);
    s.update(['A', 'B'], [1.5, 0, 0, 2, 0, 0], 500);   // A jumps ~3000 km (replay scrub); B is new
    const out = [0, 0, 0, 0, 0, 0];
    s.sample(500, out);
    expect(out[0]).toBe(1.5);
    expect(out[3]).toBe(2);
  });

  it('reports the direction of travel and matches objects by id when order changes', () => {
    const s = new MotionSmoother();
    s.update(['A', 'B'], [1, 0, 0, 0, 1, 0], 0);
    const headings = s.update(['B', 'A'], [0, 1, 0.001, 1, 0.001, 0], 500);
    expect(headings.get('A')![1]).toBeCloseTo(1, 5);
    expect(headings.get('B')![2]).toBeCloseTo(1, 5);
    const out = [0, 0, 0, 0, 0, 0];
    s.sample(500, out);                                   // at the start of the glide: still where drawn
    expect(out.slice(0, 3)).toEqual([0, 1, 0]);
    expect(out.slice(3)).toEqual([1, 0, 0]);
  });
});

describe('MotionSmoother headings', () => {
  it('ignores purely radial changes (an altitude refresh is not a direction of travel)', () => {
    const s = new MotionSmoother();
    const up = (r: number, x: number) => [r * Math.cos(x), r * Math.sin(x), 0];   // satellite on a circle in the x-y plane
    s.update(['A'], up(1.065, 0), 0);
    const h1 = s.update(['A'], up(1.065, 0.001), 1000).get('A')!;          // genuine along-track step
    expect(Math.abs(h1[1])).toBeGreaterThan(0.99);
    const h2 = s.update(['A'], up(1.06505, 0.001), 2500);                   // altitude-only refresh (+0.3 km)
    expect(h2.has('A')).toBe(false);
  });
});
