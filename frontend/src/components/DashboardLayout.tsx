// src/components/DashboardLayout.tsx
import React, { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { BullseyeRadar } from './BullseyeRadar';
import { ResourceMetrics } from './ResourceMetrics';
import { ManeuverGantt } from './ManeuverGantt';
import useOrbitalStore, {
  selectSelectedSatellite,
  selectSatelliteCount,
  selectDebrisCount,
  selectConnectionState,
} from '../store/useOrbitalStore';
import { Play, Square, Pause, RefreshCw, Activity, AlertTriangle, Satellite, ChevronDown, ChevronUp, Maximize2 } from 'lucide-react';

// ============================================================================
// SIMULATION CONTROL PANEL (Collapsible)
// ============================================================================

const SimulationControlPanel: React.FC<{ expanded: boolean; onToggle: () => void }> = ({ expanded, onToggle }) => {
  const store = useOrbitalStore();
  const simulation = store.simulation;
  const stepSimulation = store.stepSimulation;
  const setSimulationRunning = store.setSimulationRunning;
  const resetSimulation = store.resetSimulation;

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepSeconds = 60;

  const startSimulation = useCallback(() => {
    if (intervalRef.current) return;
    setSimulationRunning(true);
    intervalRef.current = setInterval(() => {
      stepSimulation(stepSeconds).catch(console.error);
    }, stepSeconds * 1000);
  }, [stepSimulation, setSimulationRunning]);

  const pauseSimulation = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setSimulationRunning(false);
  }, [setSimulationRunning]);

  const stopSimulation = useCallback(() => {
    pauseSimulation();
    resetSimulation();
  }, [pauseSimulation, resetSimulation]);

  const resetSim = useCallback(() => {
    pauseSimulation();
    resetSimulation();
  }, [pauseSimulation, resetSimulation]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const progressPercent = useMemo(() => {
    if (simulation.totalSteps === 0) return 0;
    return (simulation.currentStep / simulation.totalSteps) * 100;
  }, [simulation.currentStep, simulation.totalSteps]);

  const statusColor = useMemo(() => {
    switch (simulation.status) {
      case 'running': return '#00FFFF';
      case 'paused': return '#D29922';
      case 'completed': return '#238636';
      case 'error': return '#FF0033';
      default: return '#888888';
    }
  }, [simulation.status]);

  return (
    <div className="glass-panel rounded-lg mb-4 overflow-hidden transition-all duration-300"
      style={{ background: 'rgba(0, 0, 0, 0.60)', backdropFilter: 'blur(12px)', border: `1px solid ${statusColor}40` }}>
      
      {/* Header (always visible) */}
      <div 
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={onToggle}
        style={{ borderBottom: expanded ? `1px solid ${statusColor}30` : 'none' }}
      >
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4" style={{ color: statusColor }} />
          <h2 className="text-xs font-mono font-bold tracking-widest uppercase" style={{ color: statusColor }}>
            SIMULATION CONTROL
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="px-3 py-1 rounded text-[10px] font-mono font-bold animate-pulse"
            style={{ background: `${statusColor}15`, color: statusColor, border: `1px solid ${statusColor}40` }}
          >
            {simulation.status.toUpperCase()}
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-gray" /> : <ChevronDown className="w-4 h-4 text-muted-gray" />}
        </div>
      </div>

      {/* Collapsible content */}
      {expanded && (
        <div className="p-4 pt-2">
          {/* Progress Bar */}
          <div className="mb-4">
            <div className="flex justify-between text-[10px] font-mono mb-1.5">
              <span style={{ color: '#888888' }}>PROGRESS</span>
              <span style={{ color: statusColor }}>
                STEP {simulation.currentStep.toLocaleString()} / {simulation.totalSteps.toLocaleString()}
              </span>
            </div>
            <div className="h-2 bg-black/80 border border-red-900/50 rounded overflow-hidden relative">
              <div
                className="h-full transition-all duration-500 ease-out"
                style={{
                  width: `${progressPercent}%`,
                  backgroundColor: statusColor,
                  boxShadow: `0 0 10px ${statusColor}`,
                }}
              />
            </div>
          </div>

          {/* Buttons */}
          <div className="grid grid-cols-4 gap-2 mb-4">
            <button
              onClick={startSimulation}
              disabled={simulation.status === 'running'}
              className="flex flex-col items-center justify-center p-2 rounded border transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: simulation.status === 'running' ? 'rgba(0, 0, 0, 0.3)' : 'rgba(0, 255, 255, 0.1)',
                borderColor: simulation.status === 'running' ? '#333' : `rgba(0, 255, 255, 0.4)`,
              }}
            >
              <Play className="w-4 h-4 mb-1" style={{ color: '#00FFFF' }} />
              <span className="text-[9px] font-mono" style={{ color: '#00FFFF' }}>START</span>
            </button>
            <button
              onClick={pauseSimulation}
              disabled={simulation.status !== 'running'}
              className="flex flex-col items-center justify-center p-2 rounded border transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: simulation.status !== 'running' ? 'rgba(0, 0, 0, 0.3)' : 'rgba(210, 153, 34, 0.1)',
                borderColor: simulation.status !== 'running' ? '#333' : `rgba(210, 153, 34, 0.4)`,
              }}
            >
              <Pause className="w-4 h-4 mb-1" style={{ color: '#D29922' }} />
              <span className="text-[9px] font-mono" style={{ color: '#D29922' }}>PAUSE</span>
            </button>
            <button
              onClick={stopSimulation}
              disabled={simulation.status === 'idle' || simulation.status === 'completed'}
              className="flex flex-col items-center justify-center p-2 rounded border transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: (simulation.status === 'idle' || simulation.status === 'completed') ? 'rgba(0, 0, 0, 0.3)' : 'rgba(255, 0, 51, 0.1)',
                borderColor: (simulation.status === 'idle' || simulation.status === 'completed') ? '#333' : `rgba(255, 0, 51, 0.4)`,
              }}
            >
              <Square className="w-4 h-4 mb-1" style={{ color: '#FF0033' }} />
              <span className="text-[9px] font-mono" style={{ color: '#FF0033' }}>STOP</span>
            </button>
            <button
              onClick={resetSim}
              className="flex flex-col items-center justify-center p-2 rounded border transition-all"
              style={{ background: 'rgba(0, 0, 0, 0.3)', borderColor: '#88888840' }}
            >
              <RefreshCw className="w-4 h-4 mb-1" style={{ color: '#888888' }} />
              <span className="text-[9px] font-mono" style={{ color: '#888888' }}>RESET</span>
            </button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2 bg-black/40 rounded border border-red-900/20">
              <div className="text-[8px] font-mono text-muted-gray mb-1">MANEUVERS</div>
              <div className="text-plasma-cyan font-mono font-bold text-sm">
                {simulation.maneuversExecuted.toLocaleString()}
              </div>
            </div>
            <div className="p-2 bg-black/40 rounded border border-red-900/20">
              <div className="text-[8px] font-mono text-muted-gray mb-1">COLLISIONS</div>
              <div className={simulation.collisionsDetected > 0 ? 'text-laser-red font-mono font-bold text-sm animate-pulse' : 'text-nominal-green font-mono font-bold text-sm'}>
                {simulation.collisionsDetected.toLocaleString()}
              </div>
            </div>
          </div>

          {simulation.error && (
            <div className="mt-4 p-3 rounded border bg-laser-red/10 border-laser-red/50">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-3 h-3 text-laser-red" />
                <span className="text-[10px] font-mono font-bold text-laser-red">SIMULATION ERROR</span>
              </div>
              <p className="text-[9px] font-mono text-muted-gray">{simulation.error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// SATELLITE INFO PANEL (with Center Map button)
// ============================================================================

const SatelliteInfoPanel: React.FC<{ expanded: boolean; onToggle: () => void }> = ({ expanded, onToggle }) => {
  const selectedSat = useOrbitalStore(selectSelectedSatellite);
  const timestamp = useOrbitalStore(state => state.timestamp);
  const selectSatellite = useOrbitalStore(state => state.selectSatellite);

  const centerMap = useCallback(() => {
    if (selectedSat) {
      selectSatellite(selectedSat.id); // Re-select to trigger fly-to
    }
  }, [selectedSat, selectSatellite]);

  if (!selectedSat) {
    return (
      <div className="glass-panel rounded-lg mb-4 overflow-hidden">
        <div 
          className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-white/5 transition-colors"
          onClick={onToggle}
        >
          <div className="flex items-center gap-2">
            <Satellite className="w-4 h-4 text-muted-gray" />
            <h2 className="text-muted-gray font-mono text-xs tracking-widest uppercase">Target Lock</h2>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-gray" /> : <ChevronDown className="w-4 h-4 text-muted-gray" />}
        </div>
        {expanded && (
          <div className="p-4 text-center">
            <div className="text-muted-gray font-mono text-xs py-8 border border-dashed border-red-900/50 rounded">
              <Satellite className="w-8 h-8 mx-auto mb-2 opacity-30" />
              AWAITING TARGET SELECTION...
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="glass-panel rounded-lg mb-4 overflow-hidden">
      <div 
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2">
          <Satellite className="w-4 h-4 text-plasma-cyan" />
          <h2 className="text-muted-gray font-mono text-xs tracking-widest uppercase">Target Lock</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-plasma-cyan font-mono animate-pulse">LIVE</span>
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-gray" /> : <ChevronDown className="w-4 h-4 text-muted-gray" />}
        </div>
      </div>
      {expanded && (
        <div className="p-4 pt-2">
          <div className="space-y-2 font-mono text-xs">
            <div className="flex justify-between border-b border-red-900/30 pb-1.5">
              <span className="text-[#888888]">ID:</span>
              <span className="text-[#00FFFF] font-bold drop-shadow-[0_0_5px_cyan]">{selectedSat.id}</span>
            </div>
            <div className="flex justify-between border-b border-red-900/30 pb-1.5">
              <span className="text-[#888888]">STATUS:</span>
              <span className={selectedSat.status === 'NOMINAL' ? 'text-[#00FFFF]' : selectedSat.status === 'WARNING' ? 'text-amber' : 'text-laser-red animate-pulse'}>
                {selectedSat.status}
              </span>
            </div>
            <div className="flex justify-between border-b border-red-900/30 pb-1.5">
              <span className="text-[#888888]">FUEL MASS:</span>
              <span className={selectedSat.fuel_kg < 5 ? 'text-laser-red font-bold' : selectedSat.fuel_kg < 15 ? 'text-amber' : 'text-white'}>
                {selectedSat.fuel_kg.toFixed(3)} kg
              </span>
            </div>
            <div className="flex justify-between border-b border-red-900/30 pb-1.5">
              <span className="text-[#888888]">LATITUDE:</span>
              <span className="text-white">{selectedSat.lat.toFixed(6)}°</span>
            </div>
            <div className="flex justify-between border-b border-red-900/30 pb-1.5">
              <span className="text-[#888888]">LONGITUDE:</span>
              <span className="text-white">{selectedSat.lon.toFixed(6)}°</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#888888]">ALTITUDE:</span>
              <span className="text-white">{((selectedSat.alt ?? 400000) / 1000).toFixed(1)} km</span>
            </div>
            {timestamp && (
              <div className="pt-2 text-[9px] text-muted-gray border-t border-red-900/30">
                LAST UPDATE: {new Date(timestamp).toISOString().split('T')[1].split('.')[0]}Z
              </div>
            )}
          </div>
          <button
            onClick={centerMap}
            className="mt-3 w-full py-1.5 text-[10px] font-mono text-plasma-cyan border border-plasma-cyan/40 rounded bg-plasma-cyan/10 hover:bg-plasma-cyan/20 transition-colors flex items-center justify-center gap-1"
          >
            <Maximize2 className="w-3 h-3" />
            CENTER MAP
          </button>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// COLLAPSIBLE WRAPPER FOR OTHER SECTIONS
// ============================================================================

const CollapsibleSection: React.FC<{
  title: string;
  icon: React.ElementType;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  badge?: React.ReactNode;
}> = ({ title, icon: Icon, expanded, onToggle, children, badge }) => {
  return (
    <div className="glass-panel rounded-lg mb-4 overflow-hidden">
      <div 
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-plasma-cyan" />
          <h2 className="text-muted-gray font-mono text-xs tracking-widest uppercase">{title}</h2>
          {badge && <div className="ml-2">{badge}</div>}
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-gray" /> : <ChevronDown className="w-4 h-4 text-muted-gray" />}
      </div>
      {expanded && <div className="p-4 pt-2">{children}</div>}
    </div>
  );
};

// ============================================================================
// REAL FPS MONITOR (if we want it in dashboard)
// ============================================================================

const FPSMonitor: React.FC = () => {
  const [fps, setFps] = useState(60);
  const frames = useRef(0);
  const prevTime = useRef(performance.now());
  const requestRef = useRef<number>(0);

  useEffect(() => {
    const calcFPS = () => {
      const time = performance.now();
      frames.current += 1;
      if (time - prevTime.current >= 1000) {
        setFps(Math.round((frames.current * 1000) / (time - prevTime.current)));
        frames.current = 0;
        prevTime.current = time;
      }
      requestRef.current = requestAnimationFrame(calcFPS);
    };
    requestRef.current = requestAnimationFrame(calcFPS);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  const color = fps >= 50 ? '#00FFFF' : fps >= 30 ? '#D29922' : '#FF0033';
  return (
    <div className="flex items-center gap-1 text-[9px] font-mono">
      <span className="text-muted-gray">FPS:</span>
      <span style={{ color }}>{fps}</span>
    </div>
  );
};

// ============================================================================
// MAIN DASHBOARD LAYOUT (with expandable sections)
// ============================================================================

export const DashboardLayout: React.FC = React.memo(() => {
  const store = useOrbitalStore();
  const satelliteCount = useMemo(() => selectSatelliteCount(store), [store]);
  const debrisCount = useMemo(() => selectDebrisCount(store), [store]);
  const connectionState = useMemo(() => selectConnectionState(store), [store]);

  // Section expansion states
  const [simExpanded, setSimExpanded] = useState(true);
  const [satInfoExpanded, setSatInfoExpanded] = useState(true);
  const [radarExpanded, setRadarExpanded] = useState(true);
  const [resourcesExpanded, setResourcesExpanded] = useState(true);
  const [ganttExpanded, setGanttExpanded] = useState(true);

  return (
    <div
      className="absolute top-14 right-0 bottom-0 w-[450px] flex flex-col z-10"
      style={{
        background: 'linear-gradient(180deg, rgba(0, 0, 0, 0.70) 0%, rgba(26, 0, 0, 0.50) 100%)',
        backdropFilter: 'blur(16px)',
        borderLeft: '1px solid rgba(255, 0, 51, 0.4)',
        boxShadow: '-10px 0 30px rgba(220, 38, 38, 0.15)',
      }}
    >
      <div className="flex-grow overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-track-black/20 scrollbar-thumb-laser-red/30">
        <SimulationControlPanel expanded={simExpanded} onToggle={() => setSimExpanded(!simExpanded)} />
        <SatelliteInfoPanel expanded={satInfoExpanded} onToggle={() => setSatInfoExpanded(!satInfoExpanded)} />
        <CollapsibleSection
          title="TARGETING RADAR"
          icon={Activity}
          expanded={radarExpanded}
          onToggle={() => setRadarExpanded(!radarExpanded)}
        >
          <BullseyeRadar />
        </CollapsibleSection>
        <CollapsibleSection
          title="FLEET RESOURCES"
          icon={Activity}
          expanded={resourcesExpanded}
          onToggle={() => setResourcesExpanded(!resourcesExpanded)}
        >
          <ResourceMetrics />
        </CollapsibleSection>
        <CollapsibleSection
          title="MANEUVER TIMELINE"
          icon={Activity}
          expanded={ganttExpanded}
          onToggle={() => setGanttExpanded(!ganttExpanded)}
        >
          <ManeuverGantt />
        </CollapsibleSection>
      </div>
      
      {/* Footer with real-time stats and FPS */}
      <div className="px-4 py-3 border-t" style={{ borderColor: 'rgba(255, 0, 51, 0.3)', background: 'rgba(0, 0, 0, 0.80)' }}>
        <div className="flex items-center justify-between font-mono text-[10px]">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-plasma-cyan" />
              <span className="text-muted-gray">SATS:</span>
              <span className="text-plasma-cyan font-bold">{satelliteCount.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-laser-red" />
              <span className="text-muted-gray">DEBRIS:</span>
              <span className="text-vermillion font-bold">{debrisCount.toLocaleString()}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <FPSMonitor />
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${connectionState === 'connected' ? 'bg-nominal-green animate-pulse' : 'bg-laser-red'}`} />
              <span className={connectionState === 'connected' ? 'text-nominal-green' : 'text-laser-red'}>
                {connectionState === 'connected' ? 'LINKED' : 'OFFLINE'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default DashboardLayout;