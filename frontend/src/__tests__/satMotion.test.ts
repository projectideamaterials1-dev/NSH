import { describe, expect, it } from 'vitest';
import { SatelliteMotion } from '../lib/satMotion';

const frame = (lon: number, lat = 0, alt = 500, ids = ['A']) => ({ ids, positions: [lon, lat, alt], length: ids.length });
/** Frames every wall second at 1x, so the extrapolation already matches and no correction is pending. */
const steady = (m: SatelliteMotion, lons: number[]) => lons.forEach((lon, k) => m.ingest(frame(lon), k * 1000, k * 1000));

describe('SatelliteMotion', () => {
  it('glides between frames at the measured sim rate', () => {
    const m = new SatelliteMotion();
    steady(m, [10, 11, 12]);                  // 1 deg per sim-second, sim runs at 1x
    expect(m.sample(2000)[0]).toBeCloseTo(12, 6);
    expect(m.sample(2500)[0]).toBeCloseTo(12.5, 6);
    expect(m.moving).toBe(true);
  });

  it('scales with a fast simulation clock', () => {
    const m = new SatelliteMotion();
    m.ingest(frame(0), 0, 0);
    m.ingest(frame(6), 60_000, 1000);         // 60 sim-seconds per wall second, 0.1 deg/s
    expect(m.sample(1500)[0]).toBeCloseTo(9, 6);
  });

  it('never coasts far past a stalled stream', () => {
    const m = new SatelliteMotion();
    m.ingest(frame(0), 0, 0);
    m.ingest(frame(1), 1000, 1000);
    expect(m.sample(60_000)[0]).toBeLessThanOrEqual(1 + 1.5 + 1e-9);
  });

  it('blends a correction in instead of snapping', () => {
    const m = new SatelliteMotion();
    m.ingest(frame(0), 0, 0);
    m.ingest(frame(1), 1000, 1000);
    const drawn = m.sample(2000)[0];          // extrapolated to 2.0
    m.ingest(frame(1.8), 2000, 2000);         // truth is 1.8
    expect(m.sample(2000)[0]).toBeCloseTo(drawn, 6);   // no jump at the hand-over
    expect(Math.abs(m.sample(3500)[0] - (1.8 + 1.5 * 0.8))).toBeLessThan(1e-3);   // correction gone
  });

  it('wraps across the antimeridian', () => {
    const m = new SatelliteMotion();
    steady(m, [178.5, 179.5, -179.5]);        // +1 deg/s across 180
    expect(m.sample(2500)[0]).toBeCloseTo(-179, 6);
  });

  it('stops when the clock pauses and eases back to the real position', () => {
    const m = new SatelliteMotion();
    steady(m, [0, 1, 2]);
    m.pause(2500);                             // drawn at 2.5
    expect(m.moving).toBe(false);
    expect(m.sample(2500)[0]).toBeCloseTo(2.5, 6);
    expect(m.sample(6000)[0]).toBeCloseTo(2, 6);
  });

  it('treats a big time jump or new orbit as a teleport', () => {
    const m = new SatelliteMotion();
    m.ingest(frame(0), 0, 0);
    m.ingest(frame(1), 1000, 1000);
    m.ingest(frame(90), 3_600_000, 2000);     // replay/catalog reload: an hour later
    expect(m.sample(2000)[0]).toBeCloseTo(90, 6);
    expect(m.sample(2500)[0]).toBeCloseTo(90, 6);
  });

  it('follows satellites by id when the fleet order changes', () => {
    const m = new SatelliteMotion();
    m.ingest({ ids: ['A', 'B'], positions: [0, 0, 500, 50, 0, 500], length: 2 }, 0, 0);
    m.ingest({ ids: ['B', 'A'], positions: [52, 0, 500, 1, 0, 500], length: 2 }, 1000, 1000);
    m.ingest({ ids: ['A', 'B'], positions: [2, 0, 500, 54, 0, 500], length: 2 }, 2000, 2000);
    const out = m.sample(2500);
    expect(out[0]).toBeCloseTo(2.5, 6);       // A moves 1 deg/s
    expect(out[3]).toBeCloseTo(55, 6);        // B moves 2 deg/s
  });
});

describe('SatelliteMotion.speedDegPerSec', () => {
  it('sizes the frame rate on the bulk of the fleet, not one fast outlier', () => {
    const m = new SatelliteMotion();
    const ids = Array.from({ length: 20 }, (_, i) => `S${i}`);
    const at = (k: number) => ids.flatMap((_, i) => [i === 0 ? k * 5 : k * 0.07, 0, 500]);   // S0 races at 5 deg/s
    m.ingest({ ids, positions: at(0), length: 20 }, 0, 0);
    m.ingest({ ids, positions: at(1), length: 20 }, 1000, 1000);
    expect(m.speedDegPerSec()).toBeCloseTo(0.07, 6);
    expect(m.speedDegPerSec(1)).toBeCloseTo(5, 6);
  });
});
