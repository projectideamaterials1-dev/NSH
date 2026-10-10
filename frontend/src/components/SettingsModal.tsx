// src/components/SettingsModal.tsx
// Live simulation settings (applied immediately by the backend and persisted to config.json).

import React, { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import type { SimConfigDto } from '../store/useOrbitalStore';
import { Button, Modal } from './ui';

type NumericKey = { [K in keyof SimConfigDto]: SimConfigDto[K] extends number ? K : never }[keyof SimConfigDto];
type ToggleKey = 'atmosphericDrag' | 'verifyManeuvers';

const FIELDS: { section: string; items: { key: NumericKey; label: string; unit: string; min: number; max: number; step: number; hint: string }[] }[] = [
  {
    section: 'Spacecraft',
    items: [
      { key: 'dryMass', label: 'Dry mass', unit: 'kg', min: 100, max: 5000, step: 10, hint: 'Used in the Tsiolkovsky fuel model' },
      { key: 'initialFuel', label: 'Initial propellant', unit: 'kg', min: 1, max: 1000, step: 1, hint: 'Applied to newly ingested satellites' },
      { key: 'maxDeltaV', label: 'Max Δv per burn', unit: 'm/s', min: 0.1, max: 100, step: 0.5, hint: 'Burns above this are rejected' },
      { key: 'cooldownSeconds', label: 'Thermal cooldown', unit: 's', min: 0, max: 7200, step: 30, hint: 'Minimum time between burns' },
    ],
  },
  {
    section: 'Operations',
    items: [
      { key: 'stationKeepingRadius', label: 'Station-keeping box', unit: 'km', min: 0.5, max: 100, step: 0.5, hint: 'Uptime counts time inside this radius' },
      { key: 'lowFuelWarning', label: 'Low-fuel alert', unit: 'kg', min: 0, max: 500, step: 0.5, hint: 'Raises a warning event' },
      { key: 'eolFuelThreshold', label: 'End-of-life threshold', unit: 'kg', min: 0, max: 100, step: 0.5, hint: 'Autopilot retires the satellite' },
    ],
  },
  {
    section: 'Conjunction screening',
    items: [
      { key: 'cdmWarningKm', label: 'Warning radius', unit: 'km', min: 0.1, max: 50, step: 0.5, hint: 'Close approaches inside this radius become CDMs' },
      { key: 'cdmHorizonSeconds', label: 'Look-ahead horizon', unit: 's', min: 600, max: 172800, step: 600, hint: 'How far ahead each screen predicts' },
      { key: 'cdmScreenIntervalSeconds', label: 'Screen every', unit: 'sim s', min: 60, max: 86400, step: 60, hint: 'Automatic screening cadence' },
    ],
  },
  {
    section: 'Collision probability',
    items: [
      { key: 'pcManeuverThreshold', label: 'Maneuver threshold (Pc)', unit: '', min: 1e-7, max: 1e-2, step: 1e-5, hint: 'Pc at or above this is CRITICAL and triggers evasion (1e-4 is common)' },
      { key: 'hardBodyRadiusM', label: 'Hard-body radius', unit: 'm', min: 1, max: 200, step: 1, hint: 'Combined size of both objects' },
      { key: 'covarianceScale', label: 'Covariance scale', unit: '×', min: 0.1, max: 10, step: 0.1, hint: 'Multiplier on the modelled position uncertainty' },
    ],
  },
  {
    section: 'Force model',
    items: [
      { key: 'ballisticCoefficient', label: 'Ballistic coefficient', unit: 'm²/kg', min: 0.001, max: 0.2, step: 0.001, hint: 'Cd·A/m for drag (0.01 ≈ a 500 kg smallsat)' },
      { key: 'approvalTimeoutSeconds', label: 'Approval timeout', unit: 'sim s', min: 60, max: 86400, step: 60, hint: 'How long a proposal waits for an operator (approval mode)' },
    ],
  },
];

const TOGGLES: { key: ToggleKey; label: string; hint: string }[] = [
  { key: 'atmosphericDrag', label: 'Atmospheric drag', hint: 'Exponential atmosphere scaled by live NOAA F10.7 / Kp' },
  { key: 'verifyManeuvers', label: 'Verify maneuvers', hint: 'Re-screen post-burn trajectories for secondary conjunctions' },
];

export const SettingsModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const config = useOrbitalStore(s => s.config);
  const autopilot = useOrbitalStore(s => s.autopilot);
  const fetchConfig = useOrbitalStore(s => s.fetchConfig);
  const saveConfig = useOrbitalStore(s => s.saveConfig);
  const [draft, setDraft] = useState<SimConfigDto | null>(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchConfig().then(c => c && setDraft(c));
  }, [fetchConfig]);

  const update = <K extends keyof SimConfigDto>(key: K, value: SimConfigDto[K]) => {
    setDraft(d => (d ? { ...d, [key]: value } : d));
    setSaved(false);
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await saveConfig(draft);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Simulation settings" subtitle="Changes apply immediately and are saved to config.json" onClose={onClose} width={760}>
      {!draft ? (
        <p className="text-[13px] text-muted">Loading configuration… (is the backend running?)</p>
      ) : (
        <div className="space-y-6">
          <section>
            <h4 className="section-title mb-3">Autopilot</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="flex items-center justify-between bg-raised border border-line rounded-lg px-4 py-3">
                <span>
                  <span className="block text-[13px] text-ink">Autonomous avoidance</span>
                  <span className="block text-[12px] text-muted">Plan and schedule burns automatically</span>
                </span>
                <input type="checkbox" className="w-4 h-4 accent-[var(--color-accent)]" checked={draft.autopilotEnabled}
                  onChange={e => update('autopilotEnabled', e.target.checked)} />
              </label>
              <label className="bg-raised border border-line rounded-lg px-4 py-3">
                <span className="block text-[13px] text-ink mb-1.5">Avoidance strategy</span>
                <select value={draft.avoidanceStrategy} onChange={e => update('avoidanceStrategy', e.target.value)}
                  className="w-full h-8 px-2 rounded-md bg-panel border border-line text-[13px] text-ink focus:outline-none focus:border-accent">
                  {(autopilot?.strategies ?? [{ name: 'Auto', description: '' }]).map(s => (
                    <option key={s.name} value={s.name}>{s.name}</option>
                  ))}
                </select>
                <span className="block text-[12px] text-muted mt-1.5">
                  {autopilot?.strategies.find(s => s.name === draft.avoidanceStrategy)?.description}
                </span>
              </label>
              <label className="bg-raised border border-line rounded-lg px-4 py-3">
                <span className="block text-[13px] text-ink mb-1.5">Command authority</span>
                <select value={draft.autopilotMode} onChange={e => update('autopilotMode', e.target.value as SimConfigDto['autopilotMode'])}
                  className="w-full h-8 px-2 rounded-md bg-panel border border-line text-[13px] text-ink focus:outline-none focus:border-accent">
                  <option value="AUTONOMOUS">Autonomous — queue validated burns</option>
                  <option value="APPROVAL">Approval — operator approves each plan</option>
                </select>
                <span className="block text-[12px] text-muted mt-1.5">Approval mode keeps a human in the loop for every burn.</span>
              </label>
              <label className="bg-raised border border-line rounded-lg px-4 py-3">
                <span className="block text-[13px] text-ink mb-1.5">If nobody answers in time</span>
                <select value={draft.approvalTimeoutAction}
                  onChange={e => update('approvalTimeoutAction', e.target.value as SimConfigDto['approvalTimeoutAction'])}
                  disabled={draft.autopilotMode !== 'APPROVAL'}
                  className="w-full h-8 px-2 rounded-md bg-panel border border-line text-[13px] text-ink focus:outline-none focus:border-accent disabled:opacity-50">
                  <option value="DISCARD">Discard and re-plan</option>
                  <option value="EXECUTE">Execute the plan</option>
                </select>
                <span className="block text-[12px] text-muted mt-1.5">Applies after the approval timeout below.</span>
              </label>
              {TOGGLES.map(t => (
                <label key={t.key} className="flex items-center justify-between bg-raised border border-line rounded-lg px-4 py-3">
                  <span>
                    <span className="block text-[13px] text-ink">{t.label}</span>
                    <span className="block text-[12px] text-muted">{t.hint}</span>
                  </span>
                  <input type="checkbox" className="w-4 h-4 accent-[var(--color-accent)]" checked={draft[t.key]}
                    onChange={e => update(t.key, e.target.checked)} />
                </label>
              ))}
            </div>
          </section>

          {FIELDS.map(group => (
            <section key={group.section}>
              <h4 className="section-title mb-3">{group.section}</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                {group.items.map(f => (
                  <label key={f.key} className="block" title={f.hint}>
                    <span className="block text-[13px] text-ink mb-1.5">{f.label}</span>
                    <span className="flex items-center gap-2">
                      <input
                        type="number" min={f.min} max={f.max} step={f.step}
                        value={draft[f.key]}
                        onChange={e => update(f.key, Number(e.target.value))}
                        className="tabular flex-1 h-8 px-2.5 rounded-md bg-raised border border-line text-[13px] text-ink focus:outline-none focus:border-accent"
                      />
                      <span className="text-[12px] text-muted w-12">{f.unit}</span>
                    </span>
                    <span className="block text-[11px] text-faint mt-1">{f.hint}</span>
                  </label>
                ))}
              </div>
            </section>
          ))}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-line">
            {error && <span className="text-[13px] text-crit mr-auto">Not saved: {error}</span>}
            {saved && !error && <span className="text-[13px] text-ok mr-auto">Settings applied.</span>}
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={handleSave} disabled={saving} icon={<Save className="w-4 h-4" />}>
              {saving ? 'Saving…' : 'Apply settings'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
};

export default SettingsModal;
