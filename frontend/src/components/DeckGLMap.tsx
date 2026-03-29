// src/components/DeckGLMap.tsx
// National Space Hackathon 2026 – Orbital Insight Visualizer
// ✅ Actual trails only (red base, selected bright red)
// ✅ Burn markers from store maneuvers
// ✅ Debris markers, ground stations, LOS arcs
// ✅ Camera tracking for selected satellite
// ✅ All utility functions included, TypeScript errors fixed

import React, { useMemo, useState, useEffect, useRef, useCallback, Component, ErrorInfo, ReactNode } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, ArcLayer, PolygonLayer, PathLayer } from '@deck.gl/layers';
import { Map as MapGL } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MapViewState, ViewStateChangeParameters } from '@deck.gl/core';

import useOrbitalStore, { selectSelectedSatellite, selectHoveredSatellite } from '../store/useOrbitalStore';
import { GROUND_STATIONS } from '../lib/constants';

// ============================================================================
// ERROR BOUNDARY
// ============================================================================
interface ErrorBoundaryProps { children: ReactNode; fallback: ReactNode; }
interface ErrorBoundaryState { hasError: boolean; }
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError(): ErrorBoundaryState { return { hasError: true }; }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) { console.error('[DeckGLMap] WebGL Error Boundary:', error, errorInfo); }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================
interface TrailData {
  id: string;
  parentId: string;
  path: [number, number][];
}
interface ArcData {
  source: [number, number, number];
  target: [number, number];
  stationId: string;
  stationName: string;
}
interface BurnMarker {
  position: [number, number];
  id: string;
  satelliteId: string;
  deltaV: number;
  burnTime: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const INITIAL_VIEW_STATE: MapViewState = Object.freeze({ longitude: 0, latitude: 0, zoom: 1.5, pitch: 0, bearing: 0 });
const WORLD_OFFSETS = [-360, 0, 360] as const;
const TRAIL_DOWNSAMPLE_FACTOR = 3;

// ============================================================================
// UTILITIES (all functions needed)
// ============================================================================
function getDayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.floor((date.getTime() - start.getTime()) / 86400000) + 1;
}

function getSolarDeclinationAndLon(timestamp: string): { declination: number; sunLon: number } {
  const date = new Date(timestamp);
  const dayOfYear = getDayOfYear(date);
  const declination = -23.44 * Math.cos((360 / 365) * (dayOfYear + 10) * (Math.PI / 180));
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let sunLon = 180 - 15 * utcHours;
  while (sunLon <= -180) sunLon += 360;
  while (sunLon > 180) sunLon -= 360;
  return { declination, sunLon };
}

const terminatorCache = new Map<string, [number, number][]>();

function calculateTerminatorPolygon(timestamp: string): [number, number][] {
  const cacheKey = timestamp.slice(0, 16);
  if (terminatorCache.has(cacheKey)) return terminatorCache.get(cacheKey)!;

  const { declination, sunLon } = getSolarDeclinationAndLon(timestamp);
  const points: [number, number][] = [];
  const decRad = declination * (Math.PI / 180);

  for (let lon = -180; lon <= 180; lon += 4) {
    const lonRad = ((lon - sunLon) * Math.PI) / 180;
    const tanDec = Math.tan(decRad);
    const safeTan = Math.max(-1e10, Math.min(1e10, tanDec));
    const divisor = safeTan || 0.001;
    const arg = -Math.cos(lonRad) / divisor;
    const clampedArg = Math.max(-1e10, Math.min(1e10, arg));
    const latRad = Math.atan(clampedArg);
    const lat = latRad * (180 / Math.PI);
    if (Number.isFinite(lat)) points.push([lon, Math.max(-90, Math.min(90, lat))]);
  }
  points.push([180, declination > 0 ? -90 : 90]);
  points.push([-180, declination > 0 ? -90 : 90]);

  terminatorCache.set(cacheKey, points);
  if (terminatorCache.size > 20) terminatorCache.delete(terminatorCache.keys().next().value!);
  return points;
}

