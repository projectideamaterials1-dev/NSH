// src/components/DeckGLMap.tsx
// NSH 2026 – Orbital Insight Visualizer v5 | Crimson Nebula
// STORE SYNC: positions[i*3]=lon, [i*3+1]=lat, [i*3+2]=alt_m
// Crash-proof satellite selection | Trail isolation | 90+ FPS
// Antimeridian-safe triple-copy | Predicted tracks | Terminator

import React, {
  useMemo, useState, useEffect, useRef, useCallback,
  Component, ErrorInfo, ReactNode,
} from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, ArcLayer, PolygonLayer, PathLayer } from '@deck.gl/layers';
import { Map as MapGL } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MapViewState, ViewStateChangeParameters } from '@deck.gl/core';

import useOrbitalStore, {
  selectSelectedSatellite,
  selectHoveredSatellite,
} from '../store/useOrbitalStore';
import { GROUND_STATIONS } from '../lib/constants';

// ─────────────────────────────────────────────────────────────────────────────
// ERROR BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────

class ErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(e: Error, i: ErrorInfo) { console.error('[DeckGLMap]', e, i); }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface TrailData {
  id: string;
  parentId: string;
  path: [number, number][];
  isSelected: boolean;
}

interface ArcData {
  source: [number, number, number];
  target: [number, number];
  stationId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MAP_STYLE     = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const WORLD_OFFSETS = [-360, 0, 360] as const;
const INCLINATION   = 51.6;

const INITIAL_VIEW: MapViewState = Object.freeze({
  longitude: 0, latitude: 20, zoom: 1.8, pitch: 0, bearing: 0,
});

// Trail colours
const TRAIL_SELECTED:  [number,number,number,number] = [0, 255, 255, 240];
const TRAIL_OTHER:     [number,number,number,number] = [0, 160, 200, 60];
const TRAIL_PREDICTED: [number,number,number,number] = [0, 180, 220, 40];
const TRAIL_SEL_PRED:  [number,number,number,number] = [0, 220, 255, 110];

// ─────────────────────────────────────────────────────────────────────────────
// PURE MATH
// ─────────────────────────────────────────────────────────────────────────────

function getDayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.floor((date.getTime() - start.getTime()) / 86_400_000) + 1;
}

function solarParams(timestamp: string): { decl: number; sunLon: number } {
  const date = new Date(timestamp);
  const doy  = getDayOfYear(date);
  const decl = -23.44 * Math.cos((2 * Math.PI / 365) * (doy + 10));
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let sunLon = 180 - 15 * utcH;
  if (sunLon >  180) sunLon -= 360;
  if (sunLon < -180) sunLon += 360;
  return { decl, sunLon };
}

const terminatorCache = new Map<string, [number, number][]>();

function buildTerminator(timestamp: string): [number, number][] {
  const key = timestamp.slice(0, 16);
  if (terminatorCache.has(key)) return terminatorCache.get(key)!;

  const { decl, sunLon } = solarParams(timestamp);
  const decRad = decl * Math.PI / 180;
  const pts: [number, number][] = [];

  for (let lon = -180; lon <= 180; lon += 3) {
    const lonRad = ((lon - sunLon) * Math.PI) / 180;
    const tanD   = Math.tan(decRad);
    const arg    = -Math.cos(lonRad) / (Math.abs(tanD) < 1e-9 ? 1e-9 : tanD);
    const lat    = Math.atan(arg) * 180 / Math.PI;
    if (Number.isFinite(lat)) pts.push([lon, Math.max(-90, Math.min(90, lat))]);
  }
  pts.push([180, decl > 0 ? -90 : 90], [-180, decl > 0 ? -90 : 90]);

  terminatorCache.set(key, pts);
  if (terminatorCache.size > 30) terminatorCache.delete(terminatorCache.keys().next().value!);
  return pts;
}

