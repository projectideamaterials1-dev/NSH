// src/components/Header.tsx
// Resilient Command Center Header | Enhanced Visibility | Crimson Nebula Theme

import React, { useMemo, useEffect, useState, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { Terminal, ShieldAlert, Satellite, Wifi, WifiOff, Clock, Cpu, AlertTriangle, Settings, Save, X as XIcon, RefreshCw } from 'lucide-react';
import useOrbitalStore, {
  selectDebrisCount,
  selectSatelliteCount,
  selectHighRiskDebrisCount,
  selectConnectionState,
} from '../store/useOrbitalStore';

// ============================================================================
// ERROR BOUNDARY (internal to header)
// ============================================================================

interface HeaderErrorBoundaryProps {
  children: ReactNode;
}

interface HeaderErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class HeaderErrorBoundary extends Component<HeaderErrorBoundaryProps, HeaderErrorBoundaryState> {
  constructor(props: HeaderErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): HeaderErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[Header] Component crashed:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-16 glass-panel flex items-center justify-between px-6 w-full"
          style={{
            background: 'rgba(0, 0, 0, 0.70)',
            backdropFilter: 'blur(16px)',
            borderBottom: '1px solid rgba(255, 0, 51, 0.4)',
            boxShadow: '0 0 20px rgba(220, 38, 38, 0.25)',
          }}
        >
          <div className="flex items-center gap-4">
            <Terminal className="w-5 h-5 text-laser-red" />
            <div className="flex flex-col">
              <h1 className="text-sm font-bold tracking-[0.25em] uppercase text-plasma-cyan">Orbital Insight</h1>
              <span className="text-[9px] font-mono text-muted-gray">ACM COMMAND CENTER</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-laser-red font-mono text-xs animate-pulse">⚠️ HEADER ERROR</div>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1 text-[10px] font-mono bg-laser-red/20 border border-laser-red rounded text-laser-red hover:bg-laser-red/30 transition"
            >
              RELOAD
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

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
    1: { label: 'DEFCON 1', color: '#FF0033', pulse: true, description: 'Nuclear war imminent' },
    2: { label: 'DEFCON 2', color: '#FFBF00', pulse: true, description: 'Armed forces ready to deploy' },
    3: { label: 'DEFCON 3', color: '#D29922', pulse: false, description: 'Air force ready in 15 minutes' },
    4: { label: 'DEFCON 4', color: '#238636', pulse: false, description: 'Increased intelligence watch' },
    5: { label: 'DEFCON 5', color: '#00FFFF', pulse: false, description: 'Normal peacetime readiness' },
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

  // Format in IST (Indian Standard Time)
  const istTime = time.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="flex items-center gap-2 text-[9px] font-mono opacity-50">
      <span style={{ color: THEME.COLORS.MUTED_GRAY }}>IST:</span>
      <span style={{ color: THEME.COLORS.MUTED_GRAY }}>{istTime}Z</span>
    </div>
  );
});

const SimClock: React.FC = React.memo(() => {
  const timestamp = useOrbitalStore(state => state.timestamp);
  const formattedTime = useMemo(() => {
    if (!timestamp) return '--:--:--.---Z';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '--:--:--.---Z';
    return date.toISOString().split('T')[1];
  }, [timestamp]);
  return (
    <div
      className="flex items-center gap-3 px-4 py-2 rounded border relative overflow-hidden"
      style={{
        borderColor: `${THEME.COLORS.AMBER}40`,
        background: 'rgba(210, 153, 34, 0.05)',
      }}
    >
      {/* Subtle moving scanline effect */}
      <div className="absolute inset-0 pointer-events-none opacity-20 animate-scanline" style={{
        background: 'linear-gradient(180deg, transparent 0%, rgba(210,153,34,0.3) 50%, transparent 100%)',
        transform: 'translateY(-100%)',
        animation: 'scanline 3s linear infinite',
      }} />
      <Clock
        className="w-4 h-4 relative z-10"
        style={{
          color: THEME.COLORS.AMBER,
          filter: `drop-shadow(0 0 5px ${THEME.COLORS.AMBER}80)`,
        }}
      />
      <div className="flex flex-col relative z-10">
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
        className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border rounded cursor-help transition-all duration-300 hover:scale-105"
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
      className="flex items-center gap-2 px-3 py-1.5 bg-black/40 border rounded transition-all duration-300 hover:scale-105"
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
      {latencyMs !== null && state === 'connected' && Number.isFinite(latencyMs) && (
        <span className="text-[9px] font-mono opacity-70" style={{ color: THEME.COLORS.MUTED_GRAY }}>
          {Math.round(latencyMs)}ms
        </span>
      )}
    </div>
  );
});

