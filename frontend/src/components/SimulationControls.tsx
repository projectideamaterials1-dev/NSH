// src/components/SimulationControls.tsx
// Bottom command bar: run / pause / step / speed, replay scrubber, fleet timeline and CSV export.

import React, { useState } from 'react';
import { AlertTriangle, CalendarClock, Database, Download, History, Loader2, Pause, Play, Radio, SkipForward } from 'lucide-react';
import useOrbitalStore from '../store/useOrbitalStore';
import { formatUtcTime } from '../lib/format';
import { Button } from './ui';
import { ManeuverTimeline } from './ManeuverTimeline';

const SPEEDS = [1, 10, 60, 600] as const;
const MANUAL_STEP_SECONDS = 60;

function downloadSatelliteCsv() {
  const { satellites, timestamp, satelliteDetails } = useOrbitalStore.getState();
  if (!satellites || satellites.length === 0) return;

  const rows = ['timestamp,satellite_id,lat_deg,lon_deg,alt_km,fuel_kg,status,mode,drift_km,in_contact'];
  for (let i = 0; i < satellites.length; i++) {
    const d = satelliteDetails[satellites.ids[i]];
    rows.push([
      timestamp ?? '',
      satellites.ids[i],
      satellites.positions[i * 3 + 1].toFixed(4),
      satellites.positions[i * 3].toFixed(4),
      d ? d.alt_km.toFixed(2) : '',
      satellites.fuels[i].toFixed(3),
      satellites.statuses[i],
      d?.mode ?? '',
      d ? d.drift_km.toFixed(3) : '',
      d ? String(d.in_contact) : '',
    ].join(','));
  }

  const blob = new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `satellites_${(timestamp ?? 'snapshot').replace(/[:.]/g, '-')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

const LiveToggle: React.FC = () => {
  const realWorld = useOrbitalStore(s => s.realWorld);
  const setLiveMode = useOrbitalStore(s => s.setLiveMode);
  const setDataSourcesOpen = useOrbitalStore(s => s.setDataSourcesOpen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = realWorld?.live ?? false;

  const toggle = async () => {
    if (!realWorld?.loaded && !live) {
      setDataSourcesOpen(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setLiveMode(!live);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 pl-2 min-[1440px]:pl-3 border-l border-line">
      <button
        onClick={toggle}
        disabled={busy}
        aria-pressed={live}
        title={error ?? (live ? 'Live: simulation time follows real UTC. Click to pause.'
          : realWorld?.loaded ? 'Lock simulation time to real UTC' : 'Load real satellites to use live mode')}
        className={`flex items-center gap-1.5 h-8 px-2.5 min-[1440px]:px-3 rounded-md border text-[13px] font-medium whitespace-nowrap transition-colors disabled:opacity-50 ${
          live ? 'border-ok/50 bg-ok/15 text-ok' : error ? 'border-crit/50 text-crit' : 'border-line text-muted hover:text-ink hover:bg-raised'}`}
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (
          <span className="relative flex w-2 h-2">
            {live && <span className="absolute inline-flex h-full w-full rounded-full bg-ok opacity-60 animate-ping" />}
            <span className={`relative inline-flex w-2 h-2 rounded-full ${live ? 'bg-ok' : 'bg-faint'}`} />
          </span>
        )}
        Live<span className="hidden min-[1440px]:inline"> UTC</span>
      </button>
      <Button onClick={() => setDataSourcesOpen(true)} icon={<Database className="w-4 h-4" />} title="Real-world data sources (CelesTrak, NOAA)"
        aria-label="Real-world data sources">
        <span className="hidden min-[1700px]:inline">Data</span>
      </Button>
    </div>
  );
};

const ReplayScrubber: React.FC = () => {
  const history = useOrbitalStore(s => s.history);
  const replayIndex = useOrbitalStore(s => s.replayIndex);
  const setReplayIndex = useOrbitalStore(s => s.setReplayIndex);
  const setRunning = useOrbitalStore(s => s.setSimulationRunning);
  const isRunning = useOrbitalStore(s => s.isSimulationRunning);

  const last = history.length - 1;
  const index = replayIndex ?? last;
  const live = replayIndex === null;
  const frame = history[index];

  return (
    <div className="flex items-center gap-2 flex-1 min-w-[100px] pl-2 min-[1440px]:pl-3 border-l border-line" title="Scrub through recently received snapshots">
      <History className={`w-4 h-4 flex-shrink-0 ${live ? 'text-faint' : 'text-warn'}`} />
      <input
        type="range"
        aria-label="Replay position"
        min={0}
        max={Math.max(0, last)}
        value={Math.max(0, index)}
        disabled={history.length < 2}
        onChange={e => {
          if (isRunning) setRunning(false);
          const v = Number(e.target.value);
          setReplayIndex(v >= last ? null : v);
        }}
        className="flex-1 min-w-0 accent-[var(--color-warn)] disabled:opacity-30"
      />
      <span className="tabular text-[12px] w-[62px] text-right hidden min-[1600px]:inline" style={{ color: live ? 'var(--color-muted)' : 'var(--color-warn)' }}>
        {frame ? formatUtcTime(frame.timestamp) : '--:--:--'}
      </span>
      <button
        onClick={() => setReplayIndex(null)}
        disabled={live}
        className={`flex items-center gap-1 h-7 px-2 rounded-md text-[12px] border transition-colors ${
          live ? 'border-ok/40 text-ok cursor-default' : 'border-line text-ink hover:bg-raised'
        }`}
      >
        <Radio className="w-3.5 h-3.5" /> <span className="hidden min-[1600px]:inline">Live</span>
      </button>
    </div>
  );
};

export const SimulationControls: React.FC = () => {
  const isRunning = useOrbitalStore(s => s.isSimulationRunning);
  const speed = useOrbitalStore(s => s.simulationSpeed);
  const sim = useOrbitalStore(s => s.simulation);
  const hasData = useOrbitalStore(s => (s.satellites?.length ?? 0) > 0);
  const setRunning = useOrbitalStore(s => s.setSimulationRunning);
  const setSpeed = useOrbitalStore(s => s.setSimulationSpeed);
  const stepSimulation = useOrbitalStore(s => s.stepSimulation);
  const live = useOrbitalStore(s => s.realWorld?.live ?? false);
  const [showTimeline, setShowTimeline] = useState(false);
  const liveHint = live ? 'Live mode: the clock follows real UTC (turn off Live UTC to run the simulation)' : undefined;

  return (
    <div className="h-14 flex-shrink-0 flex items-center gap-2 min-[1440px]:gap-3 px-3 min-[1440px]:px-4 bg-panel border-t border-line">
      <Button
        variant="primary"
        className="min-[1440px]:w-[88px]"
        aria-label={isRunning ? 'Pause' : 'Run'}
        onClick={() => setRunning(!isRunning)}
        disabled={!hasData || live}
        title={liveHint}
        icon={isRunning ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
      >
        <span className="hidden min-[1440px]:inline">{isRunning ? 'Pause' : 'Run'}</span>
      </Button>
      <Button
        onClick={() => stepSimulation(MANUAL_STEP_SECONDS)}
        disabled={!hasData || isRunning || live}
        aria-label={`+${MANUAL_STEP_SECONDS} s`}
        icon={<SkipForward className="w-4 h-4" />}
        title={liveHint ?? `Advance the simulation by ${MANUAL_STEP_SECONDS} seconds`}
      >
        <span className="hidden min-[1440px]:inline">+{MANUAL_STEP_SECONDS} s</span>
      </Button>

      <div className="flex items-center gap-2 pl-2 min-[1440px]:pl-3 border-l border-line">
        <span className="text-[12px] text-muted hidden min-[1800px]:inline">Speed</span>
        <div className={`flex rounded-md border border-line overflow-hidden ${live ? 'opacity-40 pointer-events-none' : ''}`}
          role="radiogroup" aria-label="Simulation speed" title={liveHint}>
          {SPEEDS.map(s => (
            <button
              key={s}
              role="radio"
              aria-checked={s === speed}
              onClick={() => setSpeed(s)}
              className={`tabular px-1.5 min-[1440px]:px-2 h-8 text-[12px] transition-colors ${
                s === speed ? 'bg-accent/20 text-accent font-semibold' : 'text-muted hover:text-ink hover:bg-raised'
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      {sim.error ? (
        <span className="flex items-center gap-2 text-crit text-[13px] min-w-0 truncate pl-3 border-l border-line" title={sim.error}>
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> Step failed: {sim.error}
        </span>
      ) : !live && (
        <span className="text-[13px] text-muted whitespace-nowrap pl-3 border-l border-line hidden min-[1800px]:inline">
          {isRunning ? <span className="text-ok font-medium">Running</span> : hasData ? 'Paused' : 'No data'}
        </span>
      )}

      <LiveToggle />

      <ReplayScrubber />

      <Button onClick={() => setShowTimeline(true)} disabled={!hasData} icon={<CalendarClock className="w-4 h-4" />} title="Maneuver timeline"
        aria-label="Maneuver timeline">
        <span className="hidden min-[1700px]:inline">Timeline</span>
      </Button>
      <Button onClick={downloadSatelliteCsv} disabled={!hasData} icon={<Download className="w-4 h-4" />} title="Download current satellite positions as CSV"
        aria-label="Download CSV">
        <span className="hidden min-[1700px]:inline">CSV</span>
      </Button>

      {showTimeline && <ManeuverTimeline satelliteId={useOrbitalStore.getState().selectedSatelliteId} onClose={() => setShowTimeline(false)} />}
    </div>
  );
};

export default SimulationControls;
