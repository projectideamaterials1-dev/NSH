// src/App.tsx
import React, { useEffect } from 'react';
import { Header } from './components/Header';
import { DashboardLayout } from './components/DashboardLayout';
import { DeckGLMap } from './components/DeckGLMap';
import useOrbitalStore from './store/useOrbitalStore';

const App: React.FC = () => {
  const startAutoSync = useOrbitalStore(state => state.startAutoSync);
  const stopAutoSync = useOrbitalStore(state => state.stopAutoSync);

  useEffect(() => {
    // Start polling the snapshot endpoint every 2 seconds
    startAutoSync(2000);
    return () => stopAutoSync();
  }, [startAutoSync, stopAutoSync]);

  const connectionState = useOrbitalStore(state => state.connectionStatus.state);

  if (connectionState === 'error') {
    return (
      <div className="min-h-screen bg-void-black flex items-center justify-center">
        <div className="glass-panel border-laser-red p-8 text-center">
          <div className="text-laser-red font-mono text-xl mb-4 animate-pulse">⚠️ TELEMETRY LINK LOST</div>
          <p className="text-muted-gray font-mono text-sm mb-6">Cannot connect to /api/visualization/snapshot</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-laser-red/20 border border-laser-red rounded text-laser-red text-sm font-mono hover:bg-laser-red/30 transition"
          >
            RECONNECT
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-screen bg-void-black overflow-hidden">
      <Header />
      <div className="pt-20 h-full w-full relative">
        <DeckGLMap />
        <DashboardLayout />
      </div>
    </div>
  );
};

export default App;