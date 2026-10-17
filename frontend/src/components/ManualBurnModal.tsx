// src/components/ManualBurnModal.tsx
// Operator burn planner: RTN presets or custom components, live dry-run validation, then schedule.

import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Rocket, XCircle } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import type { ManualPlanResult } from '../store/useOrbitalStore';
import type { GroundPass } from '../store/types';
import { apiJson } from '../api/http';
import { COLORS, formatDuration, formatUtcTime } from '../lib/format';
import { Button, Modal } from './ui';

const PRESETS = [
  { key: 'prograde', label: 'Prograde', axis: 't', sign: 1, hint: 'Raises the opposite side of the orbit',
    detail: 'Fires along the direction of travel, speeding the satellite up. The orbit grows: half an orbit later the satellite is higher, and each lap takes slightly longer. Use it to climb, or to arrive later than a threat.' },
  { key: 'retrograde', label: 'Retrograde', axis: 't', sign: -1, hint: 'Lowers the opposite side of the orbit',
    detail: 'Fires against the direction of travel, slowing the satellite down. The orbit shrinks: half an orbit later the satellite is lower, and each lap takes slightly less time. Use it to descend, de-orbit, or arrive earlier than a threat.' },
  { key: 'radial-out', label: 'Radial out', axis: 'r', sign: 1, hint: 'Rotates the line of apsides',
    detail: 'Fires straight up, away from Earth. The orbit’s high and low points shift around it: a quarter orbit ahead the satellite is higher, a quarter orbit behind it is lower. Average altitude and lap time stay the same.' },
  { key: 'radial-in', label: 'Radial in', axis: 'r', sign: -1, hint: 'Rotates the line of apsides',
    detail: 'Fires straight down, towards Earth. The opposite of radial out: a quarter orbit ahead the satellite is lower, a quarter orbit behind it is higher. Average altitude and lap time stay the same.' },
  { key: 'normal', label: 'Normal', axis: 'n', sign: 1, hint: 'Changes inclination / RAAN',
    detail: 'Fires sideways, out of the orbit plane (towards the orbit’s "north" side). Tilts the orbit instead of resizing it: at an equator crossing it changes the inclination, near the northern- or southernmost point it swings the plane (RAAN). Moves the satellite sideways off its usual ground track.' },
  { key: 'anti-normal', label: 'Anti-normal', axis: 'n', sign: -1, hint: 'Changes inclination / RAAN',
    detail: 'Fires sideways, out of the orbit plane, the opposite way to normal. Tilts the orbit the other way: inclination at an equator crossing, the orientation of the plane (RAAN) near the northern- or southernmost point.' },
] as const;

const Check: React.FC<{ ok: boolean; label: string; detail?: string }> = ({ ok, label, detail }) => (
  <div className="flex items-center gap-2 text-[13px]">
    {ok ? <CheckCircle2 className="w-4 h-4 text-ok flex-shrink-0" /> : <XCircle className="w-4 h-4 text-crit flex-shrink-0" />}
    <span className="text-ink">{label}</span>
    {detail && <span className="ml-auto tabular text-muted">{detail}</span>}
  </div>
);

/** A burn picked elsewhere (a trade-space cell) to start from. */
export interface BurnPrefill { dv: { r: number; t: number; n: number }; offset_s: number; note?: string }

const QUICK_OFFSETS: [string, number][] = [['+5 min', 300], ['+15 min', 900], ['+30 min', 1800], ['+1 h', 3600]];
const QUICK_DV = [0.1, 0.5, 1, 2];

