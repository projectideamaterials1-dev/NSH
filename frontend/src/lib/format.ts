// src/lib/format.ts
// Formatting helpers and status metadata shared across the dashboard.

export const FUEL_INITIAL_KG = 50;
export const FUEL_EOL_KG = 2.5;

export const COLORS = {
  ok: '#3fb950',
  warn: '#e3a008',
  crit: '#f85149',
  eol: '#6b7886',
  accent: '#4da3ff',
  sat: '#38d6f5',
} as const;

export const STATUS_META = {
  NOMINAL: { label: 'Nominal', color: COLORS.ok },
  WARNING: { label: 'Warning', color: COLORS.warn },
  CRITICAL: { label: 'Critical', color: COLORS.crit },
  CRITICAL_FUEL: { label: 'Low fuel', color: COLORS.crit },
  EOL: { label: 'End of life', color: COLORS.eol },
} as const;

export function statusMeta(status: string) {
  return STATUS_META[status as keyof typeof STATUS_META] ?? { label: status, color: COLORS.eol };
}

/** Fuel colour: green above 40 %, amber above the EOL reserve, red below. */
export function fuelColor(fuelKg: number): string {
  if (fuelKg <= FUEL_EOL_KG) return COLORS.crit;
  if (fuelKg < FUEL_INITIAL_KG * 0.4) return COLORS.warn;
  return COLORS.ok;
}

export function fuelPercent(fuelKg: number): number {
  return Math.max(0, Math.min(100, (fuelKg / FUEL_INITIAL_KG) * 100));
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export function formatUtcTime(value: string | number | Date | null | undefined, withSeconds = true): string {
  const d = toDate(value);
  if (!d) return '--:--' + (withSeconds ? ':--' : '');
  return d.toISOString().substring(11, withSeconds ? 19 : 16);
}

export function formatUtcDate(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  return d ? d.toISOString().substring(0, 10) : '----------';
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US');
}

export function formatCoord(value: number, pos: string, neg: string): string {
  if (!Number.isFinite(value)) return '—';
  return `${Math.abs(value).toFixed(2)}° ${value >= 0 ? pos : neg}`;
}

export const RISK_META = {
  CRITICAL: { label: 'Critical', color: COLORS.crit, hint: 'Predicted miss under 100 m' },
  WARNING: { label: 'Warning', color: COLORS.warn, hint: 'Predicted miss under 1 km' },
  WATCH: { label: 'Watch', color: '#9aa8b6', hint: 'Predicted miss under 5 km' },
} as const;

export function riskMeta(risk: string | null | undefined) {
  return RISK_META[(risk ?? 'WATCH') as keyof typeof RISK_META] ?? RISK_META.WATCH;
}

export const CDM_STATUS_META: Record<string, { label: string; color: string }> = {
  ACTIVE: { label: 'Active', color: COLORS.crit },
  MITIGATED: { label: 'Avoidance planned', color: COLORS.accent },
  CLEARED: { label: 'Cleared', color: COLORS.ok },
  RESOLVED: { label: 'Passed safely', color: COLORS.ok },
  COLLIDED: { label: 'Collision', color: COLORS.crit },
};

export const MODE_META: Record<string, { label: string; color: string }> = {
  NOMINAL: { label: 'Nominal', color: COLORS.ok },
  BURN_QUEUED: { label: 'Burn queued', color: COLORS.accent },
  EVADING: { label: 'Evading', color: COLORS.warn },
  RECOVERING: { label: 'Recovering', color: COLORS.accent },
  GRAVEYARD: { label: 'Retired', color: COLORS.eol },
};

export const MANEUVER_META: Record<string, { label: string; color: string }> = {
  PHASING_PROGRADE: { label: 'Phasing (prograde)', color: '#4da3ff' },
  PHASING_RETROGRADE: { label: 'Phasing (retrograde)', color: '#7c8cff' },
  RADIAL_SHUNT: { label: 'Radial shunt', color: '#c678dd' },
  RECOVERY: { label: 'Recovery', color: COLORS.ok },
  EOL_GRAVEYARD: { label: 'Graveyard', color: COLORS.eol },
  MANUAL: { label: 'Manual', color: '#38d6f5' },
  EXTERNAL: { label: 'External', color: '#9aa8b6' },
  PLANE_CHANGE: { label: 'Plane change', color: COLORS.warn },
};

export function maneuverMeta(type: string) {
  return MANEUVER_META[type] ?? { label: type.replace(/_/g, ' ').toLowerCase(), color: '#9aa8b6' };
}

export const EVENT_LEVEL_META = {
  crit: { label: 'Critical', color: COLORS.crit },
  warn: { label: 'Warning', color: COLORS.warn },
  ok: { label: 'Resolved', color: COLORS.ok },
  info: { label: 'Info', color: COLORS.accent },
} as const;

/** "12m 05s", "1h 04m", "45s" */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function formatKm(km: number): string {
  if (!Number.isFinite(km)) return '—';
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 2 : 1)} km`;
}

/** Seconds from `reference` ISO time until `target` ISO time (negative if past). */
export function secondsUntil(target: string | number, reference: string | null): number {
  const t = typeof target === 'number' ? target * 1000 : Date.parse(target);
  const r = reference ? Date.parse(reference) : Date.now();
  return (t - r) / 1000;
}
