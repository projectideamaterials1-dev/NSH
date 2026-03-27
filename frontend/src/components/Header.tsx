// src/components/Header.tsx
// Ultra-Optimized Command Center Header
// Atomic Selectors | No Unnecessary Re-renders | 60 FPS Ready

import React, { useMemo, useEffect, useState, useRef } from 'react';
import { Terminal, ShieldAlert, Satellite, Wifi, WifiOff, Clock, Activity, Cpu } from 'lucide-react';
import useOrbitalStore, {
  selectDebrisCount,
  selectSatelliteCount,
  selectHighRiskDebrisCount,
  selectConnectionState,
} from '../store/useOrbitalStore';

// ============================================================================
// CONSTANTS (Crimson Nebula Theme)
// ============================================================================

const THEME = {
  COLORS: {
    PLASMA_CYAN: '#00FFFF',
    LASER_RED: '#FF0033',
    VERMILLION: '#F85149',
    AMBER: '#D29922',
    MUTED_GRAY: '#888888',
    NOMINAL_GREEN: '#238636',
  },
  DEFCON_LEVELS: {
    1: { label: 'DEFCON 1', color: '#FF0033', pulse: true },
    2: { label: 'DEFCON 2', color: '#FFBF00', pulse: true },
    3: { label: 'DEFCON 3', color: '#D29922', pulse: false },
    4: { label: 'DEFCON 4', color: '#238636', pulse: false },
    5: { label: 'DEFCON 5', color: '#00FFFF', pulse: false },
  },
} as const;

// ============================================================================
// ISOLATED SUB-COMPONENTS (each uses its own atomic selectors)
// ============================================================================

const FPSMonitor: React.FC = React.memo(() => {
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

  const color = fps >= 50 ? 'cyan' : fps >= 30 ? 'amber' : 'red';
  return <StatItem icon={Cpu} label="RENDER FPS" value={`${fps} Hz`} color={color} tooltip="Hardware rendering frame rate" />;
});

const LocalClock: React.FC = React.memo(() => {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);
  return (
    <div className="flex items-center gap-2 text-[9px] font-mono opacity-50">
      <span style={{ color: THEME.COLORS.MUTED_GRAY }}>LOCAL:</span>
      <span style={{ color: THEME.COLORS.MUTED_GRAY }}>
        {time.toISOString().split('T')[1].split('.')[0]}Z
      </span>
    </div>
  );
});

const SimClock: React.FC = React.memo(() => {
  const timestamp = useOrbitalStore(state => state.timestamp);
  const formattedTime = useMemo(() => {
    if (!timestamp) return '--:--:--.---Z';
    return new Date(timestamp).toISOString().split('T')[1];
  }, [timestamp]);
  return (
    <div
      className="flex items-center gap-3 px-4 py-2 rounded border"
      style={{
        borderColor: `${THEME.COLORS.AMBER}40`,
        background: 'rgba(210, 153, 34, 0.05)',
      }}
    >
      <Clock
        className="w-4 h-4"
        style={{
          color: THEME.COLORS.AMBER,
          filter: `drop-shadow(0 0 5px ${THEME.COLORS.AMBER}80)`,
        }}
      />
      <div className="flex flex-col">
        <span className="text-[8px] font-mono uppercase opacity-60" style={{ color: THEME.COLORS.AMBER }}>
          SIM TIME
        </span>
        <span
          className="text-xs font-mono font-bold"
          style={{
            color: THEME.COLORS.AMBER,
            textShadow: `0 0 5px ${THEME.COLORS.AMBER}60`,
          }}
        >
          {formattedTime}
        </span>
      </div>
    </div>
  );
});

// ============================================================================
// UI COMPONENTS (memoized, receive primitive props)
// ============================================================================

interface StatItemProps {
  icon: React.ElementType;
  label: string;
  value: string | number;
  color: 'cyan' | 'red' | 'amber' | 'gray';
  pulse?: boolean;
  tooltip?: string;
}

