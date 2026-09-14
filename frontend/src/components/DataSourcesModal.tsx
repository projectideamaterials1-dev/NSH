// src/components/DataSourcesModal.tsx
// Real-world data: choose CelesTrak sources (operated fleet, tracked debris), load them into the engine,
// control live (real UTC) mode and see element-set freshness and NOAA space weather.

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CloudDownload, Loader2, Radio, RefreshCw, Satellite, Sun } from 'lucide-react';
import useOrbitalStore, { DEFAULT_CATALOG_REQUEST } from '../store/useOrbitalStore';
import type { CatalogLoadRequest, CatalogSource } from '../store/useOrbitalStore';
import { COLORS, formatCount, formatUtcTime } from '../lib/format';
import { Button, Modal } from './ui';

const inputClass = 'tabular h-8 px-2.5 rounded-md bg-raised border border-line text-[13px] text-ink focus:outline-none focus:border-accent';

const SourceList: React.FC<{ sources: CatalogSource[]; selected: string[]; onToggle: (key: string) => void }> = ({ sources, selected, onToggle }) => (
  <div className="grid grid-cols-2 gap-2">
    {sources.map(s => (
      <label key={s.key} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
        selected.includes(s.key) ? 'border-accent/60 bg-accent/10' : 'border-line bg-raised hover:border-line-strong'}`}>
        <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[var(--color-accent)]" checked={selected.includes(s.key)}
          onChange={() => onToggle(s.key)} />
        <span className="min-w-0">
          <span className="flex items-baseline gap-2">
            <span className="text-[13px] text-ink">{s.label}</span>
            {s.cache && <span className="tabular text-[11px] text-faint">{formatCount(s.cache.count)}</span>}
          </span>
          <span className="block text-[11px] text-muted leading-snug mt-0.5">{s.description}</span>
        </span>
      </label>
    ))}
  </div>
);

const SpaceWeatherRow: React.FC = () => {
  const wx = useOrbitalStore(s => s.spaceWeather);
  if (!wx) return <p className="text-[12px] text-faint">Space weather unavailable (NOAA SWPC unreachable).</p>;
  const kpColor = wx.kp === null ? undefined : wx.kp >= 5 ? COLORS.crit : wx.kp >= 4 ? COLORS.warn : COLORS.ok;
  return (
    <div className="grid grid-cols-3 gap-2">
      <div className="bg-raised border border-line rounded-lg px-3 py-2" title={wx.kp_time ? `NOAA planetary Kp, ${formatUtcTime(wx.kp_time)} UTC` : undefined}>
        <div className="text-[11px] text-muted">Geomagnetic Kp</div>
        <div className="tabular text-[14px] font-semibold" style={{ color: kpColor }}>
          {wx.kp?.toFixed(2) ?? '—'} <span className="text-[12px] font-normal text-muted">{wx.kp_level}</span>
        </div>
      </div>
      <div className="bg-raised border border-line rounded-lg px-3 py-2" title="10.7 cm solar radio flux (solar flux units); higher values mean more atmospheric drag in LEO">
        <div className="text-[11px] text-muted">Solar flux F10.7</div>
        <div className="tabular text-[14px] font-semibold text-ink">{wx.f107_sfu?.toFixed(0) ?? '—'} <span className="text-[12px] font-normal text-muted">sfu</span></div>
      </div>
      <div className="bg-raised border border-line rounded-lg px-3 py-2" title="NOAA scales: geomagnetic storms (G), solar radiation storms (S), radio blackouts (R)">
        <div className="text-[11px] text-muted">NOAA scales</div>
        <div className="tabular text-[14px] font-semibold text-ink">
          {wx.scales ? (['G', 'S', 'R'] as const).map(k => (
            <span key={k} className="mr-2" style={{ color: wx.scales![k].scale > 0 ? COLORS.warn : undefined }}>{k}{wx.scales![k].scale}</span>
          )) : '—'}
        </div>
      </div>
    </div>
  );
};

export const DataSourcesModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const status = useOrbitalStore(s => s.realWorld);
  const sources = useOrbitalStore(s => s.catalogSources);
  const fetchCatalogSources = useOrbitalStore(s => s.fetchCatalogSources);
  const loadCatalog = useOrbitalStore(s => s.loadCatalog);
  const refreshCatalog = useOrbitalStore(s => s.refreshCatalog);
  const setLiveMode = useOrbitalStore(s => s.setLiveMode);
  const fetchSpaceWeather = useOrbitalStore(s => s.fetchSpaceWeather);
  const hasData = useOrbitalStore(s => (s.satellites?.length ?? 0) > 0);

  const [draft, setDraft] = useState<CatalogLoadRequest>(() => ({
    ...DEFAULT_CATALOG_REQUEST,
    ...(status?.request ?? {}),
    live: status?.live ?? true,
    replace: true,
  }));
  const [noradText, setNoradText] = useState(() => (status?.request?.norad_ids ?? []).join(', '));
  const [busy, setBusy] = useState<'load' | 'refresh' | 'live' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    fetchCatalogSources();
    fetchSpaceWeather();
  }, [fetchCatalogSources, fetchSpaceWeather]);

  const fleetSources = useMemo(() => (sources ?? []).filter(s => s.role === 'fleet'), [sources]);
  const objectSources = useMemo(() => (sources ?? []).filter(s => s.role === 'objects'), [sources]);

  const noradIds = noradText.split(/[\s,;]+/).filter(Boolean);
  const invalidNorad = noradIds.filter(id => !/^\d{1,9}$/.test(id));
  const canLoad = (draft.fleet.length > 0 || noradIds.length > 0) && invalidNorad.length === 0 && busy === null;

  const toggle = (field: 'fleet' | 'objects') => (key: string) =>
    setDraft(d => ({ ...d, [field]: d[field].includes(key) ? d[field].filter(k => k !== key) : [...d[field], key] }));

  const run = async (kind: 'load' | 'refresh' | 'live', action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  const handleLoad = () => run('load', async () => {
    const loaded = await loadCatalog({ ...draft, norad_ids: noradIds.map(Number) });
    setResult(`Loaded ${formatCount(loaded.satellites)} satellites and ${formatCount(loaded.tracked_objects)} tracked objects` +
      (loaded.live ? ' — live mode on.' : '.'));
  });

  return (
    <Modal
      title="Real-world data"
      subtitle="Live NORAD element sets from CelesTrak, propagated with SGP4 · space weather from NOAA SWPC"
      onClose={onClose}
      width={820}
    >
      <div className="space-y-6">
        {status?.loaded && (
          <section className="rounded-lg border border-line bg-raised/60 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="relative flex w-2.5 h-2.5">
                {status.live && <span className="absolute inline-flex h-full w-full rounded-full bg-ok opacity-60 animate-ping" />}
                <span className={`relative inline-flex w-2.5 h-2.5 rounded-full ${status.live ? 'bg-ok' : 'bg-faint'}`} />
              </span>
              <span className="text-[13px] text-ink font-medium">{status.live ? 'Live — simulation time is real UTC' : 'Loaded — clock paused'}</span>
              <span className="tabular text-[12px] text-muted ml-auto">
                {formatCount(status.satellites)} satellites · {formatCount(status.tracked_objects)} objects
              </span>
            </div>
            <div className="grid grid-cols-3 gap-x-4 gap-y-1 mt-2 text-[12px] text-muted tabular">
              <span title="Age of the NORAD element sets at the current time">
                Element sets: {status.element_age_hours ? `${status.element_age_hours.median.toFixed(0)} h median, ${status.element_age_hours.max.toFixed(0)} h max` : '—'}
              </span>
              <span>Refreshed: {status.last_refresh ? `${formatUtcTime(status.last_refresh)} UTC` : '—'}</span>
              <span>Next refresh: {status.next_refresh ? `${formatUtcTime(status.next_refresh)} UTC` : '—'}</span>
            </div>
            {status.last_error && <p className="text-[12px] text-crit mt-2">Live sync error: {status.last_error}</p>}
            <div className="flex gap-2 mt-3">
              <Button
                variant={status.live ? 'secondary' : 'primary'}
                disabled={busy !== null}
                onClick={() => run('live', () => setLiveMode(!status.live))}
                icon={busy === 'live' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4" />}
              >
                {status.live ? 'Pause live mode' : 'Go live (real UTC)'}
              </Button>
              <Button disabled={busy !== null} onClick={() => run('refresh', refreshCatalog)}
                title="Re-fetch element sets (cached for 2 h to respect CelesTrak's rate limits) and re-anchor objects"
                icon={busy === 'refresh' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}>
                Refresh element sets
              </Button>
            </div>
          </section>
        )}

        <section>
          <h4 className="section-title mb-3 flex items-center gap-2"><Sun className="w-3.5 h-3.5" /> Space weather</h4>
          <SpaceWeatherRow />
        </section>

        <section>
          <h4 className="section-title mb-1 flex items-center gap-2"><Satellite className="w-3.5 h-3.5" /> Operated fleet</h4>
          <p className="text-[12px] text-muted mb-3">
            These satellites get propellant, station-keeping slots, ground-station passes and autopilot avoidance burns.
          </p>
          {sources === null ? <p className="text-[13px] text-muted">Loading sources…</p> : (
            <SourceList sources={fleetSources} selected={draft.fleet} onToggle={toggle('fleet')} />
          )}
          <label className="block mt-3">
            <span className="block text-[13px] text-ink mb-1.5">Extra satellites by NORAD catalog number</span>
            <input value={noradText} onChange={e => setNoradText(e.target.value)} placeholder="e.g. 25544, 48274"
              className={`${inputClass} w-full`} />
            {invalidNorad.length > 0 && <span className="block text-[12px] text-crit mt-1">Not a NORAD number: {invalidNorad.join(', ')}</span>}
          </label>
        </section>

        <section>
          <h4 className="section-title mb-1">Tracked objects (screened for conjunctions)</h4>
          <p className="text-[12px] text-muted mb-3">Real debris fields and recent launches your fleet is screened against.</p>
          {sources !== null && <SourceList sources={objectSources} selected={draft.objects} onToggle={toggle('objects')} />}
        </section>

        <section className="grid grid-cols-2 gap-x-6 gap-y-4">
          <label className="block">
            <span className="block text-[13px] text-ink mb-1.5">Max satellites</span>
            <input type="number" min={1} max={500} value={draft.max_satellites} className={`${inputClass} w-full`}
              onChange={e => setDraft(d => ({ ...d, max_satellites: Math.max(1, Math.min(500, Number(e.target.value) || 1)) }))} />
            <span className="block text-[11px] text-faint mt-1">Newest element sets are kept when a source has more</span>
          </label>
          <label className="block">
            <span className="block text-[13px] text-ink mb-1.5">Max tracked objects</span>
            <input type="number" min={0} max={20000} step={500} value={draft.max_objects} className={`${inputClass} w-full`}
              onChange={e => setDraft(d => ({ ...d, max_objects: Math.max(0, Math.min(20000, Number(e.target.value) || 0)) }))} />
            <span className="block text-[11px] text-faint mt-1">More objects make each conjunction screen slower</span>
          </label>
          <label className="flex items-center justify-between bg-raised border border-line rounded-lg px-4 py-3">
            <span>
              <span className="block text-[13px] text-ink">Live mode</span>
              <span className="block text-[12px] text-muted">Keep simulation time locked to real UTC</span>
            </span>
            <input type="checkbox" className="w-4 h-4 accent-[var(--color-accent)]" checked={draft.live}
              onChange={e => setDraft(d => ({ ...d, live: e.target.checked }))} />
          </label>
          <label className="flex items-center justify-between bg-raised border border-line rounded-lg px-4 py-3">
            <span>
              <span className="block text-[13px] text-ink">Replace current objects</span>
              <span className="block text-[12px] text-muted">Resets fuel, burns and mission metrics</span>
            </span>
            <input type="checkbox" className="w-4 h-4 accent-[var(--color-accent)]" checked={draft.replace} disabled={!hasData}
              onChange={e => setDraft(d => ({ ...d, replace: e.target.checked }))} />
          </label>
        </section>

        {status?.warnings && status.warnings.length > 0 && (
          <ul className="space-y-1">
            {status.warnings.map(w => (
              <li key={w} className="flex items-start gap-2 text-[12px] text-warn"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />{w}</li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-line">
          {error && <span className="text-[13px] text-crit mr-auto">{error}</span>}
          {result && !error && <span className="text-[13px] text-ok mr-auto">{result}</span>}
          {busy === 'load' && <span className="text-[13px] text-muted mr-auto">Fetching element sets from CelesTrak…</span>}
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={handleLoad} disabled={!canLoad}
            icon={busy === 'load' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudDownload className="w-4 h-4" />}>
            {busy === 'load' ? 'Loading…' : draft.replace || !hasData ? 'Load real data' : 'Add to current objects'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default DataSourcesModal;
