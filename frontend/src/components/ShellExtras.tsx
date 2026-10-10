// src/components/ShellExtras.tsx
// App-shell overlays: keyboard shortcuts (handler + help), the performance HUD and the
// "not certified SSA" notice.

import React, { useEffect, useRef, useState } from 'react';
import { Gauge, ShieldAlert, X } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import { SHORTCUTS, handleShortcut } from '../lib/shortcuts';
import { formatCount } from '../lib/format';
import { Modal } from './ui';

export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { handleShortcut(e); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export const ShortcutsHelp: React.FC = () => {
  const open = useOrbitalStore(s => s.showShortcuts);
  const setOpen = useOrbitalStore(s => s.setShowShortcuts);
  if (!open) return null;
  const groups = [...new Set(SHORTCUTS.map(s => s.group))];
  return (
    <Modal title="Keyboard shortcuts" subtitle="Shortcuts are paused while typing in a field or when a dialog is open" onClose={() => setOpen(false)} width={640}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {groups.map(g => (
          <section key={g}>
            <h4 className="section-title mb-2">{g}</h4>
            <dl className="space-y-1.5">
              {SHORTCUTS.filter(s => s.group === g).map(s => (
                <div key={s.display} className="flex items-center gap-3 text-[13px]">
                  <dt><kbd className="inline-flex min-w-[28px] justify-center px-1.5 py-0.5 rounded border border-line-strong bg-raised tabular text-[12px] text-ink">{s.display}</kbd></dt>
                  <dd className="text-muted">{s.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
};

/** FPS, frame time and data-path timings. Toggle with P. */
export const PerfHud: React.FC = () => {
  const visible = useOrbitalStore(s => s.showPerfHud);
  const toggle = useOrbitalStore(s => s.togglePerfHud);
  const sats = useOrbitalStore(s => s.satellites?.length ?? 0);
  const debris = useOrbitalStore(s => s.debris?.length ?? 0);
  const parseMs = useOrbitalStore(s => s.parseTimeMs);
  const latencyMs = useOrbitalStore(s => s.connectionStatus.latencyMs);
  const screen = useOrbitalStore(s => s.metrics?.last_screen ?? null);
  const [stats, setStats] = useState({ fps: 0, worstMs: 0, avgMs: 0 });
  const frames = useRef<number[]>([]);

  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    let last = performance.now();
    let lastReport = last;
    const loop = (now: number) => {
      frames.current.push(now - last);
      last = now;
      if (now - lastReport >= 500) {
        const f = frames.current;
        const avg = f.reduce((a, b) => a + b, 0) / Math.max(1, f.length);
        setStats({ fps: 1000 / Math.max(avg, 1e-3), worstMs: Math.max(...f), avgMs: avg });
        frames.current = [];
        lastReport = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  if (!visible) return null;
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  const fpsTone = stats.fps >= 50 ? 'text-ok' : stats.fps >= 30 ? 'text-warn' : 'text-crit';
  const rows: [string, string][] = [
    ['Frame time', `${stats.avgMs.toFixed(1)} ms avg · ${stats.worstMs.toFixed(0)} ms worst`],
    ['Objects', `${formatCount(sats)} sats · ${formatCount(debris)} debris`],
    ['Snapshot', `${parseMs?.toFixed(1) ?? '—'} ms parse · ${latencyMs?.toFixed(0) ?? '—'} ms total`],
    ['Last screen', screen ? `${screen.duration_s}s (${screen.engine})` : '—'],
  ];
  if (heap) rows.push(['JS heap', `${(heap / 1048576).toFixed(0)} MB`]);
  return (
    <div className="fixed bottom-20 left-3 z-40 bg-panel/95 border border-line rounded-lg shadow-2xl px-3 py-2 text-[12px] tabular min-w-[230px]"
      role="status" aria-label="Performance overlay">
      <div className="flex items-center gap-2 mb-1">
        <Gauge className="w-4 h-4 text-muted" aria-hidden />
        <span className={`text-[15px] font-semibold ${fpsTone}`}>{stats.fps.toFixed(0)} FPS</span>
        <button className="ml-auto text-faint hover:text-ink" onClick={toggle} aria-label="Hide performance overlay"><X className="w-3.5 h-3.5" /></button>
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3"><span className="text-faint">{k}</span><span className="text-muted">{v}</span></div>
      ))}
    </div>
  );
};

const NOTICE_KEY = 'nsh.ssa-notice-dismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Standing reminder that assessments are simulation-grade, not certified SSA. */
export const CertificationNotice: React.FC = () => {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try { window.localStorage.setItem(NOTICE_KEY, '1'); } catch { /* private mode: dismiss for this session only */ }
  };
  return (
    <div className="flex items-start sm:items-center gap-2.5 px-4 py-1.5 bg-warn/10 border-b border-warn/30 text-[12px] text-ink" role="note">
      <ShieldAlert className="w-4 h-4 text-warn flex-shrink-0 mt-0.5 sm:mt-0" aria-hidden />
      <span className="flex-1">
        <b className="text-warn">Decision support only — not certified SSA.</b>{' '}
        Conjunction and Pc estimates use simulation-grade propagation and a modelled covariance. Confirm against authoritative
        CDMs (e.g. Space-Track) before acting on a real spacecraft.
      </span>
      <button onClick={dismiss} className="text-faint hover:text-ink" aria-label="Dismiss notice"><X className="w-4 h-4" /></button>
    </div>
  );
};
