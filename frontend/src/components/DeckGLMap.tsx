// src/components/DeckGLMap.tsx
// Ultra-Optimized WebGL Ground Track Map | Stable 50+ FPS
// Clickable Trails | Clear Markers | Continuous Rendering

import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import {
  ScatterplotLayer,
  ArcLayer,
  PolygonLayer,
  PathLayer,
} from '@deck.gl/layers';
import { Map as MapGL } from 'react-map-gl/maplibre';
import { FlyToInterpolator } from '@deck.gl/core';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MapViewState, ViewStateChangeParameters } from '@deck.gl/core';

import useOrbitalStore, {
  selectSelectedSatellite,
  selectHoveredSatellite,
} from '../store/useOrbitalStore';
import { GROUND_STATIONS } from '../lib/constants';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface GroundStation {
  id: string;
  name: string;
  coordinates: [number, number];
  minElevationAngle: number;
}

interface PredictedTrail {
  id: string;
  path: [number, number][];
}

interface ArcData {
  source: [number, number, number];
  target: [number, number];
  stationId: string;
  stationName: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const INITIAL_VIEW_STATE: MapViewState = {
  longitude: 0,
  latitude: 0,
  zoom: 1.5,
  pitch: 0,
  bearing: 0,
};

// Performance-optimized layer config
const LAYER_CONFIG = Object.freeze({
  debris: { radiusMinPixels: 1, radiusMaxPixels: 1, radiusScale: 1, opacity: 0.4 },
  satellite: { radiusMinPixels: 3, radiusMaxPixels: 10, radiusScale: 2, opacity: 1.0 },
  groundStation: { radiusMinPixels: 3, radiusMaxPixels: 8, radiusScale: 1, opacity: 0.9 },
  arc: { width: 2, opacity: 0.8 },
  historicalTrail: { widthMinPixels: 2, widthMaxPixels: 5, opacity: 0.9, color: [0, 255, 255, 200] },
  predictedTrail: { widthMinPixels: 1, widthMaxPixels: 3, opacity: 0.4, dashArray: [6, 4] },
} as const);

// Caches
const terminatorCache = new Map<string, [number, number][]>();
const losCache = new Map<string, boolean>();
const MAX_CACHE_SIZE = 50;

// ============================================================================
// UTILITIES (unchanged)
// ============================================================================

function getSolarDeclinationAndLon(timestamp: string): { declination: number; sunLon: number } {
  const date = new Date(timestamp);
  const dayOfYear = (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000;
  const declination = -23.44 * Math.cos((360 / 365) * (dayOfYear + 10) * (Math.PI / 180));
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let sunLon = 180 - 15 * utcHours;
  if (sunLon < -180) sunLon += 360;
  if (sunLon > 180) sunLon -= 360;
  return { declination, sunLon };
}

function calculateTerminatorPolygon(timestamp: string): [number, number][] {
  if (terminatorCache.has(timestamp)) return terminatorCache.get(timestamp)!;

  const { declination, sunLon } = getSolarDeclinationAndLon(timestamp);
  const points: [number, number][] = [];
  const decRad = declination * (Math.PI / 180);

  for (let lon = -180; lon <= 180; lon += 4) {
    const lonRad = ((lon - sunLon) * Math.PI) / 180;
    const latRad = Math.atan(-Math.cos(lonRad) / Math.tan(decRad));
    points.push([lon, latRad * (180 / Math.PI)]);
  }
  points.push(declination > 0 ? [180, -90] : [180, 90], declination > 0 ? [-180, -90] : [-180, 90]);

  terminatorCache.set(timestamp, points);
  if (terminatorCache.size > MAX_CACHE_SIZE) {
    const firstKey = terminatorCache.keys().next().value;
    if (firstKey) terminatorCache.delete(firstKey);
  }
  return points;
}

function isSatelliteInEclipse(satLat: number, satLon: number, timestamp: string): boolean {
  const { declination, sunLon } = getSolarDeclinationAndLon(timestamp);
  const latDiff = Math.abs(satLat - declination);
  const lonDiff = Math.abs(satLon - sunLon);
  return lonDiff > 90 && latDiff > 30;
}

function calculateLineOfSight(
  satLon: number,
  satLat: number,
  satAltKm: number,
  stationLon: number,
  stationLat: number,
  minElevationAngle: number = 5.0
): boolean {
  const key = `${satLat.toFixed(2)}-${satLon.toFixed(2)}-${stationLat}-${stationLon}`;
  if (losCache.has(key)) return losCache.get(key)!;

  const R = 6371;
  const φ1 = satLat * Math.PI / 180;
  const φ2 = stationLat * Math.PI / 180;
  const Δλ = (satLon - stationLon) * Math.PI / 180;
  const a = Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const angularDistDeg = (2 * Math.asin(Math.sqrt(a))) * 180 / Math.PI;
  const elevation = 90 - angularDistDeg * (R / (R + satAltKm));
  const result = elevation >= minElevationAngle && angularDistDeg <= 22;

  losCache.set(key, result);
  if (losCache.size > MAX_CACHE_SIZE * 100) {
    const firstKey = losCache.keys().next().value;
    if (firstKey) losCache.delete(firstKey);
  }
  return result;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const DeckGLMap: React.FC = React.memo(() => {
  // Store selectors
  const debris = useOrbitalStore(state => state.debris);
  const satellites = useOrbitalStore(state => state.satellites);
  const timestamp = useOrbitalStore(state => state.timestamp);
  const selectedSatelliteId = useOrbitalStore(state => state.selectedSatelliteId);
  const hoveredSatelliteId = useOrbitalStore(state => state.hoveredSatelliteId);
  const trails = useOrbitalStore(state => state.trails);
  const selectSatellite = useOrbitalStore(state => state.selectSatellite);
  const hoverSatellite = useOrbitalStore(state => state.hoverSatellite);
  const selectedSat = useOrbitalStore(selectSelectedSatellite);
  const hoveredSat = useOrbitalStore(selectHoveredSatellite);

  // Local state
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);
  const [terminatorPoints, setTerminatorPoints] = useState<[number, number][]>([]);
  const [isTracking, setIsTracking] = useState<boolean>(false);
  const [isEclipse, setIsEclipse] = useState<boolean>(false);

  const lastPredictedTrailUpdateRef = useRef<number>(0);
  const predictedTrailsRef = useRef<PredictedTrail[]>([]);
  const prevSelectedIdRef = useRef<string | null>(null);

  // ==========================================================================
  // PREDICTED TRAILS (30 points per satellite, updated every 10s)
  // ==========================================================================
  useEffect(() => {
    const updatePredictedTrails = () => {
      if (!satellites || satellites.length === 0) return;
      const now = Date.now();
      if (now - lastPredictedTrailUpdateRef.current < 10000) return;
      lastPredictedTrailUpdateRef.current = now;

      const result: PredictedTrail[] = [];
      const INCLINATION = 51.6;

      for (let i = 0; i < satellites.length; i++) {
        const id = satellites.ids[i];
        const startLon = satellites.positions[i * 3];
        const startLat = satellites.positions[i * 3 + 1];
        const path: [number, number][] = [];
        const phase = Math.asin(startLat / INCLINATION) || 0;

        for (let t = 0; t <= 5400; t += 180) {
          const progress = t / 5400;
          const newLon = startLon + (progress * 360);
          const newLat = INCLINATION * Math.sin(phase + progress * Math.PI * 2);
          path.push([newLon, newLat]);
        }
        result.push({ id, path });
      }
      predictedTrailsRef.current = result;
    };

    updatePredictedTrails();
    const interval = setInterval(updatePredictedTrails, 10000);
    return () => clearInterval(interval);
  }, [satellites]);

  // ==========================================================================
  // CAMERA TRACKING
  // ==========================================================================
  useEffect(() => {
    if (!selectedSat) {
      setIsTracking(false);
      prevSelectedIdRef.current = null;
      return;
    }

    if (prevSelectedIdRef.current !== selectedSatelliteId) {
      prevSelectedIdRef.current = selectedSatelliteId;
      setIsTracking(true);

      const timeout = setTimeout(() => {
        setViewState(v => ({
          ...v,
          longitude: selectedSat.lon,
          latitude: selectedSat.lat,
          zoom: 3,
          transitionDuration: 1500,
          transitionInterpolator: new FlyToInterpolator(),
        }));
      }, 100);
      return () => clearTimeout(timeout);
    }

    if (isTracking && !viewState.transitionDuration) {
      setViewState(v => ({
        ...v,
        longitude: selectedSat.lon,
        latitude: selectedSat.lat,
      }));
    }
  }, [selectedSat?.lon, selectedSat?.lat, selectedSatelliteId, isTracking, viewState.transitionDuration]);

  // ==========================================================================
  // ECLIPSE DETECTION (throttled)
  // ==========================================================================
  useEffect(() => {
    if (!selectedSat || !timestamp) return;
    const timeout = setTimeout(() => {
      setIsEclipse(isSatelliteInEclipse(selectedSat.lat, selectedSat.lon, timestamp));
    }, 500);
    return () => clearTimeout(timeout);
  }, [selectedSat?.lat, selectedSat?.lon, timestamp]);

  // ==========================================================================
  // TERMINATOR UPDATE (every 60 seconds)
  // ==========================================================================
  useEffect(() => {
    const interval = setInterval(() => {
      if (timestamp) setTerminatorPoints(calculateTerminatorPolygon(timestamp));
    }, 60000);
    return () => clearInterval(interval);
  }, [timestamp]);

  // ==========================================================================
  // DATA PREPARATION – historical trails (full resolution)
  // ==========================================================================
  const historicalTrailPaths = useMemo<{ id: string; path: [number, number][] }[]>(() => {
    if (!trails || Object.keys(trails).length === 0) return [];
    return Object.values(trails).map((trail) => ({
      id: trail.satelliteId,
      path: trail.positions.map(([lon, lat]) => [lon, lat] as [number, number]),
    }));
  }, [trails]);

  const arcData = useMemo<ArcData[]>(() => {
    const activeSat = selectedSat || hoveredSat;
    if (!activeSat) return [];
    return GROUND_STATIONS.filter((gs) =>
      calculateLineOfSight(
        activeSat.lon,
        activeSat.lat,
        (activeSat.alt || 400) / 1000,
        gs.coordinates[0],
        gs.coordinates[1],
        gs.minElevationAngle
      )
    ).map((gs) => ({
      source: [activeSat.lon, activeSat.lat, activeSat.alt || 400000],
      target: [gs.coordinates[0], gs.coordinates[1]],
      stationId: gs.id,
      stationName: gs.name,
    }));
  }, [selectedSat?.id, hoveredSat?.id]);

  // ==========================================================================
  // LAYERS – Optimized for performance and interactivity
  // ==========================================================================
  const layers = useMemo(() => {
    const layerList: any[] = [];

    // 1. Terminator
    if (terminatorPoints.length > 0) {
      layerList.push(
        new PolygonLayer({
          id: 'terminator',
          data: [terminatorPoints],
          getPolygon: (d: [number, number][]) => d,
          getFillColor: [0, 0, 0, 160],
          stroked: false,
          pickable: false,
        })
      );
    }

    // 2. Predicted trails (dashed)
    if (predictedTrailsRef.current.length > 0) {
      layerList.push(
        new PathLayer({
          id: 'predicted-trails',
          data: predictedTrailsRef.current,
          getPath: (d: PredictedTrail) => d.path,
          getColor: [0, 255, 255, 80],
          widthMinPixels: LAYER_CONFIG.predictedTrail.widthMinPixels,
          widthMaxPixels: LAYER_CONFIG.predictedTrail.widthMaxPixels,
          dashArray: LAYER_CONFIG.predictedTrail.dashArray,
          pickable: false,
        })
      );
    }

    // 3. Historical trails (solid, clickable)
    if (historicalTrailPaths.length > 0) {
      layerList.push(
        new PathLayer({
          id: 'historical-trails',
          data: historicalTrailPaths,
          getPath: (d: { id: string; path: [number, number][] }) => d.path,
          widthMinPixels: LAYER_CONFIG.historicalTrail.widthMinPixels,
          widthMaxPixels: LAYER_CONFIG.historicalTrail.widthMaxPixels,
          opacity: LAYER_CONFIG.historicalTrail.opacity,
          pickable: true,
          autoHighlight: false,
          // Dynamic color based on selection
          getColor: (d: { id: string; path: [number, number][] }) => {
            if (d.id === selectedSatelliteId) {
              return [255, 255, 255, 255]; // white for selected
            }
            return LAYER_CONFIG.historicalTrail.color;
          },
          onClick: (info: any) => {
            if (info.object && info.object.id) {
              selectSatellite(info.object.id);
            }
          },
        })
      );
    }

    // 4. Debris – fixed size
    if (debris && debris.length > 0) {
      layerList.push(
        new ScatterplotLayer({
          id: 'debris',
          data: {
            length: debris.length,
            attributes: {
              getPosition: { value: debris.positions, size: 3 },
              getFillColor: { value: debris.colors, size: 4 },
            },
          },
          getRadius: 1,
          radiusMinPixels: 1,
          radiusMaxPixels: 1,
          opacity: 0.4,
          pickable: false,
        })
      );
    }

    // 5. Ground stations
    layerList.push(
      new ScatterplotLayer({
        id: 'ground-stations',
        data: GROUND_STATIONS,
        getPosition: (d: GroundStation) => d.coordinates,
        getFillColor: [255, 0, 51, 255],
        getRadius: LAYER_CONFIG.groundStation.radiusScale,
        radiusMinPixels: LAYER_CONFIG.groundStation.radiusMinPixels,
        radiusMaxPixels: LAYER_CONFIG.groundStation.radiusMaxPixels,
        opacity: LAYER_CONFIG.groundStation.opacity,
        pickable: true,
        autoHighlight: false,
        highlightColor: [255, 255, 255, 255],
      })
    );

    // 6. Satellites – with outline for better visibility
    if (satellites && satellites.length > 0) {
      layerList.push(
        new ScatterplotLayer({
          id: 'satellites',
          data: {
            length: satellites.length,
            attributes: {
              getPosition: { value: satellites.positions, size: 3 },
              getFillColor: { value: satellites.colors, size: 4 },
            },
          },
          getRadius: LAYER_CONFIG.satellite.radiusScale,
          radiusMinPixels: LAYER_CONFIG.satellite.radiusMinPixels,
          radiusMaxPixels: LAYER_CONFIG.satellite.radiusMaxPixels,
          opacity: LAYER_CONFIG.satellite.opacity,
          pickable: true,
          autoHighlight: false,
          highlightColor: [255, 255, 255, 255],
          stroked: true,
          lineWidthMinPixels: 1,
          getLineColor: [255, 255, 255, 180],
          onHover: ({ index }: { index?: number }) => {
            if (index !== undefined && satellites.ids) hoverSatellite(satellites.ids[index]);
            else hoverSatellite(null);
          },
          onClick: ({ index }: { index?: number }) => {
            if (index !== undefined && satellites.ids) selectSatellite(satellites.ids[index]);
            else selectSatellite(null);
          },
        })
      );
    }

    // 7. Target lock overlay (glowing ring)
    if (selectedSat) {
      layerList.push(
        new ScatterplotLayer({
          id: 'target-lock',
          data: [selectedSat],
          getPosition: (d) => [d.lon, d.lat, d.alt || 400000],
          getFillColor: [255, 255, 255, 255],
          getLineColor: [0, 255, 255, 255],
          lineWidthMinPixels: 2,
          stroked: true,
          getRadius: LAYER_CONFIG.satellite.radiusScale * 2.2,
          radiusMinPixels: LAYER_CONFIG.satellite.radiusMinPixels * 2.2,
          radiusMaxPixels: LAYER_CONFIG.satellite.radiusMaxPixels * 2.2,
        })
      );
    }

    // 8. LOS arcs
    if (arcData.length > 0) {
      layerList.push(
        new ArcLayer({
          id: 'los-arc',
          data: arcData,
          getSourcePosition: (d: ArcData) => d.source,
          getTargetPosition: (d: ArcData) => d.target,
          getSourceColor: [255, 0, 51, 220],
          getTargetColor: [255, 0, 51, 80],
          getWidth: LAYER_CONFIG.arc.width,
          opacity: LAYER_CONFIG.arc.opacity,
          pickable: true,
        })
      );
    }

    return layerList;
  }, [
    debris,
    satellites,
    terminatorPoints,
    arcData,
    historicalTrailPaths,
    selectedSat,
    selectedSatelliteId,
    hoveredSatelliteId,
    hoverSatellite,
    selectSatellite,
  ]);

  // ==========================================================================
  // CALLBACKS
  // ==========================================================================
  const handleViewStateChange = useCallback(({ viewState: vs, interactionState }: ViewStateChangeParameters) => {
    setViewState(vs as unknown as MapViewState);
    if (interactionState?.isDragging || interactionState?.isPanning) setIsTracking(false);
  }, []);

  const handleCursor = useCallback(({ isHovering }: { isHovering: boolean }) => (isHovering ? 'crosshair' : 'default'), []);

  // ==========================================================================
  // RENDER
  // ==========================================================================
  return (
    <div className="relative w-full h-full bg-void-black overflow-hidden">
      <DeckGL
        width="100%"
        height="100%"
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        controller={true}
        layers={layers}
        getCursor={handleCursor}
        useDevicePixels={false}
      >
        <MapGL
          mapStyle={MAP_STYLE}
          reuseMaps
          dragRotate={false}
          touchZoomRotate={false}
          attributionControl={false}
        />
      </DeckGL>

      {/* Selection Info Panel (top‑right) */}
      {selectedSat && (
        <div className="absolute top-4 right-4 glass-panel px-4 py-3 z-10 max-w-xs">
          <div className="font-mono text-xs space-y-2">
            <div className="text-plasma-cyan font-semibold border-b border-red-900/30 pb-2 flex justify-between items-center">
              <span>{selectedSat.id}</span>
              {!isTracking && (
                <button
                  onClick={() => setIsTracking(true)}
                  className="text-[9px] bg-red-900/30 hover:bg-red-900/50 px-2 py-1 rounded transition-colors"
                >
                  RE-LOCK
                </button>
              )}
            </div>
            <div className="text-muted-gray space-y-1">
              <div className="flex justify-between"><span>LAT:</span><span className="text-white">{selectedSat.lat.toFixed(4)}°</span></div>
              <div className="flex justify-between"><span>LON:</span><span className="text-white">{selectedSat.lon.toFixed(4)}°</span></div>
              <div className="flex justify-between"><span>ALT:</span><span className="text-white">{((selectedSat.alt || 400000) / 1000).toFixed(1)} km</span></div>
              <div className="flex justify-between">
                <span>FUEL:</span>
                <span className={selectedSat.fuel_kg < 5 ? 'text-laser-red' : selectedSat.fuel_kg < 15 ? 'text-amber' : 'text-plasma-cyan'}>
                  {selectedSat.fuel_kg.toFixed(2)} kg
                </span>
              </div>
              <div className="flex justify-between">
                <span>STATUS:</span>
                <span className={selectedSat.status === 'CRITICAL' ? 'text-laser-red' : selectedSat.status === 'WARNING' ? 'text-amber' : 'text-nominal-green'}>
                  {selectedSat.status}
                </span>
              </div>
            </div>
            {arcData.length > 0 && (
              <div className="pt-2 border-t border-red-900/30">
                <div className="text-[10px] text-muted-gray mb-1">LOS GROUND STATIONS:</div>
                {arcData.map((arc) => (
                  <div key={arc.stationId} className="text-[10px] text-laser-red flex items-center gap-1">
                    <div className="w-1 h-1 bg-laser-red rounded-full animate-pulse" />
                    {arc.stationName}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Eclipse warning overlay */}
      {isEclipse && selectedSat && (
        <div className="absolute bottom-4 left-4 glass-panel px-3 py-2 z-10 text-amber text-[10px] font-mono animate-pulse">
          ⚡ BATTERY POWER: ECLIPSE ZONE
        </div>
      )}
    </div>
  );
});

DeckGLMap.displayName = 'DeckGLMap';
export default DeckGLMap;