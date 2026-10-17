// src/components/RightPanel.tsx
// Tabbed operations panel: Fleet · Threats · Decisions · Alerts · Activity · Score.

import React from 'react';
import useOrbitalStore, { selectOpenThreatCounts, selectPendingProposals } from '../store/useOrbitalStore';
import { COLORS } from '../lib/format';
import { ActivityPanel } from './ActivityPanel';
import { AlertsPanel } from './AlertsPanel';
import { DecisionsPanel } from './DecisionsPanel';
import { FleetPanel } from './FleetPanel';
import { ScorecardPanel } from './ScorecardPanel';
import { ThreatsPanel } from './ThreatsPanel';
import { ErrorBoundary } from './ui';

export type Tab = 'fleet' | 'threats' | 'decisions' | 'alerts' | 'activity' | 'score';

export const RightPanel: React.FC<{ className?: string }> = ({ className = '' }) => {
  const tab = useOrbitalStore(s => s.rightTab);
  const setTab = useOrbitalStore(s => s.setRightTab);
  const pending = useOrbitalStore(selectPendingProposals).length;
  const threats = useOrbitalStore(selectOpenThreatCounts);
  const satCount = useOrbitalStore(s => s.satellites?.length ?? 0);
  const alertCount = useOrbitalStore(s => s.events.filter(e => e.level === 'crit' || e.level === 'warn').length);

  const tabs: { key: Tab; label: string; badge?: number; tone?: string }[] = [
    { key: 'fleet', label: 'Fleet', badge: satCount || undefined },
    { key: 'threats', label: 'Threats', badge: threats.CRITICAL + threats.WARNING || undefined, tone: threats.CRITICAL ? COLORS.crit : COLORS.warn },
    { key: 'decisions', label: 'Decisions', badge: pending || undefined, tone: COLORS.warn },
    { key: 'alerts', label: 'Alerts', badge: alertCount || undefined, tone: COLORS.warn },
    { key: 'activity', label: 'Activity' },
    { key: 'score', label: 'Score' },
  ];

  return (
    <aside className={`w-full lg:w-[360px] flex-shrink-0 bg-panel lg:border-l border-line flex flex-col min-h-0 ${className}`} aria-label="Operations">
      <nav className="relative flex border-b border-line flex-shrink-0" role="tablist">
        {/* One underline that slides to the active tab (tabs are equal width). */}
        <span aria-hidden className="absolute bottom-[-1px] left-0 h-0.5 bg-accent rounded-full transition-transform duration-300 ease-out-quart motion-reduce:transition-none"
          style={{ width: `${100 / tabs.length}%`, transform: `translateX(${tabs.findIndex(t => t.key === tab) * 100}%)` }} />
        {tabs.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            aria-controls={`tab-${t.key}`}
            onClick={() => setTab(t.key)}
            className={`no-press flex-1 basis-0 min-w-0 flex items-center justify-center gap-1 h-10 text-[12.5px] transition-colors duration-200 ${
              tab === t.key ? 'text-ink font-medium' : 'text-muted hover:text-ink hover:bg-raised/50'
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
      <div key={tab} className="flex-1 min-h-0 animate-content-in" role="tabpanel" id={`tab-${tab}`}>
        <ErrorBoundary name={tabs.find(t => t.key === tab)!.label}>
          {tab === 'fleet' && <FleetPanel />}
          {tab === 'threats' && <ThreatsPanel />}
          {tab === 'decisions' && <DecisionsPanel />}
          {tab === 'alerts' && <AlertsPanel />}
          {tab === 'activity' && <ActivityPanel />}
          {tab === 'score' && <ScorecardPanel />}
        </ErrorBoundary>
      </div>
    </aside>
  );
};

export default RightPanel;
