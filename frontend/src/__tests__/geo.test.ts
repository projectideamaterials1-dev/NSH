import { describe, expect, it } from 'vitest';
import { bearingDeg, elevationDeg, greatCircleKm, nearbyDebris, nightPolygon, subsolarPoint } from '../lib/geo';

describe('geo helpers', () => {
  it('computes great-circle distance and bearing', () => {
    expect(greatCircleKm(0, 0, 0, 1)).toBeCloseTo(111.19, 1);
    expect(bearingDeg(0, 0, 1, 0)).toBeCloseTo(0, 5);
    expect(bearingDeg(0, 0, 0, 1)).toBeCloseTo(90, 5);
  });

  it('gives 90° elevation overhead and negative below the horizon', () => {
    expect(elevationDeg(13, 77.5, 550, 13, 77.5)).toBe(90);
    expect(elevationDeg(13, 77.5, 550, -40, -60)).toBeLessThan(0);
  });

  it('puts the sub-solar point near the equator at the equinox and on the noon meridian', () => {
    const sun = subsolarPoint('2026-03-20T12:00:00Z');
    expect(Math.abs(sun.lat)).toBeLessThan(1);
    expect(Math.abs(sun.lon)).toBeLessThan(5);
    expect(subsolarPoint('2026-06-21T12:00:00Z').lat).toBeGreaterThan(23);
  });

  it('builds a closed night polygon over the dark pole', () => {
    const ring = nightPolygon('2026-06-21T12:00:00Z');
    expect(ring.length).toBeGreaterThan(180);
    expect(ring[ring.length - 1]).toEqual([-180, -90]);   // southern winter: south pole in darkness
  });

  it('finds nearby debris sorted by distance', () => {
    const positions = new Float32Array([
      77.6, 13.0, 500000,   // ~11 km away
      80.0, 13.0, 700000,   // ~270 km away
      -60, -40, 600000,     // far away
    ]);
    const debris = { positions, colors: new Uint8ClampedArray(12), ids: ['A', 'B', 'C'], riskScores: new Float32Array(3), length: 3 };
    const near = nearbyDebris(13.0, 77.5, debris, 500);
    expect(near.map(n => n.debrisId)).toEqual(['A', 'B']);
    expect(near[0].altitudeKm).toBe(500);
  });
});
