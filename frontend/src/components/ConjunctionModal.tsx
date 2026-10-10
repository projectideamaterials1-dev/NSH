// src/components/ConjunctionModal.tsx
// Close-up of one conjunction: encounter-plane geometry with the position uncertainty, the
// maneuver trade space (Pc or miss over burn time x delta-v) and the autopilot's reasoning.

import React, { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import type { Conjunction, TradeSpace, TradeSpaceCell } from '../store/useOrbitalStore';
import { CDM_STATUS_META, formatDuration, formatKm, formatPc, formatUtcTime, riskMeta, secondsUntil } from '../lib/format';
import { Modal } from './ui';

// ── colour scales (dark surface) ──────────────────────────────────────────────
// Diverging around the Pc threshold: blue = below (safer), red = above, gray midpoint = at threshold.
const MID = '#383835';
const BLUE_ARM = ['#383835', '#184f95', '#2a78d6', '#6da7ec'];
const RED_ARM = ['#383835', '#8f2f2f', '#c94444', '#e66767'];
// Sequential (miss distance): one hue, brighter = larger miss.
const SEQ = ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef'];

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function ramp(stops: string[], t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  const f = x - i;
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}

const PC_LOW = -4;   // decades below threshold mapped to the blue end
const PC_HIGH = 2;   // decades above threshold mapped to the red end

function pcColor(pc: number, threshold: number): string {
  const d = Math.log10(Math.max(pc, 1e-30) / threshold);
  if (Math.abs(d) < 1e-9) return MID;
  return d < 0 ? ramp(BLUE_ARM, d / PC_LOW) : ramp(RED_ARM, d / PC_HIGH);
}

// ── encounter plane ───────────────────────────────────────────────────────────
const EncounterPlane: React.FC<{ c: Conjunction }> = ({ c }) => {
  const plane = c.encounter_plane;
  if (!plane) {
    return <p className="text-[13px] text-muted">No encounter-plane geometry for this prediction (older screen).</p>;
  }
  const size = 300;
  const half = size / 2 - 18;
  const hbr = (c.hbr_m ?? 20) / 1000;
  const extent = Math.max(3.2 * plane.sigma_major_km, Math.abs(plane.miss_x_km) * 1.25, (c.safe_miss_km ?? 0) * 1.1, hbr * 4, 0.05);
  const k = half / extent;                     // px per km
  const mx = plane.miss_x_km * k;
  const my = -plane.miss_y_km * k;
  const hbrPx = Math.max(2, hbr * k);
  const ticks = niceTicks(extent);

  return (
    <figure className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} role="img"
        aria-label={`Encounter plane: miss ${formatKm(plane.miss_x_km)}, 1-sigma uncertainty ${formatKm(plane.sigma_major_km)} by ${formatKm(plane.sigma_minor_km)}`}
        className="bg-canvas rounded-lg border border-line">
        {ticks.map(t => (
          <g key={t}>
            <line x1={t * k} x2={t * k} y1={-half} y2={half} stroke="var(--color-line)" strokeWidth={1} />
            <line y1={-t * k} y2={-t * k} x1={-half} x2={half} stroke="var(--color-line)" strokeWidth={1} />
          </g>
        ))}
        <line x1={-half} x2={half} y1={0} y2={0} stroke="var(--color-line-strong)" strokeWidth={1} />
        <line y1={-half} y2={half} x1={0} x2={0} stroke="var(--color-line-strong)" strokeWidth={1} />
        {/* 1/2/3-sigma uncertainty ellipses, centred on the predicted miss */}
        {[3, 2, 1].map(s => (
          <ellipse key={s} cx={mx} cy={my} rx={s * plane.sigma_major_km * k} ry={s * plane.sigma_minor_km * k}
            transform={`rotate(${-plane.ellipse_angle_deg} ${mx} ${my})`}
            fill={s === 1 ? 'rgba(77,163,255,0.14)' : 'none'} stroke="var(--color-accent)"
            strokeOpacity={s === 1 ? 0.9 : s === 2 ? 0.55 : 0.3} strokeWidth={s === 1 ? 2 : 1.5}
            strokeDasharray={s === 1 ? undefined : '4 3'} />
        ))}
        {c.safe_miss_km !== undefined && (
          <circle cx={0} cy={0} r={c.safe_miss_km * k} fill="none" stroke="var(--color-ok)" strokeWidth={1.5} strokeDasharray="2 4" />
        )}
        <line x1={0} y1={0} x2={mx} y2={my} stroke="var(--color-ink)" strokeWidth={2} />
        <circle cx={0} cy={0} r={hbrPx} fill="var(--color-crit)" stroke="var(--color-panel)" strokeWidth={2} />
        <circle cx={mx} cy={my} r={4} fill="var(--color-ink)" stroke="var(--color-panel)" strokeWidth={2} />
        <text x={-half + 2} y={half - 4} fontSize={10} fill="var(--color-faint)">grid {formatKm(ticks[1] - ticks[0] || extent)}</text>
        <text x={half - 2} y={-4} fontSize={10} fill="var(--color-faint)" textAnchor="end">x̂ miss</text>
        <text x={4} y={-half + 10} fontSize={10} fill="var(--color-faint)">ŷ</text>
      </svg>
      <figcaption className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-muted w-full max-w-[300px]">
        <Legend swatch={<span className="w-3 h-3 rounded-full bg-crit inline-block" />} label={`Hard body (${c.hbr_m ?? 20} m)`} />
        <Legend swatch={<span className="w-3 h-0.5 bg-ink inline-block" />} label="Predicted miss" />
        <Legend swatch={<span className="w-3 h-3 rounded-full border-2 border-accent inline-block" />} label="1σ / 2σ / 3σ" />
        {c.safe_miss_km !== undefined && (
          <Legend swatch={<span className="w-3 h-3 rounded-full border border-dashed border-ok inline-block" />}
            label={`Safe miss ${formatKm(c.safe_miss_km)}`} />
        )}
      </figcaption>
    </figure>
  );
};

