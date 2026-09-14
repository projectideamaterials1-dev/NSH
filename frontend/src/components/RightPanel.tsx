// src/components/RightPanel.tsx
// Tabbed operations panel: Fleet · Threats · Alerts · Score.

import React, { useState } from 'react';
import useOrbitalStore, { selectOpenThreatCounts } from '../store/useOrbitalStore';
import { COLORS } from '../lib/format';
import { AlertsPanel } from './AlertsPanel';
import { FleetPanel } from './FleetPanel';
import { ScorecardPanel } from './ScorecardPanel';
import { ThreatsPanel } from './ThreatsPanel';
import { ErrorBoundary } from './ui';

type Tab = 'fleet' | 'threats' | 'alerts' | 'score';

export const RightPanel: React.FC = () => {
  const [tab, setTab] = useState<Tab>('fleet');
  const threats = useOrbitalStore(selectOpenThreatCounts);
  const satCount = useOrbitalStore(s => s.satellites?.length ?? 0);
  const alertCount = useOrbitalStore(s => s.events.filter(e => e.level === 'crit' || e.level === 'warn').length);

  const tabs: { key: Tab; label: string; badge?: number; tone?: string }[] = [
    { key: 'fleet', label: 'Fleet', badge: satCount || undefined },
    { key: 'threats', label: 'Threats', badge: threats.CRITICAL + threats.WARNING || undefined, tone: threats.CRITICAL ? COLORS.crit : COLORS.warn },
    { key: 'alerts', label: 'Alerts', badge: alertCount || undefined, tone: COLORS.warn },
    { key: 'score', label: 'Score' },
  ];

  return (
    <aside className="w-[360px] flex-shrink-0 bg-panel border-l border-line flex flex-col min-h-0">
      <nav className="flex border-b border-line flex-shrink-0" role="tablist">
        {tabs.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 flex items-center justify-center gap-1.5 h-10 text-[13px] border-b-2 -mb-px transition-colors ${
              tab === t.key ? 'text-ink border-accent font-medium' : 'text-muted border-transparent hover:text-ink'
            }`}
          >
            {t.label}
            {t.badge !== undefined && (
              <span className="tabular text-[11px] px-1.5 rounded-full"
                style={{ color: t.tone ?? 'var(--color-muted)', background: `${t.tone ?? '#9aa8b6'}1f` }}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="flex-1 min-h-0">
        <ErrorBoundary name={tabs.find(t => t.key === tab)!.label}>
          {tab === 'fleet' && <FleetPanel />}
          {tab === 'threats' && <ThreatsPanel />}
          {tab === 'alerts' && <AlertsPanel />}
          {tab === 'score' && <ScorecardPanel />}
        </ErrorBoundary>
      </div>
    </aside>
  );
};

export default RightPanel;
