// src/components/Header.tsx
// Top bar: product, simulation clock, mission KPIs, threat level, autopilot, settings and link status.

import React, { useMemo, useState } from 'react';
import { Bot, Orbit, Settings, ShieldAlert } from 'lucide-react';
import useOrbitalStore, { selectOpenThreatCounts } from '../store/useOrbitalStore';
import { formatCount, formatUtcDate, formatUtcTime, COLORS } from '../lib/format';
import { SettingsModal } from './SettingsModal';
import { Button } from './ui';

const Kpi: React.FC<{ label: string; value: string; tone?: string; hint?: string; className?: string }> = ({ label, value, tone, hint, className = '' }) => (
  <div className={`flex flex-col justify-center px-3.5 border-l border-line h-full min-w-[84px] ${className}`} title={hint}>
    <span className="text-[11px] text-muted leading-none mb-1.5 whitespace-nowrap">{label}</span>
    <span className="tabular text-[16px] font-semibold leading-none whitespace-nowrap" style={{ color: tone ?? 'var(--color-ink)' }}>
      {value}
    </span>
  </div>
);

const LinkStatus: React.FC = () => {
  const { state, latencyMs, error } = useOrbitalStore(s => s.connectionStatus);
  const meta = {
    connected: { color: COLORS.ok, label: 'Live' },
    connecting: { color: COLORS.warn, label: error?.startsWith('Awaiting') ? 'No telemetry' : 'Connecting' },
    disconnected: { color: COLORS.eol, label: 'Offline' },
    error: { color: COLORS.crit, label: 'Link error' },
  }[state];

  return (
    <div className="flex items-center gap-2 px-3.5 border-l border-line h-full" title={error ?? undefined}>
      <span className="relative flex w-2.5 h-2.5">
        {state === 'connected' && (
          <span className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping" style={{ background: meta.color }} />
        )}
        <span className="relative inline-flex w-2.5 h-2.5 rounded-full" style={{ background: meta.color }} />
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-[13px] font-medium whitespace-nowrap" style={{ color: meta.color }}>{meta.label}</span>
        <span className="text-[11px] text-muted tabular">
          {state === 'connected' && latencyMs !== null ? `${Math.round(latencyMs)} ms` : 'backend'}
        </span>
      </div>
    </div>
  );
};

/** Threat level derived from open conjunctions and collisions (successor of the DEFCON badge). */
const ThreatLevel: React.FC = () => {
  const counts = useOrbitalStore(selectOpenThreatCounts);
  const collisions = useOrbitalStore(s => s.metrics?.collisions_detected ?? 0);
  const level = collisions > 0 || counts.CRITICAL > 0
    ? { label: 'Severe', color: COLORS.crit, hint: `${counts.CRITICAL} critical conjunction(s)${collisions ? `, ${collisions} collision(s)` : ''}` }
    : counts.WARNING > 0
      ? { label: 'Elevated', color: COLORS.warn, hint: `${counts.WARNING} conjunction(s) under 1 km` }
      : counts.WATCH > 0
        ? { label: 'Guarded', color: COLORS.accent, hint: `${counts.WATCH} object(s) under 5 km` }
        : { label: 'Low', color: COLORS.ok, hint: 'No predicted conjunctions' };

  return (
    <div className="flex items-center gap-2 px-3.5 border-l border-line h-full" title={level.hint}>
      <ShieldAlert className="w-4 h-4 flex-shrink-0" style={{ color: level.color }} />
      <div className="leading-tight">
        <div className="text-[11px] text-muted whitespace-nowrap">Threat level</div>
        <div className="text-[13px] font-semibold" style={{ color: level.color }}>{level.label}</div>
      </div>
    </div>
  );
};

