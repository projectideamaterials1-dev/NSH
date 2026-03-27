import React, { useMemo } from 'react';
import { ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { useOrbitalStore } from '../store/useOrbitalStore';

export function ResourceMetrics() {
  const { satellites, selectedSatelliteId } = useOrbitalStore();
  const selectedSat = satellites.find(s => s.id === selectedSatelliteId);
  
  // Generate mock time-series data for the fleet over the last 12 hours
  const metricsData = useMemo(() => {
    const data = [];
    let totalFuel = 5000;
    let totalAvoided = 0;
    
    for (let i = 12; i >= 0; i--) {
      const time = new Date(Date.now() - i * 60 * 60 * 1000);
      
      // Simulate fuel consumption (decreasing)
      const fuelConsumed = Math.random() * 50 + 10;
      totalFuel -= fuelConsumed;
      
      // Simulate collisions avoided (increasing cumulative or per hour)
      const avoided = Math.floor(Math.random() * 3);
      totalAvoided += avoided;
      
      data.push({
        time: `${time.getHours()}:00`,
        fuel: Math.max(0, totalFuel),
        avoided: totalAvoided,
        fuelDelta: fuelConsumed
      });
    }
    return data;
  }, []);

  const fuelLevel = selectedSat ? selectedSat.fuel_kg : 50.0;
  const fuelPercent = Math.max(0, Math.min(100, ((fuelLevel - 2.5) / (50.0 - 2.5)) * 100));
  
  const getFuelColor = (percent: number) => {
    if (percent > 60) return '#00FFFF'; // Cyan
    if (percent > 25) return '#FFBF00'; // Yellow/Amber
    return '#FF0033'; // Crimson
  };

  const fuelColor = getFuelColor(fuelPercent);

  return (
    <div className="p-4 border border-red-900/50 bg-black/60 rounded-lg flex-1 min-h-[250px] flex flex-col shadow-[0_0_15px_rgba(220,38,38,0.2)]">
      <h2 className="text-[#888888] font-mono text-xs tracking-widest mb-4 uppercase">Δv Cost Analysis</h2>
      
      {/* Fuel Gauge */}
      <div className="mb-6">
        <div className="flex justify-between text-xs font-mono mb-1">
          <span className="text-[#888888]">PROPELLANT (kg)</span>
          <span style={{ color: fuelColor }} className="drop-shadow-[0_0_5px_currentColor]">{fuelLevel.toFixed(2)} / 50.00</span>
        </div>
        <div className="h-2 bg-black/80 border border-red-900/50 rounded overflow-hidden relative">
          <div 
            className="h-full transition-all duration-1000 ease-out"
            style={{ 
              width: `${fuelPercent}%`, 
              backgroundColor: fuelColor,
              boxShadow: `0 0 10px ${fuelColor}`
            }}
          />
          {/* EOL Marker */}
          <div className="absolute top-0 bottom-0 left-[5%] w-px bg-[#FF0033] shadow-[0_0_5px_rgba(255,0,51,1)] z-10" title="EOL Threshold (2.5kg)" />
        </div>
      </div>

      <div className="flex-grow w-full h-full min-h-[150px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={metricsData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorFuel" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#8B0000" stopOpacity={0.8}/>
                <stop offset="95%" stopColor="#1A0000" stopOpacity={0.2}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#FF0033" opacity={0.2} vertical={false} />
            <XAxis dataKey="time" stroke="#888888" opacity={0.5} fontSize={10} tickLine={false} axisLine={false} />
            <YAxis yAxisId="left" stroke="#FF0033" opacity={0.5} fontSize={10} tickLine={false} axisLine={false} />
            <YAxis yAxisId="right" orientation="right" stroke="#00FFFF" opacity={0.5} fontSize={10} tickLine={false} axisLine={false} />
            <Tooltip 
              contentStyle={{ backgroundColor: 'rgba(0,0,0,0.8)', border: '1px solid rgba(220,38,38,0.5)', borderRadius: '4px', backdropFilter: 'blur(4px)', boxShadow: '0 0 15px rgba(220,38,38,0.3)' }}
              itemStyle={{ fontSize: '12px', fontFamily: 'monospace' }}
              labelStyle={{ color: '#888888', fontSize: '10px', fontFamily: 'monospace' }}
            />
            <Legend wrapperStyle={{ fontSize: '10px', fontFamily: 'monospace', paddingTop: '10px', color: '#888888' }} />
            <Area yAxisId="left" type="monotone" dataKey="fuel" name="Fleet Fuel (kg)" stroke="#FF0033" fillOpacity={1} fill="url(#colorFuel)" />
            <Line yAxisId="right" type="stepAfter" dataKey="avoided" name="Collisions Avoided" stroke="#00FFFF" strokeWidth={2} dot={{ r: 3, fill: '#00FFFF', stroke: '#00FFFF', filter: 'drop-shadow(0 0 5px rgba(0,255,255,0.8))' }} style={{ filter: 'drop-shadow(0 0 5px rgba(0,255,255,0.8))' }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
