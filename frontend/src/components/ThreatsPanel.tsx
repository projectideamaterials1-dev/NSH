// src/components/ThreatsPanel.tsx
// Fleet-wide predicted conjunctions (CDMs) with risk, time to closest approach and response status.

import React, { useEffect, useMemo, useState } from 'react';
import { Crosshair, FileUp, RefreshCw, ShieldCheck } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import type { Conjunction } from '../store/useOrbitalStore';
import { CDM_STATUS_META, formatDuration, formatKm, formatPc, formatUtcTime, needsAction, riskMeta, secondsUntil } from '../lib/format';
import { Button, EmptyState } from './ui';

const RISK_ORDER: Record<string, number> = { CRITICAL: 0, WARNING: 1, WATCH: 2 };

const PAGE = 200;

export const ThreatsPanel: React.FC = () => {
  const conjunctions = useOrbitalStore(s => s.conjunctions);
  const timestamp = useOrbitalStore(s => s.timestamp);
  const selectedId = useOrbitalStore(s => s.selectedSatelliteId);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  const screenNow = useOrbitalStore(s => s.screenNow);
  const screening = useOrbitalStore(s => s.screening);
  const lastScreen = useOrbitalStore(s => s.metrics?.last_screen ?? null);
  const hasData = useOrbitalStore(s => !!s.satellites?.length);
  const [filter, setFilter] = useState<'actionable' | 'all'>('actionable');
  const [limit, setLimit] = useState(PAGE);   // a whole-catalog fleet can have thousands of events
  const openConjunction = useOrbitalStore(s => s.openConjunction);
  const pcThreshold = useOrbitalStore(s => s.config?.pcManeuverThreshold ?? 1e-4);
  const importCdm = useOrbitalStore(s => s.importCdm);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<{ tone: 'ok' | 'warn' | 'crit'; text: string } | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const r = await importCdm(await file.text());
      const cov = r.matched.filter(m => m.has_covariance).length;
      setImportMsg(r.matched.length
        ? { tone: 'ok', text: `${r.matched.length} CDM(s) matched (${cov} with covariance)${r.unmatched.length ? `, ${r.unmatched.length} unmatched` : ''}. Pc updates after the next screen.` }
        : { tone: 'warn', text: `No CDM matched a tracked satellite/object pair (${r.unmatched.length} received).` });
    } catch (e) {
      setImportMsg({ tone: 'crit', text: e instanceof Error ? e.message : 'Import failed' });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const rows = useMemo(() => {
    const list = conjunctions.filter((c: Conjunction) => filter === 'all' || c.risk !== 'WATCH');
    return list.sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.tca_ts - b.tca_ts);
  }, [conjunctions, filter]);
  useEffect(() => setLimit(PAGE), [filter]);
  const watchCount = conjunctions.filter(c => c.risk === 'WATCH').length;

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
        <div className="flex rounded-md border border-line overflow-hidden text-[12px]">
          <button onClick={() => setFilter('actionable')} className={`px-2.5 h-8 ${filter === 'actionable' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>
            Warning+
          </button>
          <button onClick={() => setFilter('all')} className={`px-2.5 h-8 ${filter === 'all' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>
            All ({conjunctions.length})
          </button>
        </div>
        <div className="flex-1" />
        <input ref={fileRef} type="file" accept=".cdm,.kvn,.txt,.json,text/plain,application/json" className="hidden"
          onChange={e => onFile(e.target.files?.[0])} aria-label="CDM file" />
        <Button onClick={() => fileRef.current?.click()} icon={<FileUp className="w-4 h-4" />}
          title="Import CCSDS CDMs (KVN or JSON) or Space-Track cdm_public JSON" aria-label="Import CDM" />
        <Button onClick={() => screenNow()} disabled={!hasData || screening}
          icon={<RefreshCw className={`w-4 h-4 ${screening ? 'animate-spin' : ''}`} />} title="Run conjunction screening now">
          {screening ? 'Screening…' : 'Screen now'}
        </Button>
      </div>

      {importMsg && (
        <div className={`px-4 py-2 text-[12px] border-b border-line/60 ${importMsg.tone === 'ok' ? 'text-ok' : importMsg.tone === 'warn' ? 'text-warn' : 'text-crit'}`}
          role="status">
          {importMsg.text}
        </div>
      )}
      {lastScreen && (
        <div className="px-4 py-2 text-[11px] text-faint border-b border-line/60 tabular">
          Last screen {formatUtcTime(lastScreen.screened_at)} · {formatDuration(lastScreen.horizon_s)} ahead ·
          {' '}{lastScreen.predictions} predictions · {lastScreen.duration_s}s ({lastScreen.engine})
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {rows.length === 0 ? (
          <EmptyState icon={<ShieldCheck className="w-6 h-6" />} title={hasData ? 'No actionable conjunctions' : 'No telemetry yet'}>
            {hasData
              ? filter === 'actionable' && watchCount
                ? `${watchCount} distant object(s) are being watched (1–5 km).`
                : 'Screening runs automatically as simulation time advances.'
              : 'Conjunctions appear once objects are ingested.'}
          </EmptyState>
        ) : (
          <ul>
            {rows.slice(0, limit).map(c => {
              const risk = riskMeta(c.risk);
              // Autopilot acts on misses under 150 m or Pc at/above the threshold; others are monitored, not open failures.
              const status = c.status === 'ACTIVE' && !needsAction(c, pcThreshold)
                ? { label: 'Monitoring', color: '#9aa8b6' }
                : CDM_STATUS_META[c.status] ?? { label: c.status, color: '#9aa8b6' };
              const eta = secondsUntil(c.tca, timestamp);
              const selected = c.satellite_id === selectedId;
              return (
                <li key={c.cdm_id} className={`flex items-stretch border-b border-line/60 transition-colors duration-200 animate-item-in ${selected ? 'bg-accent/10' : 'hover:bg-raised'}`}>
                  <button
                    onClick={() => selectSatellite(c.satellite_id)}
                    className="flex-1 min-w-0 text-left pl-4 pr-2 py-2.5"
                    aria-label={`Select ${c.satellite_id}: ${risk.label} conjunction with ${c.object_id}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ color: risk.color, background: `${risk.color}1f` }}>
                        {risk.label}
                      </span>
                      <span className="tabular text-[13px] text-ink whitespace-nowrap">{c.satellite_id}</span>
                      <span className="text-faint text-[12px]" aria-hidden>↔</span>
                      <span className="tabular text-[13px] text-muted truncate">{c.object_id}</span>
                      <span className="ml-auto tabular text-[13px] font-semibold text-ink whitespace-nowrap">{formatKm(c.miss_distance_km)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 text-[12px] text-muted tabular whitespace-nowrap">
                      <span className={eta < 600 ? 'text-warn' : ''} title={`TCA ${formatUtcTime(c.tca)} UTC`}>TCA in {formatDuration(eta)}</span>
                      <span className="text-faint">·</span>
                      <span title={c.covariance_measured ? `Pc from measured covariance (${c.covariance_model})` : 'Probability of collision (modelled covariance)'}>
                        Pc {formatPc(c.pc)}
                      </span>
                      {c.external && (
                        <span className="text-[10px] font-semibold px-1 rounded border border-accent/50 text-accent"
                          title={`External CDM ${c.external.message_id} (${c.external.originator}): Pc ${formatPc(c.external.pc)}`}>CDM</span>
                      )}
                      <span className="ml-auto truncate min-w-0" style={{ color: status.color }}>{status.label}</span>
                    </div>
                  </button>
                  <button onClick={() => openConjunction(c.cdm_id)} title="Encounter geometry and maneuver trade space"
                    aria-label={`Open details for ${c.cdm_id}`}
                    className="px-3 text-faint hover:text-accent focus-visible:text-accent border-l border-line/60">
                    <Crosshair className="w-4 h-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {rows.length > limit && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-[12px] text-muted">
            <span className="tabular">Showing {limit} of {rows.length} (most urgent first)</span>
            <button onClick={() => setLimit(l => l + PAGE)} className="h-7 px-2.5 rounded-md border border-line text-ink hover:bg-raised">
              Show {Math.min(PAGE, rows.length - limit)} more
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ThreatsPanel;
