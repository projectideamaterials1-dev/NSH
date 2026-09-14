// src/components/LeftPanel.tsx
// Selected-satellite details (live mode, contact, passes, queued burns), conjunction bullseye
// and nearby tracked objects.

import React, { useMemo, useState } from 'react';
import { BarChart3, CalendarClock, Crosshair, Database, MousePointerClick, Radio, Rocket, X } from 'lucide-react';
import useOrbitalStore, { selectSelectedSatellite } from '../store/useOrbitalStore';
import type { Conjunction } from '../store/useOrbitalStore';
import {
  COLORS, CDM_STATUS_META, MODE_META, formatCoord, formatDuration, formatKm, formatUtcTime, fuelColor, fuelPercent,
  maneuverMeta, riskMeta, secondsUntil, statusMeta,
} from '../lib/format';
import { nearbyDebris } from '../lib/geo';
import { Button, EmptyState, Panel, StatusBadge } from './ui';
import { ResourcesModal } from './ResourcesModal';
import { ManeuverTimeline } from './ManeuverTimeline';
import { ManualBurnModal } from './ManualBurnModal';

const RADAR_RANGE_KM = 500;
const BULLSEYE_RINGS_S = [900, 3600, 10800];   // 15 min, 1 h, 3 h

const Metric: React.FC<{ label: string; value: React.ReactNode; tone?: string; title?: string }> = ({ label, value, tone, title }) => (
  <div className="bg-raised border border-line rounded-lg px-3 py-2" title={title}>
    <div className="text-[11px] text-muted">{label}</div>
    <div className="tabular text-[14px] font-semibold mt-0.5 truncate" style={{ color: tone }}>{value}</div>
  </div>
);

const FleetOverview: React.FC = () => {
  const satellites = useOrbitalStore(s => s.satellites);
  const details = useOrbitalStore(s => s.satelliteDetails);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    if (satellites) for (const s of satellites.statuses) c[s] = (c[s] ?? 0) + 1;
    return c;
  }, [satellites]);
  const detailList = Object.values(details);
  const inContact = detailList.filter(d => d.in_contact).length;
  const maneuvering = detailList.filter(d => d.mode === 'EVADING' || d.mode === 'RECOVERING').length;

  if (!satellites || satellites.length === 0) {
    return <EmptyState title="No satellites yet">Fleet details appear here once telemetry is received.</EmptyState>;
  }
  return (
    <div className="px-4 pb-4 space-y-3">
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-line-strong px-3 py-3 text-[13px] text-muted">
        <MousePointerClick className="w-4 h-4 text-accent flex-shrink-0" />
        Select a satellite on the map or in the fleet list to inspect it.
      </div>
      <div className="grid grid-cols-2 gap-2">
        {Object.entries(counts).map(([status, n]) => (
          <Metric key={status} label={statusMeta(status).label} value={n} tone={statusMeta(status).color} />
        ))}
        <Metric label="In ground contact" value={detailList.length ? inContact : '—'} tone={COLORS.ok} />
        <Metric label="Maneuvering" value={detailList.length ? maneuvering : '—'} tone={maneuvering ? COLORS.warn : undefined} />
      </div>
    </div>
  );
};

