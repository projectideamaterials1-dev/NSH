// src/components/BullseyeRadar.tsx
// Futuristic Conjunction Radar – SVG Polar Plot with Sweeping Scanner
// Optimized for 60 FPS | Real-time TCA | Risk Color Coding | Global Debris Stats

import React, { useMemo, useState } from 'react';
import useOrbitalStore, {
  selectSelectedSatellite,
  selectDebrisCount,
  selectHighRiskDebrisCount,
} from '../store/useOrbitalStore';

// ============================================================================
// CONFIGURATION
// ============================================================================

const RADAR_CONFIG = {
  MAX_TCA_SECONDS: 120,         // Display limit (2 minutes)
  MAX_DISPLAY_DEBRIS: 60,       // Performance cap
  RELATIVE_VELOCITY_KM_S: 7.5,  // Typical LEO closure rate
  DISTANCE_CRITICAL_M: 1000,    // 1 km
  DISTANCE_WARNING_M: 5000,     // 5 km
  SWEEP_SPEED_SECONDS: 4,       // Rotation duration (s)
  // Colors
  COLOR_CRITICAL: '#FF0033',
  COLOR_WARNING: '#D29922',
  COLOR_NOMINAL: '#00FFFF',
  COLOR_GRID: 'rgba(255, 0, 51, 0.3)',
  COLOR_BACKGROUND: 'rgba(0,0,0,0.4)',
};

// ============================================================================
// TYPES
// ============================================================================

interface ConjunctionData {
  id: string;
  distanceM: number;
  tca: number;
  risk: 'CRITICAL' | 'WARNING' | 'NOMINAL';
  approachAngle: number;       // 0-360 degrees
  normalizedRadius: number;    // 0..1
}

// ============================================================================
// DATA CALCULATION (Optimized with early exits)
// ============================================================================

