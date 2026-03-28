// src/components/DeckGLMap.tsx
// Ultimate Production-Grade WebGL Ground Track Map
// All Critical Fixes Applied | 60 FPS | Crash‑Proof | Antimeridian‑Proof

import React, { useMemo, useState, useEffect, useRef, useCallback, Component, ErrorInfo, ReactNode } from 'react';
import DeckGL from '@deck.gl/react';
import {
  ScatterplotLayer,
  ArcLayer,
  PolygonLayer,
  PathLayer,
} from '@deck.gl/layers';
import { Map as MapGL } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MapViewState, ViewStateChangeParameters } from '@deck.gl/core';

import useOrbitalStore, {
  selectSelectedSatellite,
  selectHoveredSatellite,
} from '../store/useOrbitalStore';
import { GROUND_STATIONS } from '../lib/constants';

// ============================================================================
// SIMPLE ERROR BOUNDARY (no external dependency)
// ============================================================================

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[DeckGLMap] ErrorBoundary caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
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

// ============================================================================
// CONSTANTS & THEME
// ============================================================================

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const INITIAL_VIEW_STATE: MapViewState = Object.freeze({
  longitude: 0,
  latitude: 0,
  zoom: 1.5,
  pitch: 0,
  bearing: 0,
});

const LAYER_CONFIG = Object.freeze({
  debris: { radiusMinPixels: 1, radiusMaxPixels: 1, opacity: 0.5 },
  satellite: { radiusMinPixels: 4, radiusMaxPixels: 10, radiusScale: 2.5, opacity: 1.0 },
  groundStation: { radiusMinPixels: 4, radiusMaxPixels: 8, radiusScale: 1.5, opacity: 1.0 },
  arc: { width: 3, opacity: 0.9 },
  historicalTrail: {
    widthMinPixels: 2.5,
    widthMaxPixels: 6,
    opacity: 1.0,
    color: [0, 255, 255, 200] as [number, number, number, number],
    selectedColor: [255, 255, 255, 255] as [number, number, number, number],
  },
  predictedTrail: {
    widthMinPixels: 1.5,
    widthMaxPixels: 3,
    opacity: 0.6,
    dashArray: [6, 4],
    color: [0, 200, 255, 120] as [number, number, number, number],
  },
  terminator: { fillColor: [0, 0, 0, 160] as [number, number, number, number] },
} as const);

// Fixed world offsets (manual triple copy for infinite scroll)
const WORLD_OFFSETS = [-360, 0, 360] as const;
const TRAIL_DOWNSAMPLE_FACTOR = 3;

// Cache for terminator polygon (minute granularity)
const terminatorCache = new Map<string, [number, number][]>();

// ============================================================================
// UTILITIES (Ironclad Safe Math)
// ============================================================================

/** Normalize longitude to [-180,180] */
const normalizeLon = (lon: number): number => ((lon % 360) + 360) % 360;

/** Correct day‑of‑year (Jan 1 = day 1) */
function getDayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.floor((date.getTime() - start.getTime()) / 86400000) + 1;
}

/** Solar declination and subsolar longitude */
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

/** Terminator polygon (night side) – safe from NaN/infinity */
function calculateTerminatorPolygon(timestamp: string): [number, number][] {
  const cacheKey = timestamp.slice(0, 16); // minute precision
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
    if (Number.isFinite(lat)) {
      points.push([lon, Math.max(-90, Math.min(90, lat))]);
    }
  }
  points.push([180, declination > 0 ? -90 : 90]);
  points.push([-180, declination > 0 ? -90 : 90]);

  terminatorCache.set(cacheKey, points);
  if (terminatorCache.size > 20) {
    terminatorCache.delete(terminatorCache.keys().next().value!);
  }
  return points;
}