const StatItem: React.FC<StatItemProps> = React.memo(
  ({ icon: Icon, label, value, color, pulse = false, tooltip }) => {
    const colorMap = {
      cyan: THEME.COLORS.PLASMA_CYAN,
      red: THEME.COLORS.LASER_RED,
      amber: THEME.COLORS.AMBER,
      gray: THEME.COLORS.MUTED_GRAY,
    };
    const hexColor = colorMap[color];
    return (
      <div
        className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border rounded cursor-help"
        style={{
          borderColor: `${hexColor}40`,
          boxShadow: `0 0 8px ${hexColor}20`,
        }}
        title={tooltip}
      >
        <Icon
          className={`w-4 h-4 ${pulse ? 'animate-pulse' : ''}`}
          style={{
            color: hexColor,
            filter: `drop-shadow(0 0 5px ${hexColor}80)`,
          }}
        />
        <div className="flex flex-col">
          <span className="text-[8px] font-mono uppercase opacity-60" style={{ color: hexColor }}>
            {label}
          </span>
          <span
            className="text-xs font-mono font-bold"
            style={{
              color: hexColor,
              filter: `drop-shadow(0 0 5px ${hexColor}60)`,
            }}
          >
            {value}
          </span>
        </div>
      </div>
    );
  }
);

interface ConnectionIndicatorProps {
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  latencyMs: number | null;
}

const ConnectionIndicator: React.FC<ConnectionIndicatorProps> = React.memo(({ state, latencyMs }) => {
  const config = {
    disconnected: { icon: WifiOff, color: THEME.COLORS.MUTED_GRAY, label: 'OFFLINE', pulse: false },
    connecting: { icon: Wifi, color: THEME.COLORS.AMBER, label: 'CONNECTING...', pulse: true },
    connected: { icon: Wifi, color: THEME.COLORS.PLASMA_CYAN, label: 'LINKED', pulse: false },
    error: { icon: WifiOff, color: THEME.COLORS.LASER_RED, label: 'ERROR', pulse: true },
  };
  const { icon: Icon, color, label, pulse } = config[state];
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border rounded"
      style={{
        borderColor: `${color}60`,
        boxShadow: `0 0 10px ${color}30`,
      }}
    >
      <Icon
        className={`w-4 h-4 ${pulse ? 'animate-pulse' : ''}`}
        style={{
          color,
          filter: `drop-shadow(0 0 5px ${color}80)`,
        }}
      />
      <span className="text-[10px] font-mono font-bold" style={{ color }}>
        {label}
      </span>
      {latencyMs !== null && state === 'connected' && (
        <span className="text-[9px] font-mono opacity-70" style={{ color: THEME.COLORS.MUTED_GRAY }}>
          {latencyMs.toFixed(0)}ms
        </span>
      )}
    </div>
  );
});

// ============================================================================
// UTILITIES (pure functions)
// ============================================================================

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

function calculateDefconLevel(highRiskCount: number, connectionState: string): number {
  if (connectionState !== 'connected') return 1;
  if (highRiskCount > 1000) return 1;
  if (highRiskCount > 500) return 2;
  if (highRiskCount > 100) return 3;
  if (highRiskCount > 10) return 4;
  return 5;
}

// ============================================================================
// MAIN HEADER COMPONENT (uses atomic selectors, no store object)
// ============================================================================

