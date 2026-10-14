// src/App.tsx
// Application shell: header, connection banner and the mission-control layout.

import React, { useEffect } from 'react';
import { WifiOff } from 'lucide-react';
import { Header } from './components/Header';
import { DashboardLayout } from './components/DashboardLayout';
import { DataSourcesModal } from './components/DataSourcesModal';
import { AssistantPanel } from './components/AssistantPanel';
import { ErrorBoundary } from './components/ui';
import { CertificationNotice, PerfHud, ShortcutsHelp, useKeyboardShortcuts } from './components/ShellExtras';
import useOrbitalStore from './store/useOrbitalStore';

const ConnectionBanner: React.FC = () => {
  const { state, error, consecutiveFailures } = useOrbitalStore(s => s.connectionStatus);
  if (state !== 'error') return null;
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-crit/15 border-b border-crit/40 text-[13px] text-ink">
      <WifiOff className="w-4 h-4 text-crit flex-shrink-0" />
      <span>
        <b className="text-crit">Cannot reach the backend.</b> Start it with{' '}
        <code className="tabular bg-canvas border border-line rounded px-1.5 py-0.5">uvicorn satellite_api.main:app --port 8000</code>
        {' '}— retrying automatically{consecutiveFailures > 1 ? ` (attempt ${consecutiveFailures})` : ''}.
      </span>
      {error && <span className="text-faint ml-auto tabular truncate">{error}</span>}
    </div>
  );
};

const App: React.FC = () => {
  const startAutoSync = useOrbitalStore(s => s.startAutoSync);
  const stopAutoSync = useOrbitalStore(s => s.stopAutoSync);
  const dataSourcesOpen = useOrbitalStore(s => s.dataSourcesOpen);
  const setDataSourcesOpen = useOrbitalStore(s => s.setDataSourcesOpen);
  const fetchPhysics = useOrbitalStore(s => s.fetchPhysics);
  useKeyboardShortcuts();

  useEffect(() => {
    startAutoSync(2000);
    fetchPhysics();
    return () => {
      stopAutoSync();
      useOrbitalStore.getState().setSimulationRunning(false);
    };
  }, [startAutoSync, stopAutoSync, fetchPhysics]);

  return (
    <div className="h-[100dvh] w-screen flex flex-col bg-canvas text-ink overflow-hidden">
      <a href="#main-view" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:px-3 focus:py-2 focus:bg-accent focus:text-[#04121f] focus:rounded-md">Skip to map</a>
      <Header />
      <ConnectionBanner />
      <CertificationNotice />
      <DashboardLayout />
      <ErrorBoundary name="Assistant"><AssistantPanel /></ErrorBoundary>
      {dataSourcesOpen && <DataSourcesModal onClose={() => setDataSourcesOpen(false)} />}
      <ShortcutsHelp />
      <PerfHud />
    </div>
  );
};

export default App;
