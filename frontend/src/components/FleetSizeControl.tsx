// src/components/FleetSizeControl.tsx
// Grow or shrink the loaded real-world fleet in place (POST /api/catalog/resize): satellites that
// stay keep their orbit, fuel, burns and history; new ones come from the loaded CelesTrak sources.

import React, { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import { Button } from './ui';

const MAX_SATELLITES = 500;   // backend limit (realworld/live.py MAX_SATELLITES)

export const FleetSizeControl: React.FC = () => {
  const realWorld = useOrbitalStore(s => s.realWorld);
  const resizeFleet = useOrbitalStore(s => s.resizeFleet);
  const current = realWorld?.satellites ?? 0;
  // Upper bound for the slider: everything the selected fleet sources published (before stale/duplicate filtering).
  const available = Math.min(MAX_SATELLITES, Math.max(current,
    (realWorld?.request?.fleet ?? []).reduce((sum, key) => sum + (realWorld?.sources[key]?.count ?? 0), 0)
    + (realWorld?.request?.norad_ids?.length ?? 0)));
  const [target, setTarget] = useState(current);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'crit'; text: string } | null>(null);

  useEffect(() => { if (!busy) setTarget(current); }, [current, busy]);

  if (!realWorld?.loaded) return null;

  const apply = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await resizeFleet(target);
      const parts = [r.added.length && `${r.added.length} added`, r.removed.length && `${r.removed.length} removed`].filter(Boolean);
      setMessage(r.warnings.length
        ? { tone: 'warn', text: r.warnings.join(' · ') }
        : { tone: 'ok', text: `${parts.join(', ') || 'No change'} — everything else kept` });
    } catch (err) {
      setMessage({ tone: 'crit', text: err instanceof Error ? err.message : 'Resize failed' });
    } finally {
      setBusy(false);
    }
  };

  const clamp = (v: number) => Math.max(1, Math.min(available, Math.round(v) || 1));

  return (
    <div className="px-4 py-2.5 border-b border-line space-y-1.5">
      <div className="flex items-center gap-2">
        <label htmlFor="fleet-size" className="text-[12px] text-muted whitespace-nowrap">Fleet size</label>
        <input
          type="range" min={1} max={available} value={Math.min(target, available)} disabled={busy}
          onChange={e => setTarget(clamp(Number(e.target.value)))}
          className="flex-1 min-w-0 accent-[var(--color-accent)]" aria-label="Fleet size slider"
        />
        <input
          id="fleet-size" type="number" min={1} max={available} value={target} disabled={busy}
          onChange={e => setTarget(clamp(Number(e.target.value)))}
          onKeyDown={e => e.key === 'Enter' && target !== current && apply()}
          className="w-14 h-7 px-1.5 rounded-md bg-raised border border-line text-[13px] tabular text-ink text-right focus:outline-none focus:border-accent"
        />
        <Button variant={target !== current ? 'primary' : 'secondary'} className="h-7" disabled={busy || target === current}
          onClick={apply} icon={busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}>
          Apply
        </Button>
      </div>
      <p className={`text-[11px] ${message ? { ok: 'text-ok', warn: 'text-warn', crit: 'text-crit' }[message.tone] : 'text-faint'}`}>
        {message?.text ?? (target === current
          ? `${current} of ~${available} available · resizing keeps fuel, burns and history`
          : target > current
            ? `Adds ${target - current} satellites from ${realWorld.request?.fleet.length ? 'the loaded sources' : 'the catalog'}`
            : `Removes the ${current - target} most recently added satellites`)}
      </p>
    </div>
  );
};

export default FleetSizeControl;
