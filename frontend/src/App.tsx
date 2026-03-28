// src/App.tsx
import React, { useEffect, useState } from 'react';
import { Header } from './components/Header';
import { DashboardLayout } from './components/DashboardLayout';
import { DeckGLMap } from './components/DeckGLMap';
import TelemetryClient from './api/telemetryClient';
import useOrbitalStore, { selectConnectionState } from './store/useOrbitalStore';

const App: React.FC = () => {
  const [isPolling, setIsPolling] = useState(false);
  const connectionState = useOrbitalStore(selectConnectionState);
  const updateTelemetry = useOrbitalStore((state) => state.updateTelemetry);

  useEffect(() => {
    if (isPolling) return;
    const cleanup = TelemetryClient.startPolling((timestamp, satellitesBinary, debrisBinary, metrics) => {
      updateTelemetry(debrisBinary, satellitesBinary, timestamp, metrics.parseTimeMs);
    });
    setIsPolling(true);
    return cleanup;
  }, [isPolling, updateTelemetry]);

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
      <DeckGLMap />
      <DashboardLayout />
    </div>
  );
};

export default App;