function unwrapTrailCoordinates(points: [number, number][]): [number, number][] {
  if (!points || points.length < 2) return [];
  const result: [number, number][] = [[points[0][0], points[0][1]]];
  let offset = 0;
  for (let i = 1; i < points.length; i++) {
    const prevLon = points[i - 1][0];
    const currLon = points[i][0];
    const diff = currLon - prevLon;
    if (diff > 180) offset -= 360;
    else if (diff < -180) offset += 360;
    if (Number.isFinite(currLon) && Number.isFinite(points[i][1])) {
      result.push([currLon + offset, points[i][1]]);
    }
  }
  return result;
}

function downsampleTrail(path: [number, number][], factor: number): [number, number][] {
  if (factor <= 1 || path.length <= 10) return path;
  const result: [number, number][] = [];
  for (let i = 0; i < path.length; i += factor) {
    result.push(path[i]);
  }
  if (result[result.length - 1] !== path[path.length - 1]) {
    result.push(path[path.length - 1]);
  }
  return result;
}

function calculateElevationAngle(
  satLat: number, satLon: number, satAltKm: number,
  gsLat: number, gsLon: number, minElev: number = 5.0
): boolean {
  const R = 6371;
  const φ1 = satLat * Math.PI / 180;
  const φ2 = gsLat * Math.PI / 180;
  const Δλ = (satLon - gsLon) * Math.PI / 180;

  const dotProduct = Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const clampedDot = Math.max(-1, Math.min(1, dotProduct));
  const centralAngle = Math.acos(clampedDot);
  const satRadius = R + satAltKm;
  const elevationRad = Math.atan((Math.cos(centralAngle) - R / satRadius) / Math.sin(centralAngle));
  const elevationDeg = elevationRad * (180 / Math.PI);
  return elevationDeg >= minElev && centralAngle * (180 / Math.PI) <= 22;
}

function isInEarthShadow(satLat: number, satLon: number, satAltKm: number, sunLon: number): boolean {
  const R = 6371;
  const satDist = R + satAltKm;
  const latRad = satLat * Math.PI / 180, lonRad = satLon * Math.PI / 180;
  const satVec = {
    x: satDist * Math.cos(latRad) * Math.cos(lonRad),
    y: satDist * Math.cos(latRad) * Math.sin(lonRad),
    z: satDist * Math.sin(latRad),
  };
  const sunVec = { x: Math.cos(sunLon * Math.PI / 180), y: Math.sin(sunLon * Math.PI / 180), z: 0 };
  const dot = satVec.x * sunVec.x + satVec.y * sunVec.y + satVec.z * sunVec.z;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot / satDist)));
  const shadowAngle = Math.asin(R / satDist);
  return angle > Math.PI / 2 + shadowAngle;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================