const SatelliteDetails: React.FC = () => {
  const sat = useOrbitalStore(selectSelectedSatellite);
  const detail = useOrbitalStore(s => (s.selectedSatelliteId ? s.satelliteDetails[s.selectedSatelliteId] : undefined));
  const maneuvers = useOrbitalStore(s => s.maneuvers);
  const passes = useOrbitalStore(s => s.selectedPasses);
  const catalogInfo = useOrbitalStore(s => (s.selectedCatalog?.id === s.selectedSatelliteId ? s.selectedCatalog : null));
  const timestamp = useOrbitalStore(s => s.timestamp);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  const cancelManeuver = useOrbitalStore(s => s.cancelManeuver);
  const [modal, setModal] = useState<'resources' | 'timeline' | 'burn' | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const stats = useMemo(() => {
    if (!sat) return null;
    const mine = maneuvers.filter(m => m.satellite_id === sat.id);
    const executed = mine.filter(m => m.status === 'executed');
    const pending = mine.filter(m => m.status === 'pending').sort((a, b) => a.burnTime.localeCompare(b.burnTime));
    return { executed: executed.length, pending, totalDv: executed.reduce((sum, m) => sum + m.delta_v_magnitude, 0) };
  }, [sat?.id, maneuvers]);

  if (!sat || !stats) return <FleetOverview />;

  const color = fuelColor(sat.fuel_kg);
  const mode = MODE_META[detail?.mode ?? 'NOMINAL'] ?? MODE_META.NOMINAL;
  const upcoming = (passes ?? []).filter(p => p.in_progress || secondsUntil(p.start, timestamp) > 0).slice(0, 3);

  const cancel = async (burnId: string) => {
    setCancelling(burnId);
    setCancelError(null);
    try {
      await cancelManeuver(burnId);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setCancelling(null);
    }
  };

  return (
    <div className="px-4 pb-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="tabular text-xl font-semibold text-ink">{sat.id}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <StatusBadge status={sat.status} />
            {detail && detail.mode !== 'NOMINAL' && (
              <span className="inline-flex items-center gap-1.5 rounded-full border text-[11px] px-2 py-0.5 font-medium"
                style={{ color: mode.color, borderColor: `${mode.color}55`, background: `${mode.color}14` }}>
                {mode.label}
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" onClick={() => selectSatellite(null)} aria-label="Clear selection" icon={<X className="w-4 h-4" />} />
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] text-muted">Propellant</span>
          <span className="tabular text-[15px] font-semibold" style={{ color }}>
            {sat.fuel_kg.toFixed(2)} <span className="text-muted font-normal text-[12px]">/ 50 kg</span>
          </span>
        </div>
        <div className="h-2 mt-1.5 rounded-full bg-raised border border-line overflow-hidden">
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${fuelPercent(sat.fuel_kg)}%`, background: color }} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Metric label="Latitude" value={formatCoord(sat.lat, 'N', 'S')} />
        <Metric label="Longitude" value={formatCoord(sat.lon, 'E', 'W')} />
        <Metric label="Altitude" value={detail ? `${detail.alt_km.toFixed(1)} km` : '—'} />
        <Metric label="Slot drift" value={detail ? formatKm(detail.drift_km) : '—'}
          tone={detail && !detail.in_box ? COLORS.warn : undefined} title="Distance from the nominal station-keeping slot" />
        <Metric label="Cooldown" value={detail ? (detail.cooldown_s > 0 ? formatDuration(detail.cooldown_s) : 'Ready') : '—'}
          tone={detail && detail.cooldown_s > 0 ? COLORS.warn : COLORS.ok} />
        <Metric label="Total Δv" value={`${stats.totalDv.toFixed(2)} m/s`} title={`${stats.executed} burns executed`} />
      </div>

      {catalogInfo && (
        <div className="rounded-lg border border-line bg-raised/60 px-3 py-2.5">
          <div className="flex items-center gap-2 text-[12px] text-muted mb-1.5">
            <Database className="w-3.5 h-3.5" /> Catalog
            <span className="ml-auto tabular text-ink whitespace-nowrap">NORAD {catalogInfo.norad_id}</span>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] tabular">
            <dt className="text-muted">Source</dt><dd className="text-ink text-right truncate" title={catalogInfo.source_label}>{catalogInfo.source_label}</dd>
            <dt className="text-muted">COSPAR ID</dt><dd className="text-ink text-right">{catalogInfo.intl_designator || '—'}</dd>
            <dt className="text-muted">Orbit</dt>
            <dd className="text-ink text-right">{catalogInfo.elements.perigee_alt_km.toFixed(0)}×{catalogInfo.elements.apogee_alt_km.toFixed(0)} km</dd>
            <dt className="text-muted">Inclination</dt><dd className="text-ink text-right">{catalogInfo.elements.inclination_deg.toFixed(2)}°</dd>
            <dt className="text-muted">Period</dt><dd className="text-ink text-right">{catalogInfo.elements.period_min.toFixed(1)} min</dd>
            <dt className="text-muted" title="Epoch of the NORAD element set this orbit is propagated from">Element set</dt>
            <dd className="text-right" style={{ color: catalogInfo.element_age_hours > 72 ? COLORS.warn : 'var(--color-ink)' }}
              title={`Epoch ${catalogInfo.epoch}`}>
              {formatDuration(catalogInfo.element_age_hours * 3600)} old
            </dd>
          </dl>
          {catalogInfo.maneuvered_since_anchor && (
            <p className="text-[11px] text-warn mt-1.5">Manoeuvred in simulation: follows its simulated orbit, not the published one.</p>
          )}
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 text-[12px] text-muted mb-1.5">
          <Radio className="w-3.5 h-3.5" /> Ground contact
          <span className={`ml-auto text-[12px] font-medium ${detail?.in_contact ? 'text-ok' : 'text-warn'}`}>
            {detail ? (detail.in_contact ? 'In contact' : 'No contact') : ''}
          </span>
        </div>
        {passes === null ? (
          <p className="text-[12px] text-faint">Predicting passes…</p>
        ) : upcoming.length === 0 ? (
          <p className="text-[13px] text-warn">No ground-station pass in the next 6 hours.</p>
        ) : (
          <ul className="space-y-1">
            {upcoming.map(p => (
              <li key={`${p.station_id}-${p.start}`} className="flex justify-between text-[12px] tabular">
                <span className="text-ink truncate mr-2">{p.station_name.replace(/_/g, ' ')}</span>
                <span className={p.in_progress ? 'text-ok' : 'text-muted'}>
                  {p.in_progress ? 'now' : `in ${formatDuration(secondsUntil(p.start, timestamp))}`} · {formatDuration(p.duration_s)} · {p.max_elevation_deg.toFixed(0)}°
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="text-[12px] text-muted mb-1.5">Queued burns ({stats.pending.length})</div>
        {stats.pending.length === 0 ? (
          <p className="text-[12px] text-faint">Nothing scheduled.</p>
        ) : (
          <ul className="space-y-1.5">
            {stats.pending.map(m => {
              const meta = maneuverMeta(m.maneuver_type);
              return (
                <li key={m.burn_id} className="flex items-center gap-2 bg-raised border border-line rounded-md px-2.5 py-1.5">
                  <span className="w-1.5 h-6 rounded-full flex-shrink-0" style={{ background: meta.color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] text-ink truncate">{meta.label} · {m.delta_v_magnitude.toFixed(2)} m/s</span>
                    <span className="block text-[11px] text-muted tabular">
                      {formatUtcTime(m.burnTime)} · in {formatDuration(secondsUntil(m.burnTime, timestamp))}
                    </span>
                  </span>
                  <button
                    onClick={() => cancel(m.burn_id)}
                    disabled={cancelling === m.burn_id}
                    className="text-[12px] text-muted hover:text-crit disabled:opacity-40"
                    title={`Cancel ${m.burn_id}`}
                  >
                    {cancelling === m.burn_id ? '…' : 'Cancel'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {cancelError && <p className="text-[12px] text-crit mt-1">{cancelError}</p>}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Button variant="primary" onClick={() => setModal('burn')} icon={<Rocket className="w-4 h-4" />}>Burn</Button>
        <Button onClick={() => setModal('resources')} icon={<BarChart3 className="w-4 h-4" />}>Fuel</Button>
        <Button onClick={() => setModal('timeline')} icon={<CalendarClock className="w-4 h-4" />}>Plan</Button>
      </div>

      {modal === 'resources' && <ResourcesModal satelliteId={sat.id} onClose={() => setModal(null)} />}
      {modal === 'timeline' && <ManeuverTimeline satelliteId={sat.id} onClose={() => setModal(null)} />}
      {modal === 'burn' && <ManualBurnModal satelliteId={sat.id} onClose={() => setModal(null)} />}
    </div>
  );
};

/** Bullseye: radius = time to closest approach, angle = approach direction in the satellite's T-N plane. */
const ConjunctionBullseye: React.FC = () => {
  const selectedId = useOrbitalStore(s => s.selectedSatelliteId);
  const conjunctions = useOrbitalStore(s => s.conjunctions);
  const timestamp = useOrbitalStore(s => s.timestamp);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);

  const items = useMemo(() => conjunctions
    .filter((c: Conjunction) => (c.status === 'ACTIVE' || c.status === 'MITIGATED') && (!selectedId || c.satellite_id === selectedId))
    .map(c => ({ ...c, eta: secondsUntil(c.tca, timestamp) }))
    .filter(c => c.eta > 0)
    .sort((a, b) => a.eta - b.eta), [conjunctions, selectedId, timestamp]);

  const size = 232;
  const c = size / 2;
  const R = c - 22;
  const maxT = BULLSEYE_RINGS_S[BULLSEYE_RINGS_S.length - 1];
  // square-root scale gives the near-term rings more room
  const radius = (t: number) => Math.sqrt(Math.min(t, maxT) / maxT) * R;

  return (
    <div className="px-4 pb-4">
      <div className="flex justify-center">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Conjunction bullseye">
          {BULLSEYE_RINGS_S.map(t => (
            <g key={t}>
              <circle cx={c} cy={c} r={radius(t)} fill="none" stroke="#2a3542" strokeDasharray={t === maxT ? undefined : '3 4'} />
              <text x={c + radius(t) * Math.SQRT1_2 + 3} y={c - radius(t) * Math.SQRT1_2 - 3} fontSize="10" fill="#6b7886"
                fontFamily="JetBrains Mono, monospace">{formatDuration(t)}</text>
            </g>
          ))}
          <line x1={c} y1={c - R} x2={c} y2={c + R} stroke="#1f2833" />
          <line x1={c - R} y1={c} x2={c + R} y2={c} stroke="#1f2833" />
          {([['Ahead', c, c - R - 8], ['Behind', c, c + R + 16], ['+N', c + R + 12, c + 4], ['−N', c - R - 12, c + 4]] as const).map(([l, x, y]) => (
            <text key={l} x={x} y={y} fontSize="10" fill="#9aa8b6" textAnchor="middle" fontWeight="600">{l}</text>
          ))}
          {items.map(item => {
            const a = (item.approach_angle_deg - 90) * Math.PI / 180;   // 0° (from ahead) at the top
            const r = radius(item.eta);
            const color = riskMeta(item.risk).color;
            return (
              <g key={item.cdm_id} style={{ cursor: 'pointer' }} onClick={() => selectSatellite(item.satellite_id)}>
                <title>{`${item.satellite_id} ↔ ${item.object_id}\nmiss ${formatKm(item.miss_distance_km)} in ${formatDuration(item.eta)}\n${CDM_STATUS_META[item.status]?.label}`}</title>
                <circle cx={c + r * Math.cos(a)} cy={c + r * Math.sin(a)} r={item.risk === 'CRITICAL' ? 5.5 : 4} fill={color}
                  stroke={item.status === 'MITIGATED' ? '#e6edf3' : '#07090d'} strokeWidth={item.status === 'MITIGATED' ? 1.5 : 1} />
              </g>
            );
          })}
          <circle cx={c} cy={c} r={5} fill={COLORS.accent} stroke="#07090d" strokeWidth={2} />
          {items.length === 0 && (
            <text x={c} y={c + 28} fontSize="12" fill="#6b7886" textAnchor="middle">
              {selectedId ? 'No predicted conjunctions' : 'Fleet clear'}
            </text>
          )}
        </svg>
      </div>

      {items.length > 0 && (
        <table className="w-full text-[12px] mt-1">
          <thead>
            <tr className="text-muted text-left">
              <th className="font-medium py-1">{selectedId ? 'Object' : 'Satellite'}</th>
              <th className="font-medium py-1 text-right">Miss</th>
              <th className="font-medium py-1 text-right">TCA in</th>
              <th className="font-medium py-1 text-right">Status</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {items.slice(0, 6).map(item => (
              <tr key={item.cdm_id} className="border-t border-line">
                <td className="py-1 text-ink truncate max-w-[88px]">{selectedId ? item.object_id : item.satellite_id}</td>
                <td className="py-1 text-right" style={{ color: riskMeta(item.risk).color }}>{formatKm(item.miss_distance_km)}</td>
                <td className="py-1 text-right text-muted">{formatDuration(item.eta)}</td>
                <td className="py-1 text-right" style={{ color: item.status === 'MITIGATED' ? CDM_STATUS_META.MITIGATED.color : riskMeta(item.risk).color }}>
                  {item.status === 'MITIGATED' ? 'Avoiding' : item.risk === 'CRITICAL' ? 'Act' : 'Watch'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-[11px] text-faint mt-2">
        Distance from centre is time to closest approach; angle is the approach direction. White outline: avoidance planned.
      </p>
    </div>
  );
};

/** Ground-track proximity of tracked objects around the selected satellite (display aid). */
const NearbyObjects: React.FC = () => {
  const sat = useOrbitalStore(selectSelectedSatellite);
  const debris = useOrbitalStore(s => s.debris);
  const nearby = useMemo(() => (sat ? nearbyDebris(sat.lat, sat.lon, debris, RADAR_RANGE_KM, 8) : []),
    [sat?.lat, sat?.lon, debris]);
  if (!sat) return null;
  return (
    <div className="px-4 pb-4">
      {nearby.length === 0 ? (
        <p className="text-[13px] text-muted">No tracked objects within {RADAR_RANGE_KM} km ground distance.</p>
      ) : (
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-muted text-left">
              <th className="font-medium py-1">Object</th>
              <th className="font-medium py-1 text-right">Range</th>
              <th className="font-medium py-1 text-right">Bearing</th>
              <th className="font-medium py-1 text-right">Alt</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {nearby.map(d => (
              <tr key={d.debrisId} className="border-t border-line">
                <td className="py-1 text-ink">{d.debrisId}</td>
                <td className="py-1 text-right text-muted">{d.distanceKm.toFixed(0)} km</td>
                <td className="py-1 text-right text-muted">{d.bearing.toFixed(0)}°</td>
                <td className="py-1 text-right text-muted">{d.altitudeKm.toFixed(0)} km</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export const LeftPanel: React.FC = () => {
  const hasSelection = useOrbitalStore(s => !!s.selectedSatelliteId);
  return (
    <aside className="w-[320px] flex-shrink-0 bg-panel border-r border-line flex flex-col min-h-0 overflow-y-auto">
      <Panel title="Satellite">
        <SatelliteDetails />
      </Panel>
      <Panel title={<span className="inline-flex items-center gap-1.5"><Crosshair className="w-3.5 h-3.5" /> Conjunction bullseye</span>}>
        <ConjunctionBullseye />
      </Panel>
      {hasSelection && (
        <Panel title="Nearby tracked objects" className="border-b-0">
          <NearbyObjects />
        </Panel>
      )}
    </aside>
  );
};

export default LeftPanel;
