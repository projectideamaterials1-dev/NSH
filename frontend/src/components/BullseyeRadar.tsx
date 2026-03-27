import React, { useMemo } from 'react';
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useOrbitalStore } from '../store/useOrbitalStore';

// Custom shape for the radar rings
const RadarRings = () => {
  return (
    <g>
      <circle cx="50%" cy="50%" r="40%" fill="none" stroke="#FF0033" strokeWidth="1" opacity="0.5" filter="drop-shadow(0 0 5px rgba(255,0,51,0.8))" />
      <circle cx="50%" cy="50%" r="30%" fill="none" stroke="#FF0033" strokeWidth="1" opacity="0.4" />
      <circle cx="50%" cy="50%" r="20%" fill="none" stroke="#FF0033" strokeWidth="1" opacity="0.3" />
      <circle cx="50%" cy="50%" r="10%" fill="none" stroke="#FF0033" strokeWidth="1" opacity="0.2" />
      <line x1="50%" y1="10%" x2="50%" y2="90%" stroke="#FF0033" strokeWidth="1" opacity="0.5" />
      <line x1="10%" y1="50%" x2="90%" y2="50%" stroke="#FF0033" strokeWidth="1" opacity="0.5" />
      <circle cx="50%" cy="50%" r="2%" fill="#00FFFF" filter="drop-shadow(0 0 8px rgba(0,255,255,1))" />
    </g>
  );
};

const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-black/80 backdrop-blur-md border border-red-900/50 p-3 text-xs font-mono text-[#888888] shadow-[0_0_15px_rgba(220,38,38,0.3)] rounded">
        <p className="text-[#00FFFF] mb-2 font-bold drop-shadow-[0_0_5px_rgba(0,255,255,0.5)]">TARGET: {data.id}</p>
        <div className="space-y-1">
          <p className="flex justify-between gap-4"><span>DISTANCE:</span> <span className="text-white">{data.distance.toFixed(3)} m</span></p>
          <p className="flex justify-between gap-4"><span>TCA:</span> <span className="text-white">{data.tca.toFixed(3)} s</span></p>
          <p className="flex justify-between gap-4">
            <span>RISK:</span> 
            <span className={data.risk === 'CRITICAL' ? 'text-[#FF0033] animate-pulse drop-shadow-[0_0_5px_rgba(255,0,51,0.8)]' : 'text-[#FFBF00] drop-shadow-[0_0_5px_rgba(255,191,0,0.8)]'}>
              {data.riskScore.toFixed(4)} ({data.risk})
            </span>
          </p>
        </div>
      </div>
    );
  }
  return null;
};

export function BullseyeRadar() {
  const { selectedSatelliteId, satellites } = useOrbitalStore();
  const selectedSat = satellites.find(s => s.id === selectedSatelliteId);

  // Generate mock conjunction data mapped to Cartesian coordinates for ScatterChart
  const conjunctionData = useMemo(() => {
    if (!selectedSat) return [];
    
    return Array.from({ length: 15 }).map((_, i) => {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.random() * 80 + 10; // 10 to 90 m
      const isCritical = distance < 30;
      const riskScore = isCritical ? 0.8 + Math.random() * 0.19 : 0.5 + Math.random() * 0.29;
      
      // Map polar to cartesian (-100 to 100)
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      
      return {
        id: `DEB-${Math.floor(Math.random() * 90000) + 10000}`,
        x,
        y,
        distance,
        tca: Math.random() * 120, // Time to Closest Approach
        risk: isCritical ? 'CRITICAL' : 'WARNING',
        riskScore,
        size: isCritical ? 60 : 30
      };
    });
  }, [selectedSat]);

  return (
    <div className="p-4 border border-red-900/50 bg-black/60 rounded-lg flex flex-col h-full shadow-[0_0_15px_rgba(220,38,38,0.2)]">
      <h2 className="text-[#888888] font-mono text-xs tracking-widest mb-2 uppercase">Conjunction Radar</h2>
      <div className="flex-grow relative w-full h-full min-h-[250px]">
        {selectedSat ? (
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
              <XAxis type="number" dataKey="x" domain={[-100, 100]} hide />
              <YAxis type="number" dataKey="y" domain={[-100, 100]} hide />
              <ZAxis type="number" dataKey="size" range={[20, 100]} />
              <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3', stroke: '#FF0033', opacity: 0.5 }} />
              
              {/* Custom Radar Background */}
              <RadarRings />
              
              <Scatter data={conjunctionData} shape="circle">
                {conjunctionData.map((entry, index) => (
                  <Cell 
                    key={`cell-${index}`} 
                    fill={entry.risk === 'CRITICAL' ? '#FF0033' : '#FFBF00'} 
                    className={entry.risk === 'CRITICAL' ? 'animate-pulse' : ''}
                    style={{ filter: `drop-shadow(0 0 5px ${entry.risk === 'CRITICAL' ? '#FF0033' : '#FFBF00'})` }}
                  />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[#888888] font-mono text-xs">
            SELECT SATELLITE TO VIEW CONJUNCTIONS
          </div>
        )}
      </div>
    </div>
  );
}
