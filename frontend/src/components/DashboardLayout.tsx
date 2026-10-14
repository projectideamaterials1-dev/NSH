// src/components/DashboardLayout.tsx
// Mission-control layout shell: details panel | map + command bar | tabbed operations panel.
// Below the lg breakpoint the three panes become switchable views (the map stays mounted so the
// WebGL context survives switching). On lg and up each side panel collapses to a thin rail.

import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Map as MapIcon, PanelLeft, PanelRight } from 'lucide-react';
import useOrbitalStore, { selectPendingProposals } from '../store/useOrbitalStore';
import useLayoutStore, { type Side } from '../store/layout';
import { ConjunctionModal } from './ConjunctionModal';
import { DeckGLMap } from './DeckGLMap';
import { LeftPanel } from './LeftPanel';
import { RightPanel } from './RightPanel';
import { SimulationControls } from './SimulationControls';
import { ErrorBoundary } from './ui';

type Pane = 'map' | 'details' | 'ops';

/** The strip between a side panel and the map: collapses the panel, or stands in for it while collapsed. */
const Rail: React.FC<{ side: Side; label: string; badge?: number }> = ({ side, label, badge }) => {
  const collapsed = useLayoutStore(s => s.collapsed[side]);
  const toggle = useLayoutStore(s => s.togglePanel);
  const pointsLeft = (side === 'left') !== collapsed;
  const Icon = pointsLeft ? ChevronLeft : ChevronRight;
  return (
    <div className={`hidden lg:flex flex-col items-center flex-shrink-0 bg-panel border-line ${side === 'left' ? 'border-r' : 'border-l'}
      ${collapsed ? 'w-9' : 'w-4 hover:w-6 transition-[width]'}`}>
      <button onClick={() => toggle(side)} aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label} panel`} title={`${collapsed ? 'Show' : 'Hide'} ${label} panel ([ / ])`}
        className="w-full h-10 flex items-center justify-center text-muted hover:text-ink hover:bg-raised border-b border-line">
        <Icon className="w-4 h-4" aria-hidden />
      </button>
      {collapsed && (
        <button onClick={() => toggle(side)} tabIndex={-1} aria-hidden
          className="flex-1 w-full flex flex-col items-center gap-2 pt-3 text-[12px] text-muted hover:text-ink hover:bg-raised">
          <span className="[writing-mode:vertical-rl] rotate-180 tracking-wide">{label}</span>
          {!!badge && <span className="tabular text-[11px] px-1.5 rounded-full text-warn bg-warn/15">{badge}</span>}
        </button>
      )}
    </div>
  );
};

export const DashboardLayout: React.FC = React.memo(() => {
  const [pane, setPane] = useState<Pane>('map');
  const pending = useOrbitalStore(selectPendingProposals).length;
  const collapsed = useLayoutStore(s => s.collapsed);
  const show = (p: Pane) => (pane === p ? 'flex' : 'hidden');

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <nav className="lg:hidden flex border-b border-line bg-panel flex-shrink-0" role="tablist" aria-label="Dashboard views">
        {([['details', PanelLeft, 'Satellite'], ['map', MapIcon, 'Map'], ['ops', PanelRight, 'Operations']] as const).map(([key, Icon, label]) => (
          <button key={key} role="tab" aria-selected={pane === key} onClick={() => setPane(key)}
            className={`flex-1 flex items-center justify-center gap-1.5 h-10 text-[13px] border-b-2 -mb-px ${
              pane === key ? 'text-ink border-accent' : 'text-muted border-transparent'}`}>
            <Icon className="w-4 h-4" aria-hidden /> {label}
            {key === 'ops' && pending > 0 && <span className="tabular text-[11px] px-1.5 rounded-full text-warn bg-warn/15">{pending}</span>}
          </button>
        ))}
      </nav>
      <div className="flex-1 min-h-0 flex">
        <div className={`${show('details')} ${collapsed.left ? 'lg:hidden' : 'lg:flex'} flex-1 lg:flex-none min-w-0`}>
          <ErrorBoundary name="Satellite panel"><LeftPanel /></ErrorBoundary>
        </div>
        <Rail side="left" label="Satellite" />
        <main className={`${show('map')} lg:flex flex-1 min-w-0 flex-col`} aria-label="Orbital view" id="main-view" tabIndex={-1}>
          <div className="flex-1 min-h-0">
            <ErrorBoundary name="Map"><DeckGLMap /></ErrorBoundary>
          </div>
          <ErrorBoundary name="Command bar"><SimulationControls /></ErrorBoundary>
        </main>
        <Rail side="right" label="Operations" badge={pending} />
        <div className={`${show('ops')} ${collapsed.right ? 'lg:hidden' : 'lg:flex'} flex-1 lg:flex-none min-w-0`}>
          <ErrorBoundary name="Operations panel"><RightPanel /></ErrorBoundary>
        </div>
      </div>
      <ConjunctionModal />
    </div>
  );
});

DashboardLayout.displayName = 'DashboardLayout';
export default DashboardLayout;
