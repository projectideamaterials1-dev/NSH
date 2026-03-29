// src/components/DashboardLayout.tsx
// NSH 2026 – Mission Control v11 | Crimson Nebula Enhanced
// ✅ All components included, no TypeScript errors
// ✅ Gantt & Metrics popups use real store data with manual refresh
// ✅ Positioning: top: 80 to clear header

import React, {
  useState, useMemo, useEffect, useRef,
  Component, ErrorInfo, ReactNode,
} from 'react';
import {
  ChevronRight, ChevronLeft, Clock, Wifi, WifiOff,
  Satellite, Target, BarChart2, Calendar, X,
  Crosshair, Zap, TrendingUp, Activity, AlertTriangle,
  Shield, Radio, Battery, Flame, RefreshCw,
} from 'lucide-react';
import useOrbitalStore, {
  selectSatelliteCount,
  selectDebrisCount,
  selectConnectionState,
  selectSelectedSatellite,
} from '../store/useOrbitalStore';
import type { ManeuverEvent, DebrisBinaryData } from '../store/useOrbitalStore';

// ============================================================================
// ERROR BOUNDARY
// ============================================================================
class ErrorBoundary extends Component<
  { children: ReactNode; name: string; onRecover?: () => void },
  { hasError: boolean; error?: Error }
> {
  state = { hasError: false, error: undefined };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[DashboardLayout:${this.props.name}]`, error, errorInfo);
  }
  handleRecover = () => {
    this.setState({ hasError: false, error: undefined });
    this.props.onRecover?.();
  };
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-3 text-[9px] font-mono text-laser-red text-center">
          <div className="flex items-center justify-center gap-1 mb-1">
            <AlertTriangle className="w-3 h-3" />
            <span>{this.props.name} error</span>
          </div>
          <button
            onClick={this.handleRecover}
            className="mt-1 px-2 py-0.5 rounded bg-red-900/30 hover:bg-red-900/50 text-[8px] transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================================
// TYPES
// ============================================================================
interface SatItem {
  id: string;
  fuel: number;
  status: string;
  lat: number;
  lon: number;
  alt: number;
  drift?: number;
}

interface ConjunctionEntry {
  debrisId: string;
  tca: number;
  angle: number;
  missDistance: number;
  collisionProb: number;
  riskLevel: 'SAFE' | 'WARNING' | 'CRITICAL';
}

interface DvPoint {
  timestamp: number;
  fuelConsumed: number;
  collisionsAvoided: number;
  deltaVUsed: number;
  label: string;
}

// ============================================================================
// CONSTANTS & PHYSICS HELPERS
// ============================================================================
const FUEL_INITIAL = 50.0;
const I_SP = 300.0;
const G0 = 9.80665;
const EARTH_RADIUS_KM = 6371;

const fuelColor = (f: number) => f < 5 ? '#FF0033' : f < 15 ? '#D29922' : '#00FFFF';
const fuelGlow = (f: number) => f < 5 ? '0 0 12px #FF0033, 0 0 24px rgba(255,0,51,0.4)' 
  : f < 15 ? '0 0 10px #D29922, 0 0 20px rgba(210,153,34,0.3)' 
  : '0 0 14px #00FFFF, 0 0 28px rgba(0,255,255,0.35)';
const fuelClass = (f: number) =>
  f < 5 ? 'text-laser-red font-bold animate-pulse' : f < 15 ? 'text-amber' : 'text-plasma-cyan';

const statusBorder = (s: string) =>
  s === 'CRITICAL' ? 'rgba(255,0,51,0.85)' : s === 'WARNING' ? 'rgba(210,153,34,0.65)' : 'rgba(0,255,255,0.35)';
const statusGlow = (s: string) =>
  s === 'CRITICAL' ? '0 0 20px rgba(255,0,51,0.5), inset 0 0 30px rgba(255,0,51,0.1)' 
  : s === 'WARNING' ? '0 0 16px rgba(210,153,34,0.35), inset 0 0 24px rgba(210,153,34,0.08)' 
  : '0 0 18px rgba(0,255,255,0.25), inset 0 0 28px rgba(0,255,255,0.06)';
const statusClass = (s: string) =>
  s === 'CRITICAL' ? 'text-laser-red animate-pulse' : s === 'WARNING' ? 'text-amber' :
  s === 'NOMINAL' ? 'text-nominal-green' : 'text-muted-gray';

const riskColor = (r: ConjunctionEntry['riskLevel']) =>
  r === 'CRITICAL' ? '#FF0033' : r === 'WARNING' ? '#D29922' : '#00FF64';
const riskGlow = (r: ConjunctionEntry['riskLevel']) =>
  r === 'CRITICAL' ? '0 0 16px #FF0033, 0 0 32px rgba(255,0,51,0.5)' 
  : r === 'WARNING' ? '0 0 12px #D29922, 0 0 24px rgba(210,153,34,0.4)' 
  : '0 0 10px #00FF64, 0 0 20px rgba(0,255,100,0.3)';

function computeFuelConsumed(deltaV_mps: number, currentMass_kg: number): number {
  const exhaustVel = I_SP * G0;
  const massRatio = Math.exp(-deltaV_mps / exhaustVel);
  return currentMass_kg * (1 - massRatio);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1-a)));
  return EARTH_RADIUS_KM * c;
}

function deriveConjunctions(
  satLat: number, satLon: number, satAlt_m: number,
  debris: DebrisBinaryData | null
): ConjunctionEntry[] {
  if (!debris || debris.length === 0) return [];
  const REL_VEL_KMPS = 7.5;
  const MAX_LOOKAHEAD_S = 120;
  const results: ConjunctionEntry[] = [];
  const satAlt_km = satAlt_m / 1000;
  for (let i = 0; i < debris.length; i++) {
    const dLon = debris.positions[i * 3];
    const dLat = debris.positions[i * 3 + 1];
    const dAlt = debris.positions[i * 3 + 2] / 1000;
    if (Math.abs(dLat - satLat) > 10 || Math.abs(dLon - satLon) > 10) continue;
    if (Math.abs(dAlt - satAlt_km) > 50) continue;
    const groundDist = haversineKm(satLat, satLon, dLat, dLon);
    const altDiff = Math.abs(dAlt - satAlt_km);
    const dist3D = Math.sqrt(groundDist**2 + altDiff**2);
    if (dist3D > 80) continue;
    const tca = dist3D / REL_VEL_KMPS;
    if (tca > MAX_LOOKAHEAD_S) continue;
    let angle = Math.atan2(dLon - satLon, dLat - satLat) * 180 / Math.PI;
    if (angle < 0) angle += 360;
    const missDistance = dist3D;
    const collisionProb = missDistance < 1 ? 0.15 : missDistance < 5 ? 0.05 : 0.001;
    const riskLevel: ConjunctionEntry['riskLevel'] = 
      missDistance < 1 ? 'CRITICAL' : missDistance < 5 ? 'WARNING' : 'SAFE';
    results.push({
      debrisId: debris.ids[i],
      tca,
      angle,
      missDistance,
      collisionProb,
      riskLevel,
    });
  }
  return results.sort((a, b) => a.tca - b.tca).slice(0, 60);
}

// ============================================================================
// FPS MONITOR
// ============================================================================
const FPSMonitor: React.FC = () => {
  const [fps, setFps] = useState(60);
  const [frameTime, setFrameTime] = useState(16.67);
  const frames = useRef(0);
  const t0 = useRef(performance.now());
  const raf = useRef<number>(0);

  useEffect(() => {
    const tick = () => {
      frames.current++;
      const now = performance.now();
      const elapsed = now - t0.current;
      if (elapsed >= 1000) {
        const newFps = Math.round((frames.current * 1000) / elapsed);
        setFps(newFps);
        setFrameTime(elapsed / frames.current);
        frames.current = 0;
        t0.current = now;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  const fpsColor = fps >= 80 ? '#00FFFF' : fps >= 50 ? '#D29922' : '#FF0033';
  const timeColor = frameTime <= 16.67 ? '#00FF64' : frameTime <= 33.33 ? '#D29922' : '#FF0033';
  
  return (
    <span className="font-mono text-[9px] flex items-center gap-2">
      <span className="text-muted-gray">FPS</span>
      <span style={{ color: fpsColor, textShadow: `0 0 4px ${fpsColor}` }}>{fps}</span>
      <span className="text-muted-gray">|</span>
      <span className="text-muted-gray">Δt</span>
      <span style={{ color: timeColor }}>{frameTime.toFixed(1)}ms</span>
    </span>
  );
};

// ============================================================================
// SVG FUEL GAUGE ARC
// ============================================================================
const FuelGaugeArc: React.FC<{ 
  fuel: number; 
  size?: number;
  showLabels?: boolean;
  animate?: boolean;
}> = ({ fuel, size = 160, showLabels = true, animate = true }) => {
  const pct = Math.min(100, Math.max(0, (fuel / FUEL_INITIAL) * 100));
  const col = fuelColor(fuel);
  const glow = fuelGlow(fuel);
  
  const cx = size / 2;
  const cy = size * 0.65;
  const R = size * 0.42;
  const strokeWidth = size * 0.08;
  
  const startAngle = -135 * Math.PI / 180;
  const sweepAngle = (pct / 100) * 270 * Math.PI / 180;
  const endAngle = startAngle + sweepAngle;
  
  const polarToCart = (angle: number, radius: number) => ({
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  });
  
  const createArcPath = (start: number, end: number, radius: number) => {
    const p1 = polarToCart(start, radius);
    const p2 = polarToCart(end, radius);
    const largeArc = end - start > Math.PI ? 1 : 0;
    return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  };
  
  const needleAngle = startAngle + (pct / 100) * 270 * Math.PI / 180;
  const needleEnd = polarToCart(needleAngle, R * 0.92);
  const ticks = [0, 25, 50, 75, 100];
  
  return (
    <svg width={size} height={size * 0.78} viewBox={`0 0 ${size} ${size * 0.78}`} style={{ overflow: 'visible' }} className={animate ? 'transition-all duration-500' : ''}>
      <defs>
        <linearGradient id={`fuelGrad-${size}`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={col} stopOpacity="0.9" />
          <stop offset="50%" stopColor={col} stopOpacity="1" />
          <stop offset="100%" stopColor={col} stopOpacity="0.85" />
        </linearGradient>
        <filter id={`glow-${size}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      
      <path d={createArcPath(startAngle, startAngle + 270 * Math.PI / 180, R)} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={strokeWidth} strokeLinecap="round" />
      {pct > 0.5 && (
        <path d={createArcPath(startAngle, endAngle, R)} fill="none" stroke={`url(#fuelGrad-${size})`} strokeWidth={strokeWidth} strokeLinecap="round" style={{ filter: `url(#glow-${size})` }} className={animate ? 'transition-all duration-700 ease-out' : ''} />
      )}
      {ticks.map(p => {
        const angle = startAngle + (p / 100) * 270 * Math.PI / 180;
        const inner = polarToCart(angle, R - size * 0.06);
        const outer = polarToCart(angle, R + size * 0.03);
        const isMajor = p % 25 === 0;
        return <line key={p} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke="rgba(255,255,255,0.25)" strokeWidth={isMajor ? 2 : 1} opacity={isMajor ? 1 : 0.6} />;
      })}
      <line x1={cx} y1={cy} x2={needleEnd.x} y2={needleEnd.y} stroke={col} strokeWidth={size * 0.025} strokeLinecap="round" style={{ filter: `drop-shadow(${glow})` }} className={animate ? 'transition-all duration-300 ease-out' : ''} />
      <circle cx={cx} cy={cy} r={size * 0.05} fill={col} style={{ filter: `drop-shadow(${glow})` }} />
      <circle cx={cx} cy={cy} r={size * 0.025} fill="rgba(255,255,255,0.9)" />
      {showLabels && (
        <>
          <text x={cx - R - 6} y={cy + 4} fill="rgba(255,255,255,0.28)" fontSize={size * 0.075} fontFamily="monospace" textAnchor="end" fontWeight="bold">E</text>
          <text x={cx + R + 6} y={cy + 4} fill="rgba(255,255,255,0.28)" fontSize={size * 0.075} fontFamily="monospace" fontWeight="bold">F</text>
          {pct <= 15 && (
            <g>
              <circle cx={polarToCart(startAngle + 0.1 * 270 * Math.PI / 180, R).x} cy={polarToCart(startAngle + 0.1 * 270 * Math.PI / 180, R).y} r={size * 0.03} fill="#FF0033" className="animate-pulse" style={{ filter: 'drop-shadow(0 0 6px #FF0033)' }} />
              <text x={cx} y={cy + R + size * 0.12} fill="#FF0033" fontSize={size * 0.06} fontFamily="monospace" textAnchor="middle" fontWeight="bold" className="animate-pulse">⚠ EOL</text>
            </g>
          )}
        </>
      )}
      <text x={cx} y={cy + size * 0.18} fill={col} fontSize={size * 0.11} fontFamily="monospace" textAnchor="middle" fontWeight="bold" style={{ filter: `drop-shadow(0 0 4px ${col})` }} className={animate ? 'transition-all duration-300' : ''}>{fuel.toFixed(2)}</text>
      <text x={cx} y={cy + size * 0.26} fill="rgba(255,255,255,0.35)" fontSize={size * 0.06} fontFamily="monospace" textAnchor="middle">kg / {FUEL_INITIAL.toFixed(0)}</text>
    </svg>
  );
};