function unwrapTrail(pts: [number, number][]): [number, number][] {
  if (pts.length < 2) return pts.slice();
  const out: [number, number][] = [[pts[0][0], pts[0][1]]];
  let offset = 0;
  for (let i = 1; i < pts.length; i++) {
    const diff = pts[i][0] - pts[i - 1][0];
    if (diff >  180) offset -= 360;
    if (diff < -180) offset += 360;
    if (Number.isFinite(pts[i][0]) && Number.isFinite(pts[i][1]))
      out.push([pts[i][0] + offset, pts[i][1]]);
  }
  return out;
}

function downsample(path: [number, number][], factor: number): [number, number][] {
  if (factor <= 1 || path.length <= 8) return path;
  const out: [number, number][] = [];
  for (let i = 0; i < path.length; i += factor) out.push(path[i]);
  if (out[out.length - 1] !== path[path.length - 1]) out.push(path[path.length - 1]);
  return out;
}

function hasLOS(
  satLat: number, satLon: number, satAltKm: number,
  gsLat: number, gsLon: number, minElev: number
): boolean {
  const R  = 6371;
  const p1 = satLat * Math.PI / 180, p2 = gsLat * Math.PI / 180;
  const dl = (satLon - gsLon) * Math.PI / 180;
  const central = Math.acos(
    Math.max(-1, Math.min(1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl)))
  );
  if (!Number.isFinite(central) || central * 180 / Math.PI > 30) return false;
  const elevRad = Math.atan((Math.cos(central) - R / (R + satAltKm)) / Math.sin(central));
  return elevRad * 180 / Math.PI >= minElev;
}

