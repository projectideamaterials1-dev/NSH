// src/components/DashboardLayout.tsx
// NSH 2026 – Mission Control v5 | Crimson Nebula
// STORE SYNC: positions[i*3]=lon, [i*3+1]=lat, [i*3+2]=alt_m | fuels | statuses | fuelHistory | maneuvers
// RIGHT PANEL: 2-col satellite grid (SELECT/METRICS/GANTT) | fully scrollable | collapsible
// LEFT PANEL:  Bullseye polar chart | auto-opens on critical conjunction | collapsible
// Graphs: pure SVG — no recharts

import React, {
  useState, useMemo, useEffect, useRef, useCallback,
  Component, ErrorInfo, ReactNode,
} from 'react';
import {
  ChevronRight, ChevronLeft, Clock, Wifi, WifiOff,
  Satellite, Target, BarChart2, Calendar, X,
  Crosshair, Zap, TrendingUp, Activity,
} from 'lucide-react';
import useOrbitalStore, {
  selectSatelliteCount,
  selectDebrisCount,
  selectConnectionState,
  selectSelectedSatellite,
} from '../store/useOrbitalStore';
import type { ManeuverEvent, DebrisBinaryData } from '../store/useOrbitalStore';

// ─────────────────────────────────────────────────────────────────────────────
// ERROR BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────