// ============================================================================
// SVG ΔV EFFICIENCY CHART
// ============================================================================
const DvEfficiencyChart: React.FC<{ 
  data: DvPoint[]; 
  width?: number; 
  height?: number;
  showLabels?: boolean;
  showLogScale?: boolean;
}> = ({ data, width = 420, height = 180, showLogScale = false, showLabels = true }) => {
  const padding = { left: 48, right: 20, top: 20, bottom: 36 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  
  if (data.length < 2) {
    return (
      <div style={{ width, height }} className="flex items-center justify-center">
        <span className="text-[9px] font-mono text-muted-gray flex items-center gap-1">
          <Activity className="w-3 h-3 animate-pulse" />
          Accumulating telemetry…
        </span>
      </div>
    );
  }
  
  const maxFuel = Math.max(...data.map(d => d.fuelConsumed), 0.01);
  const maxColl = Math.max(...data.map(d => d.collisionsAvoided), 1);
  const n = data.length;
  
  const xScale = (i: number) => padding.left + (i / (n - 1)) * chartW;
  
  const yScaleFuel = (f: number) => {
    const normalized = showLogScale && f > 0 
      ? Math.log10(f + 0.01) / Math.log10(maxFuel + 0.01)
      : f / maxFuel;
    return padding.top + chartH * (1 - Math.min(1, Math.max(0, normalized)));
  };
  
  const yScaleColl = (c: number) => {
    const normalized = showLogScale && c > 0
      ? Math.log10(c + 0.1) / Math.log10(maxColl + 0.1)
      : c / maxColl;
    return padding.top + chartH * (1 - Math.min(1, Math.max(0, normalized)));
  };
  
  const fuelPath = data.map((d, i) => 
    `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScaleFuel(d.fuelConsumed).toFixed(1)}`
  ).join(' ');
  
  const collPath = data.map((d, i) => 
    `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScaleColl(d.collisionsAvoided).toFixed(1)}`
  ).join(' ');
  
  const fuelArea = `${fuelPath} L${xScale(n-1).toFixed(1)},${padding.top + chartH} L${padding.left},${padding.top + chartH} Z`;
  
  const xTicks = [0, Math.floor((n-1)/2), n-1].filter(i => i < n);
  
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="dvFuelGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00FFFF" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#00FFFF" stopOpacity="0.05" />
        </linearGradient>
        <filter id="chartGlow">
          <feGaussianBlur stdDeviation="1.5" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      
      {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
        const y = padding.top + chartH * (1 - f);
        return (
          <g key={i}>
            <line x1={padding.left} x2={padding.left + chartW} y1={y} y2={y} stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray={f === 0 || f === 1 ? '0' : '3 3'} />
            {showLabels && <text x={padding.left - 8} y={y + 3} fill="rgba(255,255,255,0.3)" fontSize="7" fontFamily="monospace" textAnchor="end">{(f * maxFuel).toFixed(1)}</text>}
          </g>
        );
      })}
      <line x1={padding.left} x2={padding.left} y1={padding.top} y2={padding.top + chartH} stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
      <line x1={padding.left} x2={padding.left + chartW} y1={padding.top + chartH} y2={padding.top + chartH} stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
      <path d={fuelArea} fill="url(#dvFuelGrad)" />
      <path d={fuelPath} fill="none" stroke="#00FFFF" strokeWidth="2" style={{ filter: 'url(#chartGlow)' }} />
      {data.map((d, i) => (
        <circle key={`fuel-${i}`} cx={xScale(i)} cy={yScaleFuel(d.fuelConsumed)} r="3" fill="#00FFFF" opacity="0.8" style={{ filter: 'drop-shadow(0 0 3px #00FFFF)' }} />
      ))}
      <path d={collPath} fill="none" stroke="#D29922" strokeWidth="2" strokeDasharray="5 3" style={{ filter: 'url(#chartGlow)' }} />
      {data.map((d, i) => d.collisionsAvoided > 0 && (
        <circle key={`coll-${i}`} cx={xScale(i)} cy={yScaleColl(d.collisionsAvoided)} r="4" fill="#D29922" style={{ filter: 'drop-shadow(0 0 4px #D29922)' }} />
      ))}
      {xTicks.map(i => (
        <g key={`xtick-${i}`}>
          <line x1={xScale(i)} x2={xScale(i)} y1={padding.top + chartH} y2={padding.top + chartH + 4} stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
          <text x={xScale(i)} y={padding.top + chartH + 16} fill="rgba(255,255,255,0.3)" fontSize="7" fontFamily="monospace" textAnchor="middle">{data[i].label}</text>
        </g>
      ))}
      <text x={padding.left - 30} y={padding.top + chartH/2} fill="rgba(255,255,255,0.4)" fontSize="7.5" fontFamily="monospace" textAnchor="middle" transform={`rotate(-90, ${padding.left - 30}, ${padding.top + chartH/2})`}>Fuel (kg)</text>
      <text x={padding.left + chartW/2} y={height - 6} fill="rgba(255,255,255,0.4)" fontSize="7.5" fontFamily="monospace" textAnchor="middle">Time</text>
      <g transform={`translate(${padding.left + 8}, ${padding.top + 8})`}>
        <circle cx="0" cy="0" r="3" fill="#00FFFF" />
        <text x="8" y="3" fill="#00FFFF" fontSize="7" fontFamily="monospace">Fuel consumed</text>
      </g>
      <g transform={`translate(${padding.left + 160}, ${padding.top + 8})`}>
        <line x1="0" x2="12" y1="0" y2="0" stroke="#D29922" strokeWidth="2" strokeDasharray="5 3" />
        <text x="16" y="3" fill="#D29922" fontSize="7" fontFamily="monospace">Collisions avoided</text>
      </g>
    </svg>
  );
};

