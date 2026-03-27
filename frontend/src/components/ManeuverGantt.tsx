// src/components/ManeuverGantt.tsx
// Production-Ready Maneuver Timeline / Gantt Scheduler
// Millisecond Precision | Conflict Detection | Blackout Flags
// NSH 2026 PS Section 6.2 Compliance

import React, { useMemo, useCallback, useState, useEffect } from 'react';
import useOrbitalStore, {
  selectSelectedSatellite,
  selectManeuversForSatellite,
} from '../store/useOrbitalStore';
import type { ManeuverEvent } from '../store/useOrbitalStore';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface TimelineWindow {
  start: number;      // ms
  end: number;        // ms
  duration: number;   // ms
}

interface ManeuverBlock {
  maneuver: ManeuverEvent;
  burnStartMs: number;
  burnEndMs: number;
  cooldownEndMs: number;
  startPct: number;
  burnWidthPct: number;
  cooldownWidthPct: number;
  isPast: boolean;
  isCurrent: boolean;
  isFuture: boolean;
  hasConflict: boolean;
  isBlackout: boolean;
}

interface ManeuverTypeConfig {
  label: string;
  color: string;
  glowColor: string;
  icon: string;
}

// ============================================================================
// CONSTANTS (Crimson Nebula Theme + PS Section 5.1)
// ============================================================================

const THEME = {
  COLORS: {
    PLASMA_CYAN: '#00FFFF',
    LASER_RED: '#FF0033',
    AMBER: '#D29922',
    MUTED_GRAY: '#888888',
    WHITE: '#FFFFFF',
  },
  COOLDOWN_SECONDS: 600,               // PS Section 5.1
  TIMELINE_WINDOW_MINUTES: 20,         // -10min … +10min
} as const;

const MANEUVER_TYPES: Record<string, ManeuverTypeConfig> = {
  PHASING_PROGRADE:   { label: 'PHASING PROGRADE',   color: '#00FFFF', glowColor: 'rgba(0,255,255,0.8)', icon: '⟳' },
  PHASING_RETROGRADE: { label: 'PHASING RETROGRADE', color: '#00BFFF', glowColor: 'rgba(0,191,255,0.8)', icon: '⟲' },
  RADIAL_SHUNT:       { label: 'RADIAL SHUNT',       color: '#FF00FF', glowColor: 'rgba(255,0,255,0.8)', icon: '↕' },
  RECOVERY:           { label: 'RECOVERY BURN',      color: '#238636', glowColor: 'rgba(35,134,54,0.8)', icon: '✓' },
  PLANE_CHANGE:       { label: 'PLANE CHANGE',       color: '#D29922', glowColor: 'rgba(210,153,34,0.8)', icon: '⟡' },
  DEORBIT:            { label: 'DEORBIT (EOL)',      color: '#F85149', glowColor: 'rgba(248,81,73,0.8)', icon: '⚠' },
};

// ============================================================================
// UTILITIES (memoized where possible)
// ============================================================================

const formatTimestamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}:${d.getUTCSeconds().toString().padStart(2, '0')}Z`;
};

const formatRelativeTime = (ms: number, now: number): string => {
  const diff = ms - now;
  const minutes = Math.floor(Math.abs(diff) / 60000);
  const seconds = Math.floor((Math.abs(diff) % 60000) / 1000);
  if (Math.abs(diff) < 1000) return 'NOW';
  const sign = diff < 0 ? 'T-' : 'T+';
  return `${sign}${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

// Quick eclipse check (simplified, used only for visual flagging)
const isEclipseAtTime = (satLat: number, satLon: number, burnTimeMs: number): boolean => {
  const date = new Date(burnTimeMs);
  const dayOfYear = (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000;
  const declination = -23.44 * Math.cos((360 / 365) * (dayOfYear + 10) * (Math.PI / 180));
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let sunLon = 180 - 15 * utcHours;
  if (sunLon < -180) sunLon += 360;
  if (sunLon > 180) sunLon -= 360;

  // Approximate satellite movement for the burn time (coarse)
  const dtMs = burnTimeMs - Date.now();
  const projectedLon = satLon + (dtMs / 1000) * 0.000185;   // ~1 deg / 90 min

  const latRad = satLat * (Math.PI / 180);
  const decRad = declination * (Math.PI / 180);
  const lonDiffRad = (projectedLon - sunLon) * (Math.PI / 180);

  const sinElevation = Math.sin(latRad) * Math.sin(decRad) +
                       Math.cos(latRad) * Math.cos(decRad) * Math.cos(lonDiffRad);
  return sinElevation < -0.1;   // shadow threshold
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const ManeuverGantt: React.FC = React.memo(() => {
  const store = useOrbitalStore();
  const selectedSatellite = useMemo(() => selectSelectedSatellite(store), [store]);
  const satelliteManeuvers = useOrbitalStore(state =>
    selectManeuversForSatellite(state, selectedSatellite?.id ?? null)
  );

  const [currentTime, setCurrentTime] = useState(Date.now());
  const [hoveredManeuverId, setHoveredManeuverId] = useState<string | null>(null);

  // Update current time every 100ms (10Hz) – enough for smooth timeline scrolling
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(Date.now()), 100);
    return () => clearInterval(interval);
  }, []);

  // Timeline window around current time
  const timelineWindow = useMemo<TimelineWindow>(() => {
    const halfWindow = (THEME.TIMELINE_WINDOW_MINUTES / 2) * 60000;
    const start = currentTime - halfWindow;
    const end = currentTime + halfWindow;
    return { start, end, duration: end - start };
  }, [currentTime]);

  // Build maneuver blocks (memoized)
  const maneuverBlocks = useMemo<ManeuverBlock[]>(() => {
    if (!selectedSatellite || timelineWindow.duration === 0) return [];

    // First pass – compute percentages and basic flags
    const blocks = satelliteManeuvers.map((maneuver) => {
      const burnStartMs = new Date(maneuver.burnTime).getTime();
      const burnEndMs = burnStartMs + maneuver.duration_seconds * 1000;
      const cooldownEndMs = new Date(maneuver.cooldown_end).getTime();

      const startPct = ((burnStartMs - timelineWindow.start) / timelineWindow.duration) * 100;
      const burnEndPct = ((burnEndMs - timelineWindow.start) / timelineWindow.duration) * 100;
      const cooldownEndPct = ((cooldownEndMs - timelineWindow.start) / timelineWindow.duration) * 100;

      const burnWidthPct = Math.max(0.5, burnEndPct - startPct);
      const cooldownWidthPct = Math.max(0, cooldownEndPct - burnEndPct);

      const isPast = burnEndMs < currentTime;
      const isCurrent = burnStartMs <= currentTime && burnEndMs >= currentTime;
      const isFuture = burnStartMs > currentTime;

      const isBlackout = isEclipseAtTime(selectedSatellite.lat, selectedSatellite.lon, burnStartMs);

      return {
        maneuver,
        burnStartMs,
        burnEndMs,
        cooldownEndMs,
        startPct: Math.max(0, Math.min(100, startPct)),
        burnWidthPct: Math.max(0.5, Math.min(100, burnWidthPct)),
        cooldownWidthPct: Math.max(0, Math.min(100, cooldownWidthPct)),
        isPast,
        isCurrent,
        isFuture,
        hasConflict: false,        // will be set in second pass
        isBlackout,
      };
    }).filter(block =>
      block.startPct <= 100 && block.startPct + block.burnWidthPct + block.cooldownWidthPct >= 0
    );

    // Second pass – conflict detection (overlapping cooldowns)
    blocks.sort((a, b) => a.burnStartMs - b.burnStartMs);
    let previousCooldownEnd = 0;
    for (const block of blocks) {
      if (block.burnStartMs < previousCooldownEnd) {
        block.hasConflict = true;
      }
      previousCooldownEnd = Math.max(previousCooldownEnd, block.cooldownEndMs);
    }

    return blocks;
  }, [selectedSatellite, satelliteManeuvers, timelineWindow, currentTime]);

  // Stable callbacks
  const getManeuverConfig = useCallback((type: string): ManeuverTypeConfig => {
    return MANEUVER_TYPES[type] || MANEUVER_TYPES.PHASING_PROGRADE;
  }, []);

  const calculateDeltaVMagnitude = useCallback((vector: { x: number; y: number; z: number }): number => {
    return Math.hypot(vector.x, vector.y, vector.z) * 1000; // km/s → m/s
  }, []);

  const getBlockStyles = useCallback((block: ManeuverBlock) => {
    const totalWidth = block.burnWidthPct + block.cooldownWidthPct;
    const outerWidth = `${Math.max(totalWidth, 0.5)}%`;
    const left = `${block.startPct}%`;

    const burnWidthInside = (block.burnWidthPct > 0 && totalWidth > 0)
      ? `${(block.burnWidthPct / totalWidth) * 100}%`
      : '100%';

    let cooldownLeft = '0%';
    let cooldownWidth = '0%';
    if (block.cooldownWidthPct > 0 && totalWidth > 0) {
      cooldownLeft = `${(block.burnWidthPct / totalWidth) * 100}%`;
      cooldownWidth = `${(block.cooldownWidthPct / totalWidth) * 100}%`;
    }

    return { outerWidth, left, burnWidthInside, cooldownLeft, cooldownWidth };
  }, []);

  // ==========================================================================
  // RENDER
  // ==========================================================================

  return (
    <div
      className="glass-panel flex flex-col h-full overflow-hidden"
      style={{
        background: 'rgba(0,0,0,0.60)',
        backdropFilter: 'blur(12px)',
        border: '1px solid rgba(255,0,51,0.3)',
      }}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-red-900/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-plasma-cyan rounded-full animate-pulse" />
          <h2 className="text-muted-gray font-mono text-xs tracking-widest uppercase">
            Maneuver Timeline
          </h2>
        </div>
        {selectedSatellite && (
          <div className="text-[10px] font-mono text-plasma-cyan">
            {selectedSatellite.id}
          </div>
        )}
      </div>

      {/* Timeline container */}
      <div className="flex-grow relative p-4 min-h-[180px]">
        {selectedSatellite ? (
          <>
            {/* The track */}
            <div className="relative h-16 bg-black/80 border border-red-900/50 rounded overflow-hidden shadow-[inset_0_0_20px_rgba(220,38,38,0.1)]">
              {/* Animated background grid – slow drift to suggest time flow */}
              <div
                className="absolute inset-0 flex"
                style={{
                  transform: `translateX(-${((currentTime % 60000) / 60000) * 10}%)`,
                  width: '110%',
                }}
              >
                {Array.from({ length: 11 }).map((_, i) => (
                  <div
                    key={`grid-${i}`}
                    className="flex-1 border-r border-red-900/20"
                    style={{ borderRightStyle: 'dashed', borderRightWidth: '0.5px' }}
                  />
                ))}
              </div>

              {/* T‑0 playhead */}
              <div
                className="absolute top-0 bottom-0 w-px z-20"
                style={{
                  left: '50%',
                  backgroundColor: THEME.COLORS.PLASMA_CYAN,
                  boxShadow: '0 0 10px rgba(0,255,255,1)',
                }}
              >
                <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-[9px] font-mono text-plasma-cyan font-bold whitespace-nowrap">
                  T-0 (NOW)
                </div>
              </div>

              {/* Maneuver blocks */}
              {maneuverBlocks.map((block) => {
                const config = getManeuverConfig(block.maneuver.maneuver_type);
                const { outerWidth, left, burnWidthInside, cooldownLeft, cooldownWidth } = getBlockStyles(block);

                return (
                  <div
                    key={block.maneuver.burn_id}
                    className="absolute top-2 bottom-2 z-10 group"
                    style={{ left, width: outerWidth }}
                    onMouseEnter={() => setHoveredManeuverId(block.maneuver.burn_id)}
                    onMouseLeave={() => setHoveredManeuverId(null)}
                  >
                    {/* Cooldown zone */}
                    {block.cooldownWidthPct > 0 && (
                      <div
                        className={`absolute top-0 bottom-0 right-0 border rounded-sm overflow-hidden ${
                          block.hasConflict ? 'border-amber bg-amber/20 animate-pulse' : 'border-[#FF0033]/60'
                        }`}
                        style={{
                          left: cooldownLeft,
                          width: cooldownWidth,
                          backgroundImage: block.hasConflict
                            ? 'none'
                            : `repeating-linear-gradient(45deg, rgba(255,0,51,0.15) 0px, rgba(255,0,51,0.15) 2px, transparent 2px, transparent 6px)`,
                        }}
                      >
                        {block.hasConflict && (
                          <span className="absolute top-1 left-1 text-[8px] text-amber font-mono font-bold whitespace-nowrap">
                            ⚠ CONFLICT
                          </span>
                        )}
                      </div>
                    )}

                    {/* Burn block */}
                    <div
                      className={`absolute top-0 bottom-0 left-0 border rounded-sm transition-all duration-200 group-hover:scale-y-110 ${
                        block.isBlackout ? 'border-laser-red animate-pulse' : ''
                      }`}
                      style={{
                        width: burnWidthInside,
                        backgroundColor: block.isBlackout
                          ? 'rgba(255,0,51,0.4)'
                          : `${config.color}40`,
                        borderColor: block.isBlackout ? '#FF0033' : config.color,
                        boxShadow: `0 0 15px ${block.isBlackout ? 'rgba(255,0,51,0.8)' : config.glowColor}`,
                      }}
                    >
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span
                          className="text-[10px] font-mono font-bold"
                          style={{ color: block.isBlackout ? '#FF0033' : config.color }}
                        >
                          {block.isBlackout ? '⚠' : config.icon}
                        </span>
                      </div>
                      {block.isCurrent && (
                        <div className="absolute -top-1 -right-1 w-2 h-2 bg-plasma-cyan rounded-full animate-ping" />
                      )}
                      {block.isPast && <div className="absolute inset-0 bg-black/50" />}
                    </div>

                    {/* Tooltip */}
                    {hoveredManeuverId === block.maneuver.burn_id && (
                      <div
                        className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-64 glass-panel p-3 z-50 bg-black/95 border border-plasma-cyan/60 shadow-[0_0_20px_rgba(0,255,255,0.2)]"
                      >
                        {/* Warnings */}
                        {(block.hasConflict || block.isBlackout) && (
                          <div className="mb-2 pb-2 border-b border-red-900/50 space-y-1">
                            {block.hasConflict && (
                              <div className="text-[9px] font-mono font-bold text-amber bg-amber/10 px-2 py-1 rounded">
                                ⚠ COOLDOWN OVERLAP DETECTED
                              </div>
                            )}
                            {block.isBlackout && (
                              <div className="text-[9px] font-mono font-bold text-laser-red bg-laser-red/10 px-2 py-1 rounded animate-pulse">
                                ⚠ ECLIPSE BLACKOUT ZONE
                              </div>
                            )}
                          </div>
                        )}

                        <div className="flex items-center gap-2 mb-2 pb-2 border-b border-gray-700/50">
                          <span className="text-lg" style={{ color: config.color }}>
                            {config.icon}
                          </span>
                          <span className="font-mono text-xs font-bold" style={{ color: config.color }}>
                            {config.label}
                          </span>
                        </div>
                        <div className="font-mono text-[10px] text-muted-gray space-y-1.5">
                          <div className="flex justify-between">
                            <span>RELATIVE:</span>
                            <span
                              className={
                                block.isFuture
                                  ? 'text-amber'
                                  : block.isPast
                                  ? 'text-muted-gray'
                                  : 'text-plasma-cyan'
                              }
                            >
                              {formatRelativeTime(block.burnStartMs, currentTime)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span>Δv MAGNITUDE:</span>
                            <span className="text-white">
                              {calculateDeltaVMagnitude(block.maneuver.deltaV_vector).toFixed(3)} m/s
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span>DURATION:</span>
                            <span className="text-white">
                              {block.maneuver.duration_seconds.toFixed(2)}s
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Timeline labels */}
            <div className="flex justify-between text-[10px] text-muted-gray font-mono border-t border-red-900/30 pt-2 mt-2">
              <span className="opacity-60">{formatTimestamp(timelineWindow.start)}</span>
              <span className="text-plasma-cyan font-bold drop-shadow-[0_0_5px_cyan]">
                T-0 (CURRENT)
              </span>
              <span className="opacity-60">{formatTimestamp(timelineWindow.end)}</span>
            </div>

            {/* Legend */}
            <div className="flex items-center justify-center gap-4 mt-3 text-[9px] font-mono text-muted-gray">
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 bg-plasma-cyan/40 border border-plasma-cyan rounded-sm" />
                <span>BURN</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div
                  className="w-3 h-3 border border-laser-red rounded-sm"
                  style={{
                    backgroundImage: `repeating-linear-gradient(45deg, rgba(255,0,51,0.3) 0px, rgba(255,0,51,0.3) 2px, transparent 2px, transparent 6px)`,
                  }}
                />
                <span>COOLDOWN (600s)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 bg-amber/20 border border-amber rounded-sm" />
                <span>⚠ CONFLICT</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 bg-laser-red/40 border border-laser-red rounded-sm" />
                <span>⚠ ECLIPSE</span>
              </div>
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-gray font-mono text-xs">
            <span className="tracking-wider">SELECT SATELLITE TO VIEW TIMELINE</span>
          </div>
        )}
      </div>

      {/* Footer stats */}
      {selectedSatellite && maneuverBlocks.length > 0 && (
        <div className="px-4 py-2 border-t border-red-900/30 bg-black/40">
          <div className="flex items-center justify-between font-mono text-[10px]">
            <div className="text-muted-gray">
              SCHEDULED: <span className="text-white">{maneuverBlocks.length}</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-plasma-cyan rounded-full" />
                <span className="text-plasma-cyan">
                  PENDING: {maneuverBlocks.filter((b) => b.isFuture).length}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-laser-red rounded-full animate-pulse" />
                <span className="text-laser-red">
                  ACTIVE: {maneuverBlocks.filter((b) => b.isCurrent).length}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default ManeuverGantt;