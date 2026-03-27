import React, { useEffect } from 'react';
import { Header } from './components/Header';
import { DeckGLMap } from './components/DeckGLMap';
import { DashboardLayout } from './components/DashboardLayout';
import { useOrbitalStore } from './store/useOrbitalStore';

// Ignore benign ResizeObserver errors
if (typeof window !== 'undefined') {
  const resizeObserverErrDiv = document.createElement('div');
  const resizeObserverErr = 'ResizeObserver loop completed with undelivered notifications.';
  window.addEventListener('error', (e) => {
    if (e.message === resizeObserverErr || e.message === 'Script error.') {
      e.stopImmediatePropagation();
    }
  });
}

export default function App() {
  const { startPolling, stopPolling, error, satellites } = useOrbitalStore();

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  return (
    <div className="w-full h-screen bg-gradient-to-br from-[#000000] to-[#1A0000] overflow-hidden flex flex-col font-mono relative text-[#888888]">
      <Header />
      <div className="flex-1 relative">
        <DeckGLMap />
        <DashboardLayout />
      </div>
      
      {/* Loading Overlay */}
      {satellites.length === 0 && !error && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50">
          <div className="flex flex-col items-center space-y-4">
            <div className="w-12 h-12 border-4 border-red-900/50 border-t-[#00FFFF] rounded-full animate-spin shadow-[0_0_15px_rgba(0,255,255,0.5)]"></div>
            <div className="text-[#00FFFF] font-mono text-sm tracking-widest animate-pulse drop-shadow-[0_0_8px_rgba(0,255,255,0.8)]">ESTABLISHING TELEMETRY LINK...</div>
          </div>
        </div>
      )}

      {/* Error Overlay */}
      {error && (
        <div className="absolute top-16 left-1/2 transform -translate-x-1/2 bg-black/80 backdrop-blur-md border border-[#FF0033] text-[#FF0033] px-4 py-2 rounded shadow-[0_0_15px_rgba(255,0,51,0.5)] z-50 font-mono text-sm flex items-center space-x-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <span className="drop-shadow-[0_0_5px_rgba(255,0,51,0.8)]">{error}</span>
        </div>
      )}
    </div>
  );
}