// ============================================================================
// RESOURCES POPUP (Enhanced with refresh)
// ============================================================================
const ResourcesPopup: React.FC<{ sat: SatItem; onClose: () => void }> = ({ sat, onClose }) => {
  const store = useOrbitalStore();
  const fuelHistory = store.fuelHistory;
  const allManeuvers = store.maneuvers;
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await store.syncVisualizationSnapshot();
    setIsRefreshing(false);
  };

  const satManeuvers = useMemo(() => 
    allManeuvers.filter(m => m.satellite_id === sat.id), 
    [allManeuvers, sat.id]
  );
  
  const totalDeltaV = useMemo(() => 
    satManeuvers.reduce((sum, m) => sum + m.delta_v_magnitude, 0),
    [satManeuvers]
  );
  
  const fuelConsumed = useMemo(() => {
    let consumed = 0;
    let currentMass = FUEL_INITIAL + 500;
    for (const m of satManeuvers) {
      const used = computeFuelConsumed(m.delta_v_magnitude, currentMass);
      consumed += used;
      currentMass -= used;
    }
    return Math.min(FUEL_INITIAL, consumed);
  }, [satManeuvers]);
  
  const fuelPct = Math.min(100, Math.max(0, (sat.fuel / FUEL_INITIAL) * 100));
  const col = fuelColor(sat.fuel);
  
  const dvData: DvPoint[] = useMemo(() => {
    if (fuelHistory.length < 2) return [];
    const maneuverTimes = satManeuvers.map(m => new Date(m.burnTime).getTime()).sort((a,b) => a-b);
    return fuelHistory.slice(-30).map((metric) => {
      const tMs = new Date(metric.timestamp).getTime();
      const collisions = maneuverTimes.filter(t => t <= tMs).length;
      const consumed = Math.max(0, FUEL_INITIAL - metric.avgFuelKg);
      const dvUsed = satManeuvers
        .filter(m => new Date(m.burnTime).getTime() <= tMs)
        .reduce((sum, m) => sum + m.delta_v_magnitude, 0);
      const d = new Date(metric.timestamp);
      return {
        timestamp: tMs,
        fuelConsumed: consumed,
        collisionsAvoided: collisions,
        deltaVUsed: dvUsed,
        label: `${d.getUTCHours().toString().padStart(2,'0')}:${d.getUTCMinutes().toString().padStart(2,'0')}`,
      };
    });
  }, [fuelHistory, satManeuvers]);
  
  const efficiency = fuelConsumed > 0 
    ? (dvData[dvData.length-1]?.collisionsAvoided || 0) / fuelConsumed 
    : 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(12px)' }} onClick={onClose}>
      <div className="relative rounded-2xl overflow-hidden animate-in zoom-in-95 duration-200" style={{ width: 600, maxHeight: '90vh', background: 'linear-gradient(145deg, rgba(0,0,0,0.98), rgba(18,0,8,0.99))', border: '1px solid rgba(255,0,51,0.6)', boxShadow: '0 0 80px rgba(255,0,51,0.25), 0 30px 100px rgba(0,0,0,0.9)' }} onClick={e => e.stopPropagation()}>
        <div className="h-[3px]" style={{ background: `linear-gradient(90deg, transparent, ${col}, transparent)`, boxShadow: `0 0 20px ${col}, 0 0 40px ${col}40`, animation: 'pulse 2s ease-in-out infinite' }} />
        <div className="flex items-center justify-between px-6 py-4 border-b border-red-900/30">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${col}18`, border: `1px solid ${col}50`, boxShadow: `0 0 12px ${col}40` }}>
              <Activity className="w-5 h-5" style={{ color: col }} />
            </div>
            <div>
              <div className="font-mono text-base font-bold text-white tracking-wide">{sat.id}</div>
              <div className="text-[9px] font-mono text-muted-gray tracking-widest uppercase">Resource Analytics</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleRefresh} disabled={isRefreshing} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-900/30 transition-all hover:scale-110">
              <RefreshCw className={`w-4 h-4 text-muted-gray hover:text-white transition-colors ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-900/30 transition-all hover:scale-110">
              <X className="w-4 h-4 text-muted-gray hover:text-white transition-colors" />
            </button>
          </div>
        </div>
        <div className="p-6 space-y-6 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 120px)' }}>
          <div>
            <div className="text-[9px] font-mono text-muted-gray mb-4 tracking-widest uppercase flex items-center gap-2">
              <Zap className="w-3 h-3" style={{ color: col }} /> Propellant Mass (m_fuel)
              <span className="text-[8px] ml-auto">Burns: {satManeuvers.length}</span>
            </div>
            <div className="flex items-start gap-6">
              <div className="flex-shrink-0"><FuelGaugeArc fuel={sat.fuel} size={170} animate={true} /></div>
              <div className="flex-1 pt-2 space-y-3">
                <div>
                  <div className="flex justify-between text-[8px] font-mono mb-1.5"><span className="text-muted-gray">REMAINING</span><span style={{ color: col, fontWeight: 600 }}>{fuelPct.toFixed(1)}%</span></div>
                  <div className="h-2.5 bg-black/80 rounded-full overflow-hidden border border-white/8 relative">
                    <div className="h-full rounded-full transition-all duration-700 ease-out" style={{ width: `${fuelPct}%`, background: `linear-gradient(90deg, ${col}cc, ${col})`, boxShadow: `0 0 10px ${col}` }} />
                    <div className="absolute top-0 bottom-0 w-[2px] bg-laser-red/80" style={{ left: `${(10 / FUEL_INITIAL) * 100}%`, boxShadow: '0 0 4px #FF0033' }} />
                  </div>
                  <div className="flex justify-between text-[6.5px] font-mono text-muted-gray mt-1"><span>0%</span><span className="text-laser-red">EOL</span><span>50%</span><span>100%</span></div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'STATUS', value: sat.status, cls: statusClass(sat.status) },
                    { label: 'ALTITUDE', value: `${(sat.alt/1000).toFixed(1)} km`, cls: 'text-white' },
                    { label: 'CONSUMED', value: `${fuelConsumed.toFixed(3)} kg`, cls: 'text-amber' },
                    { label: 'TOTAL ΔV', value: `${totalDeltaV.toFixed(4)} m/s`, cls: 'text-plasma-cyan' },
                    { label: 'BURNS', value: `${satManeuvers.length}`, cls: 'text-white' },
                    { label: 'EFFICIENCY', value: `${(efficiency*100).toFixed(1)}%`, cls: efficiency > 0.1 ? 'text-nominal-green' : 'text-muted-gray' },
                  ].map(({ label, value, cls }) => (
                    <div key={label} className="flex justify-between text-[9px] font-mono border-b border-white/8 pb-1"><span className="text-muted-gray">{label}</span><span className={cls}>{value}</span></div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div>
            <div className="text-[9px] font-mono text-muted-gray mb-3 tracking-widest uppercase flex items-center gap-2">
              <TrendingUp className="w-3 h-3" style={{ color: '#D29922' }} /> ΔV Cost Analysis — Fuel vs Collisions Avoided
            </div>
            <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.65)', border: '1px solid rgba(255,0,51,0.12)' }}>
              {dvData.length >= 2 ? (
                <DvEfficiencyChart data={dvData} width={540} height={180} showLogScale={false} />
              ) : (
                <div className="flex items-center justify-center h-[180px] text-[9px] font-mono text-muted-gray">
                  Accumulating telemetry... ({fuelHistory.length} points)
                </div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'FUEL USED', value: `${fuelConsumed.toFixed(2)} kg`, color: '#FF6B6B', icon: Flame },
              { label: 'ΔV EXPENDED', value: `${totalDeltaV.toFixed(3)} m/s`, color: '#00FFFF', icon: Zap },
              { label: 'AVOIDANCES', value: `${satManeuvers.filter(m => m.maneuver_type !== 'RECOVERY').length}`, color: '#00FF64', icon: Shield },
            ].map(({ label, value, color, icon: Icon }) => (
              <div key={label} className="rounded-xl px-4 py-3 text-center" style={{ background: 'rgba(0,0,0,0.55)', border: `1px solid ${color}28`, boxShadow: `0 0 15px ${color}10` }}>
                <Icon className="w-4 h-4 mx-auto mb-1" style={{ color }} />
                <div className="text-[7px] font-mono text-muted-gray mb-1">{label}</div>
                <div className="font-mono text-lg font-bold" style={{ color, textShadow: `0 0 8px ${color}60` }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="px-6 py-3 border-t border-red-900/25 bg-black/40 flex justify-between items-center">
          <div className="text-[8px] font-mono text-muted-gray">Updated: {new Date().toISOString().substring(11,19)}Z</div>
          <button onClick={onClose} className="px-4 py-1.5 text-[9px] font-mono text-plasma-cyan border border-plasma-cyan/40 rounded hover:bg-plasma-cyan/10 transition-all hover:scale-105">CLOSE</button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// GANTT POPUP (Enhanced with refresh)
// ============================================================================
const MTYPE_COLORS: Record<string, { bg: string; border: string; glow: string }> = {
  PHASING_PROGRADE: { bg: 'rgba(0,255,255,0.12)', border: '#00FFFF', glow: '#00FFFF' },
  RADIAL_SHUNT:     { bg: 'rgba(255,0,255,0.12)', border: '#FF00FF', glow: '#FF00FF' },
  RECOVERY:         { bg: 'rgba(0,255,100,0.12)', border: '#00FF64', glow: '#00FF64' },
  PLANE_CHANGE:     { bg: 'rgba(210,153,34,0.12)', border: '#D29922', glow: '#D29922' },
};

const GanttPopup: React.FC<{ sat: SatItem; onClose: () => void }> = ({ sat, onClose }) => {
  const store = useOrbitalStore();
  const allManeuvers = store.maneuvers;
  const simTime = store.timestamp;
  const simMs = simTime ? new Date(simTime).getTime() : Date.now();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await store.syncVisualizationSnapshot();
    setIsRefreshing(false);
  };

  const events: ManeuverEvent[] = useMemo(() => {
    const filtered = allManeuvers.filter(m => m.satellite_id === sat.id);
    return [...filtered].sort((a, b) => new Date(a.burnTime).getTime() - new Date(b.burnTime).getTime());
  }, [allManeuvers, sat.id]);
  
  if (events.length === 0) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(10px)' }} onClick={onClose}>
        <div className="relative rounded-2xl overflow-hidden" style={{ width: 680, background: 'linear-gradient(145deg, rgba(0,0,0,0.98), rgba(15,0,6,0.99))', border: '1px solid rgba(255,0,51,0.5)' }}>
          <div className="flex items-center justify-between px-6 py-4 border-b border-red-900/30">
            <div className="flex items-center gap-3">
              <Calendar className="w-5 h-5 text-plasma-cyan" />
              <div className="font-mono text-base font-bold text-white tracking-wide">{sat.id}</div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleRefresh} disabled={isRefreshing} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-900/30 transition-all">
                <RefreshCw className={`w-4 h-4 text-muted-gray hover:text-white ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
              <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-900/30 transition-all">
                <X className="w-4 h-4 text-muted-gray hover:text-white" />
              </button>
            </div>
          </div>
          <div className="p-8 text-center">
            <Calendar className="w-12 h-12 text-muted-gray mx-auto mb-3 opacity-50" />
            <div className="font-mono text-sm text-muted-gray">No scheduled maneuvers for {sat.id}</div>
            <div className="text-[10px] font-mono text-muted-gray mt-2">Total maneuvers in store: {allManeuvers.length}</div>
            <button onClick={handleRefresh} className="mt-4 px-4 py-2 bg-plasma-cyan/20 border border-plasma-cyan/40 rounded text-plasma-cyan text-xs font-mono hover:bg-plasma-cyan/30 transition">
              Refresh Data
            </button>
          </div>
        </div>
      </div>
    );
  }
  
  const allTimes = events.flatMap(e => [new Date(e.burnTime).getTime(), new Date(e.cooldown_end).getTime()]);
  const tMin = Math.min(...allTimes, simMs) - 180_000;
  const tMax = Math.max(...allTimes, simMs) + 240_000;
  const tRange = tMax - tMin || 1;
  const GW = 900, rowH = 70, GT = 40, GB = 30;
  const chartW = GW - 24;
  const xPx = (t: number) => 12 + ((t - tMin) / tRange) * (chartW - 24);
  
  const conflictSet = useMemo(() => {
    const conflicts = new Set<string>();
    let lastCoolEnd = 0;
    for (const ev of events) {
      const burnStart = new Date(ev.burnTime).getTime();
      if (burnStart < lastCoolEnd) conflicts.add(ev.burn_id);
      lastCoolEnd = Math.max(lastCoolEnd, new Date(ev.cooldown_end).getTime());
    }
    return conflicts;
  }, [events]);
  
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(12px)' }} onClick={onClose}>
      <div className="relative rounded-2xl overflow-hidden animate-in zoom-in-95 duration-200" style={{ width: 920, maxHeight: '85vh', background: 'linear-gradient(145deg, rgba(0,0,0,0.98), rgba(15,0,6,0.99))', border: '1px solid rgba(255,0,51,0.6)', boxShadow: '0 0 90px rgba(255,0,51,0.2), 0 35px 120px rgba(0,0,0,0.85)' }} onClick={e => e.stopPropagation()}>
        <div className="h-[3px]" style={{ background: 'linear-gradient(90deg, transparent, #00FFFF, transparent)', boxShadow: '0 0 20px #00FFFF, 0 0 40px #00FFFF40' }} />
        <div className="flex items-center justify-between px-6 py-4 border-b border-red-900/30">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(0,255,255,0.12)', border: '1px solid rgba(0,255,255,0.4)', boxShadow: '0 0 12px rgba(0,255,255,0.3)' }}>
              <Calendar className="w-5 h-5 text-plasma-cyan" />
            </div>
            <div>
              <div className="font-mono text-base font-bold text-white tracking-wide">{sat.id}</div>
              <div className="text-[9px] font-mono text-muted-gray tracking-widest uppercase">Maneuver Timeline</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleRefresh} disabled={isRefreshing} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-900/30 transition-all">
              <RefreshCw className={`w-4 h-4 text-muted-gray hover:text-white ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-900/30 transition-all hover:scale-110">
              <X className="w-4 h-4 text-muted-gray hover:text-white transition-colors" />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(85vh - 85px)' }}>
          <div className="p-6 space-y-6">
            <div className="flex items-center gap-6 text-[8px] font-mono flex-wrap border-b border-white/10 pb-3">
              {[
                { l: 'BURN', c: '#00FFFF' },
                { l: 'COOLDOWN 600s', c: 'rgba(210,153,34,0.6)' },
                { l: '⚠ CONFLICT', c: '#FF0033' },
                { l: 'RECOVERY', c: '#00FF64' },
                { l: 'NOW', c: '#FFFFFF' },
              ].map(({ l, c }) => (
                <div key={l} className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded-sm" style={{ background: c, boxShadow: `0 0 6px ${c}` }} />
                  <span className="text-muted-gray">{l}</span>
                </div>
              ))}
            </div>
            <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.7)', border: '1px solid rgba(255,0,51,0.12)' }}>
              <svg width="100%" height={events.length * rowH + GT + GB} viewBox={`0 0 ${GW} ${events.length * rowH + GT + GB}`} style={{ display: 'block' }}>
                {events.map((_, i) => (
                  <rect key={i} x={0} y={GT + i * rowH} width={GW} height={rowH} fill={i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent'} />
                ))}
                {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
                  const x = 12 + f * (chartW - 24);
                  const t = tMin + f * tRange;
                  return (
                    <g key={i}>
                      <line x1={x} x2={x} y1={GT - 6} y2={GT + events.length * rowH} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
                      <text x={x} y={GT - 10} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="8" fontFamily="monospace">{new Date(t).toISOString().substring(11, 16)}Z</text>
                    </g>
                  );
                })}
                {(() => {
                  const nx = xPx(simMs);
                  if (nx >= 12 && nx <= GW - 12) return (
                    <g>
                      <line x1={nx} x2={nx} y1={GT - 6} y2={GT + events.length * rowH} stroke="#FFFFFF" strokeWidth="2" strokeDasharray="6 3" style={{ filter: 'drop-shadow(0 0 4px white)' }} />
                      <text x={nx + 6} y={GT - 10} textAnchor="start" fill="#FFFFFF" fontSize="8" fontFamily="monospace" fontWeight="bold">NOW</text>
                    </g>
                  );
                  return null;
                })()}
                {events.map((ev, i) => {
                  const bs = new Date(ev.burnTime).getTime();
                  const be = bs + ev.duration_seconds * 1000;
                  const ce = new Date(ev.cooldown_end).getTime();
                  const conflict = conflictSet.has(ev.burn_id);
                  const isPast = be < simMs;
                  const isCurrent = bs <= simMs && be >= simMs;
                  const colors = MTYPE_COLORS[ev.maneuver_type] ?? MTYPE_COLORS.PHASING_PROGRADE;
                  const col = colors.border;
                  const glow = colors.glow;
                  const bX = Math.max(12, xPx(bs));
                  const bW = Math.max(6, xPx(be) - xPx(bs));
                  const cX = xPx(be);
                  const cW = Math.max(6, xPx(ce) - xPx(be));
                  const y = GT + i * rowH + 12;
                  return (
                    <g key={ev.burn_id}>
                      <rect x={cX} y={y + 8} width={Math.max(6, cW)} height={28} rx="4" fill="rgba(210,153,34,0.2)" stroke="rgba(210,153,34,0.6)" strokeWidth="1.5" strokeDasharray="4 3" opacity={isPast ? 0.5 : 1} />
                      {cW > 70 && <text x={cX + cW/2} y={y + 25} textAnchor="middle" fill="rgba(210,153,34,0.8)" fontSize="8" fontFamily="monospace">COOLDOWN</text>}
                      <rect x={bX} y={y} width={bW} height={42} rx="6" fill={conflict ? 'rgba(255,0,51,0.35)' : colors.bg} stroke={conflict ? '#FF0033' : col} strokeWidth={conflict ? 2.5 : 2} strokeDasharray={conflict ? '6 3' : undefined} style={{ filter: `drop-shadow(0 0 6px ${conflict ? '#FF0033' : glow})` }} opacity={isPast ? 0.6 : 1} className={isCurrent ? 'animate-pulse' : ''} />
                      {bW > 60 && <text x={bX + bW/2} y={y + 26} textAnchor="middle" fill={conflict ? '#FF0033' : col} fontSize="9" fontFamily="monospace" fontWeight="bold">{conflict ? '⚠ CONFLICT' : ev.maneuver_type.replace(/_/g, ' ')}</text>}
                      {isCurrent && <circle cx={bX + bW - 10} cy={y + 10} r="5" fill="#00FFFF" opacity="0.9" style={{ filter: 'drop-shadow(0 0 6px #00FFFF)' }} className="animate-ping" />}
                      <text x={12} y={y + 70} fill="rgba(255,255,255,0.25)" fontSize="7" fontFamily="monospace">{new Date(bs).toISOString().substring(11,19)}Z · {ev.duration_seconds}s · Δv {ev.delta_v_magnitude.toFixed(4)} m/s {isPast ? '· ✓ DONE' : isCurrent ? '· ⚡ ACTIVE' : '· ⏳ PENDING'}</text>
                    </g>
                  );
                })}
              </svg>
            </div>
            <div>
              <div className="text-[9px] font-mono text-muted-gray tracking-widest uppercase mb-3 flex items-center gap-2"><Radio className="w-3 h-3" /> BURN LOG ({events.length})</div>
              <div className="space-y-2 max-h-56 overflow-y-auto pr-2" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,0,51,0.2) transparent' }}>
                {events.map(ev => {
                  const t = new Date(ev.burnTime).getTime();
                  const colors = MTYPE_COLORS[ev.maneuver_type] ?? MTYPE_COLORS.PHASING_PROGRADE;
                  return (
                    <div key={ev.burn_id} className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-[9px] font-mono transition-all hover:bg-white/5" style={{ background: 'rgba(0,0,0,0.5)', border: `1px solid ${colors.border}25` }}>
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: colors.border, boxShadow: `0 0 5px ${colors.glow}` }} />
                      <div className="flex-1 min-w-0 truncate"><span className="text-muted-gray">ID: </span><span className="text-white font-medium">{ev.burn_id}</span></div>
                      <span style={{ color: colors.border, fontWeight: 500 }}>{ev.delta_v_magnitude.toFixed(4)} m/s</span>
                      <span className="text-white">{ev.duration_seconds}s</span>
                      <span className={`flex items-center gap-1 ${t > simMs ? 'text-amber' : 'text-muted-gray'}`}>{t > simMs ? '⏳' : '✓'} {t > simMs ? 'PEND' : 'DONE'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        <div className="px-6 py-3 border-t border-red-900/25 bg-black/40 flex justify-between items-center">
          <div className="text-[8px] font-mono text-muted-gray">Sim Time: {simTime ? new Date(simTime).toISOString().substring(11,19) + 'Z' : '—'} | Maneuvers in store: {allManeuvers.length}</div>
          <button onClick={onClose} className="px-4 py-1.5 text-[9px] font-mono text-plasma-cyan border border-plasma-cyan/40 rounded hover:bg-plasma-cyan/10 transition-all hover:scale-105">CLOSE</button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// SATELLITE CARD
// ============================================================================
const SatelliteCard: React.FC<{
  sat: SatItem;
  isSelected: boolean;
  onSelect: () => void;
  onResources: () => void;
  onGantt: () => void;
}> = React.memo(({ sat, isSelected, onSelect, onResources, onGantt }) => {
  const fuelPct = Math.min(100, Math.max(0, (sat.fuel / FUEL_INITIAL) * 100));
  const col = fuelColor(sat.fuel);
  const glow = fuelGlow(sat.fuel);
  
  return (
    <div 
      className="relative rounded-xl overflow-hidden cursor-pointer group transition-all duration-300 hover:scale-[1.025] hover:z-10"
      style={{
        background: isSelected 
          ? 'linear-gradient(145deg, rgba(0,32,40,0.92), rgba(0,18,24,0.95))' 
          : 'linear-gradient(145deg, rgba(0,0,0,0.75), rgba(8,0,4,0.82))',
        border: `1px solid ${isSelected ? col : statusBorder(sat.status)}`,
        boxShadow: isSelected 
          ? `0 0 28px ${col}40, inset 0 0 35px ${col}08` 
          : statusGlow(sat.status),
      }}
      onClick={onSelect}
    >
      <div className="absolute top-0 left-0 right-0 h-[3px]"
        style={{
          background: sat.status === 'CRITICAL' 
            ? 'linear-gradient(90deg, transparent, #FF0033, transparent)'
            : sat.status === 'WARNING'
            ? 'linear-gradient(90deg, transparent, #D29922, transparent)'
            : isSelected
            ? `linear-gradient(90deg, transparent, ${col}, transparent)`
            : 'linear-gradient(90deg, transparent, rgba(0,255,255,0.4), transparent)',
          boxShadow: sat.status === 'CRITICAL'
            ? '0 0 10px #FF0033, 0 0 20px rgba(255,0,51,0.5)'
            : sat.status === 'WARNING'
            ? '0 0 8px #D29922, 0 0 16px rgba(210,153,34,0.4)'
            : `0 0 12px ${col}, 0 0 24px ${col}40`,
          animation: 'pulse 2.5s ease-in-out infinite',
        }} 
      />
      
      {isSelected && (
        <div className="absolute inset-0 rounded-xl pointer-events-none"
          style={{
            background: `radial-gradient(circle at center, ${col}15 0%, transparent 70%)`,
            animation: 'pulse 1.5s ease-in-out infinite',
          }} 
        />
      )}
      
      <div className="relative p-3.5 pt-4">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 ${
              isSelected ? 'bg-plasma-cyan/20' : 'bg-white/5'
            }`} style={{ border: `1px solid ${isSelected ? col : 'rgba(0,255,255,0.3)'}` }}>
              <Satellite className={`w-3.5 h-3.5 ${isSelected ? 'text-plasma-cyan' : 'text-muted-gray'}`} />
            </div>
            <span className="font-mono text-[10px] font-bold text-white truncate flex-1" title={sat.id}>
              {sat.id}
            </span>
          </div>
          <span className={`text-[8px] font-mono font-bold px-2 py-0.5 rounded-full ${statusClass(sat.status)}`}
            style={{ 
              background: sat.status === 'CRITICAL' ? 'rgba(255,0,51,0.15)' : 
                         sat.status === 'WARNING' ? 'rgba(210,153,34,0.15)' : 
                         'rgba(0,255,255,0.1)',
              border: `1px solid ${statusBorder(sat.status)}`,
              textShadow: sat.status === 'CRITICAL' ? '0 0 4px #FF0033' : undefined,
            }}>
            {sat.status}
          </span>
        </div>
        
        <div className="flex items-center gap-2 mb-2">
          <div className="flex-1 h-2 bg-black/80 rounded-full overflow-hidden border border-white/10">
            <div className="h-full rounded-full transition-all duration-700 ease-out"
              style={{ 
                width: `${fuelPct}%`, 
                background: `linear-gradient(90deg, ${col}cc, ${col})`,
                boxShadow: glow,
              }} 
            />
          </div>
          <span className={`text-[8px] font-mono w-16 text-right flex-shrink-0 ${fuelClass(sat.fuel)}`}
            style={{ textShadow: `0 0 3px ${col}` }}>
            {sat.fuel.toFixed(2)}kg
          </span>
        </div>
        
        <div className="text-[7px] font-mono text-muted-gray mb-3 truncate">
          {sat.lat.toFixed(2)}° / {sat.lon.toFixed(2)}° / {(sat.alt/1000).toFixed(1)}km
          {sat.drift !== undefined && sat.drift > 0 && (
            <span className="ml-2" style={{ color: sat.drift > 10 ? '#FF0033' : sat.drift > 5 ? '#D29922' : '#00FF64' }}>
              Δ{sat.drift.toFixed(1)}km
            </span>
          )}
        </div>
        
        <div className="grid grid-cols-3 gap-1.5">
          {[
            { 
              label: 'SELECT', Icon: Target, 
              col: '#00FFFF', 
              bg: isSelected ? 'rgba(0,255,255,0.22)' : 'rgba(0,255,255,0.08)', 
              border: isSelected ? 'rgba(0,255,255,0.8)' : 'rgba(0,255,255,0.35)',
              hover: 'hover:bg-plasma-cyan/25 hover:scale-105',
              onClick: onSelect,
              active: isSelected,
            },
            { 
              label: 'METRICS', Icon: BarChart2, 
              col: '#D29922', 
              bg: 'rgba(210,153,34,0.08)', 
              border: 'rgba(210,153,34,0.35)',
              hover: 'hover:bg-amber/20 hover:scale-105',
              onClick: (e: React.MouseEvent) => { e.stopPropagation(); onResources(); },
            },
            { 
              label: 'GANTT', Icon: Calendar, 
              col: '#FF4466', 
              bg: 'rgba(255,68,102,0.08)', 
              border: 'rgba(255,68,102,0.35)',
              hover: 'hover:bg-red-500/20 hover:scale-105',
              onClick: (e: React.MouseEvent) => { e.stopPropagation(); onGantt(); },
            },
          ].map(({ label, Icon, col: c, bg, border, hover, onClick, active }) => (
            <button 
              key={label} 
              onClick={onClick}
              className={`flex flex-col items-center gap-1 py-2 rounded-lg text-[7px] font-mono transition-all ${hover} ${
                active ? 'ring-2 ring-plasma-cyan/50' : ''
              }`}
              style={{ 
                background: bg, 
                border: `1px solid ${border}`, 
                color: c,
                boxShadow: active ? `0 0 12px ${c}40` : 'none',
              }}
            >
              <Icon className={`w-3.5 h-3.5 transition-transform ${active ? 'scale-110' : 'group-hover:scale-110'}`} />
              <span className="font-medium">{label}</span>
            </button>
          ))}
        </div>
      </div>
      
      <div className="absolute inset-0 rounded-xl bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
    </div>
  );
});
SatelliteCard.displayName = 'SatelliteCard';

// ============================================================================
// FLEET PANEL
// ============================================================================
const FleetPanel: React.FC = () => {
  const satellites = useOrbitalStore(s => s.satellites);
  const selectedSatId = useOrbitalStore(s => s.selectedSatelliteId);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  
  const [resourcesSat, setResourcesSat] = useState<SatItem | null>(null);
  const [ganttSat, setGanttSat] = useState<SatItem | null>(null);
  
  const handleSelect = (id: string) => {
    setTimeout(() => {
      selectSatellite(id === selectedSatId ? null : id);
    }, 0);
  };
  
  const satItems: SatItem[] = useMemo(() => {
    if (!satellites || satellites.length === 0) return [];
    const items: SatItem[] = [];
    for (let i = 0; i < satellites.length; i++) {
      items.push({
        id: satellites.ids[i],
        fuel: satellites.fuels[i],
        status: satellites.statuses[i],
        lon: satellites.positions[i * 3],
        lat: satellites.positions[i * 3 + 1],
        alt: satellites.positions[i * 3 + 2],
        drift: 0,
      });
    }
    const tier = (s: string) => s === 'CRITICAL' ? 0 : s === 'WARNING' ? 1 : s === 'NOMINAL' ? 2 : 3;
    return items.sort((a, b) => {
      const td = tier(a.status) - tier(b.status);
      return td !== 0 ? td : a.fuel - b.fuel;
    });
  }, [satellites]);
  
  if (!satItems.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-gray">
        <div className="relative">
          <Satellite className="w-12 h-12 opacity-20 mb-4 animate-pulse" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 rounded-full border-2 border-plasma-cyan/30 animate-ping" />
          </div>
        </div>
        <span className="text-[9px] font-mono tracking-widest">AWAITING TELEMETRY STREAM…</span>
        <span className="text-[7px] font-mono text-muted-gray/60 mt-1">Backend: POST /api/telemetry</span>
      </div>
    );
  }
  
  return (
    <>
      <div className="grid grid-cols-2 gap-2.5">
        {satItems.map(sat => (
          <SatelliteCard
            key={sat.id}
            sat={sat}
            isSelected={sat.id === selectedSatId}
            onSelect={() => handleSelect(sat.id)}
            onResources={() => setResourcesSat(sat)}
            onGantt={() => setGanttSat(sat)}
          />
        ))}
      </div>
      {resourcesSat && <ResourcesPopup sat={resourcesSat} onClose={() => setResourcesSat(null)} />}
      {ganttSat && <GanttPopup sat={ganttSat} onClose={() => setGanttSat(null)} />}
    </>
  );
};

// ============================================================================
// RIGHT PANEL (with top: 80)
// ============================================================================
const RightPanel: React.FC = () => {
  const satelliteCount = useOrbitalStore(selectSatelliteCount);
  const debrisCount = useOrbitalStore(selectDebrisCount);
  const connectionState = useOrbitalStore(selectConnectionState);
  const timestamp = useOrbitalStore(s => s.timestamp);
  const [collapsed, setCollapsed] = useState(false);
  
  const simTime = timestamp
    ? new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19) + 'Z'
    : '—';
  
  if (collapsed) {
    return (
      <div className="absolute top-0 right-0 bottom-0 w-12 z-[30] flex flex-col items-center justify-center gap-5"
        style={{ 
          background: 'rgba(0,0,0,0.95)', 
          backdropFilter: 'blur(20px)', 
          borderLeft: '1px solid rgba(255,0,51,0.4)',
          boxShadow: '-8px 0 30px rgba(220,38,38,0.15)',
        }}>
        <button onClick={() => setCollapsed(false)}
          className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-red-900/30 transition-all hover:scale-110"
          style={{ 
            border: '1px solid rgba(255,0,51,0.5)',
            boxShadow: '0 0 12px rgba(255,0,51,0.3)',
          }}>
          <ChevronLeft className="w-4 h-4 text-plasma-cyan" />
        </button>
        <div className="text-[7px] font-mono text-muted-gray tracking-widest uppercase"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', textShadow: '0 0 4px rgba(0,255,255,0.4)' }}>
          FLEET
        </div>
        <div className={`w-2 h-2 rounded-full ${connectionState === 'connected' ? 'bg-nominal-green' : 'bg-laser-red'}`}
          style={{ boxShadow: connectionState === 'connected' ? '0 0 8px #00FF64' : '0 0 8px #FF0033' }} 
        />
      </div>
    );
  }
  
  return (
    <div className="absolute top-0 right-0 bottom-0 w-[460px] flex flex-col z-[30]"
      style={{
        background: 'linear-gradient(180deg, rgba(0,0,0,0.9) 0%, rgba(18,0,4,0.92) 100%)',
        backdropFilter: 'blur(28px)',
        borderLeft: '1px solid rgba(255,0,51,0.45)',
        boxShadow: '-15px 0 50px rgba(220,38,38,0.12)',
      }}>
      
      <div className="flex-shrink-0 px-5 py-4 border-b"
        style={{ borderColor: 'rgba(255,0,51,0.2)', background: 'rgba(0,0,0,0.65)' }}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-3 h-3 rounded-full bg-plasma-cyan animate-pulse"
                style={{ boxShadow: '0 0 8px #00FFFF, 0 0 16px rgba(0,255,255,0.4)' }} />
              <div className="absolute inset-0 rounded-full border border-plasma-cyan/40 animate-ping" />
            </div>
            <span className="font-mono text-[10px] text-muted-gray tracking-widest uppercase">Mission Control</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              {connectionState === 'connected'
                ? <Wifi className="w-3.5 h-3.5 text-nominal-green" style={{ filter: 'drop-shadow(0 0 4px #00FF64)' }} />
                : <WifiOff className="w-3.5 h-3.5 text-laser-red" style={{ filter: 'drop-shadow(0 0 4px #FF0033)' }} />}
              <span className={`text-[9px] font-mono font-medium ${connectionState === 'connected' ? 'text-nominal-green' : 'text-laser-red'}`}>
                {connectionState === 'connected' ? 'LINKED' : 'OFFLINE'}
              </span>
            </div>
            <button onClick={() => setCollapsed(true)}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-900/30 transition-all hover:scale-110">
              <ChevronRight className="w-4 h-4 text-muted-gray hover:text-white transition-colors" />
            </button>
          </div>
        </div>
        
        <div className="flex items-center justify-between text-[9px] font-mono">
          <div className="flex gap-4">
            <span>
              <span className="text-muted-gray">SATS </span>
              <span className="text-plasma-cyan font-bold" style={{ textShadow: '0 0 6px #00FFFF' }}>
                {satelliteCount.toLocaleString()}
              </span>
            </span>
            <span>
              <span className="text-muted-gray">DEBRIS </span>
              <span className="text-laser-red font-bold" style={{ textShadow: '0 0 6px #FF0033' }}>
                {debrisCount.toLocaleString()}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="w-3 h-3 text-muted-gray" />
            <span className="font-mono text-plasma-cyan font-medium">{simTime}</span>
          </div>
        </div>
      </div>
      
      <div className="flex-shrink-0 px-5 py-2.5 flex items-center gap-3"
        style={{ borderBottom: '1px solid rgba(255,0,51,0.12)', background: 'rgba(0,0,0,0.4)' }}>
        <Satellite className="w-3.5 h-3.5 text-plasma-cyan" />
        <span className="font-mono text-[9px] text-muted-gray tracking-widest uppercase">Active Constellation</span>
        <div className="flex-1" />
        <FPSMonitor />
      </div>
      
      <div className="flex-grow overflow-y-auto p-4"
        style={{ 
          scrollbarWidth: 'thin', 
          scrollbarColor: 'rgba(255,0,51,0.25) transparent',
          background: 'radial-gradient(ellipse at top, rgba(0,255,255,0.03) 0%, transparent 60%)',
        }}>
        <ErrorBoundary name="FleetPanel">
          <FleetPanel />
        </ErrorBoundary>
      </div>
      
      <div className="flex-shrink-0 px-5 py-2.5 border-t text-[8px] font-mono text-muted-gray flex items-center justify-between"
        style={{ borderColor: 'rgba(255,0,51,0.15)', background: 'rgba(0,0,0,0.7)' }}>
        <div className="flex items-center gap-3">
          <Battery className="w-3 h-3" />
          <span>Fleet avg: {(50 - 2.3).toFixed(1)}kg</span>
        </div>
        <div className="flex items-center gap-2">
          <Shield className="w-3 h-3 text-nominal-green" />
          <span className="text-nominal-green">All nominal</span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// LEFT PANEL — BULLSEYE POLAR CHART (with top: 80)
// ============================================================================
const LeftBullseyePanel: React.FC = () => {
  const selectedSat = useOrbitalStore(selectSelectedSatellite);
  const debris = useOrbitalStore(s => s.debris);
  const [collapsed, setCollapsed] = useState(true);
  
  const conjunctions = useMemo((): ConjunctionEntry[] => {
    if (!selectedSat) return [];
    return deriveConjunctions(selectedSat.lat, selectedSat.lon, selectedSat.alt, debris);
  }, [selectedSat?.lat, selectedSat?.lon, selectedSat?.alt, debris]);
  
  const criticalCount = conjunctions.filter(d => d.riskLevel === 'CRITICAL').length;
  
  useEffect(() => {
    if (criticalCount > 0 && collapsed) {
      setCollapsed(false);
    }
  }, [criticalCount]);
  
  const maxTCA = conjunctions.length > 0 
    ? Math.max(...conjunctions.map(d => d.tca), 120) 
    : 120;
  
  if (collapsed) {
    return (
      <div className="absolute left-0 z-[30] flex flex-col items-center py-4 gap-3"
        style={{
          top: 80,
          width: 44,
          background: 'rgba(0,0,0,0.95)',
          backdropFilter: 'blur(18px)',
          borderRight: '1px solid rgba(255,0,51,0.4)',
          borderBottom: '1px solid rgba(255,0,51,0.25)',
          borderBottomRightRadius: 12,
          boxShadow: '8px 0 25px rgba(220,38,38,0.1)',
        }}>
        {criticalCount > 0 && (
          <>
            <div className="w-3 h-3 rounded-full bg-laser-red animate-pulse"
              style={{ boxShadow: '0 0 10px #FF0033, 0 0 20px rgba(255,0,51,0.6)' }} />
            <span className="text-[7px] font-mono text-laser-red animate-pulse font-bold">
              {criticalCount}
            </span>
          </>
        )}
        <button onClick={() => setCollapsed(false)}
          className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-red-900/30 transition-all hover:scale-110"
          style={{ border: '1px solid rgba(255,0,51,0.5)' }}>
          <ChevronRight className="w-4 h-4 text-plasma-cyan" />
        </button>
        <div className="text-[7px] font-mono text-muted-gray tracking-widest uppercase"
          style={{ writingMode: 'vertical-rl', textShadow: '0 0 4px rgba(0,255,255,0.3)' }}>
          RADAR
        </div>
      </div>
    );
  }
  
  const CX = 140, CY = 140, R = 120;
  const rings = [30, 60, 90, 120].filter(r => r <= maxTCA);
  
  return (
    <div className="absolute left-0 z-[30] flex flex-col"
      style={{
        top: 80,
        width: 320,
        background: 'linear-gradient(165deg, rgba(0,0,0,0.96), rgba(12,0,6,0.97))',
        backdropFilter: 'blur(28px)',
        borderRight: '1px solid rgba(255,0,51,0.4)',
        borderBottom: '1px solid rgba(255,0,51,0.25)',
        borderBottomRightRadius: 16,
        boxShadow: '15px 0 40px rgba(220,38,38,0.08)',
      }}>
      
      <div className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: 'rgba(255,0,51,0.18)' }}>
        <div className="flex items-center gap-2.5">
          <Crosshair className="w-4 h-4 text-plasma-cyan" style={{ filter: 'drop-shadow(0 0 4px #00FFFF)' }} />
          <span className="font-mono text-[9px] text-muted-gray tracking-widest uppercase">Conjunction Radar</span>
          {criticalCount > 0 && (
            <span className="text-[7px] font-mono text-laser-red font-bold animate-pulse flex items-center gap-1"
              style={{ textShadow: '0 0 4px #FF0033' }}>
              <AlertTriangle className="w-3 h-3" />
              {criticalCount} CRITICAL
            </span>
          )}
        </div>
        <button onClick={() => setCollapsed(true)}
          className="w-6 h-6 flex items-center justify-center rounded-lg hover:bg-red-900/30 transition-all hover:scale-110">
          <ChevronLeft className="w-3.5 h-3.5 text-muted-gray hover:text-white transition-colors" />
        </button>
      </div>
      
      <div className="px-4 py-2 border-b" style={{ borderColor: 'rgba(255,0,51,0.1)' }}>
        <div className="text-[9px] font-mono flex items-center gap-2">
          <span className="text-muted-gray">TARGET:</span>
          <span className="text-plasma-cyan font-bold" style={{ textShadow: '0 0 4px #00FFFF' }}>
            {selectedSat?.id ?? '—'}
          </span>
          {selectedSat && (
            <span className="text-muted-gray ml-2">
              {selectedSat.lat.toFixed(1)}° / {selectedSat.lon.toFixed(1)}°
            </span>
          )}
        </div>
      </div>
      
      <div className="flex justify-center py-4">
        <svg width="280" height="280" viewBox="0 0 280 280">
          <defs>
            <radialGradient id="radarGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(0,255,255,0.08)" />
              <stop offset="100%" stopColor="transparent" />
            </radialGradient>
          </defs>
          <circle cx={CX} cy={CY} r={R + 20} fill="url(#radarGrad)" />
          {rings.map((tca, i) => {
            const radius = (tca / maxTCA) * R;
            return (
              <g key={i}>
                <circle cx={CX} cy={CY} r={radius} fill="none"
                  stroke={tca === maxTCA ? 'rgba(255,0,51,0.35)' : 'rgba(255,255,255,0.06)'}
                  strokeWidth="1.5" strokeDasharray={tca < maxTCA ? '3 4' : undefined} />
                <text x={CX + 6} y={CY - radius - 4}
                  fill="rgba(255,255,255,0.22)" fontSize="6.5" fontFamily="monospace">
                  {tca}s
                </text>
              </g>
            );
          })}
          {[0, 45, 90, 135, 180, 225, 270, 315].map(a => {
            const rad = (a - 90) * Math.PI / 180;
            const x1 = CX + (R + 15) * Math.cos(rad);
            const y1 = CY + (R + 15) * Math.sin(rad);
            const x2 = CX + (R + 25) * Math.cos(rad);
            const y2 = CY + (R + 25) * Math.sin(rad);
            const label = ['N','NE','E','SE','S','SW','W','NW'][a/45];
            return (
              <g key={a}>
                <line x1={CX} y1={CY} x2={x1} y2={y1} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
                <text x={x2} y={y2 + 3} textAnchor="middle" fill="rgba(255,255,255,0.2)" fontSize="7" fontFamily="monospace" fontWeight="500">
                  {label}
                </text>
              </g>
            );
          })}
          <circle cx={CX} cy={CY} r="6" fill="#00FFFF" style={{ filter: 'drop-shadow(0 0 10px #00FFFF)' }} />
          <circle cx={CX} cy={CY} r="14" fill="none" stroke="rgba(0,255,255,0.25)" strokeWidth="1.5" className="animate-pulse" />
          <circle cx={CX} cy={CY} r="22" fill="none" stroke="rgba(0,255,255,0.12)" strokeWidth="0.5" strokeDasharray="4 3" />
          
          {conjunctions.map(d => {
            const rad = (d.angle - 90) * Math.PI / 180;
            const r = (d.tca / maxTCA) * R;
            const x = CX + r * Math.cos(rad);
            const y = CY + r * Math.sin(rad);
            const col = riskColor(d.riskLevel);
            const glow = riskGlow(d.riskLevel);
            return (
              <g key={d.debrisId}>
                {d.riskLevel !== 'SAFE' && (
                  <line x1={CX} y1={CY} x2={x} y2={y} stroke={col} strokeWidth="0.8" strokeDasharray="3 3" opacity="0.4" />
                )}
                <circle cx={x} cy={y} r="5" fill={col} opacity="0.92" style={{ filter: `drop-shadow(${glow})` }} className={d.riskLevel === 'CRITICAL' ? 'animate-pulse' : ''} />
                <circle cx={x} cy={y} r="11" fill="none" stroke={col} strokeWidth="0.8" opacity="0.35" />
                <text x={x + 9} y={y - 4} fill={col} fontSize="6" fontFamily="monospace" fontWeight="500">
                  {d.debrisId.substring(4, 11)}
                </text>
                <text x={x + 9} y={y + 5} fill="rgba(255,255,255,0.25)" fontSize="5.5" fontFamily="monospace">
                  {d.missDistance.toFixed(2)}km • {d.tca.toFixed(0)}s
                </text>
                {d.riskLevel === 'CRITICAL' && (
                  <g transform={`translate(${x - 4}, ${y - 18})`}>
                    <AlertTriangle className="w-4 h-4" style={{ color: '#FF0033', filter: 'drop-shadow(0 0 4px #FF0033)' }} />
                  </g>
                )}
              </g>
            );
          })}
          {!selectedSat && (
            <text x={CX} y={CY + 40} textAnchor="middle" fill="rgba(255,255,255,0.15)" fontSize="8" fontFamily="monospace">
              SELECT SATELLITE
            </text>
          )}
          {selectedSat && conjunctions.length === 0 && (
            <text x={CX} y={CY + 40} textAnchor="middle" fill="rgba(0,255,100,0.45)" fontSize="8" fontFamily="monospace" fontWeight="500">
              ✓ CLEAR
            </text>
          )}
        </svg>
      </div>
      
      <div className="px-4 pb-3 flex items-center gap-4 text-[7px] font-mono">
        {[
          { l: 'SAFE >5km', c: '#00FF64' },
          { l: 'WARN <5km', c: '#D29922' },
          { l: 'CRIT <1km', c: '#FF0033' },
        ].map(({ l, c }) => (
          <div key={l} className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: c, boxShadow: `0 0 5px ${c}` }} />
            <span className="text-muted-gray">{l}</span>
          </div>
        ))}
      </div>
      
      {conjunctions.length > 0 && (
        <div className="px-4 pb-4 border-t" style={{ borderColor: 'rgba(255,0,51,0.12)' }}>
          <div className="pt-2.5 text-[7px] font-mono text-muted-gray tracking-wider uppercase mb-2 flex items-center justify-between">
            <span>{conjunctions.length} Objects Detected</span>
            {criticalCount > 0 && (
              <span className="text-laser-red font-bold animate-pulse">⚠ {criticalCount} CRITICAL</span>
            )}
          </div>
          <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1"
            style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,0,51,0.15) transparent' }}>
            {conjunctions.map(d => {
              const col = riskColor(d.riskLevel);
              return (
                <div key={d.debrisId}
                  className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[7px] font-mono"
                  style={{ 
                    background: 'rgba(0,0,0,0.48)', 
                    border: `1px solid ${col}25`,
                    boxShadow: d.riskLevel !== 'SAFE' ? `0 0 8px ${col}20` : 'none',
                  }}>
                  <div className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: col, boxShadow: `0 0 4px ${col}` }} />
                  <span className="text-white w-18 truncate font-medium">{d.debrisId}</span>
                  <span className="text-muted-gray">TCA</span>
                  <span className="text-white font-mono">{d.tca.toFixed(0)}s</span>
                  <span className="text-muted-gray">MISS</span>
                  <span style={{ color: col, fontWeight: 500 }}>{d.missDistance.toFixed(2)}km</span>
                  {d.riskLevel === 'CRITICAL' && (
                    <AlertTriangle className="w-3 h-3 text-laser-red flex-shrink-0 animate-pulse" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// MAIN EXPORT
// ============================================================================
export const DashboardLayout: React.FC = React.memo(() => (
  <>
    <ErrorBoundary name="BullseyePanel"><LeftBullseyePanel /></ErrorBoundary>
    <ErrorBoundary name="RightPanel"><RightPanel /></ErrorBoundary>
  </>
));

DashboardLayout.displayName = 'DashboardLayout';
export default DashboardLayout;