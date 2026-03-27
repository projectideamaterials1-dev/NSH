import React, { useMemo } from 'react';
import { useOrbitalStore } from '../store/useOrbitalStore';

export function ManeuverGantt() {
  const { selectedSatelliteId, maneuvers } = useOrbitalStore();

  const satelliteManeuvers = useMemo(() => {
    return maneuvers.filter(m => m.satellite_id === selectedSatelliteId);
  }, [maneuvers, selectedSatelliteId]);

  // For visualization, we'll map the next 20 minutes (-10m to +10m)
  // T-0 is now.
  const renderManeuver = (maneuver: any) => {
    const now = Date.now();
    const start = new Date(maneuver.start_time).getTime();
    // Enforce 600s cooldown if not provided
    const end = maneuver.cooldown_end ? new Date(maneuver.cooldown_end).getTime() : start + 600 * 1000;
    
    const windowStart = now - 10 * 60 * 1000; // -10 mins
    const windowEnd = now + 10 * 60 * 1000; // +10 mins
    const windowDuration = windowEnd - windowStart;

    // Calculate percentages for positioning
    const startPct = Math.max(0, ((start - windowStart) / windowDuration) * 100);
    const endPct = Math.min(100, ((end - windowStart) / windowDuration) * 100);
    const widthPct = Math.max(0.5, endPct - startPct);

    // Burn duration is very short (e.g. 1.2s), so we'll give it a fixed small width or calculate it
    const burnEnd = start + maneuver.duration * 1000;
    const burnEndPct = Math.min(100, ((burnEnd - windowStart) / windowDuration) * 100);
    const burnWidthPct = Math.max(0.5, burnEndPct - startPct);

    if (startPct > 100 || endPct < 0) return null; // Outside window

    const formatTime = (ms: number) => {
      const d = new Date(ms);
      return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}:${d.getUTCSeconds().toString().padStart(2, '0')}.${d.getUTCMilliseconds().toString().padStart(3, '0')}Z`;
    };

    return (
      <div key={maneuver.id} className="absolute top-1 bottom-1" style={{ left: `${startPct}%`, width: `${widthPct}%` }}>
        {/* Cooldown Area - Cross-hatched glowing red */}
        <div 
          className="absolute inset-0 border border-[#FF0033]/80 rounded-sm group flex items-center px-1 overflow-hidden shadow-[0_0_10px_rgba(255,0,51,0.5)]"
          style={{
            backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,0,51,0.2) 0, rgba(255,0,51,0.2) 2px, transparent 2px, transparent 6px)'
          }}
        >
          <span className="text-[9px] text-[#FF0033] font-mono opacity-80 group-hover:opacity-100 whitespace-nowrap drop-shadow-[0_0_5px_rgba(255,0,51,0.8)] font-bold">THERMAL COOLDOWN (600s)</span>
        </div>
        
        {/* Burn Area */}
        <div className="absolute top-0 bottom-0 bg-[#00FFFF]/80 border border-[#00FFFF] flex items-center justify-center rounded-sm shadow-[0_0_15px_rgba(0,255,255,0.8)] group cursor-pointer hover:bg-[#00FFFF] transition-colors z-10" style={{ width: `${Math.max(4, burnWidthPct * 10)}px` }}>
          {/* Tooltip */}
          <div className="absolute bottom-full mb-2 hidden group-hover:block w-48 bg-black/90 backdrop-blur-md border border-[#00FFFF]/50 p-2 rounded text-[10px] text-[#00FFFF] z-50 shadow-[0_0_15px_rgba(0,255,255,0.3)]">
            <div className="font-bold border-b border-[#00FFFF]/30 pb-1 mb-1">{maneuver.type || 'PHASING_PROGRADE'}</div>
            <div>ID: {maneuver.id}</div>
            <div>START: {formatTime(start)}</div>
            <div>Δv: {maneuver.delta_v} m/s</div>
            <div>DUR: {maneuver.duration}s</div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="p-4 border border-red-900/50 bg-black/60 rounded-lg shadow-[0_0_15px_rgba(220,38,38,0.2)]">
      <h2 className="text-[#888888] font-mono text-xs tracking-widest mb-4 uppercase">Maneuver Timeline</h2>
      <div className="space-y-3">
        {selectedSatelliteId ? (
          <>
            <div className="relative h-12 bg-black/80 border border-red-900/50 rounded overflow-hidden shadow-[inset_0_0_20px_rgba(220,38,38,0.1)]">
              {/* Background grid */}
              <div className="absolute inset-0 flex">
                {Array.from({length: 10}).map((_, i) => (
                  <div key={i} className="flex-1 border-r border-red-900/30 opacity-50"></div>
                ))}
              </div>
              
              {/* Current Time Indicator */}
              <div className="absolute top-0 bottom-0 w-px bg-[#00FFFF] left-1/2 z-0 shadow-[0_0_10px_rgba(0,255,255,1)]"></div>
              
              {satelliteManeuvers.map(renderManeuver)}
              
              {satelliteManeuvers.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-[10px] text-[#888888] font-mono opacity-50">
                  NO SCHEDULED MANEUVERS
                </div>
              )}
            </div>
            
            <div className="flex justify-between text-[10px] text-[#888888] font-mono border-t border-red-900/50 pt-1">
              <span>-10m</span>
              <span className="text-[#00FFFF] drop-shadow-[0_0_5px_rgba(0,255,255,0.8)] font-bold">T-0</span>
              <span>+10m</span>
            </div>
          </>
        ) : (
          <div className="text-[#888888] font-mono text-xs text-center py-8 border border-dashed border-red-900/50">
            SELECT TARGET FOR TIMELINE
          </div>
        )}
      </div>
    </div>
  );
}