const AutopilotToggle: React.FC = () => {
  const autopilot = useOrbitalStore(s => s.autopilot);
  const setAutopilot = useOrbitalStore(s => s.setAutopilot);
  const [busy, setBusy] = useState(false);
  const enabled = autopilot?.enabled ?? false;

  const toggle = async () => {
    setBusy(true);
    try {
      await setAutopilot({ enabled: !enabled });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2.5 px-3.5 border-l border-line h-full">
      <Bot className="w-4 h-4 flex-shrink-0" style={{ color: enabled ? COLORS.ok : COLORS.eol }} />
      <div className="leading-tight">
        <div className="text-[11px] text-muted">Autopilot</div>
        <div className="text-[12px] text-ink whitespace-nowrap">{autopilot ? autopilot.strategy : '—'}</div>
      </div>
      <button
        role="switch"
        aria-checked={enabled}
        aria-label="Toggle autopilot"
        disabled={!autopilot || busy}
        onClick={toggle}
        className={`relative w-9 h-5 rounded-full transition-colors disabled:opacity-40 ${enabled ? 'bg-ok' : 'bg-line-strong'}`}
        title={enabled ? 'Autopilot schedules avoidance, recovery and end-of-life burns' : 'Autopilot disabled: threats are only reported'}
      >
        <span className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
};

export const Header: React.FC = () => {
  const timestamp = useOrbitalStore(s => s.timestamp);
  const satellites = useOrbitalStore(s => s.satellites);
  const debrisCount = useOrbitalStore(s => s.debris?.length ?? 0);
  const metrics = useOrbitalStore(s => s.metrics);
  const threats = useOrbitalStore(selectOpenThreatCounts);
  const live = useOrbitalStore(s => s.realWorld?.live ?? false);
  const spaceWeather = useOrbitalStore(s => s.spaceWeather);
  const [showSettings, setShowSettings] = useState(false);

  const fleet = useMemo(() => {
    if (!satellites || satellites.length === 0) return null;
    let fuel = 0;
    for (let i = 0; i < satellites.length; i++) fuel += satellites.fuels[i];
    return { count: satellites.length, avgFuel: fuel / satellites.length };
  }, [satellites]);

  const uptime = metrics?.station_keeping?.time_weighted_uptime_percentage;
  const openThreats = threats.CRITICAL + threats.WARNING;

  return (
    <header className="h-14 flex items-stretch bg-panel border-b border-line flex-shrink-0">
      <div className="flex items-center gap-3 px-4">
        <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center flex-shrink-0">
          <Orbit className="w-[18px] h-[18px] text-accent" />
        </div>
        <div className="leading-tight">
          <h1 className="text-[15px] font-semibold text-ink whitespace-nowrap">Crimson Nebula</h1>
          <p className="text-[11px] text-muted whitespace-nowrap hidden 2xl:block">Autonomous Constellation Manager</p>
        </div>
      </div>

      <div className="flex items-center gap-3 px-4 border-l border-line">
        <div className="leading-tight">
          <div className="text-[11px] whitespace-nowrap flex items-center gap-1.5">
            {live ? (
              <span className="text-ok font-medium flex items-center gap-1.5" title="Live mode: simulation time follows real UTC">
                <span className="w-1.5 h-1.5 rounded-full bg-ok" /> Live · real time (UTC)
              </span>
            ) : <span className="text-muted">Simulation time (UTC)</span>}
          </div>
          <div className="tabular text-[16px] font-semibold text-ink whitespace-nowrap">
            {timestamp ? formatUtcTime(timestamp) : '—'}
            {timestamp && <span className="text-[12px] font-normal text-muted ml-2 hidden xl:inline">{formatUtcDate(timestamp)}</span>}
          </div>
        </div>
      </div>

      <div className="flex-1" />

      <div className="flex items-stretch">
        <Kpi label="Satellites" value={fleet ? formatCount(fleet.count) : '—'} />
        <Kpi label="Debris" value={debrisCount ? formatCount(debrisCount) : '—'} className="hidden min-[1440px]:flex" />
        <Kpi
          label="Threats"
          value={String(openThreats)}
          tone={threats.CRITICAL ? COLORS.crit : threats.WARNING ? COLORS.warn : undefined}
          hint={`${threats.CRITICAL} critical (<100 m), ${threats.WARNING} warning (<1 km), ${threats.WATCH} watch (<5 km)`}
        />
        <Kpi label="Avg fuel" value={fleet ? `${fleet.avgFuel.toFixed(1)} kg` : '—'} className="hidden min-[1440px]:flex" hint="Fleet average propellant" />
        <Kpi
          label="SK uptime"
          value={uptime === undefined ? '—' : `${uptime.toFixed(1)}%`}
          tone={uptime !== undefined && uptime < 95 ? COLORS.warn : undefined}
          hint="Time-weighted share of satellite-time spent inside the station-keeping box"
        />
        <Kpi label="Avoided" value={String(metrics?.collisions_avoided ?? 0)} tone={metrics?.collisions_avoided ? COLORS.ok : undefined}
          hint="Critical/warning conjunctions that passed safely after autopilot action" />
        <Kpi label="Collisions" value={String(metrics?.collisions_detected ?? 0)} tone={metrics?.collisions_detected ? COLORS.crit : undefined} />
        {spaceWeather?.kp != null && (
          <Kpi
            label="Kp index"
            value={spaceWeather.kp.toFixed(1)}
            tone={spaceWeather.kp >= 5 ? COLORS.crit : spaceWeather.kp >= 4 ? COLORS.warn : undefined}
            className="hidden min-[1680px]:flex"
            hint={`NOAA planetary Kp (${spaceWeather.kp_level}); F10.7 ${spaceWeather.f107_sfu ?? '—'} sfu. Geomagnetic storms raise LEO drag and prediction uncertainty.`}
          />
        )}
        <ThreatLevel />
        <AutopilotToggle />
        <div className="flex items-center px-2 border-l border-line">
          <Button variant="ghost" onClick={() => setShowSettings(true)} aria-label="Settings" title="Simulation settings"
            icon={<Settings className="w-4 h-4" />} />
        </div>
        <LinkStatus />
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </header>
  );
};

export default Header;