class ErrorBoundary extends Component<
  { children: ReactNode; name: string },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(e: Error, i: ErrorInfo) { console.error('[DashboardLayout]', e, i); }
  render() {
    if (this.state.hasError)
      return <div className="p-3 text-[9px] font-mono text-laser-red text-center opacity-60">⚠ {this.props.name} error</div>;
    return this.props.children;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface SatItem {
  id: string;
  fuel: number;
  status: string;
  lat: number;
  lon: number;
  alt: number; // metres (from positions[i*3+2])
}

interface ConjunctionEntry {
  debrisId: string;
  tca: number;
  angle: number;
  missDistance: number;
  collisionProb: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const FUEL_INITIAL = 50.0;

const fuelColor = (f: number) => f < 5 ? '#FF0033' : f < 15 ? '#D29922' : '#00FFFF';
const fuelClass = (f: number) =>
  f < 5 ? 'text-laser-red font-bold animate-pulse' : f < 15 ? 'text-amber' : 'text-plasma-cyan';
const statusBorder = (s: string) =>
  s === 'CRITICAL' ? 'rgba(255,0,51,0.7)' : s === 'WARNING' ? 'rgba(210,153,34,0.5)' : 'rgba(0,255,255,0.25)';
const statusGlow = (s: string) =>
  s === 'CRITICAL' ? 'rgba(255,0,51,0.4)' : s === 'WARNING' ? 'rgba(210,153,34,0.28)' : 'rgba(0,255,255,0.1)';
const statusClass = (s: string) =>
  s === 'CRITICAL' ? 'text-laser-red animate-pulse' : s === 'WARNING' ? 'text-amber' :
  s === 'NOMINAL' ? 'text-nominal-green' : 'text-muted-gray';

function fmtISO(ms: number) {
  return new Date(ms).toISOString().replace('T', ' ').substring(0, 19) + 'Z';
}
function fmtDur(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Haversine-based conjunction derivation from store.debris
function deriveConjunctions(
  satLat: number, satLon: number,
  debris: DebrisBinaryData | null
): ConjunctionEntry[] {
  if (!debris || debris.length === 0) return [];
  const REL_VEL = 7.5; // km/s typical LEO closure
  const results: ConjunctionEntry[] = [];
  const phi1 = satLat * Math.PI / 180;
  const cosPhi1 = Math.cos(phi1);

  for (let i = 0; i < debris.length; i++) {
    const dLon = debris.positions[i * 3];     // lon stored at stride 0
    const dLat = debris.positions[i * 3 + 1]; // lat stored at stride 1

    if (Math.abs(dLat - satLat) > 8) continue;
    let dl = Math.abs(dLon - satLon);
    if (dl > 180) dl = 360 - dl;
    if (dl > 8) continue;

    const phi2 = dLat * Math.PI / 180;
    const dlambda = (dLon - satLon) * Math.PI / 180;
    const a = Math.sin((phi2 - phi1) / 2) ** 2 + cosPhi1 * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
    const distKm = 2 * Math.asin(Math.sqrt(Math.min(1, a))) * 6371;
    if (distKm > 80) continue;

    const tca = distKm / REL_VEL;
    if (tca > 120) continue;

    let ang = Math.atan2(dLat - satLat, dLon - satLon) * 180 / Math.PI;
    if (ang < 0) ang += 360;

    results.push({
      debrisId: debris.ids[i],
      tca,
      angle: ang,
      missDistance: distKm,
      collisionProb: distKm < 1 ? 0.15 : distKm < 5 ? 0.05 : 0.001,
    });
  }
  return results.sort((a, b) => a.tca - b.tca).slice(0, 60);
}

// ─────────────────────────────────────────────────────────────────────────────
// FPS MONITOR
// ─────────────────────────────────────────────────────────────────────────────

const FPSMonitor: React.FC = () => {
  const [fps, setFps] = useState(60);
  const frames = useRef(0);
  const t0 = useRef(performance.now());
  const raf = useRef<number>(0);

  useEffect(() => {
    const tick = () => {
      frames.current++;
      const now = performance.now();
      if (now - t0.current >= 1000) {
        setFps(Math.round((frames.current * 1000) / (now - t0.current)));
        frames.current = 0;
        t0.current = now;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  const c = fps >= 80 ? '#00FFFF' : fps >= 50 ? '#D29922' : '#FF0033';
  return (
    <span className="font-mono text-[9px]">
      <span className="text-muted-gray">FPS </span>
      <span style={{ color: c }}>{fps}</span>
    </span>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SVG FUEL GAUGE ARC
// ─────────────────────────────────────────────────────────────────────────────

const FuelGaugeArc: React.FC<{ fuel: number; size?: number }> = ({ fuel, size = 160 }) => {
  const pct = Math.min(100, Math.max(0, (fuel / FUEL_INITIAL) * 100));
  const col = fuelColor(fuel);
  const cx = size / 2, cy = size * 0.62, R = size * 0.42;
  const startRad = -135 * Math.PI / 180;
  const sweepRad = (pct / 100) * 270 * Math.PI / 180;
  const endRad   = startRad + sweepRad;

  const arc = (a1: number, a2: number, r: number) => {
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${a2 - a1 > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };

  const nA = startRad + (pct / 100) * 270 * Math.PI / 180;
  const nL = R * 0.84;

  return (
    <svg width={size} height={size * 0.72} viewBox={`0 0 ${size} ${size * 0.72}`} style={{ overflow: 'visible' }}>
      <path d={arc(-135 * Math.PI / 180, 135 * Math.PI / 180, R)}
        fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={size * 0.076} strokeLinecap="round" />
      {pct > 0 && (
        <path d={arc(startRad, endRad, R)}
          fill="none" stroke={col} strokeWidth={size * 0.076} strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 ${size * 0.03}px ${col})` }} />
      )}
      {[0, 25, 50, 75, 100].map(p => {
        const a = (-135 + (p / 100) * 270) * Math.PI / 180;
        const r1 = R - size * 0.05, r2 = R + size * 0.025;
        return <line key={p}
          x1={(cx + r1 * Math.cos(a)).toFixed(2)} y1={(cy + r1 * Math.sin(a)).toFixed(2)}
          x2={(cx + r2 * Math.cos(a)).toFixed(2)} y2={(cy + r2 * Math.sin(a)).toFixed(2)}
          stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />;
      })}
      <line x1={cx.toFixed(2)} y1={cy.toFixed(2)}
        x2={(cx + nL * Math.cos(nA)).toFixed(2)} y2={(cy + nL * Math.sin(nA)).toFixed(2)}
        stroke={col} strokeWidth="2.5" strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 4px ${col})` }} />
      <circle cx={cx} cy={cy} r={size * 0.04} fill={col} style={{ filter: `drop-shadow(0 0 6px ${col})` }} />
      <text x={cx - R - 4} y={cy + 6} fill="rgba(255,255,255,0.22)" fontSize={size * 0.07} fontFamily="monospace" textAnchor="end">E</text>
      <text x={cx + R + 4} y={cy + 6} fill="rgba(255,255,255,0.22)" fontSize={size * 0.07} fontFamily="monospace">F</text>
    </svg>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SVG ΔV EFFICIENCY CHART  (fuel consumed vs collisions avoided over time)
// ─────────────────────────────────────────────────────────────────────────────

interface DvPoint { fuelConsumed: number; collisions: number; label: string; }

const DvChart: React.FC<{ data: DvPoint[]; width?: number; height?: number }> = ({
  data, width = 360, height = 130,
}) => {
  const pL = 36, pR = 10, pT = 14, pB = 26;
  const cW = width - pL - pR, cH = height - pT - pB;

  if (data.length < 2) {
    return (
      <div style={{ width, height }} className="flex items-center justify-center">
        <span className="text-[9px] font-mono text-muted-gray">Accumulating telemetry…</span>
      </div>
    );
  }

  const maxF = Math.max(...data.map(d => d.fuelConsumed), 0.01);
  const maxC = Math.max(...data.map(d => d.collisions), 1);
  const n    = data.length;

  const px = (i: number) => pL + (i / (n - 1)) * cW;
  const pyF = (f: number) => pT + cH - Math.min(1, f / maxF) * cH;
  const pyC = (c: number) => pT + cH - Math.min(1, c / maxC) * cH;

  const fuelPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${pyF(d.fuelConsumed).toFixed(1)}`).join(' ');
  const collPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${pyC(d.collisions).toFixed(1)}`).join(' ');
  const fuelFill = `${fuelPath} L${px(n - 1).toFixed(1)},${pT + cH} L${pL},${pT + cH} Z`;

  const xTicks = [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="dvFuelGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00FFFF" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#00FFFF" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
        <line key={i} x1={pL} x2={pL + cW} y1={pT + cH * (1 - f)} y2={pT + cH * (1 - f)}
          stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
      ))}
      {/* Axes */}
      <line x1={pL} x2={pL} y1={pT} y2={pT + cH} stroke="rgba(255,255,255,0.14)" strokeWidth="1" />
      <line x1={pL} x2={pL + cW} y1={pT + cH} y2={pT + cH} stroke="rgba(255,255,255,0.14)" strokeWidth="1" />
      {/* Fuel area fill + line */}
      <path d={fuelFill} fill="url(#dvFuelGrad)" />
      <path d={fuelPath} fill="none" stroke="#00FFFF" strokeWidth="1.5"
        style={{ filter: 'drop-shadow(0 0 3px #00FFFF)' }} />
      {/* Fuel dots at data points */}
      {data.map((d, i) => (
        <circle key={i} cx={px(i)} cy={pyF(d.fuelConsumed)} r="2" fill="#00FFFF" opacity="0.6" />
      ))}
      {/* Collisions avoided dashed step line */}
      <path d={collPath} fill="none" stroke="#D29922" strokeWidth="1.5" strokeDasharray="4 2"
        style={{ filter: 'drop-shadow(0 0 3px #D29922)' }} />
      {/* Collision step dots */}
      {data.map((d, i) => d.collisions > 0 && (
        <circle key={i} cx={px(i)} cy={pyC(d.collisions)} r="3"
          fill="#D29922" style={{ filter: 'drop-shadow(0 0 4px #D29922)' }} />
      ))}
      {/* Y-axis ticks */}
      <text x={pL - 3} y={pT + 4} fill="rgba(255,255,255,0.18)" fontSize="7" fontFamily="monospace" textAnchor="end">{maxF.toFixed(1)}</text>
      <text x={pL - 3} y={pT + cH + 3} fill="rgba(255,255,255,0.18)" fontSize="7" fontFamily="monospace" textAnchor="end">0</text>
      {/* X-axis time labels */}
      {xTicks.map(i => (
        <text key={i} x={px(i)} y={pT + cH + 14} fill="rgba(255,255,255,0.18)"
          fontSize="6.5" fontFamily="monospace" textAnchor="middle">{data[i].label}</text>
      ))}
      {/* Legend */}
      <circle cx={pL + 8} cy={pT + 8} r="3" fill="#00FFFF" />
      <text x={pL + 14} y={pT + 12} fill="#00FFFF" fontSize="6.5" fontFamily="monospace">Fuel consumed (kg)</text>
      <line x1={pL + 116} x2={pL + 128} y1={pT + 8} y2={pT + 8} stroke="#D29922" strokeWidth="2" strokeDasharray="3 2" />
      <text x={pL + 132} y={pT + 12} fill="#D29922" fontSize="6.5" fontFamily="monospace">Collisions avoided</text>
    </svg>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// RESOURCES POPUP
// ─────────────────────────────────────────────────────────────────────────────

const ResourcesPopup: React.FC<{ sat: SatItem; onClose: () => void }> = ({ sat, onClose }) => {
  // Read from store (no lats/lons arrays — use positions stride)
  const fuelHistory  = useOrbitalStore(s => s.fuelHistory);
  const allManeuvers = useOrbitalStore(s => s.maneuvers);

  const satManeuvers = useMemo(() => allManeuvers.filter(m => m.satellite_id === sat.id), [allManeuvers, sat.id]);
  const totalDv      = satManeuvers.reduce((s, m) => s + m.delta_v_magnitude, 0);
  const fuelConsumed = Math.max(0, FUEL_INITIAL - sat.fuel);
  const fuelPct      = Math.min(100, Math.max(0, (sat.fuel / FUEL_INITIAL) * 100));
  const col          = fuelColor(sat.fuel);

  // Build ΔV chart data from fuelHistory
  const dvData: DvPoint[] = useMemo(() => {
    if (fuelHistory.length < 2) return [];
    let collisions = 0;
    return fuelHistory.slice(-30).map(metric => {
      const tMs = new Date(metric.timestamp).getTime();
      collisions = satManeuvers.filter(m => new Date(m.burnTime).getTime() <= tMs).length;
      const consumed = Math.max(0, FUEL_INITIAL - metric.avgFuelKg);
      const d = new Date(metric.timestamp);
      return {
        fuelConsumed: consumed,
        collisions,
        label: `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`,
      };
    });
  }, [fuelHistory, satManeuvers]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.82)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}>
      <div className="relative rounded-2xl overflow-hidden"
        style={{
          width: 440,
          background: 'linear-gradient(140deg,rgba(0,0,0,0.97),rgba(14,0,5,0.99))',
          border: '1px solid rgba(255,0,51,0.45)',
          boxShadow: '0 0 60px rgba(255,0,51,0.1), 0 25px 80px rgba(0,0,0,0.7)',
        }}
        onClick={e => e.stopPropagation()}>
        {/* Glowing top strip */}
        <div className="h-[2px]"
          style={{ background: `linear-gradient(90deg,transparent,${col},transparent)`, boxShadow: `0 0 12px ${col}` }} />

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-red-900/25">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ background: `${col}18`, border: `1px solid ${col}44` }}>
              <Activity className="w-4 h-4" style={{ color: col }} />
            </div>
            <div>
              <div className="font-mono text-sm font-bold text-white">{sat.id}</div>
              <div className="text-[9px] font-mono text-muted-gray tracking-widest">TELEMETRY & RESOURCES</div>
            </div>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-900/25 transition-colors">
            <X className="w-4 h-4 text-muted-gray" />
          </button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 100px)' }}>

          {/* Fuel gauge + stats side by side */}
          <div>
            <div className="text-[9px] font-mono text-muted-gray mb-3 tracking-widest uppercase flex items-center gap-1.5">
              <Zap className="w-3 h-3" /> Propellant Mass (m_fuel)
            </div>
            <div className="flex items-start gap-4">
              {/* Gauge */}
              <div className="flex-shrink-0">
                <FuelGaugeArc fuel={sat.fuel} size={156} />
                <div className="text-center mt-[-6px]">
                  <div className={`text-base font-mono font-bold ${fuelClass(sat.fuel)}`}>{sat.fuel.toFixed(3)} kg</div>
                  <div className="text-[7px] font-mono text-muted-gray">of {FUEL_INITIAL.toFixed(1)} kg</div>
                </div>
              </div>
              {/* Side stats */}
              <div className="flex-1 pt-1 space-y-2.5">
                {/* Fuel progress bar */}
                <div>
                  <div className="flex justify-between text-[8px] font-mono mb-1">
                    <span className="text-muted-gray">REMAINING</span>
                    <span style={{ color: col }}>{fuelPct.toFixed(1)}%</span>
                  </div>
                  <div className="h-2 bg-black/70 rounded-full overflow-hidden border border-white/5 relative">
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${fuelPct}%`, background: col, boxShadow: `0 0 8px ${col}` }} />
                    {/* EOL marker at 5% */}
                    <div className="absolute top-0 bottom-0 w-[1px] bg-laser-red/60"
                      style={{ left: `${(5 / FUEL_INITIAL) * 100}%` }} />
                  </div>
                  <div className="flex justify-between text-[6.5px] font-mono text-muted-gray mt-0.5">
                    <span>0%</span><span>EOL</span><span>50%</span><span>100%</span>
                  </div>
                </div>
                {/* Stats */}
                {[
                  ['STATUS',   sat.status,                          statusClass(sat.status)],
                  ['ALTITUDE', `${(sat.alt / 1000).toFixed(1)} km`, 'text-white'],
                  ['CONSUMED', `${fuelConsumed.toFixed(3)} kg`,     'text-amber'],
                  ['TOTAL ΔV', `${totalDv.toFixed(4)} m/s`,         'text-plasma-cyan'],
                  ['BURNS',    `${satManeuvers.length}`,             'text-white'],
                ].map(([label, value, cls]) => (
                  <div key={label as string} className="flex justify-between text-[9px] font-mono border-b border-white/5 pb-1">
                    <span className="text-muted-gray">{label as string}</span>
                    <span className={cls as string}>{value as string}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ΔV efficiency chart */}
          <div>
            <div className="text-[9px] font-mono text-muted-gray mb-2 tracking-widest uppercase flex items-center gap-1.5">
              <TrendingUp className="w-3 h-3" /> ΔV Cost — Fuel Consumed vs Collisions Avoided
            </div>
            <div className="rounded-xl overflow-hidden"
              style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,0,51,0.09)' }}>
              <DvChart data={dvData} width={390} height={130} />
            </div>
            {dvData.length < 2 && (
              <p className="text-[7px] font-mono text-muted-gray mt-1 text-center">
                Populates from fuelHistory (updates every 60s)
              </p>
            )}
          </div>

          {/* Summary 3-col cards */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'FUEL USED',     value: `${fuelConsumed.toFixed(2)} kg`, color: '#FF6B6B' },
              { label: 'BURNS',         value: `${satManeuvers.length}`,        color: '#00FFFF' },
              { label: 'AVOIDANCES',    value: `${satManeuvers.filter(m => m.maneuver_type !== 'RECOVERY').length}`, color: '#00FF64' },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded-xl px-3 py-2.5 text-center"
                style={{ background: 'rgba(0,0,0,0.5)', border: `1px solid ${color}22` }}>
                <div className="text-[7px] font-mono text-muted-gray mb-1">{label}</div>
                <div className="font-mono text-sm font-bold" style={{ color }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// GANTT POPUP  — reads store.maneuvers
// ─────────────────────────────────────────────────────────────────────────────

const MTYPE_COL: Record<string, string> = {
  PHASING_PROGRADE: '#00FFFF',
  RADIAL_SHUNT:     '#FF00FF',
  RECOVERY:         '#00FF64',
  PLANE_CHANGE:     '#D29922',
};

const GanttPopup: React.FC<{ sat: SatItem; onClose: () => void }> = ({ sat, onClose }) => {
  const allManeuvers = useOrbitalStore(s => s.maneuvers);
  const simTime      = useOrbitalStore(s => s.timestamp);
  const simMs        = simTime ? new Date(simTime).getTime() : Date.now();

  // Use real maneuvers or demo fallback
  const events: ManeuverEvent[] = useMemo(() => {
    const filtered = allManeuvers.filter(m => m.satellite_id === sat.id);
    if (filtered.length > 0) return [...filtered].sort((a, b) => new Date(b.burnTime).getTime() - new Date(a.burnTime).getTime());
    // Demo events so Gantt always shows something
    const now = simMs;
    return [
      { burn_id: 'EVASION_1', satellite_id: sat.id, burnTime: new Date(now - 3_600_000).toISOString(),
        deltaV_vector: { x: 0.002, y: 0.015, z: -0.001 }, maneuver_type: 'PHASING_PROGRADE',
        duration_seconds: 62, cooldown_start: new Date(now - 3_600_000).toISOString(),
        cooldown_end: new Date(now - 3_000_000).toISOString(), delta_v_magnitude: 0.015 },
      { burn_id: 'RECOVERY_1', satellite_id: sat.id, burnTime: new Date(now - 1_200_000).toISOString(),
        deltaV_vector: { x: -0.002, y: -0.014, z: 0.001 }, maneuver_type: 'RECOVERY',
        duration_seconds: 58, cooldown_start: new Date(now - 1_200_000).toISOString(),
        cooldown_end: new Date(now - 600_000).toISOString(), delta_v_magnitude: 0.014 },
    ];
  }, [allManeuvers, sat.id, simMs]);

  const allMs = events.flatMap(e => [new Date(e.burnTime).getTime(), new Date(e.cooldown_end).getTime()]);
  const tMin  = Math.min(...allMs) - 120_000;
  const tMax  = Math.max(...allMs, simMs) + 180_000;
  const tRange = tMax - tMin || 1;

  const GW = 540, rowH = 58, GT = 22, GB = 14;
  const chartW = GW - 8;
  const xPx = (t: number) => 4 + ((t - tMin) / tRange) * (chartW - 8);

  // Conflict: does this burn's start fall inside any previous cooldown?
  const sortedByTime = [...events].sort((a, b) => new Date(a.burnTime).getTime() - new Date(b.burnTime).getTime());
  const conflictSet = new Set<string>();
  let prevCoolEnd = 0;
  for (const ev of sortedByTime) {
    const bs = new Date(ev.burnTime).getTime();
    if (bs < prevCoolEnd) conflictSet.add(ev.burn_id);
    prevCoolEnd = Math.max(prevCoolEnd, new Date(ev.cooldown_end).getTime());
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}>
      <div className="relative rounded-2xl overflow-hidden"
        style={{
          width: 640,
          maxHeight: '88vh',
          background: 'linear-gradient(140deg,rgba(0,0,0,0.97),rgba(12,0,5,0.99))',
          border: '1px solid rgba(255,0,51,0.45)',
          boxShadow: '0 0 60px rgba(255,0,51,0.09)',
        }}
        onClick={e => e.stopPropagation()}>
        <div className="h-[2px]"
          style={{ background: 'linear-gradient(90deg,transparent,#00FFFF,transparent)', boxShadow: '0 0 12px #00FFFF' }} />

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-red-900/25">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ background: 'rgba(0,255,255,0.1)', border: '1px solid rgba(0,255,255,0.3)' }}>
              <Calendar className="w-4 h-4 text-plasma-cyan" />
            </div>
            <div>
              <div className="font-mono text-sm font-bold text-white">{sat.id}</div>
              <div className="text-[9px] font-mono text-muted-gray tracking-widest">MANEUVER TIMELINE</div>
            </div>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-900/25 transition-colors">
            <X className="w-4 h-4 text-muted-gray" />
          </button>
        </div>

        <div className="overflow-y-auto" style={{ maxHeight: 'calc(88vh - 78px)' }}>
          <div className="p-5 space-y-4">

            {/* Legend */}
            <div className="flex items-center gap-4 text-[8px] font-mono flex-wrap">
              {[
                { l: 'BURN',          c: '#00FFFF' },
                { l: 'COOLDOWN 600s', c: 'rgba(210,153,34,0.5)' },
                { l: '⚠ CONFLICT',    c: '#FF0033' },
                { l: 'RECOVERY',      c: '#00FF64' },
              ].map(({ l, c }) => (
                <div key={l} className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-sm" style={{ background: c }} />
                  <span className="text-muted-gray">{l}</span>
                </div>
              ))}
            </div>

            {/* Gantt SVG */}
            <div className="rounded-xl overflow-hidden"
              style={{ background: 'rgba(0,0,0,0.65)', border: '1px solid rgba(255,0,51,0.09)' }}>
              <svg width="100%" height={events.length * rowH + GT + GB}
                viewBox={`0 0 ${GW} ${events.length * rowH + GT + GB}`} style={{ display: 'block' }}>

                {/* Stripe backgrounds */}
                {events.map((_, i) => (
                  <rect key={i} x={0} y={GT + i * rowH} width={GW} height={rowH}
                    fill={i % 2 === 0 ? 'rgba(255,255,255,0.014)' : 'rgba(0,0,0,0)'} />
                ))}

                {/* Time ruler */}
                {[0, 0.2, 0.4, 0.6, 0.8, 1].map((f, i) => {
                  const x = 4 + f * (chartW - 8);
                  return (
                    <g key={i}>
                      <line x1={x} x2={x} y1={GT - 2} y2={GT + events.length * rowH}
                        stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
                      <text x={x} y={GT - 5} textAnchor="middle"
                        fill="rgba(255,255,255,0.18)" fontSize="7" fontFamily="monospace">
                        {new Date(tMin + f * tRange).toISOString().substring(11, 16)}Z
                      </text>
                    </g>
                  );
                })}

                {/* NOW marker */}
                {(() => {
                  const nx = xPx(simMs);
                  if (nx >= 4 && nx <= GW - 4) return (
                    <g>
                      <line x1={nx} x2={nx} y1={GT - 2} y2={GT + events.length * rowH}
                        stroke="#00FFFF" strokeWidth="1.5"
                        style={{ filter: 'drop-shadow(0 0 4px #00FFFF)' }} />
                      <text x={nx} y={GT - 5} textAnchor="middle"
                        fill="#00FFFF" fontSize="7" fontFamily="monospace" fontWeight="bold">NOW</text>
                    </g>
                  );
                  return null;
                })()}

                {/* Event rows */}
                {events.map((ev, i) => {
                  const bs    = new Date(ev.burnTime).getTime();
                  const be    = bs + ev.duration_seconds * 1000;
                  const ce    = new Date(ev.cooldown_end).getTime();
                  const conflict  = conflictSet.has(ev.burn_id);
                  const isPast    = be < simMs;
                  const isCurrent = bs <= simMs && be >= simMs;
                  const col = MTYPE_COL[ev.maneuver_type] ?? '#00FFFF';

                  const bX = Math.max(4, xPx(bs));
                  const bW = Math.max(5, xPx(be) - xPx(bs));
                  const cX = xPx(be);
                  const cW2 = Math.max(4, xPx(ce) - xPx(be));
                  const y  = GT + i * rowH + 8;

                  return (
                    <g key={ev.burn_id}>
                      {/* Cooldown */}
                      <rect x={cX} y={y + 4} width={Math.max(4, cW2)} height={18} rx="2"
                        fill="rgba(210,153,34,0.16)" stroke="rgba(210,153,34,0.42)"
                        strokeWidth="1" strokeDasharray="3 2" opacity={isPast ? 0.4 : 1} />
                      {cW2 > 60 && (
                        <text x={cX + cW2 / 2} y={y + 16} textAnchor="middle"
                          fill="rgba(210,153,34,0.55)" fontSize="6.5" fontFamily="monospace">COOLDOWN 600s</text>
                      )}
                      {/* Burn block */}
                      <rect x={bX} y={y} width={bW} height={26} rx="4"
                        fill={conflict ? 'rgba(255,0,51,0.3)' : `${col}2A`}
                        stroke={conflict ? '#FF0033' : col}
                        strokeWidth={conflict ? 2 : 1.5}
                        strokeDasharray={conflict ? '5 3' : undefined}
                        style={{ filter: `drop-shadow(0 0 5px ${conflict ? '#FF0033' : col})` }}
                        opacity={isPast ? 0.5 : 1} />
                      {bW > 36 && (
                        <text x={bX + bW / 2} y={y + 15} textAnchor="middle"
                          fill={conflict ? '#FF0033' : col} fontSize="7" fontFamily="monospace" fontWeight="bold">
                          {conflict ? '⚠ CONFLICT' : ev.maneuver_type.replace(/_/g, ' ')}
                        </text>
                      )}
                      {isCurrent && (
                        <circle cx={bX + bW - 5} cy={y + 5} r="3" fill="#00FFFF"
                          opacity="0.9" style={{ filter: 'drop-shadow(0 0 4px #00FFFF)' }} />
                      )}
                      {/* Row timestamp */}
                      <text x={4} y={y + 40} fill="rgba(255,255,255,0.15)" fontSize="6.5" fontFamily="monospace">
                        {fmtISO(bs)} · {fmtDur(ev.duration_seconds * 1000)} · Δv {ev.delta_v_magnitude.toFixed(4)} m/s
                        {isPast ? ' · DONE' : isCurrent ? ' · ACTIVE' : ' · PENDING'}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* Burn log table */}
            <div>
              <div className="text-[9px] font-mono text-muted-gray tracking-widest uppercase mb-2">
                BURN LOG ({events.length})
              </div>
              <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1"
                style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,0,51,0.18) transparent' }}>
                {events.map(ev => {
                  const t   = new Date(ev.burnTime).getTime();
                  const col = MTYPE_COL[ev.maneuver_type] ?? '#00FFFF';
                  return (
                    <div key={ev.burn_id}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg text-[9px] font-mono"
                      style={{ background: 'rgba(0,0,0,0.44)', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ background: col, boxShadow: `0 0 4px ${col}` }} />
                      <div className="flex-1 min-w-0 truncate">
                        <span className="text-muted-gray">ID: </span>
                        <span className="text-white">{ev.burn_id}</span>
                      </div>
                      <span style={{ color: col }}>{ev.delta_v_magnitude.toFixed(4)} m/s</span>
                      <span className="text-white">{ev.duration_seconds}s</span>
                      <span className={t > simMs ? 'text-amber' : 'text-muted-gray'}>
                        {t > simMs ? '⏳ PEND' : '✓ DONE'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SATELLITE CARD
// ─────────────────────────────────────────────────────────────────────────────

const SatelliteCard: React.FC<{
  sat: SatItem;
  isSelected: boolean;
  onSelect: () => void;
  onResources: () => void;
  onGantt: () => void;
}> = React.memo(({ sat, isSelected, onSelect, onResources, onGantt }) => {
  const fuelPct = Math.min(100, Math.max(0, (sat.fuel / FUEL_INITIAL) * 100));
  const col = fuelColor(sat.fuel);

  return (
    <div className="relative rounded-xl overflow-hidden transition-all duration-200 hover:scale-[1.018] hover:z-10"
      style={{
        background: isSelected ? 'rgba(0,28,36,0.88)' : 'rgba(0,0,0,0.68)',
        border: `1px solid ${isSelected ? 'rgba(0,255,255,0.65)' : statusBorder(sat.status)}`,
        boxShadow: isSelected
          ? '0 0 22px rgba(0,255,255,0.3), inset 0 0 20px rgba(0,255,255,0.04)'
          : `0 0 12px ${statusGlow(sat.status)}`,
      }}>
      {/* Top glow strip */}
      <div className="absolute top-0 left-0 right-0 h-[2px]"
        style={{
          background: sat.status === 'CRITICAL' ? '#FF0033' : sat.status === 'WARNING' ? '#D29922' : isSelected ? '#00FFFF' : 'rgba(0,255,255,0.3)',
          boxShadow: `0 0 8px ${sat.status === 'CRITICAL' ? '#FF0033' : sat.status === 'WARNING' ? '#D29922' : '#00FFFF'}`,
        }} />

      <div className="p-3 pt-3.5">
        {/* ID + status */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Satellite className="w-3 h-3 flex-shrink-0 text-plasma-cyan" />
            <span className="font-mono text-[10px] font-bold text-white truncate" title={sat.id}>{sat.id}</span>
          </div>
          <span className={`text-[8px] font-mono font-bold ${statusClass(sat.status)}`}>{sat.status}</span>
        </div>

        {/* Fuel bar */}
        <div className="flex items-center gap-1.5 mb-1.5">
          <div className="flex-1 h-1.5 bg-black/70 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-700"
              style={{ width: `${fuelPct}%`, background: col, boxShadow: `0 0 5px ${col}` }} />
          </div>
          <span className={`text-[8px] font-mono w-14 text-right flex-shrink-0 ${fuelClass(sat.fuel)}`}>
            {sat.fuel.toFixed(2)}kg
          </span>
        </div>

        {/* Coordinates */}
        <div className="text-[7px] font-mono text-muted-gray mb-2.5 truncate">
          {sat.lat.toFixed(1)}° / {sat.lon.toFixed(1)}° / {(sat.alt / 1000).toFixed(0)}km
        </div>

        {/* Buttons */}
        <div className="grid grid-cols-3 gap-1">
          {[
            { label: 'SELECT',  Icon: Target,   col: '#00FFFF', bg: isSelected ? 'rgba(0,255,255,0.18)' : 'rgba(0,255,255,0.07)', border: isSelected ? 'rgba(0,255,255,0.7)' : 'rgba(0,255,255,0.28)', onClick: onSelect },
            { label: 'METRICS', Icon: BarChart2, col: '#D29922', bg: 'rgba(210,153,34,0.07)', border: 'rgba(210,153,34,0.28)', onClick: onResources },
            { label: 'GANTT',   Icon: Calendar,  col: '#FF4466', bg: 'rgba(255,68,102,0.07)', border: 'rgba(255,68,102,0.28)', onClick: onGantt },
          ].map(({ label, Icon, col: c, bg, border, onClick }) => (
            <button key={label} onClick={onClick}
              className="flex flex-col items-center gap-0.5 py-1.5 rounded-lg text-[7px] font-mono transition-all hover:scale-105 active:scale-95"
              style={{ background: bg, border: `1px solid ${border}`, color: c }}>
              <Icon className="w-3 h-3" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});
SatelliteCard.displayName = 'SatelliteCard';

// ─────────────────────────────────────────────────────────────────────────────
// FLEET PANEL  (reads store directly using positions stride)
// ─────────────────────────────────────────────────────────────────────────────

const FleetPanel: React.FC = () => {
  const satellites      = useOrbitalStore(s => s.satellites);
  const selectedSatId   = useOrbitalStore(s => s.selectedSatelliteId);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);

  const [resourcesSat, setResourcesSat] = useState<SatItem | null>(null);
  const [ganttSat,     setGanttSat]     = useState<SatItem | null>(null);

  // Read from binary store: positions[i*3]=lon, [i*3+1]=lat, [i*3+2]=alt_m
  const satItems: SatItem[] = useMemo(() => {
    if (!satellites || satellites.length === 0) return [];
    const items: SatItem[] = [];
    for (let i = 0; i < satellites.length; i++) {
      items.push({
        id:     satellites.ids[i],
        fuel:   satellites.fuels[i],
        status: satellites.statuses[i],
        lon:    satellites.positions[i * 3],
        lat:    satellites.positions[i * 3 + 1],
        alt:    satellites.positions[i * 3 + 2],
      });
    }
    // CRITICAL → WARNING → NOMINAL → EOL, then fuel asc within tier
    const tier = (s: string) => s === 'CRITICAL' ? 0 : s === 'WARNING' ? 1 : s === 'NOMINAL' ? 2 : 3;
    return items.sort((a, b) => {
      const td = tier(a.status) - tier(b.status);
      return td !== 0 ? td : a.fuel - b.fuel;
    });
  }, [satellites]);

  if (!satItems.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-gray">
        <Satellite className="w-10 h-10 opacity-15 mb-3" />
        <span className="text-[9px] font-mono tracking-widest">AWAITING TELEMETRY…</span>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {satItems.map(sat => (
          <SatelliteCard
            key={sat.id}
            sat={sat}
            isSelected={sat.id === selectedSatId}
            onSelect={() => selectSatellite(sat.id === selectedSatId ? null : sat.id)}
            onResources={() => setResourcesSat(sat)}
            onGantt={() => setGanttSat(sat)}
          />
        ))}
      </div>
      {resourcesSat && <ResourcesPopup sat={resourcesSat} onClose={() => setResourcesSat(null)} />}
      {ganttSat     && <GanttPopup     sat={ganttSat}     onClose={() => setGanttSat(null)} />}
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// RIGHT PANEL
// ─────────────────────────────────────────────────────────────────────────────

const RightPanel: React.FC = () => {
  const satelliteCount  = useOrbitalStore(selectSatelliteCount);
  const debrisCount     = useOrbitalStore(selectDebrisCount);
  const connectionState = useOrbitalStore(selectConnectionState);
  const timestamp       = useOrbitalStore(s => s.timestamp);
  const [collapsed, setCollapsed] = useState(false);

  const simTime = timestamp
    ? new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19) + 'Z'
    : '—';

  if (collapsed) {
    return (
      <div className="absolute top-0 right-0 bottom-0 w-10 z-[20] flex flex-col items-center justify-center gap-4"
        style={{ background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(16px)', borderLeft: '1px solid rgba(255,0,51,0.3)' }}>
        <button onClick={() => setCollapsed(false)}
          className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-red-900/20 transition-colors"
          style={{ border: '1px solid rgba(255,0,51,0.4)' }}>
          <ChevronLeft className="w-4 h-4 text-plasma-cyan" />
        </button>
        <div className="text-[7px] font-mono text-muted-gray tracking-widest uppercase"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>FLEET</div>
      </div>
    );
  }

  return (
    <div className="absolute top-0 right-0 bottom-0 w-[450px] flex flex-col z-[20]"
      style={{
        background: 'linear-gradient(180deg,rgba(0,0,0,0.85) 0%,rgba(14,0,2,0.80) 100%)',
        backdropFilter: 'blur(22px)',
        borderLeft: '1px solid rgba(255,0,51,0.4)',
        boxShadow: '-12px 0 40px rgba(220,38,38,0.09)',
      }}>
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b"
        style={{ borderColor: 'rgba(255,0,51,0.16)', background: 'rgba(0,0,0,0.58)' }}>
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-plasma-cyan animate-pulse"
              style={{ boxShadow: '0 0 6px #00FFFF' }} />
            <span className="font-mono text-[9px] text-muted-gray tracking-widest uppercase">Mission Control</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              {connectionState === 'connected'
                ? <Wifi className="w-3 h-3 text-nominal-green" />
                : <WifiOff className="w-3 h-3 text-laser-red" />}
              <span className={`text-[9px] font-mono ${connectionState === 'connected' ? 'text-nominal-green' : 'text-laser-red'}`}>
                {connectionState === 'connected' ? 'LINKED' : 'OFFLINE'}
              </span>
            </div>
            <button onClick={() => setCollapsed(true)}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-900/20 transition-colors">
              <ChevronRight className="w-4 h-4 text-muted-gray" />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between text-[9px] font-mono">
          <div className="flex gap-3">
            <span><span className="text-muted-gray">SATS </span>
              <span className="text-plasma-cyan font-bold">{satelliteCount.toLocaleString()}</span></span>
            <span><span className="text-muted-gray">DEBRIS </span>
              <span className="text-laser-red font-bold">{debrisCount.toLocaleString()}</span></span>
          </div>
          <div className="flex items-center gap-1">
            <Clock className="w-2.5 h-2.5 text-muted-gray" />
            <span className="font-mono text-plasma-cyan">{simTime}</span>
          </div>
        </div>
      </div>

      {/* Fleet label row */}
      <div className="flex-shrink-0 px-4 py-2 flex items-center gap-2"
        style={{ borderBottom: '1px solid rgba(255,0,51,0.09)' }}>
        <Satellite className="w-3 h-3 text-plasma-cyan" />
        <span className="font-mono text-[9px] text-muted-gray tracking-widest uppercase">Active Constellation</span>
        <div className="flex-1" />
        <FPSMonitor />
      </div>

      {/* Scrollable grid */}
      <div className="flex-grow overflow-y-auto p-3"
        style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,0,51,0.2) transparent' }}>
        <ErrorBoundary name="FleetPanel">
          <FleetPanel />
        </ErrorBoundary>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// LEFT PANEL — BULLSEYE POLAR CHART
// ─────────────────────────────────────────────────────────────────────────────

const LeftBullseyePanel: React.FC = () => {
  const selectedSat = useOrbitalStore(selectSelectedSatellite);
  const debris      = useOrbitalStore(s => s.debris);
  const [collapsed, setCollapsed] = useState(true);

  // Derive conjunctions (re-computed on every debris update for selected sat)
  const conjunctions = useMemo((): ConjunctionEntry[] => {
    if (!selectedSat) return [];
    return deriveConjunctions(selectedSat.lat, selectedSat.lon, debris);
  }, [selectedSat?.lat, selectedSat?.lon, debris]);

  const hasUrgent = conjunctions.some(d => d.missDistance < 5 || d.collisionProb > 0.01);

  useEffect(() => {
    if (hasUrgent && collapsed) setCollapsed(false);
  }, [hasUrgent]);

  const debCol = (d: ConjunctionEntry) =>
    d.missDistance < 1 ? '#FF0033' : d.missDistance < 5 ? '#D29922' : '#00FF64';

  const CX = 120, CY = 120, R = 100;
  const maxTCA = conjunctions.length > 0 ? Math.max(...conjunctions.map(d => d.tca), 120) : 120;

  if (collapsed) {
    return (
      <div className="absolute left-0 z-[20] flex flex-col items-center py-3 gap-2"
        style={{
          top: 64, width: 40,
          background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(14px)',
          borderRight: '1px solid rgba(255,0,51,0.3)',
          borderBottom: '1px solid rgba(255,0,51,0.2)',
          borderTopRightRadius: 10, borderBottomRightRadius: 10,
        }}>
        {hasUrgent && (
          <div className="w-2 h-2 rounded-full bg-laser-red animate-pulse"
            style={{ boxShadow: '0 0 6px #FF0033' }} />
        )}
        <button onClick={() => setCollapsed(false)}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-900/20 transition-colors">
          <ChevronRight className="w-3 h-3 text-plasma-cyan" />
        </button>
        <div className="text-[7px] font-mono text-muted-gray tracking-widest uppercase"
          style={{ writingMode: 'vertical-rl' }}>RADAR</div>
      </div>
    );
  }

  return (
    <div className="absolute left-0 z-[20] flex flex-col"
      style={{
        top: 64, width: 280,
        background: 'linear-gradient(160deg,rgba(0,0,0,0.95),rgba(10,0,5,0.9))',
        backdropFilter: 'blur(22px)',
        borderRight: '1px solid rgba(255,0,51,0.35)',
        borderBottom: '1px solid rgba(255,0,51,0.2)',
        borderBottomRightRadius: 14,
        boxShadow: '12px 0 30px rgba(220,38,38,0.06)',
      }}>

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b"
        style={{ borderColor: 'rgba(255,0,51,0.16)' }}>
        <div className="flex items-center gap-2">
          <Crosshair className="w-3.5 h-3.5 text-plasma-cyan" />
          <span className="font-mono text-[9px] text-muted-gray tracking-widest uppercase">Conjunction Radar</span>
          {hasUrgent && <span className="text-[7px] font-mono text-laser-red animate-pulse">⚠ ALERT</span>}
        </div>
        <button onClick={() => setCollapsed(true)}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-900/20 transition-colors">
          <ChevronLeft className="w-3 h-3 text-muted-gray" />
        </button>
      </div>

      {/* Target */}
      <div className="px-3 py-1.5 border-b" style={{ borderColor: 'rgba(255,0,51,0.07)' }}>
        <div className="text-[9px] font-mono">
          <span className="text-muted-gray">TARGET: </span>
          <span className="text-plasma-cyan font-bold">{selectedSat?.id ?? '—'}</span>
        </div>
      </div>

      {/* Polar chart */}
      <div className="flex justify-center py-3">
        <svg width="240" height="240" viewBox="0 0 240 240">
          {/* Range rings */}
          {[0.25, 0.5, 0.75, 1].map((f, i) => (
            <circle key={i} cx={CX} cy={CY} r={R * f} fill="none"
              stroke={f === 1 ? 'rgba(255,0,51,0.28)' : 'rgba(255,255,255,0.05)'}
              strokeWidth="1" strokeDasharray={f < 1 ? '2 3' : undefined} />
          ))}
          {/* Cross axes */}
          {[0, 45, 90, 135].map(a => {
            const rad = a * Math.PI / 180;
            return <line key={a} stroke="rgba(255,255,255,0.04)" strokeWidth="1"
              x1={CX - R * Math.cos(rad)} y1={CY - R * Math.sin(rad)}
              x2={CX + R * Math.cos(rad)} y2={CY + R * Math.sin(rad)} />;
          })}
          {/* TCA labels */}
          {[0.25, 0.5, 0.75, 1].map(f => (
            <text key={f} x={CX + 2} y={CY - R * f - 2}
              fill="rgba(255,255,255,0.18)" fontSize="6" fontFamily="monospace">
              {Math.round(maxTCA * f)}s
            </text>
          ))}
          {/* Satellite at center */}
          <circle cx={CX} cy={CY} r="5" fill="#00FFFF"
            style={{ filter: 'drop-shadow(0 0 8px #00FFFF)' }} />
          <circle cx={CX} cy={CY} r="12" fill="none"
            stroke="rgba(0,255,255,0.22)" strokeWidth="1" />

          {/* Debris markers */}
          {conjunctions.map(d => {
            const r   = (d.tca / maxTCA) * R;
            const ang = (d.angle - 90) * Math.PI / 180;
            const x   = CX + r * Math.cos(ang);
            const y   = CY + r * Math.sin(ang);
            const col = debCol(d);
            return (
              <g key={d.debrisId}>
                {d.missDistance < 5 && (
                  <line x1={CX} y1={CY} x2={x} y2={y}
                    stroke={col} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.35" />
                )}
                <circle cx={x} cy={y} r="4" fill={col} opacity="0.88"
                  style={{ filter: `drop-shadow(0 0 5px ${col})` }} />
                <circle cx={x} cy={y} r="9" fill="none" stroke={col}
                  strokeWidth="0.5" opacity="0.28" />
                <text x={x + 7} y={y - 3} fill={col} fontSize="5.5" fontFamily="monospace">
                  {d.debrisId.substring(0, 9)}
                </text>
                <text x={x + 7} y={y + 5} fill="rgba(255,255,255,0.2)" fontSize="5" fontFamily="monospace">
                  {d.missDistance.toFixed(2)}km
                </text>
              </g>
            );
          })}

          {!selectedSat && (
            <text x={CX} y={CY + 32} textAnchor="middle"
              fill="rgba(255,255,255,0.1)" fontSize="8" fontFamily="monospace">SELECT SATELLITE</text>
          )}
          {selectedSat && conjunctions.length === 0 && (
            <text x={CX} y={CY + 32} textAnchor="middle"
              fill="rgba(0,255,100,0.38)" fontSize="8" fontFamily="monospace">CLEAR ✓</text>
          )}
        </svg>
      </div>

      {/* Legend */}
      <div className="px-3 pb-2 flex items-center gap-3 text-[7px] font-mono">
        {[['SAFE', '#00FF64'], ['< 5 km', '#D29922'], ['< 1 km', '#FF0033']].map(([l, c]) => (
          <div key={l} className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full" style={{ background: c, boxShadow: `0 0 4px ${c}` }} />
            <span className="text-muted-gray">{l}</span>
          </div>
        ))}
      </div>

      {/* Debris list */}
      {conjunctions.length > 0 && (
        <div className="px-3 pb-3 border-t" style={{ borderColor: 'rgba(255,0,51,0.07)' }}>
          <div className="pt-2 text-[7px] font-mono text-muted-gray tracking-wider uppercase mb-1">
            {conjunctions.length} Objects Detected
          </div>
          <div className="space-y-1 max-h-28 overflow-y-auto pr-1"
            style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,0,51,0.1) transparent' }}>
            {conjunctions.map(d => {
              const col = debCol(d);
              return (
                <div key={d.debrisId}
                  className="flex items-center gap-2 px-2 py-1 rounded text-[7px] font-mono"
                  style={{ background: 'rgba(0,0,0,0.42)', border: `1px solid ${col}20` }}>
                  <div className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: col, boxShadow: `0 0 3px ${col}` }} />
                  <span className="text-white w-16 truncate">{d.debrisId}</span>
                  <span className="text-muted-gray">TCA</span>
                  <span className="text-white">{d.tca.toFixed(1)}s</span>
                  <span className="text-muted-gray">MISS</span>
                  <span style={{ color: col }}>{d.missDistance.toFixed(2)}km</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export const DashboardLayout: React.FC = React.memo(() => (
  <>
    <ErrorBoundary name="BullseyePanel">
      <LeftBullseyePanel />
    </ErrorBoundary>
    <ErrorBoundary name="RightPanel">
      <RightPanel />
    </ErrorBoundary>
  </>
));

DashboardLayout.displayName = 'DashboardLayout';
export default DashboardLayout;