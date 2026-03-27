import React from 'react';
import { BullseyeRadar } from './BullseyeRadar';
import { ResourceMetrics } from './ResourceMetrics';
import { ManeuverGantt } from './ManeuverGantt';
import { useOrbitalStore } from '../store/useOrbitalStore';

export function DashboardLayout() {
  const { satellites, selectedSatelliteId, timestamp } = useOrbitalStore();
  const selectedSat = satellites.find(s => s.id === selectedSatelliteId);

  return (
    <div className="absolute top-14 right-0 bottom-0 w-[450px] bg-black/40 backdrop-blur-md border-l border-red-900/50 p-4 flex flex-col gap-4 overflow-y-auto z-10 shadow-[-10px_0_30px_rgba(220,38,38,0.1)]">
      
      {/* Selected Satellite Info */}
      <div className="p-4 border border-red-900/50 bg-black/60 rounded-lg shadow-[0_0_15px_rgba(220,38,38,0.2)]">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[#888888] font-mono text-xs tracking-widest uppercase">Target Lock</h2>
          {selectedSat && <span className="text-[10px] text-[#00FFFF] font-mono animate-pulse drop-shadow-[0_0_5px_rgba(0,255,255,0.8)]">LIVE</span>}
        </div>
        {selectedSat ? (
          <div className="space-y-2 font-mono text-xs">
            <div className="flex justify-between border-b border-red-900/30 pb-1">
              <span className="text-[#888888]">ID:</span>
              <span className="text-[#00FFFF] font-bold drop-shadow-[0_0_5px_rgba(0,255,255,0.5)]">{selectedSat.id}</span>
            </div>
            <div className="flex justify-between border-b border-red-900/30 pb-1">
              <span className="text-[#888888]">STATUS:</span>
              <span className={
                selectedSat.status === 'NOMINAL' ? 'text-[#00FFFF] drop-shadow-[0_0_5px_rgba(0,255,255,0.5)]' : 
                selectedSat.status === 'WARNING' ? 'text-[#FFBF00] drop-shadow-[0_0_5px_rgba(255,191,0,0.5)]' : 
                'text-[#FF0033] animate-pulse font-bold drop-shadow-[0_0_8px_rgba(255,0,51,0.8)]'
              }>
                {selectedSat.status}
              </span>
            </div>
            <div className="flex justify-between border-b border-red-900/30 pb-1">
              <span className="text-[#888888]">FUEL MASS:</span>
              <span className="text-white">{selectedSat.fuel_kg.toFixed(3)} kg</span>
            </div>
            <div className="flex justify-between border-b border-red-900/30 pb-1">
              <span className="text-[#888888]">LATITUDE:</span>
              <span className="text-white">{selectedSat.lat.toFixed(6)}°</span>
            </div>
            <div className="flex justify-between border-b border-red-900/30 pb-1">
              <span className="text-[#888888]">LONGITUDE:</span>
              <span className="text-white">{selectedSat.lon.toFixed(6)}°</span>
            </div>
            <div className="flex justify-between pt-1">
              <span className="text-[#888888]">LAST UPDATE:</span>
              <span className="text-[#888888]">{timestamp ? new Date(timestamp).toISOString() : 'N/A'}</span>
            </div>
          </div>
        ) : (
          <div className="text-[#888888] font-mono text-xs text-center py-8 border border-dashed border-red-900/50">
            AWAITING TARGET SELECTION...
          </div>
        )}
      </div>

      <BullseyeRadar />
      <ResourceMetrics />
      <ManeuverGantt />
    </div>
  );
}
