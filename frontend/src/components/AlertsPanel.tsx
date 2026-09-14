// src/components/AlertsPanel.tsx
// Scrolling operator event feed with level filters.

import React, { useMemo, useState } from 'react';
import { Bell } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import type { OpsEvent } from '../store/useOrbitalStore';
import { EVENT_LEVEL_META, formatUtcTime } from '../lib/format';
import { EmptyState } from './ui';

const LEVELS = ['crit', 'warn', 'ok', 'info'] as const;

export const AlertsPanel: React.FC = () => {
  const events = useOrbitalStore(s => s.events);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({ crit: true, warn: true, ok: true, info: true });

  const counts = useMemo(() => {
    const c: Record<string, number> = { crit: 0, warn: 0, ok: 0, info: 0 };
    for (const e of events) c[e.level] = (c[e.level] ?? 0) + 1;
    return c;
  }, [events]);

  const visible = useMemo(() => events.filter((e: OpsEvent) => enabled[e.level]).slice().reverse(), [events, enabled]);

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex flex-wrap gap-1.5 px-4 py-3 border-b border-line">
        {LEVELS.map(level => {
          const meta = EVENT_LEVEL_META[level];
          const on = enabled[level];
          return (
            <button
              key={level}
              onClick={() => setEnabled(s => ({ ...s, [level]: !s[level] }))}
              aria-pressed={on}
              className={`flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[12px] transition-colors ${on ? 'text-ink' : 'text-faint border-line'}`}
              style={on ? { borderColor: `${meta.color}66`, background: `${meta.color}14` } : undefined}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: on ? meta.color : 'var(--color-line-strong)' }} />
              {meta.label}
              <span className="tabular text-muted">{counts[level]}</span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {visible.length === 0 ? (
          <EmptyState icon={<Bell className="w-6 h-6" />} title="No alerts">
            Threat detections, burns, fuel and station-keeping events appear here.
          </EmptyState>
        ) : (
          <ol>
            {visible.map(e => {
              const meta = EVENT_LEVEL_META[e.level] ?? EVENT_LEVEL_META.info;
              return (
                <li key={e.id} className="flex gap-3 px-4 py-2.5 border-b border-line/60">
                  <span className="w-1 rounded-full flex-shrink-0" style={{ background: meta.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[11px] text-muted tabular">
                      <span>{e.sim_time ? formatUtcTime(e.sim_time) : '—'}</span>
                      <span className="uppercase tracking-wide">{e.category.replace('_', ' ')}</span>
                      {e.satellite_id && (
                        <button onClick={() => selectSatellite(e.satellite_id)} className="ml-auto text-accent hover:underline">
                          {e.satellite_id}
                        </button>
                      )}
                    </div>
                    <p className="text-[13px] text-ink leading-snug mt-0.5">{e.message}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
};

export default AlertsPanel;