function calculateConjunctionData(
  selectedSat: ReturnType<typeof selectSelectedSatellite>,
  debris: ReturnType<typeof useOrbitalStore.getState>['debris']
): ConjunctionData[] {
  if (!selectedSat || !debris || debris.length === 0) return [];

  const results: ConjunctionData[] = [];
  const satLatRad = selectedSat.lat * (Math.PI / 180);
  const satLon = selectedSat.lon;

  // Pre-calc cos(lat) for haversine
  const cosSatLat = Math.cos(satLatRad);

  // Iterate over debris (up to 100k)
  for (let i = 0; i < debris.length; i++) {
    const lon = debris.positions[i * 3];
    const lat = debris.positions[i * 3 + 1];

    // Quick bounding box – skip far away objects (approx 10 degrees ~ 1110 km)
    if (Math.abs(lat - selectedSat.lat) > 10) continue;
    let deltaLon = Math.abs(lon - satLon);
    if (deltaLon > 180) deltaLon = 360 - deltaLon;
    if (deltaLon > 10) continue;

    // Haversine angular distance
    const debLatRad = lat * (Math.PI / 180);
    const deltaLonRad = (lon - satLon) * (Math.PI / 180);
    const a = Math.sin((debLatRad - satLatRad) / 2) ** 2 +
              cosSatLat * Math.cos(debLatRad) *
              Math.sin(deltaLonRad / 2) ** 2;
    const angularDist = 2 * Math.asin(Math.sqrt(a));
    const distanceKm = angularDist * (180 / Math.PI) * 111; // degrees to km
    const distanceM = distanceKm * 1000;

    if (distanceM > 100000) continue; // >100 km

    const tca = distanceKm / RADAR_CONFIG.RELATIVE_VELOCITY_KM_S;
    if (tca > RADAR_CONFIG.MAX_TCA_SECONDS) continue;

    // Risk based on distance
    let risk: 'CRITICAL' | 'WARNING' | 'NOMINAL';
    if (distanceM < RADAR_CONFIG.DISTANCE_CRITICAL_M) risk = 'CRITICAL';
    else if (distanceM < RADAR_CONFIG.DISTANCE_WARNING_M) risk = 'WARNING';
    else risk = 'NOMINAL';

    // Approach angle relative to satellite
    let angle = Math.atan2(lat - selectedSat.lat, lon - satLon) * (180 / Math.PI);
    if (angle < 0) angle += 360;

    const normalizedRadius = Math.min(0.98, Math.max(0.05, tca / RADAR_CONFIG.MAX_TCA_SECONDS));

    results.push({
      id: debris.ids[i] || `DEB-${i}`,
      distanceM,
      tca,
      risk,
      approachAngle: angle,
      normalizedRadius,
    });
  }

  // Sort by TCA (closest first) and cap
  return results.sort((a, b) => a.tca - b.tca).slice(0, RADAR_CONFIG.MAX_DISPLAY_DEBRIS);
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const BullseyeRadar: React.FC = React.memo(() => {
  const store = useOrbitalStore();
  const selectedSat = useMemo(() => selectSelectedSatellite(store), [store]);
  const debris = store.debris;

  const debrisCount = useMemo(() => selectDebrisCount(store), [store]);
  const highRiskCount = useMemo(() => selectHighRiskDebrisCount(store), [store]);

  const [hoveredBlip, setHoveredBlip] = useState<ConjunctionData | null>(null);

  const conjunctionData = useMemo(
    () => calculateConjunctionData(selectedSat, debris),
    [selectedSat, debris]
  );

  // Memoize SVG generation to avoid recalc on every hover
  const svgMarkup = useMemo(() => {
    if (!selectedSat) return null;

    const rings = [25, 50, 75, 100];
    const sweepPath = `M 0,0 L 0,-100 A 100,100 0 0,1 70.7,-70.7 Z`;

    return (
      <svg className="absolute inset-0 w-full h-full drop-shadow-lg" viewBox="-100 -100 200 200">
        {/* Background plate */}
        <circle cx="0" cy="0" r="100" fill={RADAR_CONFIG.COLOR_BACKGROUND} />

        {/* Range rings */}
        {rings.map((r, i) => (
          <g key={r}>
            <circle
              cx="0"
              cy="0"
              r={r}
              fill="none"
              stroke={RADAR_CONFIG.COLOR_GRID}
              strokeWidth="0.5"
              strokeDasharray={r === 50 || r === 100 ? 'none' : '4 4'}
            />
            <text x="2" y={-r + 6} fill="#FF0033" fontSize="5" opacity="0.7" fontFamily="monospace">
              {(i + 1) * (RADAR_CONFIG.MAX_TCA_SECONDS / 4)}s
            </text>
          </g>
        ))}

        {/* Crosshairs */}
        <line x1="0" y1="-100" x2="0" y2="100" stroke={RADAR_CONFIG.COLOR_GRID} strokeWidth="0.5" />
        <line x1="-100" y1="0" x2="100" y2="0" stroke={RADAR_CONFIG.COLOR_GRID} strokeWidth="0.5" />
        <circle cx="0" cy="0" r="1.5" fill={RADAR_CONFIG.COLOR_NOMINAL} filter="drop-shadow(0 0 4px cyan)" />

        {/* Rotating sweep (CSS animation) */}
        <g className="animate-radar-spin" style={{ transformOrigin: '0px 0px' }}>
          <path d={sweepPath} fill="rgba(0, 255, 255, 0.15)" />
          <line x1="0" y1="0" x2="0" y2="-100" stroke="#00FFFF" strokeWidth="1" filter="drop-shadow(0 0 4px cyan)" />
        </g>

        {/* Blips */}
        {conjunctionData.map((data, idx) => {
          const rad = data.approachAngle * (Math.PI / 180);
          const r = data.normalizedRadius * 100;
          const cx = Math.cos(rad) * r;
          const cy = -(Math.sin(rad) * r); // SVG Y is flipped
          const isCritical = data.risk === 'CRITICAL';
          const color = isCritical
            ? RADAR_CONFIG.COLOR_CRITICAL
            : data.risk === 'WARNING'
            ? RADAR_CONFIG.COLOR_WARNING
            : RADAR_CONFIG.COLOR_NOMINAL;

          return (
            <g
              key={`${data.id}-${idx}`}
              onMouseEnter={() => setHoveredBlip(data)}
              onMouseLeave={() => setHoveredBlip(null)}
              className="cursor-crosshair"
            >
              {isCritical && (
                <line
                  x1="0"
                  y1="0"
                  x2={cx}
                  y2={cy}
                  stroke={color}
                  strokeWidth="0.5"
                  strokeDasharray="2 2"
                  className="animate-pulse"
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r={isCritical ? 3.5 : data.risk === 'WARNING' ? 2.5 : 1.5}
                fill={color}
                className={isCritical ? 'animate-blip' : ''}
                filter={isCritical ? 'drop-shadow(0 0 6px #FF0033)' : 'none'}
              />
              {(isCritical || data.risk === 'WARNING' || hoveredBlip?.id === data.id) && (
                <text x={cx + 5} y={cy + 2} fill={color} fontSize="4" fontFamily="monospace" fontWeight="bold">
                  {data.id}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    );
  }, [selectedSat, conjunctionData, hoveredBlip]);

  return (
    <div
      className="glass-panel flex flex-col h-full overflow-hidden relative"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,0,51,0.3)' }}
    >
      {/* CSS animations */}
      <style>
        {`
          @keyframes radar-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          .animate-radar-spin {
            animation: radar-spin ${RADAR_CONFIG.SWEEP_SPEED_SECONDS}s linear infinite;
          }
          @keyframes blip-pulse {
            0% { opacity: 0.2; transform: scale(0.8); }
            50% { opacity: 1; transform: scale(1.2); }
            100% { opacity: 0.2; transform: scale(0.8); }
          }
          .animate-blip {
            animation: blip-pulse 2s infinite;
          }
        `}
      </style>

      {/* Header */}
      <div className="px-4 py-3 border-b border-red-900/30 flex items-center justify-between z-10 bg-black/40">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-laser-red rounded-full animate-pulse shadow-[0_0_8px_#FF0033]" />
          <h2 className="text-muted-gray font-mono text-xs tracking-widest uppercase">Targeting Radar</h2>
        </div>
        {selectedSat && <div className="text-[10px] font-mono text-plasma-cyan font-bold">{selectedSat.id}</div>}
      </div>

      {/* Radar Canvas */}
      <div className="relative flex-grow w-full flex items-center justify-center p-2">
        {selectedSat ? (
          <div className="relative w-full max-w-[320px] aspect-square">
            {svgMarkup}
            {/* Floating tooltip */}
            {hoveredBlip && (
              <div className="absolute top-2 left-2 pointer-events-none z-20">
                <div
                  className="glass-panel px-3 py-2"
                  style={{
                    background: 'rgba(0,0,0,0.95)',
                    border: `1px solid ${
                      hoveredBlip.risk === 'CRITICAL' ? '#FF0033' : hoveredBlip.risk === 'WARNING' ? '#D29922' : '#00FFFF'
                    }`,
                  }}
                >
                  <div
                    className="text-[10px] font-mono font-bold mb-1"
                    style={{
                      color: hoveredBlip.risk === 'CRITICAL' ? '#FF0033' : hoveredBlip.risk === 'WARNING' ? '#D29922' : '#00FFFF',
                    }}
                  >
                    TARGET: {hoveredBlip.id}
                  </div>
                  <div className="text-[9px] font-mono text-muted-gray space-y-0.5">
                    <div>
                      DIST: <span className="text-white">{hoveredBlip.distanceM.toFixed(0)}m</span>
                    </div>
                    <div>
                      TCA: <span className="text-white">{hoveredBlip.tca.toFixed(1)}s</span>
                    </div>
                    <div>
                      BEARING: <span className="text-white">{hoveredBlip.approachAngle.toFixed(0)}°</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-gray font-mono text-xs">
            <div className="animate-pulse w-12 h-12 rounded-full border border-dashed border-red-900/50 mb-3 flex items-center justify-center">
              <div className="w-1 h-1 bg-red-900 rounded-full" />
            </div>
            <span className="tracking-wider">AWAITING TARGET LOCK</span>
          </div>
        )}
      </div>

      {/* Threat summary footer */}
      {selectedSat && conjunctionData.length > 0 && (
        <div className="px-4 py-2 border-t border-red-900/30 bg-black/40 z-10">
          <div className="flex justify-between font-mono text-[10px]">
            <div className="text-muted-gray">
              BOGEYS: <span className="text-white">{conjunctionData.length}</span>
            </div>
            <div className="flex gap-3">
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-laser-red rounded-full animate-pulse" />
                <span className="text-laser-red">
                  CRIT: {conjunctionData.filter((d) => d.risk === 'CRITICAL').length}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-amber rounded-full" />
                <span className="text-amber">
                  WARN: {conjunctionData.filter((d) => d.risk === 'WARNING').length}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Global debris stats (always visible) */}
      <div className="px-4 py-2 border-t border-red-900/20 bg-black/30 z-10">
        <div className="flex justify-between font-mono text-[10px] text-muted-gray">
          <span>GLOBAL DEBRIS:</span>
          <span className="text-plasma-cyan">{debrisCount.toLocaleString()}</span>
        </div>
        {highRiskCount > 0 && (
          <div className="flex justify-between font-mono text-[10px] text-muted-gray mt-1">
            <span>HIGH RISK TRACTS:</span>
            <span className="text-laser-red animate-pulse">{highRiskCount.toLocaleString()}</span>
          </div>
        )}
      </div>
    </div>
  );
});

export default BullseyeRadar;