export const ManualBurnModal: React.FC<{ satelliteId: string; onClose: () => void; prefill?: BurnPrefill }> = ({ satelliteId, onClose, prefill }) => {
  const planManualBurn = useOrbitalStore(s => s.planManualBurn);
  const config = useOrbitalStore(s => s.config);
  const timestamp = useOrbitalStore(s => s.timestamp);
  const [mode, setMode] = useState<'preset' | 'custom'>(prefill ? 'custom' : 'preset');
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['key']>('prograde');
  const [magnitude, setMagnitude] = useState(1.0);
  const [custom, setCustom] = useState(prefill?.dv ?? { r: 0, t: 1, n: 0 });
  const [offset, setOffset] = useState(prefill ? Math.max(10, Math.round(prefill.offset_s / 10) * 10) : 60);
  const [passes, setPasses] = useState<GroundPass[] | null>(null);
  const [preview, setPreview] = useState<ManualPlanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scheduled, setScheduled] = useState<ManualPlanResult | null>(null);
  const maxDv = config?.maxDeltaV ?? 15;

  const dv = useMemo(() => {
    if (mode === 'custom') return custom;
    const p = PRESETS.find(p => p.key === preset)!;
    return { r: 0, t: 0, n: 0, [p.axis]: p.sign * magnitude };
  }, [mode, preset, magnitude, custom]);

  const burns = useMemo(() => [{ offset_s: offset, frame: 'RTN' as const, dv_mps: dv }], [offset, dv]);

  // Ground contacts for this satellite, so "next contact" can place the burn where it can be uplinked.
  useEffect(() => {
    let cancelled = false;
    apiJson<{ passes: GroundPass[] }>(`/api/satellites/${encodeURIComponent(satelliteId)}/passes?hours=6`)
      .then(r => { if (!cancelled) setPasses(r.passes); })
      .catch(() => { if (!cancelled) setPasses([]); });
    return () => { cancelled = true; };
  }, [satelliteId]);

  // Commands are uplinked when Schedule is pressed, so what matters is contact NOW (the engine checks it
  // then); the burn itself may fire later, out of contact.
  const contact = useMemo(() => {
    if (!passes || !timestamp) return null;
    const now = Date.parse(timestamp);
    const current = passes.find(p => p.in_progress);
    if (current) return { now: true, station: current.station_name, untilS: (Date.parse(current.end) - now) / 1000 };
    const next = passes.find(p => Date.parse(p.start) > now);
    return next ? { now: false, station: next.station_name, inS: (Date.parse(next.start) - now) / 1000, at: next.start } : { now: false };
  }, [passes, timestamp]);
  const maxOffset = Math.max(5400, offset);

  // Live dry-run preview (debounced)
  useEffect(() => {
    setScheduled(null);
    const handle = setTimeout(async () => {
      try {
        setError(null);
        setPreview(await planManualBurn(satelliteId, burns, true));
      } catch (err) {
        setPreview(null);
        setError(err instanceof Error ? err.message : 'Preview failed');
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [satelliteId, burns, planManualBurn]);

  const schedule = async () => {
    setBusy(true);
    try {
      const result = await planManualBurn(satelliteId, burns, false);
      if (result.scheduled) setScheduled(result);
      else setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scheduling failed');
    } finally {
      setBusy(false);
    }
  };

  const total = Math.hypot(dv.r, dv.t, dv.n);
  const accepted = preview?.status === 'SCHEDULED';
  const reason = preview && !accepted ? preview.status.replace('REJECTED: ', '').replace(/_/g, ' ').toLowerCase() : null;
  const before = preview?.orbit_before;
  const after = preview?.orbit_after;
  const burnTime = timestamp ? new Date(Date.parse(timestamp) + offset * 1000).toISOString() : null;

  return (
    <Modal title={`Plan burn · ${satelliteId}`} subtitle="Impulsive burn in the satellite's local RTN frame (radial, along-track, normal)" onClose={onClose} width={760}>
      <div className="grid grid-cols-[1fr_300px] gap-6">
        <div className="space-y-5">
          <div className="flex rounded-md border border-line overflow-hidden text-[13px] w-fit">
            {(['preset', 'custom'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)} className={`px-3 h-8 ${mode === m ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>
                {m === 'preset' ? 'Direction preset' : 'Custom RTN'}
              </button>
            ))}
          </div>

          {mode === 'preset' ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                {PRESETS.map((p, i) => (
                  <div key={p.key} className="relative group">
                    <button
                      onClick={() => setPreset(p.key)}
                      aria-describedby={`burn-preset-${p.key}`}
                      className={`w-full h-9 rounded-md border text-[13px] transition-colors ${
                        preset === p.key ? 'border-accent bg-accent/15 text-ink' : 'border-line bg-raised text-muted hover:text-ink'
                      }`}
                    >
                      {p.label}
                    </button>
                    {/* Hover / keyboard-focus description; edge columns align to their side so it stays inside the dialog. */}
                    <div id={`burn-preset-${p.key}`} role="tooltip"
                      className={`pointer-events-none absolute top-full z-20 mt-1.5 w-64 rounded-md border border-line bg-panel px-3 py-2 text-[12px] leading-relaxed text-muted shadow-xl
                        invisible opacity-0 translate-y-1 transition-[opacity,transform,visibility] duration-150 ease-out-quart
                        group-hover:visible group-hover:opacity-100 group-hover:translate-y-0 group-hover:delay-300
                        group-has-[:focus-visible]:visible group-has-[:focus-visible]:opacity-100 group-has-[:focus-visible]:translate-y-0
                        ${i % 3 === 0 ? 'left-0' : i % 3 === 2 ? 'right-0' : 'left-1/2 -translate-x-1/2'}`}>
                      <span className="block font-medium text-ink mb-0.5">{p.label}</span>
                      {p.detail}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[12px] text-muted -mt-2">{PRESETS.find(p => p.key === preset)!.hint}.</p>
              <div className="block">
                <span className="flex items-center justify-between gap-2 text-[13px] mb-1.5">
                  <span className="text-ink">Δv magnitude</span>
                  <span className="flex items-center gap-1">
                    {QUICK_DV.filter(v => v <= maxDv).map(v => (
                      <button key={v} onClick={() => setMagnitude(v)}
                        className={`tabular text-[11px] px-1.5 h-6 rounded border ${magnitude === v ? 'border-accent text-ink bg-accent/15' : 'border-line text-muted hover:text-ink'}`}>
                        {v}
                      </button>
                    ))}
                    <input type="number" min={0.01} max={maxDv} step={0.01} value={magnitude} aria-label="Δv magnitude in m/s"
                      onChange={e => setMagnitude(Math.min(maxDv, Math.max(0, Number(e.target.value))))}
                      className="tabular w-20 h-6 px-1.5 rounded bg-raised border border-line text-[12px] text-accent text-right focus:outline-none focus:border-accent" />
                    <span className="text-[12px] text-muted">m/s</span>
                  </span>
                </span>
                <input type="range" min={0.01} max={maxDv} step={0.01} value={magnitude} aria-label="Δv magnitude slider"
                  onChange={e => setMagnitude(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
                <span className="flex justify-between text-[11px] text-faint tabular"><span>0</span><span>limit {maxDv} m/s</span></span>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {([['r', 'Radial'], ['t', 'Along-track'], ['n', 'Normal']] as const).map(([axis, label]) => (
                <label key={axis} className="block">
                  <span className="block text-[13px] text-ink mb-1.5">{label} (m/s)</span>
                  <input type="number" step={0.1} value={custom[axis]}
                    onChange={e => setCustom(c => ({ ...c, [axis]: Number(e.target.value) }))}
                    className="tabular w-full h-8 px-2.5 rounded-md bg-raised border border-line text-[13px] text-ink focus:outline-none focus:border-accent" />
                </label>
              ))}
            </div>
          )}

          <div className="block">
            <span className="flex items-center justify-between gap-2 text-[13px] mb-1.5">
              <span className="text-ink">Execute in</span>
              <span className="tabular text-muted">{formatDuration(offset)}{burnTime ? ` · ${formatUtcTime(burnTime)} UTC` : ''}</span>
            </span>
            <input type="range" min={10} max={maxOffset} step={10} value={offset} aria-label="Time until the burn"
              onChange={e => setOffset(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
            <div className="flex flex-wrap gap-1 mt-1.5">
              {QUICK_OFFSETS.map(([label, s]) => (
                <button key={s} onClick={() => setOffset(s)}
                  className={`text-[11px] px-2 h-6 rounded border ${offset === s ? 'border-accent text-ink bg-accent/15' : 'border-line text-muted hover:text-ink'}`}>
                  {label}
                </button>
              ))}
            </div>
            {contact && (
              <p className={`text-[12px] mt-2 ${contact.now ? 'text-ok' : 'text-warn'}`} aria-live="polite">
                {contact.now
                  ? `In contact with ${contact.station} for ${formatDuration(contact.untilS!)}: the burn can be uplinked now.`
                  : contact.station
                    ? `No ground contact now - commands can't be uplinked until ${contact.station} at ${formatUtcTime(contact.at!)} UTC (in ${formatDuration(contact.inS!)}). Prepare the burn and schedule it then.`
                    : 'No ground contact in the next 6 h.'}
              </p>
            )}
          </div>
          {prefill?.note && <p className="text-[12px] text-muted">{prefill.note}</p>}

          {before && after && (
            <div>
              <h4 className="section-title mb-2">Resulting orbit</h4>
              <table className="w-full text-[13px] tabular">
                <thead>
                  <tr className="text-muted text-left"><th className="font-medium py-1" /><th className="font-medium py-1 text-right">Now</th><th className="font-medium py-1 text-right">After burn</th><th className="font-medium py-1 text-right">Change</th></tr>
                </thead>
                <tbody>
                  {([['Perigee altitude', 'perigee_alt_km', 'km'], ['Apogee altitude', 'apogee_alt_km', 'km'], ['Period', 'period_min', 'min'], ['Inclination', 'inclination_deg', '°']] as const).map(([label, key, unit]) => {
                    const delta = after[key] - before[key];
                    return (
                      <tr key={key} className="border-t border-line">
                        <td className="py-1.5 text-muted">{label}</td>
                        <td className="py-1.5 text-right text-ink">{before[key].toFixed(key === 'inclination_deg' ? 3 : 2)} {unit}</td>
                        <td className="py-1.5 text-right text-ink">{after[key].toFixed(key === 'inclination_deg' ? 3 : 2)} {unit}</td>
                        <td className="py-1.5 text-right" style={{ color: Math.abs(delta) < 1e-3 ? '#6b7886' : COLORS.accent }}>
                          {delta >= 0 ? '+' : ''}{delta.toFixed(key === 'inclination_deg' ? 3 : 2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-raised border border-line rounded-lg p-4 flex flex-col gap-3 h-fit">
          <div>
            <div className="text-[12px] text-muted">Total Δv</div>
            <div className="tabular text-2xl font-semibold" style={{ color: total > maxDv ? COLORS.crit : 'var(--color-ink)' }}>{total.toFixed(2)} m/s</div>
          </div>
          {preview ? (
            <>
              <Check ok={preview.checks.ground_station_los} label="Ground-station contact" />
              <Check ok={preview.checks.max_delta_v} label="Within Δv limit" detail={`≤ ${maxDv} m/s`} />
              <Check ok={preview.checks.cooldown} label="Thermal cooldown clear" />
              <Check ok={preview.checks.fuel} label="Sufficient propellant"
                detail={`${preview.fuel_needed_kg.toFixed(3)} of ${preview.available_fuel_kg.toFixed(2)} kg`} />
              <div className="text-[12px] text-muted tabular">
                Mass after burn: {preview.validation.projected_mass_remaining_kg.toFixed(2)} kg
              </div>
              <div className={`text-[13px] font-medium ${accepted ? 'text-ok' : 'text-crit'}`}>
                {accepted ? 'Ready to schedule' : `Would be rejected: ${reason}`}
                {!accepted && preview.checks.ground_station_los === false && (
                  <span className="block text-[12px] text-muted font-normal mt-1">Wait for the next ground-station pass, or plan from the Plan tab.</span>
                )}
              </div>
            </>
          ) : (
            <p className="text-[13px] text-muted">{error ? <span className="text-crit">{error}</span> : 'Validating…'}</p>
          )}
          {scheduled ? (
            <div className="text-[13px] text-ok">
              Scheduled {scheduled.burns_eci[0]?.burn_id} for {formatUtcTime(scheduled.burns_eci[0]?.burnTime)} UTC.
            </div>
          ) : (
            <Button variant="primary" onClick={schedule} disabled={!accepted || busy || total === 0} icon={<Rocket className="w-4 h-4" />}>
              {busy ? 'Scheduling…' : 'Schedule burn'}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>{scheduled ? 'Done' : 'Cancel'}</Button>
        </div>
      </div>
    </Modal>
  );
};

export default ManualBurnModal;
