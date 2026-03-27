// src/components/ResourceMetrics.tsx
// Production-Ready Telemetry & Resource Heatmaps
// Active Fleet Analytics | Recharts Optimization | Crimson Nebula Theme

import React, { useMemo, useCallback } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import useOrbitalStore, {
  selectSelectedSatellite,
  selectLatestFuelMetric,
  selectSatelliteCount,
  selectDebrisCount,
  selectSimulationState,
} from '../store/useOrbitalStore';
import type { FuelMetric } from '../store/useOrbitalStore';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface ChartDataPoint {
  timestamp: string;
  time: string;
  totalFuelKg: number;
  avgFuelKg: number;
  collisionsAvoided: number;
  maneuversExecuted: number;
}

interface FuelGaugeConfig {
  color: string;
  glowColor: string;
  label: string;
}

interface FleetStatus {
  nominal: number;
  warning: number;
  critical: number;
  eol: number;
}

// ============================================================================
// CONSTANTS (Crimson Nebula Theme + PS Section 5.1)
// ============================================================================

const THEME = {
  COLORS: {
    PLASMA_CYAN: '#00FFFF',
    LASER_RED: '#FF0033',
    VERMILLION: '#F85149',
    AMBER: '#D29922',
    MUTED_GRAY: '#888888',
    WHITE: '#FFFFFF',
  },
  FUEL_THRESHOLDS: {
    CRITICAL: 5.0,
    WARNING: 15.0,
    INITIAL: 50.0,
    EOL: 2.5,
  },
  FUEL_PERCENT_THRESHOLDS: {
    HIGH: 60,
    MEDIUM: 25,
  },
} as const;

// ============================================================================
// PURE UTILITIES (memoized)
// ============================================================================

const formatTimestamp = (timestamp: string): string => {
  const date = new Date(timestamp);
  return `${date.getUTCHours().toString().padStart(2, '0')}:${date.getUTCMinutes().toString().padStart(2, '0')}`;
};

const formatFuelValue = (fuel: number): string => fuel.toFixed(2);
const formatCount = (count: number): string => count >= 1000 ? `${(count / 1000).toFixed(1)}K` : count.toString();

const formatYAxisTick = (value: number): string => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toString();

const getFuelGaugeConfig = (percent: number): FuelGaugeConfig => {
  if (percent > THEME.FUEL_PERCENT_THRESHOLDS.HIGH) {
    return { color: THEME.COLORS.PLASMA_CYAN, glowColor: 'rgba(0,255,255,0.8)', label: 'NOMINAL' };
  }
  if (percent > THEME.FUEL_PERCENT_THRESHOLDS.MEDIUM) {
    return { color: THEME.COLORS.AMBER, glowColor: 'rgba(210,153,34,0.8)', label: 'WARNING' };
  }
  return { color: THEME.COLORS.LASER_RED, glowColor: 'rgba(255,0,51,0.8)', label: 'CRITICAL' };
};

// ============================================================================
// CUSTOM RECHARTS COMPONENTS (stable references)
// ============================================================================

const CustomDot = React.memo((props: any) => {
  const { cx, cy, value } = props;
  if (value === 0 || !cx || !cy) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={4} fill={THEME.COLORS.PLASMA_CYAN} opacity={0.4} filter="blur(2px)" />
      <circle cx={cx} cy={cy} r={2} fill={THEME.COLORS.WHITE} stroke={THEME.COLORS.PLASMA_CYAN} strokeWidth={1.5} />
    </g>
  );
});

