import React, { useMemo, useState, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, ArcLayer, PolygonLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { Map } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useOrbitalStore } from '../store/useOrbitalStore';
import { GROUND_STATIONS } from '../lib/mockData';

const INITIAL_VIEW_STATE = {
  longitude: 0,
  latitude: 0,
  zoom: 1.5,
  pitch: 0,
  bearing: 0
};

// Calculate the day/night terminator polygon based on current time
function getTerminatorPolygon(date: Date) {
  const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 1000 / 60 / 60 / 24);
  const declination = -23.44 * Math.cos((360 / 365) * (dayOfYear + 10) * (Math.PI / 180));
  
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  // Sun moves 15 degrees per hour. At 12:00 UTC, sun is at 0 degrees longitude.
  let sunLon = 180 - (15 * utcHours);
  if (sunLon < -180) sunLon += 360;
  if (sunLon > 180) sunLon -= 360;
  
  const points = [];
  const decRad = declination * (Math.PI / 180);
  
  for (let lon = -180; lon <= 180; lon += 2) {
    const lonRad = (lon - sunLon) * (Math.PI / 180);
    // Latitude of terminator at this longitude
    const latRad = Math.atan(-Math.cos(lonRad) / Math.tan(decRad));
    points.push([lon, latRad * (180 / Math.PI)]);
  }
  
  // Close the polygon around the night side (opposite to sun)
  if (declination > 0) {
    // Northern summer, night is at South Pole
    points.push([180, -90], [-180, -90]);
  } else {
    // Northern winter, night is at North Pole
    points.push([180, 90], [-180, 90]);
  }
  
  return [points];
}

export function DeckGLMap() {
  const { satellites, debris, satelliteHistory, selectedSatelliteId, setSelectedSatellite } = useOrbitalStore();
  const [time, setTime] = useState(0);
  const [terminator, setTerminator] = useState(() => getTerminatorPolygon(new Date()));

  useEffect(() => {
    let animationFrame: number;
    let lastUpdate = 0;
    
    const animate = (now: number) => {
      setTime(t => (t + 1) % 1000); // Loop time from 0 to 1000
      
      // Update terminator every minute
      if (now - lastUpdate > 60000) {
        setTerminator(getTerminatorPolygon(new Date()));
        lastUpdate = now;
      }
      
      animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  const selectedSat = useMemo(() => satellites.find(s => s.id === selectedSatelliteId), [satellites, selectedSatelliteId]);

  const historyData = useMemo(() => {
    return Object.entries(satelliteHistory).map(([id, path]) => ({
      id,
      path,
      timestamps: path.map((_, i) => i * 10) // Mock timestamps for TripsLayer: 0, 10, 20... up to 1000
    }));
  }, [satelliteHistory]);

  const layers = [
    // Terminator Line (Night zone)
    new PolygonLayer({
      id: 'terminator-layer',
      data: [{ polygon: terminator }],
      getPolygon: (d: any) => d.polygon,
      getFillColor: [0, 0, 0, 150],
      stroked: false,
      updateTriggers: {
        getPolygon: [terminator]
      }
    }),

    // Debris Layer (Optimized Binary Rendering)
    debris && new ScatterplotLayer({
      id: 'debris-layer',
      data: {
        length: debris.length,
        attributes: {
          getPosition: { value: debris.positions, size: 3 },
          getFillColor: { value: debris.colors, size: 4 }
        }
      },
      getRadius: 20000,
      radiusMinPixels: 1,
      radiusMaxPixels: 3,
      updateTriggers: {
        getFillColor: [selectedSatelliteId]
      }
    }),

    // Satellite History Path (TripsLayer for comet tails)
    new TripsLayer({
      id: 'satellite-history',
      data: historyData,
      getPath: (d: any) => d.path,
      getTimestamps: (d: any) => d.timestamps,
      getColor: (d: any) => d.id === selectedSatelliteId ? [255, 255, 255, 255] : [0, 255, 255, 255],
      opacity: 0.8,
      widthMinPixels: 2,
      trailLength: 5400,
      currentTime: time,
      updateTriggers: {
        getColor: [selectedSatelliteId]
      }
    }),

    // Ground Stations
    new ScatterplotLayer({
      id: 'ground-stations',
      data: GROUND_STATIONS,
      getPosition: (d: any) => d.coordinates,
      getFillColor: [255, 0, 51, 200],
      getRadius: 50000,
      radiusMinPixels: 3,
      radiusMaxPixels: 10,
    }),

    // Satellites Layer
    new ScatterplotLayer({
      id: 'satellites-layer',
      data: satellites,
      pickable: true,
      onClick: (info) => setSelectedSatellite(info.object ? info.object.id : null),
      getPosition: (d: any) => [d.lon, d.lat, 400000], // Assume 400km alt
      getFillColor: (d: any) => {
        if (d.id === selectedSatelliteId) return [255, 255, 255, 255];
        if (d.status === 'CRITICAL') return [255, 0, 51, 255]; // Laser Red
        if (d.status === 'WARNING') return [255, 191, 0, 255]; // Amber
        return [0, 255, 255, 255]; // Plasma Cyan
      },
      getRadius: 100000,
      radiusMinPixels: 4,
      radiusMaxPixels: 15,
      updateTriggers: {
        getFillColor: [selectedSatelliteId]
      }
    }),

    // Arc Layer for Line of Sight
    new ArcLayer({
      id: 'arc-layer',
      data: selectedSat ? GROUND_STATIONS.map(gs => ({
        source: [selectedSat.lon, selectedSat.lat, 400000],
        target: gs.coordinates
      })) : [],
      getSourcePosition: (d: any) => d.source,
      getTargetPosition: (d: any) => d.target,
      getSourceColor: [255, 0, 51, 255], // Laser Red
      getTargetColor: [255, 0, 51, 50],
      getWidth: 2,
    })
  ].filter(Boolean);

  return (
    <div className="absolute inset-0 w-full h-full">
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE as any}
        controller={true}
        layers={layers}
        getCursor={({isHovering}) => isHovering ? 'crosshair' : 'default'}
      >
        <Map
          mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json"
          reuseMaps
        />
      </DeckGL>
    </div>
  );
}
