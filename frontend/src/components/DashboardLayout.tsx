// src/components/DashboardLayout.tsx
// Mission-control layout shell: details panel | map + command bar | tabbed operations panel.
// Below the lg breakpoint the three panes become switchable views (the map stays mounted so the
// WebGL context survives switching).

import React, { useState } from 'react';
import { Map as MapIcon, PanelLeft, PanelRight } from 'lucide-react';
import useOrbitalStore, { selectPendingProposals } from '../store/useOrbitalStore';
import { ConjunctionModal } from './ConjunctionModal';
import { DeckGLMap } from './DeckGLMap';
import { LeftPanel } from './LeftPanel';
import { RightPanel } from './RightPanel';
import { SimulationControls } from './SimulationControls';
import { ErrorBoundary } from './ui';

type Pane = 'map' | 'details' | 'ops';

export const DashboardLayout: React.FC = React.memo(() => {
  const [pane, setPane] = useState<Pane>('map');
  const pending = useOrbitalStore(selectPendingProposals).length;
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
        <div className={`${show('details')} lg:flex flex-1 lg:flex-none min-w-0`}>
          <ErrorBoundary name="Satellite panel"><LeftPanel /></ErrorBoundary>
        </div>
        <main className={`${show('map')} lg:flex flex-1 min-w-0 flex-col`} aria-label="Orbital view" id="main-view" tabIndex={-1}>
          <div className="flex-1 min-h-0">
            <ErrorBoundary name="Map"><DeckGLMap /></ErrorBoundary>
          </div>
          <ErrorBoundary name="Command bar"><SimulationControls /></ErrorBoundary>
        </main>
        <div className={`${show('ops')} lg:flex flex-1 lg:flex-none min-w-0`}>
          <ErrorBoundary name="Operations panel"><RightPanel /></ErrorBoundary>
        </div>
      </div>
      <ConjunctionModal />
    </div>
  );
});

DashboardLayout.displayName = 'DashboardLayout';
export default DashboardLayout;