const Legend: React.FC<{ swatch: React.ReactNode; label: string }> = ({ swatch, label }) => (
  <span className="flex items-center gap-1.5">{swatch}{label}</span>
);

function niceTicks(extent: number): number[] {
  const raw = extent / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * pow).find(s => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = -Math.floor(extent / step) * step; t <= extent + 1e-9; t += step) out.push(+t.toFixed(10));
  return out;
}

// ── trade space ───────────────────────────────────────────────────────────────
type Metric = 'pc' | 'miss';

const TradeSpaceView: React.FC<{ cdm: Conjunction }> = ({ cdm }) => {
  const fetchTradeSpace = useOrbitalStore(s => s.fetchTradeSpace);
  const [axis, setAxis] = useState<'T' | 'R' | 'N'>('T');
  const [metric, setMetric] = useState<Metric>('pc');
  const [study, setStudy] = useState<TradeSpace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<TradeSpaceCell | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTradeSpace(cdm.cdm_id, axis)
      .then(s => { if (!cancelled) setStudy(s); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Trade study failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cdm.cdm_id, axis, fetchTradeSpace]);

  const maxMiss = useMemo(() => Math.max(...(study?.grid.map(g => g.miss_km) ?? [1])), [study]);

  const cellW = 36, cellH = 22, gap = 2, left = 64, top = 8, bottom = 34;
  const nx = study?.burn_offsets_s.length ?? 0;
  const ny = study?.dv_mps.length ?? 0;
  const width = left + nx * (cellW + gap);
  const height = top + ny * (cellH + gap) + bottom;
  const tcaOffset = study ? Date.parse(study.tca) / 1000 - Date.parse(study.computed_at) / 1000 : 0;
  const planned = study?.planned_burn;
  // Grid cell(s) nearest the autopilot's first burn (magnitude only: the planner may burn either way).
  const plannedCell = useMemo(() => {
    if (!study || !planned || axis !== 'T') return null;
    const near = (vals: number[], v: number) => vals.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
    return { bo: near(study.burn_offsets_s, planned.burn_offset_s),
             dvAbs: near(study.dv_mps.map(Math.abs), planned.dv_mps) };
  }, [study, planned, axis]);

  const color = (g: TradeSpaceCell) => (metric === 'pc' ? pcColor(g.pc, study!.pc_threshold) : ramp(SEQ, g.miss_km / maxMiss));
  const axisLabel = { T: 'along-track', R: 'radial', N: 'cross-track' }[axis];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Segmented value={axis} onChange={v => setAxis(v as typeof axis)} label="Burn direction"
          options={[['T', 'Along-track'], ['R', 'Radial'], ['N', 'Cross-track']]} />
        <Segmented value={metric} onChange={v => setMetric(v as Metric)} label="Colour by"
          options={[['pc', 'Pc'], ['miss', 'Miss']]} />
        {loading && <Loader2 className="w-4 h-4 animate-spin text-muted" aria-label="Computing" />}
      </div>
      {error && <p className="text-[13px] text-crit">{error}</p>}
      {study && (
        <>
          <div className="overflow-x-auto">
            <svg width={width} height={height} role="img"
              aria-label={`Trade space: ${metric === 'pc' ? 'probability of collision' : 'miss distance'} for ${axisLabel} burns`}>
              {study.dv_mps.map((dv, j) => (
                <text key={dv} x={left - 8} y={top + (ny - 1 - j) * (cellH + gap) + cellH / 2 + 4} fontSize={11}
                  fill="var(--color-muted)" textAnchor="end" className="tabular">{dv > 0 ? '+' : ''}{dv.toFixed(1)}</text>
              ))}
              {study.burn_offsets_s.map((bo, i) => i % 2 === 0 && (
                <text key={bo} x={left + i * (cellW + gap) + cellW / 2} y={top + ny * (cellH + gap) + 14} fontSize={11}
                  fill="var(--color-muted)" textAnchor="middle" className="tabular">{formatDuration(tcaOffset - bo)}</text>
              ))}
              <text x={left + (nx * (cellW + gap)) / 2} y={height - 4} fontSize={11} fill="var(--color-faint)" textAnchor="middle">
                burn time before TCA
              </text>
              {study.grid.map(g => {
                const i = study.burn_offsets_s.indexOf(g.burn_offset_s);
                const j = study.dv_mps.indexOf(g.dv_mps);
                const x = left + i * (cellW + gap);
                const y = top + (ny - 1 - j) * (cellH + gap);
                const isPlanned = !!plannedCell && g.burn_offset_s === plannedCell.bo &&
                  Math.abs(Math.abs(g.dv_mps) - plannedCell.dvAbs) < 1e-6;
                return (
                  <rect key={`${i}-${j}`} x={x} y={y} width={cellW} height={cellH} rx={3} fill={color(g)}
                    stroke={hover === g ? 'var(--color-ink)' : isPlanned ? 'var(--color-ok)' : 'none'} strokeWidth={2}
                    onMouseEnter={() => setHover(g)} onMouseLeave={() => setHover(null)}>
                    <title>{`Burn ${formatDuration(tcaOffset - g.burn_offset_s)} before TCA, ${g.dv_mps.toFixed(2)} m/s: miss ${formatKm(g.miss_km)}, Pc ${formatPc(g.pc)}, ${g.fuel_kg.toFixed(3)} kg`}</title>
                  </rect>
                );
              })}
            </svg>
          </div>
          <div className="text-[11px] text-faint -mt-1 mb-2">Δv (m/s, {axisLabel})</div>

          <ScaleLegend metric={metric} threshold={study.pc_threshold} maxMiss={maxMiss} />

          <p className="text-[12px] text-muted mt-2 tabular min-h-[18px]" aria-live="polite">
            {hover
              ? `Burn ${formatDuration(tcaOffset - hover.burn_offset_s)} before TCA · ${hover.dv_mps.toFixed(2)} m/s → miss ${formatKm(hover.miss_km)}, Pc ${formatPc(hover.pc)}, ${hover.fuel_kg.toFixed(3)} kg`
              : `No burn: miss ${formatKm(study.baseline.miss_km)}, Pc ${formatPc(study.baseline.pc)}.` +
                (planned ? ` Autopilot's first burn: ${planned.dv_mps.toFixed(2)} m/s, ${formatDuration(tcaOffset - planned.burn_offset_s)} before TCA (green outline, nearest cell).` : '')}
          </p>

          <details className="mt-2 text-[12px]">
            <summary className="cursor-pointer text-muted hover:text-ink">Table view</summary>
            <div className="max-h-48 overflow-y-auto mt-2">
              <table className="w-full tabular">
                <thead className="text-faint text-left">
                  <tr><th className="py-1">Before TCA</th><th>Δv (m/s)</th><th>Miss</th><th>Pc</th><th>Fuel (kg)</th></tr>
                </thead>
                <tbody className="text-muted">
                  {study.grid.map((g, n) => (
                    <tr key={n} className="border-t border-line/50">
                      <td className="py-0.5">{formatDuration(tcaOffset - g.burn_offset_s)}</td>
                      <td>{g.dv_mps.toFixed(2)}</td><td>{formatKm(g.miss_km)}</td><td>{formatPc(g.pc)}</td><td>{g.fuel_kg.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
};

const ScaleLegend: React.FC<{ metric: Metric; threshold: number; maxMiss: number }> = ({ metric, threshold, maxMiss }) => {
  const stops = Array.from({ length: 24 }, (_, i) => i / 23);
  const gradient = metric === 'pc'
    ? stops.map(t => pcColor(threshold * 10 ** (PC_LOW + t * (PC_HIGH - PC_LOW)), threshold))
    : stops.map(t => ramp(SEQ, t));
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted tabular">
      <span>{metric === 'pc' ? formatPc(threshold * 10 ** PC_LOW) : '0 m'}</span>
      <span className="h-2.5 w-40 rounded" style={{ background: `linear-gradient(90deg, ${gradient.join(',')})` }} />
      <span>{metric === 'pc' ? `≥ ${formatPc(threshold * 10 ** PC_HIGH)}` : formatKm(maxMiss)}</span>
      {metric === 'pc' && <span className="text-faint">· gray = threshold {formatPc(threshold)}, red = above</span>}
    </div>
  );
};

const Segmented: React.FC<{ value: string; onChange: (v: string) => void; options: [string, string][]; label: string }> = ({ value, onChange, options, label }) => (
  <div className="flex rounded-md border border-line overflow-hidden text-[12px]" role="radiogroup" aria-label={label}>
    {options.map(([v, text]) => (
      <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)}
        className={`px-2.5 h-7 ${value === v ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>{text}</button>
    ))}
  </div>
);

// ── modal ─────────────────────────────────────────────────────────────────────
export const ConjunctionModal: React.FC = () => {
  const id = useOrbitalStore(s => s.conjunctionDetailId);
  const open = useOrbitalStore(s => s.openConjunction);
  const cdm = useOrbitalStore(s => s.conjunctions.find(c => c.cdm_id === s.conjunctionDetailId) ?? null);
  const timestamp = useOrbitalStore(s => s.timestamp);
  const decisions = useOrbitalStore(s => s.decisions);
  const fetchDecisions = useOrbitalStore(s => s.fetchDecisions);

  useEffect(() => { if (id) fetchDecisions(); }, [id, fetchDecisions]);
  if (!id) return null;
  const close = () => open(null);
  if (!cdm) {
    return <Modal title="Conjunction" onClose={close}><p className="text-[13px] text-muted">This conjunction is no longer open.</p></Modal>;
  }
  const risk = riskMeta(cdm.risk);
  const decision = decisions.find(d => d.cdm_ids?.includes(cdm.cdm_id));
  const stats: [string, string][] = [
    ['Probability of collision', formatPc(cdm.pc)],
    ['Predicted miss', formatKm(cdm.miss_distance_km)],
    ['Time to TCA', formatDuration(secondsUntil(cdm.tca, timestamp))],
    ['Relative speed', `${cdm.relative_velocity_kms.toFixed(2)} km/s`],
    ['Status', CDM_STATUS_META[cdm.status]?.label ?? cdm.status],
    ['Propagator', cdm.propagator ?? 'RK4 + J2'],
  ];

  return (
    <Modal width={980} onClose={close}
      title={<span className="flex items-center gap-2">{cdm.satellite_id} <span className="text-faint">↔</span> {cdm.object_id}
        <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ color: risk.color, background: `${risk.color}1f` }}>{risk.label}</span></span>}
      subtitle={`${cdm.cdm_id} · TCA ${formatUtcTime(cdm.tca)} UTC · Pc uses a modelled covariance, not orbit-determination data`}>
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
        {stats.map(([k, v]) => (
          <div key={k} className="bg-raised border border-line rounded-lg px-3 py-2">
            <dt className="text-[11px] text-faint">{k}</dt>
            <dd className="text-[14px] text-ink tabular font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
        <section>
          <h4 className="section-title mb-2">Encounter plane</h4>
          <EncounterPlane c={cdm} />
        </section>
        <section className="min-w-0">
          <h4 className="section-title mb-2">Maneuver trade space</h4>
          <TradeSpaceView cdm={cdm} />
        </section>
      </div>
      {decision && (
        <section className="mt-5 border-t border-line pt-4">
          <h4 className="section-title mb-2">Autopilot reasoning</h4>
          <p className="text-[13px] text-ink leading-relaxed">{decision.rationale}</p>
        </section>
      )}
    </Modal>
  );
};

export default ConjunctionModal;