function inEclipse(satLat: number, satLon: number, sunLon: number): boolean {
  const latR  = satLat * Math.PI / 180;
  const dLonR = (satLon - sunLon) * Math.PI / 180;
  return Math.cos(latR) * Math.cos(dLonR) < -0.1;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUFFER POOL (ref-scoped, not module-level)
// ─────────────────────────────────────────────────────────────────────────────

interface BufPool {
  debPos: Float32Array | null;
  debCol: Uint8ClampedArray | null;
  satPos: Float32Array | null;
  satCol: Uint8ClampedArray | null;
}

function ensureBuf<T extends Float32Array | Uint8ClampedArray>(
  cur: T | null, need: number, make: () => T
): T {
  if (cur && cur.length >= need) { cur.fill(0); return cur; }
  return make();
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export const DeckGLMap: React.FC = React.memo(() => {
  // ── Store selectors (atomic, fine-grained) ─────────────────────────────────
  const debris          = useOrbitalStore(s => s.debris);
  const satellites      = useOrbitalStore(s => s.satellites);
  const timestamp       = useOrbitalStore(s => s.timestamp);
  const selectedSatId   = useOrbitalStore(s => s.selectedSatelliteId);
  const trails          = useOrbitalStore(s => s.trails);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  const hoverSatellite  = useOrbitalStore(s => s.hoverSatellite);

  // These selectors use positions stride internally (safe)
  const selectedSat = useOrbitalStore(selectSelectedSatellite);
  const hoveredSat  = useOrbitalStore(selectHoveredSatellite);

  // ── Local state ─────────────────────────────────────────────────────────────
  const [viewState,       setViewState]       = useState<MapViewState>(INITIAL_VIEW);
  const [terminator,      setTerminator]       = useState<[number, number][]>([]);
  const [predictedTrails, setPredictedTrails]  = useState<TrailData[]>([]);
  const [eclipse,         setEclipse]          = useState(false);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const bufPool     = useRef<BufPool>({ debPos: null, debCol: null, satPos: null, satCol: null });
  const isDragging  = useRef(false);
  const predPending = useRef(false);
  const predTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── 1. TERMINATOR (60 s interval) ─────────────────────────────────────────
  useEffect(() => {
    if (!timestamp) return;
    setTerminator(buildTerminator(timestamp));
    const id = setInterval(() => setTerminator(buildTerminator(timestamp)), 60_000);
    return () => clearInterval(id);
  }, [timestamp]);

  // ── 2. ECLIPSE (500 ms debounce) ───────────────────────────────────────────
  useEffect(() => {
    if (!selectedSat || !timestamp) { setEclipse(false); return; }
    const tid = setTimeout(() => {
      const { sunLon } = solarParams(timestamp);
      setEclipse(inEclipse(selectedSat.lat, selectedSat.lon, sunLon));
    }, 500);
    return () => clearTimeout(tid);
  }, [selectedSat?.lat, selectedSat?.lon, timestamp]);

  // ── 3. PREDICTED TRAILS (debounced 300 ms, idle callback) ─────────────────
  useEffect(() => {
    if (!satellites || satellites.length === 0) return;
    if (predPending.current) return;
    predPending.current = true;

    if (predTimer.current) clearTimeout(predTimer.current);
    predTimer.current = setTimeout(() => {
      const run = () => {
        if (!satellites) { predPending.current = false; return; }
        const result: TrailData[] = [];

        for (let i = 0; i < satellites.length; i++) {
          const id  = satellites.ids[i];
          // positions stride: lon=[i*3], lat=[i*3+1]
          const lon = satellites.positions[i * 3];
          const lat = satellites.positions[i * 3 + 1];
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

          const isSel = id === selectedSatId;
          const path: [number, number][] = [];
          const phase = Math.asin(Math.max(-1, Math.min(1, lat / INCLINATION))) || 0;

          for (let t = 0; t <= 5400; t += 60) {
            const progress = t / 5400;
            const pLon = lon + progress * 360;
            const pLat = INCLINATION * Math.sin(phase + progress * Math.PI * 2);
            path.push([pLon, Math.max(-INCLINATION, Math.min(INCLINATION, pLat))]);
          }

          const unwrapped  = unwrapTrail(path);
          const downsampled = downsample(unwrapped, 3);
          if (downsampled.length < 2) continue;

          for (const offset of WORLD_OFFSETS) {
            result.push({
              id: `${id}_pred_${offset}`,
              parentId: id,
              isSelected: isSel,
              path: downsampled.map(([lo, la]) => [lo + offset, la]),
            });
          }
        }

        setPredictedTrails(result);
        predPending.current = false;
      };

      // Use requestIdleCallback when available, else setTimeout
      if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(run, { timeout: 2000 });
      else setTimeout(run, 0);
    }, 300);
  }, [satellites, selectedSatId]);

  // ── 4. HISTORICAL TRAILS (derived from store.trails) ──────────────────────
  const historicalTrails = useMemo<TrailData[]>(() => {
    if (!trails || Object.keys(trails).length === 0) return [];
    const result: TrailData[] = [];

    for (const trail of Object.values(trails)) {
      if (!trail.positions || trail.positions.length < 2) continue;
      const isSel = trail.satelliteId === selectedSatId;
      const rawPts = trail.positions.map(([lo, la]) => [lo, la] as [number, number]);
      const unwrapped  = unwrapTrail(rawPts);
      const downsampled = downsample(unwrapped, 2);
      if (downsampled.length < 2) continue;

      for (const offset of WORLD_OFFSETS) {
        result.push({
          id: `${trail.satelliteId}_hist_${offset}`,
          parentId: trail.satelliteId,
          isSelected: isSel,
          path: downsampled.map(([lo, la]) => [lo + offset, la]),
        });
      }
    }
    return result;
  }, [trails, selectedSatId]);

  // ── 5. TERMINATOR COPIES ───────────────────────────────────────────────────
  const terminatorCopies = useMemo(() => {
    if (!terminator.length) return [];
    return WORLD_OFFSETS.map(offset => terminator.map(([lo, la]) => [lo + offset, la] as [number, number]));
  }, [terminator]);

  // ── 6. LOS ARCS ────────────────────────────────────────────────────────────
  const arcData = useMemo<ArcData[]>(() => {
    const sat = selectedSat ?? hoveredSat;
    if (!sat || !Number.isFinite(sat.lon)) return [];
    // alt from store is in metres, hasLOS expects km
    const altKm = (sat.alt ?? 400_000) / 1_000;

    return GROUND_STATIONS.flatMap(gs =>
      hasLOS(sat.lat, sat.lon, altKm, gs.coordinates[1], gs.coordinates[0], gs.minElevationAngle)
        ? WORLD_OFFSETS.map(offset => ({
            source: [sat.lon + offset, sat.lat, sat.alt ?? 400_000] as [number, number, number],
            target: [gs.coordinates[0] + offset, gs.coordinates[1]] as [number, number],
            stationId: `${gs.id}_${offset}`,
          }))
        : []
    );
  }, [selectedSat?.id, selectedSat?.lon, selectedSat?.lat, hoveredSat?.id]);

  // ── 7. INSTANCED DEBRIS ────────────────────────────────────────────────────
  const instancedDebris = useMemo(() => {
    if (!debris || debris.length === 0) return null;
    if (!debris.positions || debris.positions.length < debris.length * 3) return null;
    if (!debris.colors    || debris.colors.length    < debris.length * 4) return null;

    const N = debris.length;
    bufPool.current.debPos = ensureBuf(bufPool.current.debPos, N * 9, () => new Float32Array(N * 9));
    bufPool.current.debCol = ensureBuf(bufPool.current.debCol, N * 12, () => new Uint8ClampedArray(N * 12));

    const pos = bufPool.current.debPos!;
    const col = bufPool.current.debCol!;

    for (let w = 0; w < 3; w++) {
      const offset = WORLD_OFFSETS[w];
      const pBase = w * N * 3, cBase = w * N * 4;
      for (let i = 0; i < N; i++) {
        pos[pBase + i * 3]     = debris.positions[i * 3] + offset;
        pos[pBase + i * 3 + 1] = debris.positions[i * 3 + 1];
        pos[pBase + i * 3 + 2] = debris.positions[i * 3 + 2];
        col[cBase + i * 4]     = debris.colors[i * 4];
        col[cBase + i * 4 + 1] = debris.colors[i * 4 + 1];
        col[cBase + i * 4 + 2] = debris.colors[i * 4 + 2];
        col[cBase + i * 4 + 3] = debris.colors[i * 4 + 3];
      }
    }
    return { length: N * 3, positions: pos, colors: col };
  }, [debris]);

  // ── 8. INSTANCED SATELLITES  (per-sat colour override for selected/hovered) ─
  const instancedSatellites = useMemo(() => {
    if (!satellites || satellites.length === 0) return null;

    const N = satellites.length;
    bufPool.current.satPos = ensureBuf(bufPool.current.satPos, N * 9, () => new Float32Array(N * 9));
    bufPool.current.satCol = ensureBuf(bufPool.current.satCol, N * 12, () => new Uint8ClampedArray(N * 12));

    const pos = bufPool.current.satPos!;
    const col = bufPool.current.satCol!;

    for (let w = 0; w < 3; w++) {
      const offset = WORLD_OFFSETS[w];
      const pBase = w * N * 3, cBase = w * N * 4;
      for (let i = 0; i < N; i++) {
        // positions stride: lon=[i*3], lat=[i*3+1], alt=[i*3+2]
        pos[pBase + i * 3]     = satellites.positions[i * 3] + offset;
        pos[pBase + i * 3 + 1] = satellites.positions[i * 3 + 1];
        pos[pBase + i * 3 + 2] = satellites.positions[i * 3 + 2];

        const id = satellites.ids[i];
        if (id === selectedSatId) {
          col[cBase + i * 4]     = 255;
          col[cBase + i * 4 + 1] = 255;
          col[cBase + i * 4 + 2] = 255;
          col[cBase + i * 4 + 3] = 255;
        } else if (id === hoveredSat?.id) {
          col[cBase + i * 4]     = 160;
          col[cBase + i * 4 + 1] = 255;
          col[cBase + i * 4 + 2] = 255;
          col[cBase + i * 4 + 3] = 255;
        } else {
          col[cBase + i * 4]     = satellites.colors[i * 4];
          col[cBase + i * 4 + 1] = satellites.colors[i * 4 + 1];
          col[cBase + i * 4 + 2] = satellites.colors[i * 4 + 2];
          col[cBase + i * 4 + 3] = satellites.colors[i * 4 + 3];
        }
      }
    }
    return { length: N * 3, originalLength: N, positions: pos, colors: col };
  }, [satellites, selectedSatId, hoveredSat?.id]);

  // ── 9. GROUND STATION DATA (memoised once) ─────────────────────────────────
  const gsData = useMemo(() =>
    GROUND_STATIONS.flatMap(gs =>
      WORLD_OFFSETS.map(offset => ({
        id: `${gs.id}_${offset}`,
        coordinates: [gs.coordinates[0] + offset, gs.coordinates[1]] as [number, number],
      }))
    ),
  []);

  // ── 10. SATELLITE CLICK / HOVER HANDLERS (crash-proof) ────────────────────
  // Key: use setTimeout(0) + try/catch + safe index % originalLength

  const handleSatClick = useCallback(
    ({ index }: { index?: number }) => {
      if (isDragging.current || index === undefined) return;
      setTimeout(() => {
        try {
          if (!satellites?.ids || !instancedSatellites?.originalLength) return;
          const safeIdx = ((index % instancedSatellites.originalLength) + instancedSatellites.originalLength) % instancedSatellites.originalLength;
          if (safeIdx >= satellites.ids.length) return;
          const newId = satellites.ids[safeIdx];
          if (newId) selectSatellite?.(newId === selectedSatId ? null : newId);
        } catch (e) { console.error('[DeckGLMap] onClick', e); }
      }, 0);
    },
    [satellites, instancedSatellites?.originalLength, selectedSatId, selectSatellite]
  );

  const handleSatHover = useCallback(
    ({ index }: { index?: number }) => {
      if (isDragging.current) return;
      setTimeout(() => {
        try {
          if (index === undefined || index < 0 || !satellites?.ids || !instancedSatellites?.originalLength) {
            hoverSatellite?.(null); return;
          }
          const safeIdx = ((index % instancedSatellites.originalLength) + instancedSatellites.originalLength) % instancedSatellites.originalLength;
          if (safeIdx >= satellites.ids.length) { hoverSatellite?.(null); return; }
          hoverSatellite?.(satellites.ids[safeIdx]);
        } catch (e) { hoverSatellite?.(null); }
      }, 0);
    },
    [satellites, instancedSatellites?.originalLength, hoverSatellite]
  );

  // ── 11. LAYERS ─────────────────────────────────────────────────────────────
  const layers = useMemo(() => {
    const ls: any[] = [];

    // Terminator (night shadow)
    if (terminatorCopies.length > 0) {
      ls.push(new PolygonLayer({
        id: 'terminator',
        data: terminatorCopies,
        getPolygon: (d: [number, number][]) => d,
        getFillColor: [0, 0, 0, 145],
        stroked: false,
        pickable: false,
        wrapLongitude: false,
      }));
    }

    // Predicted trails (dashed)
    if (predictedTrails.length > 0) {
      ls.push(new PathLayer({
        id: 'predicted-trails',
        data: predictedTrails,
        getPath: (d: TrailData) => d.path,
        getColor: (d: TrailData) => d.isSelected ? TRAIL_SEL_PRED : TRAIL_PREDICTED,
        getWidth: (d: TrailData) => d.isSelected ? 1.8 : 1,
        widthMinPixels: 1,
        widthMaxPixels: 3,
        dashArray: [6, 4],
        pickable: false,
        wrapLongitude: false,
        updateTriggers: { getColor: [selectedSatId], getWidth: [selectedSatId] },
      }));
    }

    // Historical trails (solid, thicker for selected)
    if (historicalTrails.length > 0) {
      ls.push(new PathLayer({
        id: 'historical-trails',
        data: historicalTrails,
        getPath: (d: TrailData) => d.path,
        getColor: (d: TrailData) => d.isSelected ? TRAIL_SELECTED : TRAIL_OTHER,
        getWidth: (d: TrailData) => d.isSelected ? 3 : 1.5,
        widthMinPixels: 1.5,
        widthMaxPixels: 7,
        opacity: 1,
        pickable: false,
        wrapLongitude: false,
        updateTriggers: { getColor: [selectedSatId], getWidth: [selectedSatId] },
      }));
    }

    // Debris (instanced, no picking – too many)
    if (instancedDebris) {
      ls.push(new ScatterplotLayer({
        id: 'debris',
        data: {
          length: instancedDebris.length,
          attributes: {
            getPosition: { value: instancedDebris.positions, size: 3 },
            getFillColor: { value: instancedDebris.colors, size: 4 },
          },
        },
        getRadius: 1200,
        radiusMinPixels: 1,
        radiusMaxPixels: 2,
        opacity: 0.5,
        pickable: false,
        wrapLongitude: false,
        updateTriggers: { getPosition: [instancedDebris.positions], getFillColor: [instancedDebris.colors] },
      }));
    }

    // Ground stations
    ls.push(new ScatterplotLayer({
      id: 'ground-stations',
      data: gsData,
      getPosition: (d: any) => [d.coordinates[0], d.coordinates[1]],
      getFillColor: [255, 0, 51, 255],
      getRadius: 3500,
      radiusMinPixels: 5,
      radiusMaxPixels: 10,
      stroked: true,
      lineWidthMinPixels: 1.5,
      getLineColor: [255, 100, 100, 180],
      opacity: 1,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 255],
      wrapLongitude: false,
    }));

    // Satellites (instanced with per-sat colour override)
    if (instancedSatellites) {
      ls.push(new ScatterplotLayer({
        id: 'satellites',
        data: {
          length: instancedSatellites.length,
          attributes: {
            getPosition: { value: instancedSatellites.positions, size: 3 },
            getFillColor: { value: instancedSatellites.colors, size: 4 },
          },
        },
        getRadius: 4500,
        radiusMinPixels: 3,
        radiusMaxPixels: 12,
        opacity: 1,
        stroked: true,
        lineWidthMinPixels: 0.5,
        getLineColor: [255, 255, 255, 50],
        pickable: true,
        autoHighlight: false,
        wrapLongitude: false,
        onHover: handleSatHover,
        onClick: handleSatClick,
        updateTriggers: {
          getPosition: [instancedSatellites.positions],
          getFillColor: [instancedSatellites.colors],
        },
      }));
    }

    // Selected satellite — two concentric glowing rings
    if (selectedSat && Number.isFinite(selectedSat.lon)) {
      const lockData = WORLD_OFFSETS.map(offset => ({
        ...selectedSat,
        lon: selectedSat.lon + offset,
      }));
      ls.push(new ScatterplotLayer({
        id: 'target-ring-outer',
        data: lockData,
        getPosition: (d: any) => [d.lon, d.lat, d.alt ?? 400_000],
        getFillColor: [0, 255, 255, 0],
        getLineColor: [0, 255, 255, 190],
        getRadius: 16_000,
        radiusMinPixels: 14,
        radiusMaxPixels: 22,
        stroked: true,
        lineWidthMinPixels: 2,
        wrapLongitude: false,
        updateTriggers: { getPosition: [selectedSat.lon, selectedSat.lat] },
      }));
      ls.push(new ScatterplotLayer({
        id: 'target-ring-inner',
        data: lockData,
        getPosition: (d: any) => [d.lon, d.lat, d.alt ?? 400_000],
        getFillColor: [0, 255, 255, 25],
        getLineColor: [0, 255, 255, 100],
        getRadius: 9_000,
        radiusMinPixels: 8,
        radiusMaxPixels: 13,
        stroked: true,
        lineWidthMinPixels: 1,
        wrapLongitude: false,
        updateTriggers: { getPosition: [selectedSat.lon, selectedSat.lat] },
      }));
    }

    // LOS arcs
    if (arcData.length > 0) {
      ls.push(new ArcLayer({
        id: 'los-arcs',
        data: arcData,
        getSourcePosition: (d: ArcData) => d.source,
        getTargetPosition: (d: ArcData) => d.target,
        getSourceColor: [255, 0, 51, 220],
        getTargetColor: [255, 0, 51, 55],
        getWidth: 2,
        opacity: 0.8,
        pickable: false,
        wrapLongitude: false,
        updateTriggers: { getSourcePosition: [arcData.length] },
      }));
    }

    return ls;
  }, [
    instancedDebris,
    instancedSatellites,
    terminatorCopies,
    arcData,
    historicalTrails,
    predictedTrails,
    selectedSat,
    selectedSatId,
    gsData,
    handleSatClick,
    handleSatHover,
  ]);

  // ── 12. VIEWPORT ───────────────────────────────────────────────────────────
  const handleViewStateChange = useCallback(
    ({ viewState: vs, interactionState }: ViewStateChangeParameters) => {
      setViewState(vs as unknown as MapViewState);
      isDragging.current = Boolean(
        interactionState?.isDragging || interactionState?.isPanning || interactionState?.isZooming
      );
    },
    []
  );

  const getCursor = useCallback(
    ({ isHovering }: { isHovering: boolean }) =>
      isDragging.current ? 'grabbing' : isHovering ? 'crosshair' : 'default',
    []
  );

  // ── 13. WEBGL CONTEXT LOSS ─────────────────────────────────────────────────
  useEffect(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    const onLost = (e: Event) => { e.preventDefault(); console.error('[DeckGLMap] WebGL context lost'); };
    const onRestored = () => console.log('[DeckGLMap] WebGL context restored');
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    };
  }, []);

  // ── 14. STATUS STRIP helper ────────────────────────────────────────────────
  const satStatusColor = (status: string) =>
    status === 'CRITICAL' ? 'text-laser-red animate-pulse' :
    status === 'WARNING'  ? 'text-amber' : 'text-nominal-green';

  // ── 15. RENDER ─────────────────────────────────────────────────────────────
  return (
    <ErrorBoundary
      fallback={
        <div className="w-full h-full flex items-center justify-center bg-black font-mono text-laser-red">
          <div className="text-center space-y-3">
            <div className="text-4xl">⚠️</div>
            <div className="text-sm">WebGL Rendering Failed</div>
            <button onClick={() => window.location.reload()}
              className="px-4 py-2 text-xs border border-laser-red rounded hover:bg-laser-red/20 transition-colors">
              RELOAD
            </button>
          </div>
        </div>
      }
    >
      <div className="relative w-full h-full bg-black overflow-hidden">
        <DeckGL
          width="100%"
          height="100%"
          viewState={viewState}
          onViewStateChange={handleViewStateChange}
          controller={{
            scrollZoom: { smooth: true, speed: 0.01 },
            dragPan: true,
            dragRotate: false,
            touchRotate: false,
            doubleClickZoom: true,
            keyboard: true,
          }}
          layers={layers}
          getCursor={getCursor}
          // useDevicePixels=true gives the GPU full native resolution → higher FPS potential
          useDevicePixels={true}
          onWebGLInitialized={(gl: WebGLRenderingContext) => {
            gl.clearColor(0, 0, 0, 1);
          }}
        >
          <MapGL
            mapStyle={MAP_STYLE}
            reuseMaps
            renderWorldCopies={false}
            dragRotate={false}
            touchZoomRotate={false}
            attributionControl={false}
          />
        </DeckGL>

        {/* ── Selected satellite HUD strip (top-centre) ── */}
        {selectedSat && (
          <div className="absolute top-16 left-1/2 pointer-events-none z-10"
            style={{ transform: 'translateX(-50%)' }}>
            <div className="flex items-center gap-3 px-4 py-2 rounded-full font-mono text-xs"
              style={{
                background: 'rgba(0,0,0,0.78)',
                border: '1px solid rgba(0,255,255,0.45)',
                boxShadow: '0 0 20px rgba(0,255,255,0.18)',
                backdropFilter: 'blur(10px)',
              }}>
              <div className="w-2 h-2 rounded-full bg-plasma-cyan animate-pulse"
                style={{ boxShadow: '0 0 6px #00FFFF' }} />
              <span className="text-plasma-cyan font-bold">{selectedSat.id}</span>
              <span className="text-muted-gray">LOCKED</span>
              <span className="text-white">{selectedSat.lat.toFixed(3)}° / {selectedSat.lon.toFixed(3)}°</span>
              <span className={`font-mono ${selectedSat.fuel_kg < 5 ? 'text-laser-red font-bold animate-pulse' : selectedSat.fuel_kg < 15 ? 'text-amber' : 'text-plasma-cyan'}`}>
                ⛽ {selectedSat.fuel_kg.toFixed(2)} kg
              </span>
              <span className={`font-mono font-bold ${satStatusColor(selectedSat.status)}`}>
                {selectedSat.status}
              </span>
              <button
                className="pointer-events-auto text-muted-gray hover:text-white transition-colors ml-1"
                onClick={() => selectSatellite?.(null)}>
                ✕
              </button>
            </div>
          </div>
        )}

        {/* ── Eclipse warning (bottom-centre) ── */}
        {eclipse && selectedSat && (
          <div className="absolute bottom-8 left-1/2 pointer-events-none z-10"
            style={{ transform: 'translateX(-50%)' }}>
            <div className="px-4 py-2 rounded font-mono text-xs font-bold animate-pulse"
              style={{
                background: 'rgba(210,153,34,0.14)',
                border: '1px solid rgba(210,153,34,0.55)',
                color: '#D29922',
                boxShadow: '0 0 16px rgba(210,153,34,0.28)',
              }}>
              ⚡ ECLIPSE ZONE — BATTERY POWER
            </div>
          </div>
        )}

        {/* ── Map legend (bottom-right) ── */}
        <div className="absolute bottom-4 right-4 pointer-events-none z-10 rounded-lg px-3 py-2.5"
          style={{
            background: 'rgba(0,0,0,0.72)',
            border: '1px solid rgba(255,0,51,0.18)',
            backdropFilter: 'blur(8px)',
          }}>
          <div className="space-y-1.5 text-[8px] font-mono">
            {[
              { col: '#00FFFF', label: 'NOMINAL' },
              { col: '#FFbf00', label: 'WARNING' },
              { col: '#FF0033', label: 'CRITICAL' },
              { col: '#FF0033', label: 'GROUND STN', square: true },
            ].map(({ col, label, square }) => (
              <div key={label} className="flex items-center gap-2">
                <div className={`${square ? 'w-2 h-2' : 'w-2 h-2 rounded-full'}`}
                  style={{ background: col, boxShadow: `0 0 4px ${col}` }} />
                <span className="text-muted-gray">{label}</span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <div className="w-4 h-[1px]" style={{ background: 'rgba(0,200,255,0.5)' }} />
              <span className="text-muted-gray">PREDICTED</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-[2px]" style={{ background: '#00FFFF' }} />
              <span className="text-muted-gray">TRAIL</span>
            </div>
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
});

DeckGLMap.displayName = 'DeckGLMap';
export default DeckGLMap;