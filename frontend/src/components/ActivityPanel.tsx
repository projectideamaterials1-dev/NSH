// src/components/ActivityPanel.tsx
// Catalog activity: maneuvers detected in new element sets over a chosen window (1 h / 6 h / 24 h /
// 48 h) and predicted re-entries, with a watchlist filter.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Star } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import useWatchlist from '../store/watchlist';
import { apiJson } from '../api/http';
import { formatUtcDate, formatUtcTime } from '../lib/format';
import { EmptyState } from './ui';

interface Detection {
  id: string; name: string; norad_id: number; role: 'fleet' | 'object'; kind: string;
  detected_at: string; dv_estimate_mps: number; unexplained_delta_a_km: number; delta_inclination_deg: number;
}
interface Reentry {
  id: string; name: string; norad_id: number; role: 'fleet' | 'object'; lifetime_days: number;
  predicted_reentry: string; window: [string, string]; perigee_alt_km: number; confidence: string;
}

const WINDOWS: [string, number][] = [['1 h', 1], ['6 h', 6], ['24 h', 24], ['48 h', 48]];
const REFRESH_MS = 60_000;

export const StarButton: React.FC<{ id: string; className?: string }> = ({ id, className = '' }) => {
  const on = useWatchlist(s => s.ids.includes(id));
  const toggle = useWatchlist(s => s.toggle);
  return (
    <button onClick={e => { e.stopPropagation(); toggle(id); }} aria-pressed={on}
      aria-label={on ? `Remove ${id} from watchlist` : `Add ${id} to watchlist`} title={on ? 'On your watchlist' : 'Watch this object'}
      className={`flex-shrink-0 ${on ? 'text-warn' : 'text-faint hover:text-ink'} ${className}`}>
      <Star className="w-4 h-4" fill={on ? 'currentColor' : 'none'} aria-hidden />
    </button>
  );
};

