// src/components/SettingsModal.tsx
// Live simulation settings (applied immediately by the backend and persisted to config.json).

import React, { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import type { SimConfigDto } from '../store/useOrbitalStore';
import { Button, Modal } from './ui';

type NumericKey = Exclude<keyof SimConfigDto, 'autopilotEnabled' | 'avoidanceStrategy'>;

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
            <div className="grid grid-cols-2 gap-4">
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
            </div>
          </section>

          {FIELDS.map(group => (
            <section key={group.section}>
              <h4 className="section-title mb-3">{group.section}</h4>
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
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
