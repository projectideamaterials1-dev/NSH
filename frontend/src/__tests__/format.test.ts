import { describe, expect, it } from 'vitest';
import {
  formatCoord, formatDuration, formatKm, formatUtcTime, fuelColor, fuelPercent, maneuverMeta, riskMeta,
  secondsUntil, statusMeta, COLORS,
} from '../lib/format';

describe('format helpers', () => {
  it('formats durations compactly', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(725)).toBe('12m 05s');
    expect(formatDuration(3840)).toBe('1h 04m');
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('—');
  });

  it('formats distances in metres below 1 km', () => {
    expect(formatKm(0.047)).toBe('47 m');
    expect(formatKm(3.456)).toBe('3.46 km');
    expect(formatKm(42.19)).toBe('42.2 km');
  });

  it('formats UTC times and coordinates', () => {
    expect(formatUtcTime('2026-01-01T12:34:56.789Z')).toBe('12:34:56');
    expect(formatUtcTime('2026-01-01T12:34:56Z', false)).toBe('12:34');
    expect(formatUtcTime('not a date')).toBe('--:--:--');
    expect(formatCoord(-12.345, 'N', 'S')).toBe('12.35° S');
  });

  it('computes time until a TCA relative to simulation time', () => {
    expect(secondsUntil('2026-01-01T00:10:00Z', '2026-01-01T00:00:00Z')).toBe(600);
    expect(secondsUntil(1767225600 + 30, '2026-01-01T00:00:00Z')).toBe(30);
  });

  it('maps fuel to percentage and colour', () => {
    expect(fuelPercent(25)).toBe(50);
    expect(fuelPercent(80)).toBe(100);
    expect(fuelColor(2)).toBe(COLORS.crit);
    expect(fuelColor(15)).toBe(COLORS.warn);
    expect(fuelColor(45)).toBe(COLORS.ok);
  });

  it('provides labels for statuses, risks and maneuver types', () => {
    expect(statusMeta('CRITICAL_FUEL').label).toBe('Low fuel');
    expect(statusMeta('SOMETHING').label).toBe('SOMETHING');
    expect(riskMeta('CRITICAL').color).toBe(COLORS.crit);
    expect(riskMeta(null).label).toBe('Watch');
    expect(maneuverMeta('RADIAL_SHUNT').label).toBe('Radial shunt');
    expect(maneuverMeta('CUSTOM_THING').label).toBe('custom thing');
  });
});
