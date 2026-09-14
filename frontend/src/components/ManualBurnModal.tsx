// src/components/ManualBurnModal.tsx
// Operator burn planner: RTN presets or custom components, live dry-run validation, then schedule.

import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Rocket, XCircle } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import type { ManualPlanResult } from '../store/useOrbitalStore';
import { COLORS, formatDuration, formatUtcTime } from '../lib/format';
import { Button, Modal } from './ui';

const PRESETS = [
  { key: 'prograde', label: 'Prograde', axis: 't', sign: 1, hint: 'Raises the opposite side of the orbit' },
  { key: 'retrograde', label: 'Retrograde', axis: 't', sign: -1, hint: 'Lowers the opposite side of the orbit' },
  { key: 'radial-out', label: 'Radial out', axis: 'r', sign: 1, hint: 'Rotates the line of apsides' },
  { key: 'radial-in', label: 'Radial in', axis: 'r', sign: -1, hint: 'Rotates the line of apsides' },
  { key: 'normal', label: 'Normal', axis: 'n', sign: 1, hint: 'Changes inclination / RAAN' },
  { key: 'anti-normal', label: 'Anti-normal', axis: 'n', sign: -1, hint: 'Changes inclination / RAAN' },
] as const;

const Check: React.FC<{ ok: boolean; label: string; detail?: string }> = ({ ok, label, detail }) => (
  <div className="flex items-center gap-2 text-[13px]">
    {ok ? <CheckCircle2 className="w-4 h-4 text-ok flex-shrink-0" /> : <XCircle className="w-4 h-4 text-crit flex-shrink-0" />}
    <span className="text-ink">{label}</span>
    {detail && <span className="ml-auto tabular text-muted">{detail}</span>}
  </div>
);

export const ManualBurnModal: React.FC<{ satelliteId: string; onClose: () => void }> = ({ satelliteId, onClose }) => {
  const planManualBurn = useOrbitalStore(s => s.planManualBurn);
  const config = useOrbitalStore(s => s.config);
  const timestamp = useOrbitalStore(s => s.timestamp);
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['key']>('prograde');
  const [magnitude, setMagnitude] = useState(1.0);
  const [custom, setCustom] = useState({ r: 0, t: 1, n: 0 });
  const [offset, setOffset] = useState(60);
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
                {PRESETS.map(p => (
                  <button
                    key={p.key}
                    onClick={() => setPreset(p.key)}
                    title={p.hint}
                    className={`h-9 rounded-md border text-[13px] transition-colors ${
                      preset === p.key ? 'border-accent bg-accent/15 text-ink' : 'border-line bg-raised text-muted hover:text-ink'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <label className="block">
                <span className="flex justify-between text-[13px] mb-1.5">
                  <span className="text-ink">Δv magnitude</span>
                  <span className="tabular text-accent">{magnitude.toFixed(2)} m/s</span>
                </span>
                <input type="range" min={0.01} max={maxDv} step={0.01} value={magnitude}
                  onChange={e => setMagnitude(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
                <span className="flex justify-between text-[11px] text-faint tabular"><span>0</span><span>limit {maxDv} m/s</span></span>
              </label>
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

          <label className="block">
            <span className="flex justify-between text-[13px] mb-1.5">
              <span className="text-ink">Execute in</span>
              <span className="tabular text-muted">{formatDuration(offset)}{burnTime ? ` · ${formatUtcTime(burnTime)} UTC` : ''}</span>
            </span>
            <input type="range" min={10} max={5400} step={10} value={offset}
              onChange={e => setOffset(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
          </label>

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