// ============================================================================
// NEW: Telemetry Ticker (scrolling message)
// ============================================================================

const TelemetryTicker: React.FC = React.memo(() => {
  const [messages, setMessages] = useState<string[]>([]);
  const timestamp = useOrbitalStore(state => state.timestamp);
  const maneuvers = useOrbitalStore(state => state.maneuvers);
  const collisions = useOrbitalStore(state => state.simulation.collisionsDetected);

  useEffect(() => {
    // Build a ticker message from recent events
    const newMessages: string[] = [];
    if (timestamp) {
      const date = new Date(timestamp);
      if (!isNaN(date.getTime())) {
        const time = date.toISOString().substring(11, 19);
        newMessages.push(`🛰️ SIM TIME: ${time}Z`);
      }
    }
    if (maneuvers.length > 0) {
      const lastBurn = maneuvers[maneuvers.length - 1];
      const burnTime = new Date(lastBurn.burnTime).toISOString().substring(11, 19);
      newMessages.push(`🔥 LAST BURN: ${lastBurn.satellite_id} @ ${burnTime}Z | Δv=${lastBurn.delta_v_magnitude.toFixed(3)} m/s`);
    }
    if (collisions > 0) {
      newMessages.push(`⚠️ TOTAL COLLISIONS AVOIDED: ${collisions}`);
    }
    setMessages(newMessages.slice(-3));
  }, [timestamp, maneuvers, collisions]);

  if (messages.length === 0) return null;

  return (
    <div className="absolute bottom-0 left-0 right-0 overflow-hidden whitespace-nowrap bg-black/60 border-t border-red-900/30 text-[8px] font-mono text-plasma-cyan py-1">
      <div className="animate-scroll inline-block px-4">
        {messages.map((msg, i) => (
          <span key={i} className="mr-6">{msg}</span>
        ))}
      </div>
    </div>
  );
});

// ============================================================================
// UTILITIES (pure functions)
// ============================================================================

function formatCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

function calculateDefconLevel(highRiskCount: number, connectionState: string): number {
  if (connectionState !== 'connected') return 1;
  const risk = highRiskCount || 0;
  if (risk > 1000) return 1;
  if (risk > 500) return 2;
  if (risk > 100) return 3;
  if (risk > 10) return 4;
  return 5;
}

// ============================================================================
// SETTINGS MODAL
// ============================================================================

const SettingsModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [config, setConfig] = useState({
    dryMass: 500,
    initialFuel: 50,
    stationKeepingRadius: 10,
    maxDeltaV: 15,
    cooldownSeconds: 600
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-API-Key': 'CRIMSON_NEBULA_2026'
        },
        body: JSON.stringify(config)
      });
      if (response.ok) {
        alert('Configuration saved successfully. Restart required for full effect.');
        onClose();
      }
    } catch (err) {
      console.error('Failed to save config:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md" onClick={onClose}>
      <div className="w-96 glass-panel p-6 border-red-900/40 relative animate-in zoom-in-95" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-muted-gray hover:text-white">
          <XIcon className="w-4 h-4" />
        </button>
        <h2 className="text-sm font-bold font-mono text-plasma-cyan mb-6 tracking-widest uppercase">System Configuration</h2>
        
        <div className="space-y-4">
          {[
            { label: 'DRY MASS (kg)', key: 'dryMass', min: 100, max: 2000, step: 50 },
            { label: 'INITIAL FUEL (kg)', key: 'initialFuel', min: 10, max: 500, step: 10 },
            { label: 'STATION KEEPING (km)', key: 'stationKeepingRadius', min: 1, max: 50, step: 1 },
            { label: 'MAX ΔV (m/s)', key: 'maxDeltaV', min: 5, max: 50, step: 5 },
            { label: 'COOLDOWN (s)', key: 'cooldownSeconds', min: 60, max: 3600, step: 60 },
          ].map(field => (
            <div key={field.key} className="space-y-1.5">
              <div className="flex justify-between text-[10px] font-mono">
                <span className="text-muted-gray">{field.label}</span>
                <span className="text-plasma-cyan">{config[field.key as keyof typeof config]}</span>
              </div>
              <input 
                type="range" 
                min={field.min} 
                max={field.max} 
                step={field.step}
                value={config[field.key as keyof typeof config]}
                onChange={e => setConfig({...config, [field.key]: parseFloat(e.target.value)})}
                className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-plasma-cyan"
              />
            </div>
          ))}
        </div>

        <button 
          onClick={handleSave}
          disabled={saving}
          className="w-full mt-8 py-2 bg-plasma-cyan/10 border border-plasma-cyan/40 rounded flex items-center justify-center gap-2 text-[10px] font-mono text-plasma-cyan hover:bg-plasma-cyan/20 transition-all"
        >
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          SAVE CONFIGURATION
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// MAIN HEADER COMPONENT (uses atomic selectors, no store object)
// ============================================================================

const HeaderContent: React.FC = () => {
  // Each selector subscribes only to its part of the state – no unnecessary re-renders
  const debrisCount = useOrbitalStore(selectDebrisCount);
  const satelliteCount = useOrbitalStore(selectSatelliteCount);
  const highRiskCount = useOrbitalStore(selectHighRiskDebrisCount);
  const connectionState = useOrbitalStore(selectConnectionState);
  const latencyMs = useOrbitalStore(state => state.connectionStatus.latencyMs);
  const [showSettings, setShowSettings] = useState(false);

  // Derive defcon level only when highRiskCount or connectionState changes
  const defconLevel = useMemo(
    () => calculateDefconLevel(highRiskCount, connectionState),
    [highRiskCount, connectionState]
  );
  const defconConfig = THEME.DEFCON_LEVELS[defconLevel as keyof typeof THEME.DEFCON_LEVELS];

  return (
    <header
      className="fixed top-0 left-0 right-0 h-16 glass-panel grid grid-cols-3 items-center px-6 z-50 w-full"
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
          className="flex items-center gap-3 px-4 py-2 rounded border relative overflow-hidden"
          style={{
            borderColor: `${THEME.COLORS.PLASMA_CYAN}60`,
            background: 'rgba(0, 255, 255, 0.05)',
            boxShadow: `0 0 15px ${THEME.COLORS.PLASMA_CYAN}30`,
          }}
        >
          {/* Animated gradient overlay */}
          <div className="absolute inset-0 pointer-events-none opacity-30 animate-gradient" style={{
            background: 'linear-gradient(90deg, transparent, rgba(0,255,255,0.4), transparent)',
            backgroundSize: '200% 100%',
            animation: 'gradient 3s linear infinite',
          }} />
          <Terminal
            className="w-5 h-5 relative z-10"
            style={{
              color: THEME.COLORS.PLASMA_CYAN,
              filter: `drop-shadow(0 0 8px ${THEME.COLORS.PLASMA_CYAN})`,
            }}
          />
          <div className="flex flex-col relative z-10">
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
            Space
          </span>
          <span className="text-[8px] font-mono opacity-50">-LEO-</span>
          <span
            className="text-[10px] font-mono font-bold tracking-wider"
            style={{ color: THEME.COLORS.LASER_RED }}
          >
            CYBERCOMMAND
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
            icon={AlertTriangle}
            label="HIGH RISK"
            value={formatCount(highRiskCount)}
            color="red"
            pulse
            tooltip="Critical conjunction threats"
          />
        )}
        <ConnectionIndicator state={connectionState as ConnectionIndicatorProps['state']} latencyMs={latencyMs} />
        
        <button 
          onClick={() => setShowSettings(true)}
          className="p-2 rounded border border-white/10 hover:bg-white/5 transition-all"
          title="Open System Configuration"
        >
          <Settings className="w-4 h-4 text-muted-gray hover:text-plasma-cyan transition-colors" />
        </button>
        <div
          className="px-4 py-2 rounded border font-mono text-xs font-bold tracking-wider animate-pulse"
          style={{
            background: `${defconConfig.color}15`,
            borderColor: `${defconConfig.color}60`,
            color: defconConfig.color,
            boxShadow: `0 0 15px ${defconConfig.color}40`,
            animationDuration: defconConfig.pulse ? '2s' : '0s',
          }}
          title={defconConfig.description}
        >
          {defconConfig.label}
        </div>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {/* Add CSS animations */}
      <style>{`
        @keyframes scanline {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(200%); }
        }
        @keyframes gradient {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes scroll {
          0% { transform: translateX(100%); }
          100% { transform: translateX(-100%); }
        }
        .animate-scroll {
          animation: scroll 20s linear infinite;
        }
      `}</style>
    </header>
  );
};

export const Header: React.FC = () => (
  <HeaderErrorBoundary>
    <HeaderContent />
    <TelemetryTicker />
  </HeaderErrorBoundary>
);

Header.displayName = 'Header';
export default Header;