const CustomTooltip = React.memo(({ active, payload, label }: any) => {
  if (!active || !payload || payload.length === 0) return null;
  const data = payload[0].payload as ChartDataPoint;

  return (
    <div
      className="glass-panel px-4 py-3 min-w-[200px]"
      style={{
        background: 'rgba(0, 0, 0, 0.90)',
        backdropFilter: 'blur(12px)',
        border: '1px solid rgba(255, 0, 51, 0.5)',
        boxShadow: '0 0 15px rgba(220, 38, 38, 0.3)',
      }}
    >
      <div className="text-[10px] font-mono text-muted-gray mb-2 pb-2 border-b border-red-900/30">
        SIM TIME: <span className="text-plasma-cyan font-bold">{label}</span>
      </div>
      <div className="font-mono text-[10px] text-muted-gray space-y-1.5">
        <div className="flex justify-between items-center">
          <span>FLEET FUEL:</span>
          <span className="text-vermillion font-bold">{formatFuelValue(data.totalFuelKg)} kg</span>
        </div>
        <div className="flex justify-between items-center">
          <span>AVG (ACTIVE):</span>
          <span className="text-white font-bold">{formatFuelValue(data.avgFuelKg)} kg</span>
        </div>
        <div className="flex justify-between items-center pt-1.5 border-t border-red-900/30">
          <span>MANEUVERS:</span>
          <span className="text-amber font-bold">{data.maneuversExecuted}</span>
        </div>
        <div className="flex justify-between items-center">
          <span>COLLISIONS AVOIDED:</span>
          <span className="text-plasma-cyan font-bold">{data.collisionsAvoided}</span>
        </div>
      </div>
    </div>
  );
});

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const ResourceMetrics: React.FC = React.memo(() => {
  const store = useOrbitalStore();

  // Atomic selectors – only re-run when the specific slice changes
  const selectedSatellite = useMemo(() => selectSelectedSatellite(store), [store]);
  const latestFuelMetric = useMemo(() => selectLatestFuelMetric(store), [store]);
  const fuelHistory = store.fuelHistory;
  const satellites = store.satellites;
  const satelliteCount = useMemo(() => selectSatelliteCount(store), [store]);
  const debrisCount = useMemo(() => selectDebrisCount(store), [store]);
  const simulation = useMemo(() => selectSimulationState(store), [store]);

  // Fleet status (memoized)
  const fleetStatus = useMemo<FleetStatus>(() => {
    const status: FleetStatus = { nominal: 0, warning: 0, critical: 0, eol: 0 };
    if (!satellites || satellites.length === 0) return status;

    for (let i = 0; i < satellites.length; i++) {
      const fuel = satellites.fuels[i];
      if (satellites.statuses[i] === 'EOL' || fuel <= THEME.FUEL_THRESHOLDS.EOL) status.eol++;
      else if (fuel <= THEME.FUEL_THRESHOLDS.CRITICAL) status.critical++;
      else if (fuel <= THEME.FUEL_THRESHOLDS.WARNING) status.warning++;
      else status.nominal++;
    }
    return status;
  }, [satellites]);

  // Chart data (memoized)
  const chartData = useMemo<ChartDataPoint[]>(() => {
    if (!fuelHistory || fuelHistory.length === 0) return [];
    return fuelHistory.map((metric: FuelMetric) => ({
      timestamp: metric.timestamp,
      time: formatTimestamp(metric.timestamp),
      totalFuelKg: metric.totalFuelKg,
      avgFuelKg: metric.avgFuelKg,
      collisionsAvoided: metric.collisionsAvoided,
      maneuversExecuted: metric.maneuversExecuted,
    }));
  }, [fuelHistory]);

  // Selected satellite fuel gauge
  const fuelLevel = selectedSatellite?.fuel_kg ?? THEME.FUEL_THRESHOLDS.INITIAL;
  const fuelPercent = useMemo(() => {
    const percent = ((fuelLevel - THEME.FUEL_THRESHOLDS.EOL) / (THEME.FUEL_THRESHOLDS.INITIAL - THEME.FUEL_THRESHOLDS.EOL)) * 100;
    return Math.max(0, Math.min(100, percent));
  }, [fuelLevel]);
  const fuelGaugeConfig = useMemo(() => getFuelGaugeConfig(fuelPercent), [fuelPercent]);

  // Fleet average fuel (active only)
  const fleetAvgFuel = useMemo(() => {
    if (!satellites || satellites.length === 0) return 0;
    let activeTotal = 0, activeCount = 0;
    for (let i = 0; i < satellites.length; i++) {
      if (satellites.fuels[i] > THEME.FUEL_THRESHOLDS.EOL) {
        activeTotal += satellites.fuels[i];
        activeCount++;
      }
    }
    return activeCount > 0 ? activeTotal / activeCount : 0;
  }, [satellites]);
  const fleetFuelGaugeConfig = useMemo(
    () => getFuelGaugeConfig((fleetAvgFuel / THEME.FUEL_THRESHOLDS.INITIAL) * 100),
    [fleetAvgFuel]
  );

  // Display numbers (simulation or latest metric)
  const collisionsDisplay = simulation.collisionsDetected > 0
    ? simulation.collisionsDetected
    : latestFuelMetric?.collisionsAvoided ?? 0;
  const maneuversDisplay = simulation.maneuversExecuted > 0
    ? simulation.maneuversExecuted
    : latestFuelMetric?.maneuversExecuted ?? 0;

  // Stable callbacks for Recharts (avoid recreation)
  const handleYAxisTick = useCallback(formatYAxisTick, []);

  return (
    <div
      className="glass-panel flex flex-col h-full overflow-hidden"
      style={{
        background: 'rgba(0, 0, 0, 0.60)',
        backdropFilter: 'blur(12px)',
        border: '1px solid rgba(255, 0, 51, 0.3)',
      }}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-red-900/30 flex items-center justify-between bg-black/40">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-plasma-cyan rounded-full animate-pulse shadow-[0_0_8px_cyan]" />
          <h2 className="text-muted-gray font-mono text-xs tracking-widest uppercase">Fleet Resources</h2>
        </div>
        <div className="text-[10px] font-mono text-muted-gray">
          ACTIVE: <span className="text-plasma-cyan font-bold">{satelliteCount - fleetStatus.eol}</span> SATS
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-grow p-4 overflow-y-auto space-y-6">
        {/* Dynamic Fuel Gauge */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-mono text-muted-gray uppercase tracking-wider">
              {selectedSatellite ? selectedSatellite.id : 'FLEET AVERAGE (ACTIVE)'}
            </span>
            <span
              className="text-[10px] font-mono font-bold"
              style={{
                color: selectedSatellite ? fuelGaugeConfig.color : fleetFuelGaugeConfig.color,
                textShadow: `0 0 8px ${selectedSatellite ? fuelGaugeConfig.glowColor : fleetFuelGaugeConfig.glowColor}`,
              }}
            >
              {selectedSatellite ? fuelGaugeConfig.label : fleetFuelGaugeConfig.label}
            </span>
          </div>

          <div className="flex justify-between text-xs font-mono mb-1.5">
            <span className="text-muted-gray">PROPELLANT</span>
            <span
              className="font-semibold drop-shadow-[0_0_5px_currentColor]"
              style={{ color: selectedSatellite ? fuelGaugeConfig.color : fleetFuelGaugeConfig.color }}
            >
              {formatFuelValue(selectedSatellite ? fuelLevel : fleetAvgFuel)} / {THEME.FUEL_THRESHOLDS.INITIAL.toFixed(2)} kg
            </span>
          </div>

          <div className="h-3 bg-black/80 border border-red-900/50 rounded overflow-hidden relative shadow-[inset_0_0_5px_rgba(255,0,0,0.2)]">
            <div
              className="h-full transition-all duration-700 ease-out"
              style={{
                width: `${selectedSatellite ? fuelPercent : (fleetAvgFuel / THEME.FUEL_THRESHOLDS.INITIAL) * 100}%`,
                backgroundColor: selectedSatellite ? fuelGaugeConfig.color : fleetFuelGaugeConfig.color,
                boxShadow: `0 0 12px ${selectedSatellite ? fuelGaugeConfig.glowColor : fleetFuelGaugeConfig.glowColor}`,
              }}
            />
            {/* EOL Marker */}
            <div
              className="absolute top-0 bottom-0 w-px min-w-[2px] bg-laser-red z-10 opacity-80"
              style={{ left: `${(THEME.FUEL_THRESHOLDS.EOL / THEME.FUEL_THRESHOLDS.INITIAL) * 100}%` }}
            >
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 text-[8px] font-mono text-laser-red">EOL</div>
            </div>
            {/* Warning Marker */}
            <div
              className="absolute top-0 bottom-0 w-px bg-amber z-10 opacity-30"
              style={{ left: `${(THEME.FUEL_THRESHOLDS.WARNING / THEME.FUEL_THRESHOLDS.INITIAL) * 100}%` }}
            />
          </div>
        </div>

        {/* Fleet Status Distribution */}
        <div className="grid grid-cols-4 gap-2">
          <div className="text-center p-2 bg-black/40 rounded border border-cyan-900/30">
            <div className="text-[9px] text-muted-gray mb-1">NOMINAL</div>
            <div className="text-plasma-cyan font-mono font-bold text-sm">{fleetStatus.nominal}</div>
          </div>
          <div className="text-center p-2 bg-black/40 rounded border border-amber/30">
            <div className="text-[9px] text-muted-gray mb-1">WARNING</div>
            <div className="text-amber font-mono font-bold text-sm">{fleetStatus.warning}</div>
          </div>
          <div className="text-center p-2 bg-black/40 rounded border border-red-900/50">
            <div className="text-[9px] text-muted-gray mb-1">CRITICAL</div>
            <div className="text-laser-red font-mono font-bold text-sm animate-pulse">{fleetStatus.critical}</div>
          </div>
          <div className="text-center p-2 bg-black/60 rounded border border-gray-800">
            <div className="text-[9px] text-muted-gray mb-1">DEAD (EOL)</div>
            <div className="text-muted-gray font-mono font-bold text-sm">{fleetStatus.eol}</div>
          </div>
        </div>

        {/* Δv Cost Analysis Chart */}
        <div className="flex flex-col flex-grow min-h-[220px]">
          <h3 className="text-[10px] font-mono text-muted-gray uppercase tracking-wider mb-2">
            Historical Propellant Burn
          </h3>
          <div className="flex-grow w-full">
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorFuel" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={THEME.COLORS.VERMILLION} stopOpacity={0.6} />
                      <stop offset="95%" stopColor="#000" stopOpacity={0.1} />
                    </linearGradient>
                  </defs>

                  <CartesianGrid strokeDasharray="2 4" stroke={THEME.COLORS.LASER_RED} opacity={0.1} vertical={false} />

                  <XAxis
                    dataKey="time"
                    stroke={THEME.COLORS.MUTED_GRAY}
                    opacity={0.6}
                    fontSize={9}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={20}
                  />

                  <YAxis
                    yAxisId="left"
                    stroke={THEME.COLORS.VERMILLION}
                    opacity={0.6}
                    fontSize={9}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={handleYAxisTick}
                    domain={['auto', 'auto']}
                  />

                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    stroke={THEME.COLORS.PLASMA_CYAN}
                    opacity={0.6}
                    fontSize={9}
                    tickLine={false}
                    axisLine={false}
                  />

                  <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,0,51,0.2)', strokeWidth: 20 }} />

                  <Legend
                    wrapperStyle={{
                      fontSize: '9px',
                      fontFamily: 'monospace',
                      paddingTop: '10px',
                      color: THEME.COLORS.MUTED_GRAY,
                    }}
                    iconType="circle"
                  />

                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="totalFuelKg"
                    name="Fleet Fuel (kg)"
                    stroke={THEME.COLORS.VERMILLION}
                    strokeWidth={2}
                    fill="url(#colorFuel)"
                    isAnimationActive={false}
                  />

                  <Line
                    yAxisId="right"
                    type="stepAfter"
                    dataKey="collisionsAvoided"
                    name="Collisions Avoided"
                    stroke={THEME.COLORS.PLASMA_CYAN}
                    strokeWidth={1.5}
                    dot={<CustomDot />}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center border border-dashed border-red-900/30 rounded bg-black/20">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="opacity-30 text-laser-red mb-2">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
                <span className="text-[9px] font-mono text-muted-gray tracking-widest">AWAITING TELEMETRY...</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer Stats */}
      <div className="px-4 py-2 border-t border-red-900/30 bg-black/40 z-10">
        <div className="flex justify-between font-mono text-[10px]">
          <div className="text-muted-gray">
            DEBRIS: <span className="text-vermillion">{formatCount(debrisCount)}</span>
          </div>
          <div className="flex gap-4">
            <div className="text-muted-gray">
              AVOIDED: <span className="text-plasma-cyan font-bold">{collisionsDisplay}</span>
            </div>
            <div className="text-muted-gray">
              BURNS: <span className="text-amber font-bold">{maneuversDisplay}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

ResourceMetrics.displayName = 'ResourceMetrics';
export default ResourceMetrics;