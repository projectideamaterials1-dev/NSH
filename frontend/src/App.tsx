// src/App.tsx
// Application shell: header, connection banner and the mission-control layout.

import React, { useEffect } from 'react';
import { WifiOff } from 'lucide-react';
import { Header } from './components/Header';
import { DashboardLayout } from './components/DashboardLayout';
import { DataSourcesModal } from './components/DataSourcesModal';
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

  useEffect(() => {
    startAutoSync(2000);
    return () => {
      stopAutoSync();
      useOrbitalStore.getState().setSimulationRunning(false);
    };
  }, [startAutoSync, stopAutoSync]);

  return (
    <div className="h-screen w-screen flex flex-col bg-canvas text-ink overflow-hidden min-w-[1200px]">
      <Header />
      <ConnectionBanner />
      <DashboardLayout />
      {dataSourcesOpen && <DataSourcesModal onClose={() => setDataSourcesOpen(false)} />}
    </div>
  );
};

export default App;