export const ActivityPanel: React.FC = () => {
  const [hours, setHours] = useState(24);
  const [watchedOnly, setWatchedOnly] = useState(false);
  const [maneuvers, setManeuvers] = useState<Detection[] | null>(null);
  const [reentries, setReentries] = useState<Reentry[] | null>(null);
  const [loaded, setLoaded] = useState(true);
  const watch = useWatchlist(s => s.ids);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  const satIds = useOrbitalStore(s => s.satellites?.ids);

  const refresh = useCallback(async () => {
    try {
      const status = await apiJson<{ loaded: boolean }>('/api/catalog/status');
      setLoaded(status.loaded);
      if (!status.loaded) return;
      const [m, r] = await Promise.all([
        apiJson<{ maneuvers: Detection[] }>(`/api/catalog/maneuvers?hours=${hours}`),
        apiJson<{ reentries: Reentry[] }>('/api/catalog/reentries?max_days=90'),
      ]);
      setManeuvers(m.maneuvers);
      setReentries(r.reentries);
    } catch {
      setManeuvers(m => m ?? []);
      setReentries(r => r ?? []);
    }
  }, [hours]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const keep = useCallback((id: string) => !watchedOnly || watch.includes(id), [watchedOnly, watch]);
  const shownManeuvers = useMemo(() => (maneuvers ?? []).filter(m => keep(m.id)), [maneuvers, keep]);
  const shownReentries = useMemo(() => (reentries ?? []).filter(r => keep(r.id)), [reentries, keep]);
  const open = (id: string) => { if (satIds?.includes(id)) selectSatellite(id); };

  if (!loaded) {
    return (
      <EmptyState icon={<Activity className="w-6 h-6" />} title="No real catalog loaded">
        Maneuver detection and re-entry predictions work on real element sets. Load a catalog from Data sources.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-3 border-b border-line">
        <div className="flex rounded-md border border-line overflow-hidden text-[12px]" role="radiogroup" aria-label="Time window">
          {WINDOWS.map(([label, h]) => (
            <button key={h} role="radio" aria-checked={hours === h} onClick={() => setHours(h)}
              className={`px-2.5 h-7 ${hours === h ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>{label}</button>
          ))}
        </div>
        <button onClick={() => setWatchedOnly(!watchedOnly)} aria-pressed={watchedOnly}
          className={`ml-auto flex items-center gap-1 h-7 px-2.5 rounded-full border text-[12px] ${watchedOnly ? 'text-ink border-warn/60 bg-warn/10' : 'text-muted border-line'}`}>
          <Star className="w-3.5 h-3.5" fill={watchedOnly ? 'currentColor' : 'none'} aria-hidden /> Watchlist ({watch.length})
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <h3 className="section-title px-4 pt-3 pb-1">Maneuvers detected · last {hours} h</h3>
        {maneuvers === null ? <p className="px-4 text-[12px] text-faint">Loading…</p> : shownManeuvers.length === 0 ? (
          <p className="px-4 pb-2 text-[12px] text-muted">None{watchedOnly ? ' on your watchlist' : ''}. New element sets are compared every catalog refresh (~2 h).</p>
        ) : (
          <ol>
            {shownManeuvers.map((m, i) => (
              <li key={`${m.id}-${m.detected_at}-${i}`} onClick={() => open(m.id)}
                className="flex items-start gap-2 px-4 py-2 border-b border-line/60 cursor-pointer hover:bg-raised/50">
                <StarButton id={m.id} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] text-ink truncate">{m.name}</span>
                    <span className="text-[11px] text-faint">{m.role === 'fleet' ? 'satellite' : 'tracked'}</span>
                    <span className="ml-auto text-[11px] text-muted tabular">{formatUtcTime(m.detected_at)}</span>
                  </div>
                  <div className="text-[12px] text-muted tabular">
                    {m.kind} · ≈{m.dv_estimate_mps} m/s · Δa {m.unexplained_delta_a_km >= 0 ? '+' : ''}{(m.unexplained_delta_a_km * 1000).toFixed(0)} m
                    {Math.abs(m.delta_inclination_deg) >= 0.001 ? ` · Δi ${m.delta_inclination_deg.toFixed(3)}°` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}

        <h3 className="section-title px-4 pt-4 pb-1">Predicted re-entries · next 90 days</h3>
        {reentries === null ? <p className="px-4 text-[12px] text-faint">Loading…</p> : shownReentries.length === 0 ? (
          <p className="px-4 pb-3 text-[12px] text-muted">None{watchedOnly ? ' on your watchlist' : ''} in the loaded catalog.</p>
        ) : (
          <ol>
            {shownReentries.map(r => (
              <li key={r.id} onClick={() => open(r.id)}
                className="flex items-start gap-2 px-4 py-2 border-b border-line/60 cursor-pointer hover:bg-raised/50">
                <StarButton id={r.id} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] text-ink truncate">{r.name}</span>
                    <span className="ml-auto text-[12px] tabular" style={{ color: r.lifetime_days < 7 ? 'var(--color-crit)' : r.lifetime_days < 30 ? 'var(--color-warn)' : 'var(--color-muted)' }}>
                      {r.lifetime_days < 2 ? `${Math.round(r.lifetime_days * 24)} h` : `${r.lifetime_days.toFixed(0)} d`}
                    </span>
                  </div>
                  <div className="text-[12px] text-muted tabular">
                    {formatUtcDate(r.window[0])} – {formatUtcDate(r.window[1])} · perigee {r.perigee_alt_km.toFixed(0)} km
                    {r.confidence !== 'nominal' ? ` · ${r.confidence}` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="px-4 py-3 text-[11px] text-faint">
          Maneuvers: semi-major-axis jumps drag can't explain (&gt; 100 m) or inclination jumps between element sets.
          Re-entries: lifetime from the object's observed decay through the engine's atmosphere, ±25 %.
        </p>
      </div>
    </div>
  );
};

export default ActivityPanel;
