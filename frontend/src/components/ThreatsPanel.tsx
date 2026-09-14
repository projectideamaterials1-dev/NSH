// src/components/ThreatsPanel.tsx
// Fleet-wide predicted conjunctions (CDMs) with risk, time to closest approach and response status.

import React, { useMemo, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import type { Conjunction } from '../store/useOrbitalStore';
import { CDM_STATUS_META, formatDuration, formatKm, formatUtcTime, riskMeta, secondsUntil } from '../lib/format';
import { Button, EmptyState } from './ui';

const RISK_ORDER: Record<string, number> = { CRITICAL: 0, WARNING: 1, WATCH: 2 };

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

  const rows = useMemo(() => {
    const list = conjunctions.filter((c: Conjunction) => filter === 'all' || c.risk !== 'WATCH');
    return list.sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.tca_ts - b.tca_ts);
  }, [conjunctions, filter]);
  const watchCount = conjunctions.filter(c => c.risk === 'WATCH').length;

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
        <div className="flex rounded-md border border-line overflow-hidden text-[12px]">
          <button onClick={() => setFilter('actionable')} className={`px-2.5 h-8 ${filter === 'actionable' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>
            Under 1 km
          </button>
          <button onClick={() => setFilter('all')} className={`px-2.5 h-8 ${filter === 'all' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>
            All ({conjunctions.length})
          </button>
        </div>
        <div className="flex-1" />
        <Button onClick={() => screenNow()} disabled={!hasData || screening}
          icon={<RefreshCw className={`w-4 h-4 ${screening ? 'animate-spin' : ''}`} />} title="Run conjunction screening now">
          {screening ? 'Screening…' : 'Screen now'}
        </Button>
      </div>

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
            {rows.map(c => {
              const risk = riskMeta(c.risk);
              // Autopilot acts on predicted misses under 150 m; wider conjunctions are monitored, not flagged as open failures.
              const status = c.status === 'ACTIVE' && c.miss_distance_km > 0.15
                ? { label: 'Monitoring', color: '#9aa8b6' }
                : CDM_STATUS_META[c.status] ?? { label: c.status, color: '#9aa8b6' };
              const eta = secondsUntil(c.tca, timestamp);
              const selected = c.satellite_id === selectedId;
              return (
                <li key={c.cdm_id}>
                  <button
                    onClick={() => selectSatellite(c.satellite_id)}
                    className={`w-full text-left px-4 py-2.5 border-b border-line/60 transition-colors ${selected ? 'bg-accent/10' : 'hover:bg-raised'}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ color: risk.color, background: `${risk.color}1f` }}>
                        {risk.label}
                      </span>
                      <span className="tabular text-[13px] text-ink">{c.satellite_id}</span>
                      <span className="text-faint text-[12px]">↔</span>
                      <span className="tabular text-[13px] text-muted truncate">{c.object_id}</span>
                      <span className="ml-auto tabular text-[13px] font-semibold" style={{ color: risk.color }}>{formatKm(c.miss_distance_km)}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[12px] text-muted tabular">
                      <span>TCA {formatUtcTime(c.tca)}</span>
                      <span className="text-faint">·</span>
                      <span className={eta < 600 ? 'text-warn' : ''}>in {formatDuration(eta)}</span>
                      <span className="text-faint">·</span>
                      <span>{c.relative_velocity_kms.toFixed(1)} km/s</span>
                      <span className="ml-auto" style={{ color: status.color }}>{status.label}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default ThreatsPanel;