export const DeckGLMap: React.FC = React.memo(() => {
  // ===== STORE SELECTORS =====
  const debris = useOrbitalStore(state => state.debris);
  const satellites = useOrbitalStore(state => state.satellites);
  const timestamp = useOrbitalStore(state => state.timestamp);
  const selectedSatelliteId = useOrbitalStore(state => state.selectedSatelliteId);
  const trails = useOrbitalStore(state => state.trails);
  const maneuvers = useOrbitalStore(state => state.maneuvers);

  const selectSatellite = useOrbitalStore(state => state.selectSatellite);
  const hoverSatellite = useOrbitalStore(state => state.hoverSatellite);
  const selectedSat = useOrbitalStore(selectSelectedSatellite);
  const hoveredSat = useOrbitalStore(selectHoveredSatellite);

  // ===== LOCAL STATE =====
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);
  const [terminatorPoints, setTerminatorPoints] = useState<[number, number][]>([]);
  const [isTracking, setIsTracking] = useState<boolean>(false);
  const [isEclipse, setIsEclipse] = useState<boolean>(false);

  // ===== REFS =====
  const isNavigatingRef = useRef<boolean>(false);
  const lastTerminatorUpdateRef = useRef<number>(0);

  const canRender = useMemo(() => satellites && satellites.length > 0, [satellites]);

  // ==========================================================================
  // 1. TERMINATOR UPDATE (throttled every 60s)
  // ==========================================================================
  useEffect(() => {
    if (!timestamp) return;
    const now = Date.now();
    if (now - lastTerminatorUpdateRef.current < 60000) return;
    lastTerminatorUpdateRef.current = now;
    setTerminatorPoints(calculateTerminatorPolygon(timestamp));
  }, [timestamp]);

  // ==========================================================================
  // 2. ECLIPSE DETECTION
  // ==========================================================================
  useEffect(() => {
    if (!selectedSat || !timestamp || !Number.isFinite(selectedSat.lon)) {
      setIsEclipse(false);
      return;
    }
    const timeout = setTimeout(() => {
      const { sunLon } = getSolarDeclinationAndLon(timestamp);
      const altKm = (selectedSat.alt ?? 400000) / 1000;
      setIsEclipse(isInEarthShadow(selectedSat.lat, selectedSat.lon, altKm, sunLon));
    }, 500);
    return () => clearTimeout(timeout);
  }, [selectedSat?.lat, selectedSat?.lon, timestamp]);

  // ==========================================================================
  // 3. CAMERA TRACKING (follow selected satellite)
  // ==========================================================================
  useEffect(() => {
    if (isTracking && selectedSat && Number.isFinite(selectedSat.lon) && Number.isFinite(selectedSat.lat)) {
      setViewState(prev => ({ ...prev, longitude: selectedSat.lon, latitude: selectedSat.lat }));
    }
  }, [isTracking, selectedSat?.lon, selectedSat?.lat]);

  // ==========================================================================
  // 4. DATA PREPARATION – ACTUAL TRAILS ONLY
  // ==========================================================================
  const historicalTrailCopies = useMemo<TrailData[]>(() => {
    if (!trails || Object.keys(trails).length === 0) return [];
    const copies: TrailData[] = [];
    const validTrails = Object.values(trails).filter(t => t && t.positions && t.positions.length > 1);
    for (const trail of validTrails) {
      const rawPoints = trail.positions.map(([lon, lat]) => [Number(lon), Number(lat)] as [number, number]);
      const unwrapped = unwrapTrailCoordinates(rawPoints);
      const downsampled = downsampleTrail(unwrapped, TRAIL_DOWNSAMPLE_FACTOR);
      if (downsampled.length > 1) {
        for (const offset of WORLD_OFFSETS) {
          copies.push({
            id: `${trail.satelliteId}_${offset}`,
            parentId: trail.satelliteId,
            path: downsampled.map(([lon, lat]) => [lon + offset, lat]),
          });
        }
      }
    }
    return copies;
  }, [trails]);

  const highlightedHistoricalTrails = useMemo<TrailData[]>(() => {
    if (!selectedSatelliteId) return [];
    return historicalTrailCopies.filter(t => String(t.parentId) === String(selectedSatelliteId));
  }, [historicalTrailCopies, selectedSatelliteId]);

  // ==========================================================================
  // 5. BURN MARKERS
  // ==========================================================================
  const burnMarkers = useMemo<BurnMarker[]>(() => {
    if (!maneuvers || maneuvers.length === 0) return [];
    const markers: BurnMarker[] = [];
    for (const m of maneuvers) {
      if (m.lat !== undefined && m.lon !== undefined && Number.isFinite(m.lat) && Number.isFinite(m.lon)) {
        for (const offset of WORLD_OFFSETS) {
          markers.push({
            position: [m.lon + offset, m.lat],
            id: `${m.burn_id}_${offset}`,
            satelliteId: m.satellite_id,
            deltaV: m.delta_v_magnitude,
            burnTime: m.burnTime,
          });
        }
      }
    }
    return markers;
  }, [maneuvers]);

  // ==========================================================================
  // 6. OTHER DATA (terminator, arc data, debris, satellites)
  // ==========================================================================
  const terminatorCopies = useMemo(() => {
    if (terminatorPoints.length === 0) return [];
    return WORLD_OFFSETS.map(offset => terminatorPoints.map(([lon, lat]) => [lon + offset, lat] as [number, number]));
  }, [terminatorPoints]);

  const arcData = useMemo<ArcData[]>(() => {
    const activeSat = selectedSat || hoveredSat;
    if (!activeSat || !Number.isFinite(activeSat.lon) || !Number.isFinite(activeSat.lat)) return [];
    const sLat = Number(activeSat.lat), sLon = Number(activeSat.lon);
    const sAlt = Number(activeSat.alt) || 400000;
    const altKm = sAlt / 1000;
    return GROUND_STATIONS.filter(gs => calculateElevationAngle(sLat, sLon, altKm, Number(gs.coordinates[1]), Number(gs.coordinates[0]), gs.minElevationAngle))
      .flatMap(gs => WORLD_OFFSETS.map(offset => ({
        source: [sLon + offset, sLat, sAlt] as [number, number, number],
        target: [Number(gs.coordinates[0]) + offset, Number(gs.coordinates[1])] as [number, number],
        stationId: `${gs.id}_${offset}`,
        stationName: gs.name,
      })));
  }, [selectedSat, hoveredSat]);

  // ==========================================================================
  // 7. INSTANCED BUFFERS (optimised)
  // ==========================================================================
  const instancedDebris = useMemo(() => {
    if (!debris || debris.length === 0 || !debris.positions || !debris.colors) return null;
    const len = debris.length;
    const pos = new Float32Array(len * 3 * 3);
    const col = new Uint8ClampedArray(len * 4 * 3);
    for (let w = 0; w < WORLD_OFFSETS.length; w++) {
      const offset = WORLD_OFFSETS[w];
      const destPos = w * len * 3;
      const destCol = w * len * 4;
      for (let i = 0; i < len; i++) {
        const px = debris.positions[i * 3];
        const py = debris.positions[i * 3 + 1];
        const pz = debris.positions[i * 3 + 2];
        pos[destPos + i * 3] = Number.isFinite(px) ? px + offset : 0;
        pos[destPos + i * 3 + 1] = Number.isFinite(py) ? py : 0;
        pos[destPos + i * 3 + 2] = Number.isFinite(pz) ? pz : 0;

        const cr = debris.colors[i * 4];
        const cg = debris.colors[i * 4 + 1];
        const cb = debris.colors[i * 4 + 2];
        const ca = debris.colors[i * 4 + 3];
        col[destCol + i * 4] = Number.isFinite(cr) ? cr : 0;
        col[destCol + i * 4 + 1] = Number.isFinite(cg) ? cg : 255;
        col[destCol + i * 4 + 2] = Number.isFinite(cb) ? cb : 255;
        col[destCol + i * 4 + 3] = Number.isFinite(ca) ? ca : 100;
      }
    }
    return { length: len * 3, positions: pos, colors: col };
  }, [debris]);

  const instancedSatellites = useMemo(() => {
    if (!satellites || satellites.length === 0 || !satellites.positions || !satellites.colors) return null;
    const len = satellites.length;
    const pos = new Float32Array(len * 3 * 3);
    const col = new Uint8ClampedArray(len * 4 * 3);
    for (let w = 0; w < WORLD_OFFSETS.length; w++) {
      const offset = WORLD_OFFSETS[w];
      const destPos = w * len * 3;
      const destCol = w * len * 4;
      for (let i = 0; i < len; i++) {
        const px = satellites.positions[i * 3];
        const py = satellites.positions[i * 3 + 1];
        const pz = satellites.positions[i * 3 + 2];
        pos[destPos + i * 3] = Number.isFinite(px) ? px + offset : 0;
        pos[destPos + i * 3 + 1] = Number.isFinite(py) ? py : 0;
        pos[destPos + i * 3 + 2] = Number.isFinite(pz) ? pz : 0;

        const cr = satellites.colors[i * 4];
        const cg = satellites.colors[i * 4 + 1];
        const cb = satellites.colors[i * 4 + 2];
        const ca = satellites.colors[i * 4 + 3];
        col[destCol + i * 4] = Number.isFinite(cr) ? cr : 255;
        col[destCol + i * 4 + 1] = Number.isFinite(cg) ? cg : 255;
        col[destCol + i * 4 + 2] = Number.isFinite(cb) ? cb : 255;
        col[destCol + i * 4 + 3] = Number.isFinite(ca) ? ca : 255;
      }
    }
    return { length: len * 3, positions: pos, colors: col, originalLength: len };
  }, [satellites]);

  // ==========================================================================
  // 8. WEBGL LAYERS (actual trails + burn markers)
  // ==========================================================================
  const layers = useMemo(() => {
    const layerList: any[] = [];

    // Terminator
    if (terminatorCopies.length > 0) {
      layerList.push(new PolygonLayer({
        id: 'terminator',
        data: terminatorCopies,
        getPolygon: (d: [number, number][]) => d,
        getFillColor: [0, 0, 0, 160],
        stroked: false,
        pickable: false,
        wrapLongitude: false,
      }));
    }

    // ACTUAL TRAILS – unselected (faint red)
    if (historicalTrailCopies.length > 0) {
      layerList.push(new PathLayer({
        id: 'historical-trails-base',
        data: historicalTrailCopies,
        getPath: (d: TrailData) => d.path,
        getColor: [255, 0, 0, 40],
        widthMinPixels: 2,
        widthMaxPixels: 4,
        pickable: true,
        autoHighlight: false,
        wrapLongitude: false,
        onClick: (info: any) => {
          setTimeout(() => {
            try {
              if (info?.object?.parentId && typeof selectSatellite === 'function') {
                selectSatellite(String(info.object.parentId));
              }
            } catch (err) { console.error('[DeckGLMap] Trail click error:', err); }
          }, 0);
        },
      }));
    }

    // ACTUAL TRAILS – selected (bright red glow)
    if (highlightedHistoricalTrails.length > 0) {
      layerList.push(
        new PathLayer({
          id: 'historical-trails-glow',
          data: highlightedHistoricalTrails,
          getPath: (d: TrailData) => d.path,
          getColor: [255, 0, 0, 80],
          widthMinPixels: 10,
          widthMaxPixels: 14,
          pickable: false,
          wrapLongitude: false,
        }),
        new PathLayer({
          id: 'historical-trails-highlight',
          data: highlightedHistoricalTrails,
          getPath: (d: TrailData) => d.path,
          getColor: [255, 0, 0, 255],
          widthMinPixels: 4,
          widthMaxPixels: 6,
          pickable: false,
          wrapLongitude: false,
        })
      );
    }

    // BURN MARKERS (orange)
    if (burnMarkers.length > 0) {
      layerList.push(new ScatterplotLayer({
        id: 'burn-markers',
        data: burnMarkers,
        getPosition: (d: BurnMarker) => d.position,
        getFillColor: [255, 140, 0, 200],
        getRadius: 3,
        radiusMinPixels: 3,
        radiusMaxPixels: 6,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 255],
        wrapLongitude: false,
        onHover: ({ object }: { object?: BurnMarker }) => {
          // optional: tooltip logging (can be replaced with actual tooltip)
          if (object) console.log(`Burn: ${object.satelliteId} Δv=${object.deltaV.toFixed(3)} m/s`);
        },
      }));
    }

    // Debris field
    if (instancedDebris) {
      layerList.push(new ScatterplotLayer({
        id: 'debris',
        data: {
          length: instancedDebris.length,
          attributes: {
            getPosition: { value: instancedDebris.positions, size: 3 },
            getFillColor: { value: instancedDebris.colors, size: 4 },
          },
        },
        getRadius: 1,
        radiusMinPixels: 1,
        opacity: 0.5,
        pickable: false,
        wrapLongitude: false,
      }));
    }

    // Ground stations
    layerList.push(new ScatterplotLayer({
      id: 'ground-stations',
      data: GROUND_STATIONS.flatMap(gs => WORLD_OFFSETS.map(offset => ({
        ...gs,
        coordinates: [Number(gs.coordinates[0]) + offset, Number(gs.coordinates[1])],
      }))),
      getPosition: (d: any) => d.coordinates,
      getFillColor: [255, 0, 51, 255],
      getRadius: 1.5,
      radiusMinPixels: 4,
      opacity: 1.0,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 255],
      wrapLongitude: false,
    }));

    // Satellites (instanced, clickable)
    if (instancedSatellites) {
      layerList.push(new ScatterplotLayer({
        id: 'satellites',
        data: {
          length: instancedSatellites.length,
          attributes: {
            getPosition: { value: instancedSatellites.positions, size: 3 },
            getFillColor: { value: instancedSatellites.colors, size: 4 },
          },
        },
        getRadius: 2.5,
        radiusMinPixels: 4,
        opacity: 1.0,
        stroked: true,
        lineWidthMinPixels: 1,
        getLineColor: [255, 255, 255, 180],
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 255],
        wrapLongitude: false,
        onHover: ({ index }: { index?: number }) => {
          if (isNavigatingRef.current) return;
          setTimeout(() => {
            try {
              if (index !== undefined && index !== -1 && satellites?.ids && instancedSatellites?.originalLength) {
                const safeIndex = index % instancedSatellites.originalLength;
                hoverSatellite(satellites.ids[safeIndex] || null);
              } else { hoverSatellite(null); }
            } catch (err) {}
          }, 0);
        },
        onClick: ({ index }: { index?: number }) => {
          setTimeout(() => {
            try {
              if (index !== undefined && index !== -1 && satellites?.ids && instancedSatellites?.originalLength) {
                const safeIndex = index % instancedSatellites.originalLength;
                selectSatellite(satellites.ids[safeIndex] || null);
              } else { selectSatellite(null); }
            } catch (err) {}
          }, 0);
        },
      }));
    }

    // Target lock indicator
    if (selectedSat && Number.isFinite(selectedSat.lon) && Number.isFinite(selectedSat.lat)) {
      const lockData = WORLD_OFFSETS.map(offset => ({
        ...selectedSat,
        lon: Number(selectedSat.lon) + offset,
        lat: Number(selectedSat.lat),
        alt: Number(selectedSat.alt) || 400000,
      }));
      layerList.push(new ScatterplotLayer({
        id: 'target-lock',
        data: lockData,
        getPosition: d => [d.lon, d.lat, d.alt],
        getFillColor: [0, 255, 255, 80],
        getLineColor: [0, 255, 255, 255],
        lineWidthMinPixels: 2,
        stroked: true,
        getRadius: 7.5,
        radiusMinPixels: 9,
        wrapLongitude: false,
      }));
    }

    // LOS arcs
    if (arcData.length > 0) {
      layerList.push(new ArcLayer({
        id: 'los-arc',
        data: arcData,
        getSourcePosition: (d: ArcData) => d.source,
        getTargetPosition: (d: ArcData) => d.target,
        getSourceColor: [255, 0, 51, 220],
        getTargetColor: [255, 0, 51, 80],
        getWidth: 3,
        opacity: 0.9,
        pickable: true,
        wrapLongitude: false,
      }));
    }

    return layerList;
  }, [
    instancedDebris,
    instancedSatellites,
    terminatorCopies,
    arcData,
    historicalTrailCopies,
    highlightedHistoricalTrails,
    burnMarkers,
    selectedSat,
    selectedSatelliteId,
    hoverSatellite,
    selectSatellite,
  ]);

  // ==========================================================================
  // 9. VIEWPORT HANDLER
  // ==========================================================================
  const handleViewStateChange = useCallback(({ viewState: vs, interactionState }: ViewStateChangeParameters) => {
    setViewState(vs as unknown as MapViewState);
    const isMoving = Boolean(interactionState?.isDragging || interactionState?.isPanning || interactionState?.isZooming);
    isNavigatingRef.current = isMoving;
    if (isMoving) setIsTracking(false);
  }, []);

  const handleCursor = useCallback(({ isHovering }: { isHovering: boolean }) => {
    if (isNavigatingRef.current) return 'grabbing';
    return isHovering ? 'crosshair' : 'default';
  }, []);

  // ==========================================================================
  // 10. WEBGL CONTEXT LOSS RECOVERY
  // ==========================================================================
  useEffect(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    const onContextLost = (e: Event) => { e.preventDefault(); console.error('[DeckGLMap] WebGL context lost'); };
    const onContextRestored = () => { console.log('[DeckGLMap] WebGL context restored'); };
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);
    return () => {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
    };
  }, []);

  // ==========================================================================
  // 11. RENDER
  // ==========================================================================
  const renderContent = () => {
    if (!canRender) {
      return (
        <div className="w-full h-full flex items-center justify-center bg-void-black text-muted-gray">
          <div className="text-center animate-pulse font-mono tracking-widest text-xs">🛰️ Initializing orbital display...</div>
        </div>
      );
    }

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
          onWebGLInitialized={gl => gl.clearColor(0, 0, 0, 1)}
        >
          <MapGL
            mapStyle={MAP_STYLE}
            reuseMaps
            interactive={false}
            renderWorldCopies={false}
            attributionControl={false}
          />
        </DeckGL>

        {/* Selection Info Panel */}
        {selectedSat && (
          <div className="absolute top-4 right-4 glass-panel px-4 py-3 z-10 max-w-xs">
            <div className="font-mono text-xs space-y-2">
              <div className="text-plasma-cyan font-semibold border-b border-red-900/30 pb-2 flex justify-between items-center">
                <span>{selectedSat.id}</span>
                {!isTracking && (
                  <button onClick={() => setIsTracking(true)} className="text-[9px] bg-red-900/30 hover:bg-red-900/50 px-2 py-1 rounded transition-colors">
                    RE-LOCK
                  </button>
                )}
              </div>
              <div className="text-muted-gray space-y-1">
                <div className="flex justify-between"><span>LAT:</span><span className="text-white">{Number(selectedSat.lat || 0).toFixed(4)}°</span></div>
                <div className="flex justify-between"><span>LON:</span><span className="text-white">{Number(selectedSat.lon || 0).toFixed(4)}°</span></div>
                <div className="flex justify-between"><span>ALT:</span><span className="text-white">{((selectedSat.alt || 400000) / 1000).toFixed(1)} km</span></div>
                <div className="flex justify-between"><span>FUEL:</span><span className={selectedSat.fuel_kg < 5 ? 'text-laser-red' : 'text-plasma-cyan'}>{Number(selectedSat.fuel_kg || 0).toFixed(2)} kg</span></div>
                <div className="flex justify-between"><span>STATUS:</span><span className={selectedSat.status === 'CRITICAL' ? 'text-laser-red' : 'text-nominal-green'}>{selectedSat.status}</span></div>
              </div>
            </div>
          </div>
        )}

        {/* Eclipse Warning */}
        {isEclipse && selectedSat && (
          <div className="absolute bottom-4 left-4 glass-panel px-3 py-2 z-10 border border-amber/50 text-amber text-[10px] font-mono font-bold animate-pulse shadow-[0_0_15px_rgba(210,153,34,0.4)]">
            ⚡ BATTERY POWER: ECLIPSE ZONE
          </div>
        )}
      </div>
    );
  };

  return (
    <ErrorBoundary
      fallback={
        <div className="w-full h-full flex items-center justify-center bg-void-black text-laser-red">
          <div className="text-center">
            <h2 className="text-xl font-bold">🛰️ Visualizer Error</h2>
            <p className="text-sm text-muted-gray mt-2">WebGL context desynced.</p>
            <button onClick={() => window.location.reload()} className="mt-4 px-4 py-2 bg-plasma-cyan text-black rounded hover:opacity-90">
              Restart Matrix
            </button>
          </div>
        </div>
      }
    >
      {renderContent()}
    </ErrorBoundary>
  );
});

DeckGLMap.displayName = 'DeckGLMap';
export default DeckGLMap;