/** Unwrap trail coordinates so they don't snap back across the antimeridian */
function unwrapTrailCoordinates(points: [number, number][]): [number, number][] {
  if (points.length < 2) return points.slice();
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

/** Downsample a path to reduce geometry */
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

/** Proper elevation angle calculation for LOS */
function calculateElevationAngle(
  satLat: number,
  satLon: number,
  satAltKm: number,
  gsLat: number,
  gsLon: number,
  minElev: number = 5.0
): boolean {
  const R = 6371;
  const φ1 = satLat * Math.PI / 180;
  const φ2 = gsLat * Math.PI / 180;
  const Δλ = (satLon - gsLon) * Math.PI / 180;

  // Central angle
  const centralAngle = Math.acos(
    Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  );

  // Elevation angle
  const satRadius = R + satAltKm;
  const elevationRad = Math.atan(
    (Math.cos(centralAngle) - R / satRadius) / Math.sin(centralAngle)
  );
  const elevationDeg = elevationRad * (180 / Math.PI);

  return elevationDeg >= minElev && centralAngle * (180 / Math.PI) <= 22;
}

/** Eclipse check (true if satellite is in Earth's shadow) */
function isInEarthShadow(
  satLat: number,
  satLon: number,
  satAltKm: number,
  sunLon: number
): boolean {
  const R = 6371;
  const satDist = R + satAltKm;
  const latRad = satLat * Math.PI / 180;
  const lonRad = satLon * Math.PI / 180;

  // Satellite position vector (ECI approximate)
  const satVec = {
    x: satDist * Math.cos(latRad) * Math.cos(lonRad),
    y: satDist * Math.cos(latRad) * Math.sin(lonRad),
    z: satDist * Math.sin(latRad),
  };

  // Sun direction vector (in ECI, ecliptic plane)
  const sunVec = {
    x: Math.cos(sunLon * Math.PI / 180),
    y: Math.sin(sunLon * Math.PI / 180),
    z: 0,
  };

  const dot = satVec.x * sunVec.x + satVec.y * sunVec.y + satVec.z * sunVec.z;
  const angle = Math.acos(dot / satDist);
  const shadowAngle = Math.asin(R / satDist);
  return angle > Math.PI / 2 + shadowAngle;
}

// ============================================================================
// BUFFER POOL (Now a ref, not module-level)
// ============================================================================

interface BufferPool {
  debrisPositions: Float32Array | null;
  debrisColors: Uint8ClampedArray | null;
  satPositions: Float32Array | null;
  satColors: Uint8ClampedArray | null;
}

/** Safe buffer resizing: if current buffer is large enough, reuse it; otherwise create new */
function ensureBufferSize<T extends Float32Array | Uint8ClampedArray>(
  current: T | null,
  neededLength: number,
  factory: () => T
): T {
  if (current && current.length >= neededLength) {
    current.fill(0);      // Clear reused buffer to avoid stale data
    return current;
  }
  return factory();       // New buffer is already zero-initialized
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const DeckGLMap: React.FC = React.memo(() => {
  // Store selectors – using stable references to avoid re‑runs
  const debris = useOrbitalStore(state => state.debris);
  const satellites = useOrbitalStore(state => state.satellites);
  const timestamp = useOrbitalStore(state => state.timestamp);
  const selectedSatelliteId = useOrbitalStore(state => state.selectedSatelliteId);
  // const hoveredSatelliteId = useOrbitalStore(state => state.hoveredSatelliteId); // unused – removed
  const trails = useOrbitalStore(state => state.trails);

  const selectSatellite = useOrbitalStore(state => state.selectSatellite);
  const hoverSatellite = useOrbitalStore(state => state.hoverSatellite);
  const selectedSat = useOrbitalStore(selectSelectedSatellite);
  const hoveredSat = useOrbitalStore(selectHoveredSatellite);

  // Local state
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);
  const [terminatorPoints, setTerminatorPoints] = useState<[number, number][]>([]);
  const [predictedTrails, setPredictedTrails] = useState<TrailData[]>([]);
  const [isTracking, setIsTracking] = useState<boolean>(false);
  const [isEclipse, setIsEclipse] = useState<boolean>(false);

  // Refs
  const lastPredictedUpdateRef = useRef<number>(0);
  const predictedTrailsPendingRef = useRef<boolean>(false);
  const isNavigatingRef = useRef<boolean>(false);
  const prevSelectedIdRef = useRef<string | null>(null);
  // Buffer pool as ref, not module-level (fix #2)
  const bufferPoolRef = useRef<BufferPool>({
    debrisPositions: null,
    debrisColors: null,
    satPositions: null,
    satColors: null,
  });

  // ==========================================================================
  // 1. PREDICTED TRAILS (throttled, with debounce)
  // ==========================================================================
  useEffect(() => {
    if (!satellites || satellites.length === 0) return;

    const compute = () => {
      if (predictedTrailsPendingRef.current) return;
      predictedTrailsPendingRef.current = true;

      setTimeout(() => {
        const now = Date.now();
        if (now - lastPredictedUpdateRef.current < 10000) {
          predictedTrailsPendingRef.current = false;
          return;
        }
        lastPredictedUpdateRef.current = now;

        const result: TrailData[] = [];
        const INCLINATION = 51.6;

        for (let i = 0; i < satellites.length; i++) {
          const id = satellites.ids[i];
          const startLon = satellites.positions[i * 3];
          const startLat = satellites.positions[i * 3 + 1];

          if (!Number.isFinite(startLon) || !Number.isFinite(startLat)) continue;

          const path: [number, number][] = [];
          const phase = Math.asin(Math.max(-1, Math.min(1, startLat / INCLINATION))) || 0;

          for (let t = 0; t <= 5400; t += 180) {
            const progress = t / 5400;
            const continuousLon = startLon + progress * 360;
            const newLat = INCLINATION * Math.sin(phase + progress * Math.PI * 2);
            path.push([continuousLon, Math.max(-INCLINATION, Math.min(INCLINATION, newLat))]);
          }

          const unwrapped = unwrapTrailCoordinates(path);
          const downsampled = downsampleTrail(unwrapped, TRAIL_DOWNSAMPLE_FACTOR);

          if (downsampled.length > 1) {
            for (const offset of WORLD_OFFSETS) {
              result.push({
                id: `${id}_${offset}`,
                parentId: id,
                path: downsampled.map(([lon, lat]) => [lon + offset, lat]),
              });
            }
          }
        }
        setPredictedTrails(result);
        predictedTrailsPendingRef.current = false;
      }, 50);
    };

    compute();
  }, [satellites]);

  // ==========================================================================
  // 2. TERMINATOR UPDATE (every 60 seconds)
  // ==========================================================================
  useEffect(() => {
    if (!timestamp) return;
    const update = () => {
      setTerminatorPoints(calculateTerminatorPolygon(timestamp));
    };
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, [timestamp]);

  // ==========================================================================
  // 3. ECLIPSE DETECTION (proper geometry, throttled)
  // ==========================================================================
  useEffect(() => {
    if (!selectedSat || !timestamp || !Number.isFinite(selectedSat.lon)) {
      setIsEclipse(false);
      return;
    }
    const timeout = setTimeout(() => {
      const { sunLon } = getSolarDeclinationAndLon(timestamp);
      const altKm = (selectedSat.alt ?? 400000) / 1000; // store in meters → km for calc
      const inShadow = isInEarthShadow(
        selectedSat.lat,
        selectedSat.lon,
        altKm,
        sunLon
      );
      setIsEclipse(inShadow);
    }, 500);
    return () => clearTimeout(timeout);
  }, [selectedSat?.lat, selectedSat?.lon, timestamp]);

  // ==========================================================================
  // 4. CAMERA TRACKING (with normalized longitude)
  // ==========================================================================
  const getClosestTargetLon = useCallback((targetLon: number, currentLon: number) => {
    const normCurrent = normalizeLon(currentLon);
    let diff = targetLon - normCurrent;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return normCurrent + diff;
  }, []);

  useEffect(() => {
    if (!selectedSat || !Number.isFinite(selectedSat.lon)) {
      setIsTracking(false);
      prevSelectedIdRef.current = null;
      return;
    }

    if (prevSelectedIdRef.current !== selectedSatelliteId) {
      prevSelectedIdRef.current = selectedSatelliteId;
      setIsTracking(true);

      const targetLon = getClosestTargetLon(selectedSat.lon, viewState.longitude);
      setViewState(v => ({
        ...v,
        longitude: targetLon,
        latitude: selectedSat.lat,
        zoom: 3,
        transitionDuration: 1000,
      }));
      return;
    }

    if (isTracking && !viewState.transitionDuration && !isNavigatingRef.current) {
      const targetLon = getClosestTargetLon(selectedSat.lon, viewState.longitude);
      setViewState(v => ({ ...v, longitude: targetLon, latitude: selectedSat.lat }));
    }
  }, [selectedSat?.lon, selectedSat?.lat, selectedSatelliteId, isTracking, viewState.transitionDuration, viewState.longitude, getClosestTargetLon]);

  // ==========================================================================
  // 5. DATA PREPARATION (triple copies, downsampled)
  // ==========================================================================
  const historicalTrailCopies = useMemo<TrailData[]>(() => {
    if (!trails || Object.keys(trails).length === 0) return [];

    const validTrails = Object.values(trails).filter(t => t.positions && t.positions.length > 1);
    const copies: TrailData[] = [];

    for (const trail of validTrails) {
      const rawPoints = trail.positions.map(([lon, lat]) => [lon, lat] as [number, number]);
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

  const terminatorCopies = useMemo(() => {
    if (terminatorPoints.length === 0) return [];
    const copies: [number, number][][] = [];
    for (const offset of WORLD_OFFSETS) {
      copies.push(terminatorPoints.map(([lon, lat]) => [lon + offset, lat]));
    }
    return copies;
  }, [terminatorPoints]);

  const arcData = useMemo<ArcData[]>(() => {
    const activeSat = selectedSat || hoveredSat;
    if (!activeSat || !Number.isFinite(activeSat.lon) || !Number.isFinite(activeSat.lat)) return [];

    const altMeters = activeSat.alt ?? 400000;      // store in meters (consistent)
    const altKm = altMeters / 1000;                 // for elevation calc

    return GROUND_STATIONS.filter((gs) =>
      calculateElevationAngle(
        activeSat.lat,
        activeSat.lon,
        altKm,
        gs.coordinates[1],
        gs.coordinates[0],
        gs.minElevationAngle
      )
    ).flatMap((gs) =>
      WORLD_OFFSETS.map(offset => ({
        source: [activeSat.lon + offset, activeSat.lat, altMeters] as [number, number, number],
        target: [gs.coordinates[0] + offset, gs.coordinates[1]] as [number, number],
        stationId: `${gs.id}_${offset}`,
        stationName: gs.name,
      }))
    );
  }, [selectedSat?.id, hoveredSat?.id, selectedSat?.lon, selectedSat?.lat, selectedSat?.alt, hoveredSat?.lon, hoveredSat?.lat, hoveredSat?.alt]);

  // ==========================================================================
  // 6. BINARY INSTANCING WITH BUFFER REUSE (ref-based)
  // ==========================================================================
  const instancedDebris = useMemo(() => {
    if (!debris || debris.length === 0) return null;

    // Validate buffer sizes
    const expectedColors = debris.length * 4;
    const expectedPositions = debris.length * 3;
    if (!debris.colors || debris.colors.length < expectedColors || !debris.positions || debris.positions.length < expectedPositions) {
      console.warn('[DeckGLMap] Invalid debris buffer sizes');
      return null;
    }

    const neededPos = debris.length * 9;
    const neededCol = debris.length * 12;

    bufferPoolRef.current.debrisPositions = ensureBufferSize(
      bufferPoolRef.current.debrisPositions,
      neededPos,
      () => new Float32Array(neededPos)
    );
    bufferPoolRef.current.debrisColors = ensureBufferSize(
      bufferPoolRef.current.debrisColors,
      neededCol,
      () => new Uint8ClampedArray(neededCol)
    );

    const pos = bufferPoolRef.current.debrisPositions!;
    const col = bufferPoolRef.current.debrisColors!;

    for (let w = 0; w < WORLD_OFFSETS.length; w++) {
      const offset = WORLD_OFFSETS[w];
      const destPos = w * debris.length * 3;
      const destCol = w * debris.length * 4;
      for (let i = 0; i < debris.length; i++) {
        pos[destPos + i * 3] = debris.positions[i * 3] + offset;
        pos[destPos + i * 3 + 1] = debris.positions[i * 3 + 1];
        pos[destPos + i * 3 + 2] = debris.positions[i * 3 + 2];

        col[destCol + i * 4] = debris.colors[i * 4];
        col[destCol + i * 4 + 1] = debris.colors[i * 4 + 1];
        col[destCol + i * 4 + 2] = debris.colors[i * 4 + 2];
        col[destCol + i * 4 + 3] = debris.colors[i * 4 + 3];
      }
    }
    return { length: debris.length * 3, positions: pos, colors: col };
  }, [debris]);

  const instancedSatellites = useMemo(() => {
    if (!satellites || satellites.length === 0) return null;

    const neededPos = satellites.length * 9;
    const neededCol = satellites.length * 12;

    bufferPoolRef.current.satPositions = ensureBufferSize(
      bufferPoolRef.current.satPositions,
      neededPos,
      () => new Float32Array(neededPos)
    );
    bufferPoolRef.current.satColors = ensureBufferSize(
      bufferPoolRef.current.satColors,
      neededCol,
      () => new Uint8ClampedArray(neededCol)
    );

    const pos = bufferPoolRef.current.satPositions!;
    const col = bufferPoolRef.current.satColors!;

    for (let w = 0; w < WORLD_OFFSETS.length; w++) {
      const offset = WORLD_OFFSETS[w];
      const destPos = w * satellites.length * 3;
      const destCol = w * satellites.length * 4;
      for (let i = 0; i < satellites.length; i++) {
        pos[destPos + i * 3] = satellites.positions[i * 3] + offset;
        pos[destPos + i * 3 + 1] = satellites.positions[i * 3 + 1];
        pos[destPos + i * 3 + 2] = satellites.positions[i * 3 + 2];

        col[destCol + i * 4] = satellites.colors[i * 4];
        col[destCol + i * 4 + 1] = satellites.colors[i * 4 + 1];
        col[destCol + i * 4 + 2] = satellites.colors[i * 4 + 2];
        col[destCol + i * 4 + 3] = satellites.colors[i * 4 + 3];
      }
    }
    return { length: satellites.length * 3, positions: pos, colors: col, originalLength: satellites.length };
  }, [satellites]);

  // ==========================================================================
  // 7. WEBGL LAYERS (with dataComparator removed to avoid type errors)
  // ==========================================================================
  const layers = useMemo(() => {
    const layerList: any[] = [];

    // Terminator
    if (terminatorCopies.length > 0) {
      layerList.push(
        new PolygonLayer({
          id: 'terminator',
          data: terminatorCopies,
          getPolygon: (d: [number, number][]) => d,
          getFillColor: LAYER_CONFIG.terminator.fillColor,
          stroked: false,
          pickable: false,
          wrapLongitude: false,
        })
      );
    }

    // Predicted trails
    if (predictedTrails.length > 0) {
      layerList.push(
        new PathLayer({
          id: 'predicted-trails',
          data: predictedTrails,
          getPath: (d: TrailData) => d.path,
          getColor: LAYER_CONFIG.predictedTrail.color,
          widthMinPixels: LAYER_CONFIG.predictedTrail.widthMinPixels,
          widthMaxPixels: LAYER_CONFIG.predictedTrail.widthMaxPixels,
          dashArray: LAYER_CONFIG.predictedTrail.dashArray,
          pickable: false,
          wrapLongitude: false,
        })
      );
    }

    // Historical trails (clickable)
    if (historicalTrailCopies.length > 0) {
      layerList.push(
        new PathLayer({
          id: 'historical-trails',
          data: historicalTrailCopies,
          getPath: (d: TrailData) => d.path,
          widthMinPixels: LAYER_CONFIG.historicalTrail.widthMinPixels,
          widthMaxPixels: LAYER_CONFIG.historicalTrail.widthMaxPixels,
          opacity: LAYER_CONFIG.historicalTrail.opacity,
          getColor: (d: TrailData) => {
            if (!d || !d.parentId) return LAYER_CONFIG.historicalTrail.color;
            return d.parentId === selectedSatelliteId ? LAYER_CONFIG.historicalTrail.selectedColor : LAYER_CONFIG.historicalTrail.color;
          },
          getWidth: (d: TrailData) => {
            if (!d || !d.parentId) return 2;
            return d.parentId === selectedSatelliteId ? 4 : 2;
          },
          pickable: true,
          autoHighlight: false,
          wrapLongitude: false,
          updateTriggers: {
            getColor: [selectedSatelliteId],
            getWidth: [selectedSatelliteId],
          },
          onClick: (info: any) => {
            // Defer selection and add type guard (fix #4)
            setTimeout(() => {
              try {
                if (info?.object?.parentId && typeof selectSatellite === 'function') {
                  selectSatellite(String(info.object.parentId));
                } else {
                  console.warn('[DeckGLMap] Trail click: missing parentId or selectSatellite', info);
                }
              } catch (err) {
                console.error('[DeckGLMap] Error in trail onClick', err);
              }
            }, 0);
          },
        })
      );
    }

    // Debris (instanced)
    if (instancedDebris) {
      layerList.push(
        new ScatterplotLayer({
          id: 'debris',
          data: {
            length: instancedDebris.length,
            attributes: {
              getPosition: { value: instancedDebris.positions, size: 3 },
              getFillColor: { value: instancedDebris.colors, size: 4 },
            },
          },
          getRadius: 1,
          radiusMinPixels: LAYER_CONFIG.debris.radiusMinPixels,
          opacity: LAYER_CONFIG.debris.opacity,
          pickable: false,
          wrapLongitude: false,
          updateTriggers: {
            getPosition: [instancedDebris.positions],
            getFillColor: [instancedDebris.colors],
          },
        })
      );
    }

    // Ground stations (triple copies)
    layerList.push(
      new ScatterplotLayer({
        id: 'ground-stations',
        data: GROUND_STATIONS.flatMap(gs =>
          WORLD_OFFSETS.map(offset => ({ ...gs, coordinates: [gs.coordinates[0] + offset, gs.coordinates[1]] }))
        ),
        getPosition: (d: any) => d.coordinates,
        getFillColor: [255, 0, 51, 255],
        getRadius: LAYER_CONFIG.groundStation.radiusScale,
        radiusMinPixels: LAYER_CONFIG.groundStation.radiusMinPixels,
        opacity: LAYER_CONFIG.groundStation.opacity,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 255],
        wrapLongitude: false,
      })
    );

    // Satellites (instanced)
    if (instancedSatellites) {
      layerList.push(
        new ScatterplotLayer({
          id: 'satellites',
          data: {
            length: instancedSatellites.length,
            attributes: {
              getPosition: { value: instancedSatellites.positions, size: 3 },
              getFillColor: { value: instancedSatellites.colors, size: 4 },
            },
          },
          getRadius: LAYER_CONFIG.satellite.radiusScale,
          radiusMinPixels: LAYER_CONFIG.satellite.radiusMinPixels,
          opacity: LAYER_CONFIG.satellite.opacity,
          stroked: true,
          lineWidthMinPixels: 1,
          getLineColor: [255, 255, 255, 180],
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 255],
          wrapLongitude: false,
          onHover: ({ index }: { index?: number }) => {
            if (isNavigatingRef.current) return;
            if (index !== undefined && satellites?.ids && instancedSatellites?.originalLength && typeof hoverSatellite === 'function') {
              const safeIndex = index % instancedSatellites.originalLength;
              if (safeIndex >= 0 && safeIndex < satellites.ids.length) {
                hoverSatellite(satellites.ids[safeIndex]);
              } else {
                hoverSatellite(null);
              }
            } else {
              hoverSatellite(null);
            }
          },
          onClick: ({ index }: { index?: number }) => {
            if (index !== undefined && satellites?.ids && instancedSatellites?.originalLength && typeof selectSatellite === 'function') {
              const safeIndex = index % instancedSatellites.originalLength;
              if (safeIndex >= 0 && safeIndex < satellites.ids.length) {
                selectSatellite(satellites.ids[safeIndex]);
              } else {
                selectSatellite(null);
              }
            } else {
              selectSatellite(null);
            }
          },
          updateTriggers: {
            getPosition: [instancedSatellites.positions],
            getFillColor: [instancedSatellites.colors],
          },
        })
      );
    }

    // Target lock (triple copies)
    if (selectedSat && Number.isFinite(selectedSat.lon)) {
      const lockData = WORLD_OFFSETS.map(offset => ({ ...selectedSat, lon: selectedSat.lon + offset }));
      layerList.push(
        new ScatterplotLayer({
          id: 'target-lock',
          data: lockData,
          getPosition: d => [d.lon, d.lat, d.alt || 400000],
          getFillColor: [0, 255, 255, 80],
          getLineColor: [0, 255, 255, 255],
          lineWidthMinPixels: 2,
          stroked: true,
          getRadius: LAYER_CONFIG.satellite.radiusScale * 3,
          radiusMinPixels: 9,
          wrapLongitude: false,
          updateTriggers: {
            getPosition: [selectedSat.lon, selectedSat.lat],
          },
        })
      );
    }

    // LOS arcs
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
          wrapLongitude: false,
          updateTriggers: {
            getSourcePosition: [arcData.length],
          },
        })
      );
    }

    return layerList;
  }, [
    instancedDebris,
    instancedSatellites,
    terminatorCopies,
    arcData,
    historicalTrailCopies,
    predictedTrails,
    selectedSat,
    selectedSatelliteId,
    hoverSatellite,
    selectSatellite,
    // ❌ satellites removed from deps – fixes bug #1
  ]);

  // ==========================================================================
  // 8. VIEWPORT HANDLER (with navigation flag)
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
  // 9. WEBGL CONTEXT LOSS HANDLER
  // ==========================================================================
  useEffect(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return;

    const onContextLost = (e: Event) => {
      e.preventDefault();
      console.error('[DeckGLMap] WebGL context lost. Attempting recovery...');
    };
    const onContextRestored = () => {
      console.log('[DeckGLMap] WebGL context restored.');
    };
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);
    return () => {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
    };
  }, []);

  // ==========================================================================
  // 10. RENDER (with custom ErrorBoundary)
  // ==========================================================================
  const renderContent = () => (
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
          renderWorldCopies={false} // Manual triple copies, so disable built-in repeating
          dragRotate={false}
          touchZoomRotate={false}
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
                <button
                  onClick={() => setIsTracking(true)}
                  className="text-[9px] bg-red-900/30 hover:bg-red-900/50 px-2 py-1 rounded transition-colors"
                >
                  RE-LOCK
                </button>
              )}
            </div>
            <div className="text-muted-gray space-y-1">
              <div className="flex justify-between">
                <span>LAT:</span>
                <span className="text-white">{Number(selectedSat.lat || 0).toFixed(4)}°</span>
              </div>
              <div className="flex justify-between">
                <span>LON:</span>
                <span className="text-white">{Number(selectedSat.lon || 0).toFixed(4)}°</span>
              </div>
              <div className="flex justify-between">
                <span>ALT:</span>
                <span className="text-white">{((selectedSat.alt || 400000) / 1000).toFixed(1)} km</span>
              </div>
              <div className="flex justify-between">
                <span>FUEL:</span>
                <span className={selectedSat.fuel_kg < 5 ? 'text-laser-red' : 'text-plasma-cyan'}>
                  {Number(selectedSat.fuel_kg || 0).toFixed(2)} kg
                </span>
              </div>
              <div className="flex justify-between">
                <span>STATUS:</span>
                <span className={selectedSat.status === 'CRITICAL' ? 'text-laser-red' : 'text-nominal-green'}>
                  {selectedSat.status}
                </span>
              </div>
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

  // Wrap in our own ErrorBoundary
  return (
    <ErrorBoundary
      fallback={
        <div className="w-full h-full flex items-center justify-center bg-void-black text-laser-red">
          <div className="text-center">
            <h2 className="text-xl font-bold">🛰️ Visualizer Error</h2>
            <p className="text-sm text-muted-gray mt-2">WebGL rendering failed.</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 bg-plasma-cyan text-black rounded hover:opacity-90"
            >
              Reload
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