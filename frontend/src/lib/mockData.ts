export const GROUND_STATIONS = [
  { id: 'GS-001', name: 'ISTRAC_Bengaluru', coordinates: [77.5167, 13.0333] },
  { id: 'GS-002', name: 'Svalbard_Sat_Station', coordinates: [15.4077, 78.2297] },
  { id: 'GS-003', name: 'Goldstone_Tracking', coordinates: [-116.8900, 35.4266] },
  { id: 'GS-004', name: 'Punta_Arenas', coordinates: [-70.9167, -53.1500] },
  { id: 'GS-005', name: 'IIT_Delhi_Ground_Node', coordinates: [77.1926, 28.5450] },
  { id: 'GS-006', name: 'McMurdo_Station', coordinates: [166.6682, -77.8463] },
];

export const generateSatellites = (count: number) => {
  return Array.from({ length: count }).map((_, i) => ({
    id: `SAT-${i}`,
    coordinates: [(Math.random() - 0.5) * 360, (Math.random() - 0.5) * 180],
    fuel: Math.random() * 50,
    status: Math.random() > 0.9 ? 'WARNING' : 'NOMINAL',
  }));
};

export const generateDebris = (count: number) => {
  return Array.from({ length: count }).map((_, i) => ({
    id: `DEB-${i}`,
    coordinates: [(Math.random() - 0.5) * 360, (Math.random() - 0.5) * 180],
    risk: Math.random(),
  }));
};
