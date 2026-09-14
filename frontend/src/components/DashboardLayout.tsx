// src/components/DashboardLayout.tsx
// Mission-control layout shell: details panel | map + command bar | tabbed operations panel.

import React from 'react';
import { DeckGLMap } from './DeckGLMap';
import { LeftPanel } from './LeftPanel';
import { RightPanel } from './RightPanel';
import { SimulationControls } from './SimulationControls';
import { ErrorBoundary } from './ui';

export const DashboardLayout: React.FC = React.memo(() => (
  <div className="flex-1 min-h-0 flex">
    <ErrorBoundary name="Satellite panel"><LeftPanel /></ErrorBoundary>
    <main className="flex-1 min-w-0 flex flex-col">
      <div className="flex-1 min-h-0">
        <ErrorBoundary name="Map"><DeckGLMap /></ErrorBoundary>
      </div>
      <ErrorBoundary name="Command bar"><SimulationControls /></ErrorBoundary>
    </main>
    <ErrorBoundary name="Operations panel"><RightPanel /></ErrorBoundary>
  </div>
));

DashboardLayout.displayName = 'DashboardLayout';
export default DashboardLayout;
