// src/main.tsx
// Entry point. StrictMode is intentionally not used: its development double-mount
// tears down and recreates the deck.gl WebGL device, which races luma.gl's resize observer.

import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import telemetryClient from './api/telemetryClient';
import useOrbitalStore from './store/useOrbitalStore';

if (import.meta.env.DEV) {
  // Development diagnostics: window.__acm.telemetry.getMetrics(), window.__acm.store.getState()
  (window as any).__acm = { telemetry: telemetryClient, store: useOrbitalStore };
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
