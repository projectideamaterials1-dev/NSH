// src/lib/shortcuts.ts
// Global keyboard shortcuts: one table drives both the handler and the help overlay.

import useOrbitalStore from '../store/useOrbitalStore';

export interface Shortcut {
  keys: string[];          // KeyboardEvent.key values (case-insensitive for letters)
  label: string;           // shown in the help overlay
  display: string;         // how the key is drawn
  group: 'Time' | 'View' | 'Panels' | 'Selection' | 'Help';
  run: (e: KeyboardEvent) => void;
}

const store = () => useOrbitalStore.getState();

function scrub(delta: number) {
  const s = store();
  const last = Math.max(0, s.history.length - 1);
  const current = s.predictIndex !== null ? last + 1 + s.predictIndex : s.replayIndex ?? last;
  const next = current + delta;
  if (s.isSimulationRunning) s.setSimulationRunning(false);
  if (next <= last) s.setReplayIndex(next >= last ? null : Math.max(0, next));
  else if (s.prediction) s.setPredictIndex(next - last - 1);
  else s.fetchPrediction().then(() => store().setPredictIndex(next - last - 1));
}

function cycleSatellite(delta: number) {
  const s = store();
  const ids = s.satellites?.ids ?? [];
  if (!ids.length) return;
  const i = s.selectedSatelliteId ? ids.indexOf(s.selectedSatelliteId) : -1;
  s.selectSatellite(ids[(i + delta + ids.length) % ids.length]);
}

export const SHORTCUTS: Shortcut[] = [
  { keys: [' '], display: 'Space', label: 'Run / pause the simulation', group: 'Time',
    run: () => { const s = store(); if (!s.realWorld?.live && s.satellites?.length) s.setSimulationRunning(!s.isSimulationRunning); } },
  { keys: ['.'], display: '.', label: 'Step +60 s', group: 'Time',
    run: () => { const s = store(); if (!s.isSimulationRunning && !s.realWorld?.live) s.stepSimulation(60); } },
  { keys: ['ArrowLeft'], display: '←', label: 'Scrub back one frame (Shift: 10)', group: 'Time', run: e => scrub(e.shiftKey ? -10 : -1) },
  { keys: ['ArrowRight'], display: '→', label: 'Scrub forward one frame, into predictions (Shift: 10)', group: 'Time', run: e => scrub(e.shiftKey ? 10 : 1) },
  { keys: ['l'], display: 'L', label: 'Back to live', group: 'Time', run: () => store().setReplayIndex(null) },
  { keys: ['3'], display: '3', label: '3D Earth', group: 'View', run: () => store().setViewMode('3d') },
  { keys: ['2'], display: '2', label: '2D map', group: 'View', run: () => store().setViewMode('2d') },
  { keys: ['p'], display: 'P', label: 'Performance overlay', group: 'View', run: () => store().togglePerfHud() },
  { keys: ['f'], display: 'F', label: 'Fleet tab', group: 'Panels', run: () => store().setRightTab('fleet') },
  { keys: ['t'], display: 'T', label: 'Threats tab', group: 'Panels', run: () => store().setRightTab('threats') },
  { keys: ['d'], display: 'D', label: 'Decisions & approvals tab', group: 'Panels', run: () => store().setRightTab('decisions') },
  { keys: ['a'], display: 'A', label: 'Alerts tab', group: 'Panels', run: () => store().setRightTab('alerts') },
  { keys: ['s'], display: 'S', label: 'Screen for conjunctions now', group: 'Panels',
    run: () => { const s = store(); if (s.satellites?.length && !s.screening) s.screenNow(); } },
  { keys: ['j'], display: 'J', label: 'Select next satellite', group: 'Selection', run: () => cycleSatellite(1) },
  { keys: ['k'], display: 'K', label: 'Select previous satellite', group: 'Selection', run: () => cycleSatellite(-1) },
  { keys: ['Escape'], display: 'Esc', label: 'Clear selection', group: 'Selection', run: () => store().selectSatellite(null) },
  { keys: ['?'], display: '?', label: 'Show this help', group: 'Help', run: () => store().setShowShortcuts(true) },
];

/** True when the key press belongs to a form control or an open dialog, not the dashboard. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (el.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return type !== 'range' && type !== 'checkbox' && type !== 'radio' && type !== 'button';
  }
  return false;
}

export function handleShortcut(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || isTypingTarget(e.target)) return false;
  if (document.querySelector('[role="dialog"]')) return false;     // dialogs own the keyboard (Esc closes them)
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Arrow keys on a focused slider already scrub it natively.
  if ((key === 'ArrowLeft' || key === 'ArrowRight') && (e.target as HTMLElement | null)?.tagName === 'INPUT') return false;
  const hit = SHORTCUTS.find(s => s.keys.includes(key));
  if (!hit) return false;
  e.preventDefault();
  hit.run(e);
  return true;
}