export const Header: React.FC = React.memo(() => {
  // Each selector subscribes only to its part of the state – no unnecessary re-renders
  const debrisCount = useOrbitalStore(selectDebrisCount);
  const satelliteCount = useOrbitalStore(selectSatelliteCount);
  const highRiskCount = useOrbitalStore(selectHighRiskDebrisCount);
  const connectionState = useOrbitalStore(selectConnectionState);
  const latencyMs = useOrbitalStore(state => state.connectionStatus.latencyMs);

  // Derive defcon level only when highRiskCount or connectionState changes
  const defconLevel = useMemo(
    () => calculateDefconLevel(highRiskCount, connectionState),
    [highRiskCount, connectionState]
  );
  const defconConfig = THEME.DEFCON_LEVELS[defconLevel as keyof typeof THEME.DEFCON_LEVELS];

  return (
    <header
      className="h-16 glass-panel grid grid-cols-3 items-center px-6 z-50 w-full"
      style={{
        background: 'rgba(0, 0, 0, 0.70)',
        backdropFilter: 'blur(16px)',
        borderBottom: '1px solid rgba(255, 0, 51, 0.4)',
        boxShadow: '0 0 20px rgba(220, 38, 38, 0.25)',
      }}
    >
      {/* LEFT: BRAND & VERSION */}
      <div className="flex items-center gap-4 justify-start">
        <div
          className="flex items-center gap-3 px-4 py-2 rounded border"
          style={{
            borderColor: `${THEME.COLORS.PLASMA_CYAN}60`,
            background: 'rgba(0, 255, 255, 0.05)',
            boxShadow: `0 0 15px ${THEME.COLORS.PLASMA_CYAN}30`,
          }}
        >
          <Terminal
            className="w-5 h-5"
            style={{
              color: THEME.COLORS.PLASMA_CYAN,
              filter: `drop-shadow(0 0 8px ${THEME.COLORS.PLASMA_CYAN})`,
            }}
          />
          <div className="flex flex-col">
            <h1
              className="text-sm font-bold tracking-[0.25em] uppercase"
              style={{
                color: THEME.COLORS.PLASMA_CYAN,
                textShadow: `0 0 10px ${THEME.COLORS.PLASMA_CYAN}`,
              }}
            >
              Orbital Insight
            </h1>
            <span className="text-[9px] font-mono opacity-60" style={{ color: THEME.COLORS.MUTED_GRAY }}>
              ACM COMMAND CENTER
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border border-red-900/40 rounded">
          <span className="text-[10px] font-mono" style={{ color: THEME.COLORS.MUTED_GRAY }}>
            v2.0.4
          </span>
          <span className="text-[8px] font-mono opacity-50">///</span>
          <span
            className="text-[10px] font-mono font-bold tracking-wider"
            style={{ color: THEME.COLORS.LASER_RED }}
          >
            CYBER-COMMAND
          </span>
        </div>
      </div>

      {/* CENTER: SIMULATION TIME */}
      <div className="flex items-center justify-center gap-6">
        <SimClock />
        <LocalClock />
      </div>

      {/* RIGHT: TELEMETRY & STATUS */}
      <div className="flex items-center gap-4 justify-end">
        <FPSMonitor />
        <StatItem
          icon={Satellite}
          label="SATS"
          value={formatCount(satelliteCount)}
          color="cyan"
          tooltip="Active constellation members"
        />
        <StatItem
          icon={ShieldAlert}
          label="DEBRIS"
          value={formatCount(debrisCount)}
          color="red"
          pulse={highRiskCount > 100}
          tooltip="Tracked orbital debris objects"
        />
        {highRiskCount > 0 && (
          <StatItem
            icon={Activity}
            label="HIGH RISK"
            value={formatCount(highRiskCount)}
            color="red"
            pulse
            tooltip="Critical conjunction threats"
          />
        )}
        <ConnectionIndicator state={connectionState as ConnectionIndicatorProps['state']} latencyMs={latencyMs} />
        <div
          className="px-4 py-2 rounded border font-mono text-xs font-bold tracking-wider animate-pulse"
          style={{
            background: `${defconConfig.color}15`,
            borderColor: `${defconConfig.color}60`,
            color: defconConfig.color,
            boxShadow: `0 0 15px ${defconConfig.color}40`,
            animationDuration: defconConfig.pulse ? '2s' : '0s',
          }}
          title={`Threat Level: ${defconConfig.label}`}
        >
          {defconConfig.label}
        </div>
      </div>
    </header>
  );
});

Header.displayName = 'Header';
export default Header;