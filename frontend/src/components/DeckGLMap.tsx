// src/components/DeckGLMap.tsx
// Orbital view: photorealistic 3D Earth (Three.js, see EarthGlobe) or 2D ground-track map (deck.gl +
// MapLibre dark basemap). Both show the debris cloud, satellites (real altitude in 3D), threat rings,
// trails, predicted orbit, ground-station visibility lines, executed burns and replay frames.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { FlyToInterpolator, MapView, WebMercatorViewport } from '@deck.gl/core';
import type { MapViewState, PickingInfo, Position } from '@deck.gl/core';
import { LineLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { PathStyleExtension, CollisionFilterExtension } from '@deck.gl/extensions';
import { Basemap } from './Basemap';
import { Box, Cloud, CloudDownload, Crosshair, Globe2, History, Loader2, Map as MapIcon, Maximize2, Satellite as SatelliteIcon, Terminal } from 'lucide-react';

import useOrbitalStore, { DEFAULT_CATALOG_REQUEST, selectReplayFrame } from '../store/useOrbitalStore';
import type { TrackBurn } from '../store/types';
import { GROUND_STATIONS } from '../lib/constants';
import { MISSION_STATIONS, REFERENCE_STATIONS, STATION_COLORS, type Station } from '../lib/stations';
import useLayoutStore from '../store/layout';
import { SatelliteCard, cardPosition } from './SatelliteCard';
import { COLORS, formatUtcTime, statusMeta } from '../lib/format';
import { elevationDeg, nightPolygon } from '../lib/geo';
import { useSatMotion } from '../lib/useSatMotion';
import type { PickHit } from '../lib/earthScene';
import { EarthGlobe, type EarthGlobeHandle, type GlobeSatellite } from './EarthGlobe';
import { Button, usePresence } from './ui';

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';
const MAP_VIEW = new MapView({ id: 'map', repeat: true });
const DEFAULT_SAT_ALT_KM = 550; // used until /api/satellites reports the real altitude
const UNSELECTED_TRAIL_POINTS = 6;
/** Working satellites outside the fleet (tracked, not operated): violet, apart from debris grey. */
const OTHER_SAT_COLOR = '#b392f0';
/** Above this many fleet satellites the 2-D map draws them as small dots (see satStyle). */
const DENSE_FLEET = 1500;
const DASH = new PathStyleExtension({ dash: true });
const COLLIDE = new CollisionFilterExtension();

type RGBA = [number, number, number, number];
const hexToRgba = (hex: string, alpha = 255): RGBA => [
  parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), alpha,
];
const statusColor = (status: string) =>
  status === 'WARNING' ? COLORS.warn : status === 'CRITICAL' || status === 'CRITICAL_FUEL' ? COLORS.crit : status === 'EOL' ? COLORS.eol : COLORS.sat;
const SAT_RGBA: Record<string, RGBA> = {
  NOMINAL: hexToRgba(COLORS.sat),
  WARNING: hexToRgba(COLORS.warn),
  CRITICAL: hexToRgba(COLORS.crit),
  CRITICAL_FUEL: hexToRgba(COLORS.crit),
  EOL: hexToRgba(COLORS.eol),
};

/** Shows all longitudes across the available width (polar regions may be cropped). */
function fitWorld(width: number, height: number): MapViewState {
  const zoom = Math.max(0, Math.log2(width / 512));
  const latitude = height < width * 0.75 ? 18 : 0;
  return { longitude: 0, latitude, zoom, pitch: 0, bearing: 0 };
}

const LegendItem: React.FC<{ color: string; label: string; shape?: 'dot' | 'ring' | 'line' | 'dash' }> = ({ color, label, shape = 'dot' }) => (
  <div className="flex items-center gap-2">
    {shape === 'dot' && <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />}
    {shape === 'ring' && <span className="w-2.5 h-2.5 rounded-full border-2" style={{ borderColor: color }} />}
    {shape === 'line' && <span className="w-4 h-0.5 rounded" style={{ background: color }} />}
    {shape === 'dash' && <span className="w-4 h-0 border-t-2 border-dashed" style={{ borderColor: color }} />}
    <span>{label}</span>
  </div>
);

const FLY = new FlyToInterpolator({ speed: 1.6 });

/** The next queued burn anywhere in the fleet, counting down in simulation time. Click to select it. */
const NextBurnChip: React.FC = () => {
  const maneuvers = useOrbitalStore(s => s.maneuvers);
  const timestamp = useOrbitalStore(s => s.timestamp);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  const now = timestamp ? Date.parse(timestamp) : NaN;
  const next = useMemo(() => {
    let best: (typeof maneuvers)[number] | null = null;
    let bestT = Infinity;
    for (const m of maneuvers) {
      const t = m.status === 'pending' ? Date.parse(m.burnTime) : NaN;
      if (t > now && t < bestT) { best = m; bestT = t; }
    }
    return best ? { m: best, t: bestT } : null;
  }, [maneuvers, now]);
  const { mounted, closing } = usePresence(!!next, 180);
  const shown = useRef(next);
  if (next) shown.current = next;
  if (!mounted || !shown.current) return null;
  const { m, t } = shown.current;
  const left = Math.max(0, Math.round((t - now) / 1000));
  const soon = left <= 60;
  return (
    <button onClick={() => selectSatellite(m.satellite_id)} title="Select this satellite"
      className={`absolute top-3 left-3 flex items-center gap-2.5 bg-panel/90 backdrop-blur-sm border rounded-lg pl-2.5 pr-3 h-9 shadow-lg text-[12.5px] hover:bg-raised ${
        soon ? 'border-accent/70' : 'border-line'} ${closing ? 'animate-fade-out' : 'animate-pop-in'}`}>
      <span className="relative flex w-2.5 h-2.5">
        <span className="absolute inset-0 rounded-full bg-accent animate-burn-pulse" />
        <span className="relative w-2.5 h-2.5 rounded-full bg-accent" />
      </span>
      <span className="text-muted">Next burn</span>
      <span className="text-ink font-medium truncate max-w-[160px]">{m.satellite_id}</span>
      <span className="text-muted tabular">{m.delta_v_magnitude.toFixed(2)} m/s</span>
      <span className={`tabular font-semibold min-w-[52px] text-right ${soon ? 'text-accent' : 'text-ink'}`}>
        T−{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
      </span>
    </button>
  );
};

/** The selected satellite's queued burns, where they fire on its predicted track. */
function burnsPlanned(burns: TrackBurn[] | null, selectedId: string | null, replay: unknown) {
  return selectedId && !replay && burns ? burns.map(b => ({ lon: b.lon, lat: b.lat })) : [];
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface DisplaySat { id: string; lon: number; lat: number; alt: number; status: string; fuel: number }
/** A burn marker: executed (any satellite) or planned (the selected satellite's queue). alt in metres. */
interface MapBurn { burn_id: string; satellite_id: string; lon: number; lat: number; alt: number; dv_mps: number; planned: boolean; t?: string }

export const DeckGLMap: React.FC = () => {
  const liveDebris = useOrbitalStore(s => s.debris);
  const liveSatellites = useOrbitalStore(s => s.satellites);
  const liveTimestamp = useOrbitalStore(s => s.timestamp);
  const live = useOrbitalStore(s => s.realWorld?.live ?? false);
  const isSimulationRunning = useOrbitalStore(s => s.isSimulationRunning);
  const trails = useOrbitalStore(s => s.trails);
  const maneuvers = useOrbitalStore(s => s.maneuvers);
  const connection = useOrbitalStore(s => s.connectionStatus);
  const details = useOrbitalStore(s => s.satelliteDetails);
  const selectedTrack = useOrbitalStore(s => s.selectedTrack);
  const selectedTrackBurns = useOrbitalStore(s => s.selectedTrackBurns);
  const selectedTrackCoast = useOrbitalStore(s => s.selectedTrackCoast);
  const selectedId = useOrbitalStore(s => s.selectedSatelliteId);
  const selectSatellite = useOrbitalStore(s => s.selectSatellite);
  const replay = useOrbitalStore(selectReplayFrame);
  const viewMode = useOrbitalStore(s => s.viewMode);
  const setViewMode = useOrbitalStore(s => s.setViewMode);
  const setReplayIndex = useOrbitalStore(s => s.setReplayIndex);
  const loadCatalog = useOrbitalStore(s => s.loadCatalog);
  const setDataSourcesOpen = useOrbitalStore(s => s.setDataSourcesOpen);
  const [quickLoad, setQuickLoad] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const containerRef = useRef<HTMLDivElement>(null);
  const [mapState, setMapState] = useState<MapViewState>(() => fitWorld(1100, 700));
  const [follow, setFollow] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [clouds, setClouds] = useState(true);
  const [models, setModels] = useState(true);
  const globeRef = useRef<EarthGlobeHandle>(null);
  const userMovedRef = useRef(false);
  const is3d = viewMode === '3d';

  // Fit the 2D world map to the available space until the user pans/zooms (the globe fits itself).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
      if (!userMovedRef.current) setMapState(fitWorld(width, height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const timestamp = replay?.timestamp ?? liveTimestamp;

  // ── Satellites to display (live or replay frame) ──────────────────────────
  // On the 2D map live satellites glide between telemetry frames (lib/satMotion); the globe has its own
  // smoother in world space (lib/motionSmoother). Replay frames are drawn as-is.
  const smooth = useSatMotion(liveSatellites, liveTimestamp, !replay && !is3d, live || isSimulationRunning,
    (512 * 2 ** mapState.zoom) / 360);
  const sats = useMemo<DisplaySat[]>(() => {
    const src = replay
      ? { ids: replay.satIds, positions: replay.satPositions, statuses: replay.satStatuses, fuels: replay.satFuels, length: replay.satIds.length }
      : liveSatellites;
    if (!src) return [];
    const pos = !replay && smooth ? smooth : src.positions;
    const out: DisplaySat[] = [];
    for (let i = 0; i < src.length; i++) {
      const id = src.ids[i];
      out.push({
        id, lon: pos[i * 3], lat: pos[i * 3 + 1],
        alt: (details[id]?.alt_km ?? DEFAULT_SAT_ALT_KM) * 1000,
        status: src.statuses[i], fuel: src.fuels[i],
      });
    }
    return out;
  }, [replay, liveSatellites, details, smooth]);

  const selected = useMemo(() => sats.find(s => s.id === selectedId) ?? null, [sats, selectedId]);

  // Camera moves on the 2D map fly instead of jumping. While a flight runs, follow waits for it.
  const flyingUntil = useRef(0);
  const flyTo = useCallback((target: Partial<MapViewState>, ms = 700) => {
    flyingUntil.current = performance.now() + ms;
    setMapState(v => ({ ...v, ...target, transitionDuration: ms, transitionInterpolator: FLY, transitionEasing: easeInOutCubic } as MapViewState));
  }, []);

  const following = follow && !!selected && !is3d;
  useEffect(() => {
    if (following && selected) flyTo({ longitude: selected.lon, latitude: selected.lat, zoom: Math.max(mapState.zoom, 2.5) }, 800);
  }, [following]);   // eslint-disable-line react-hooks/exhaustive-deps -- fly once when follow starts

  useEffect(() => {
    if (!following || !selected || performance.now() < flyingUntil.current) return;   // the globe follows inside EarthGlobe
    setMapState(v => ({ ...v, longitude: selected.lon, latitude: selected.lat }));
  }, [following, selected?.lon, selected?.lat]);

  useEffect(() => {
    if (!selectedId) setFollow(false);
  }, [selectedId]);

  const hasData = sats.length > 0;

  // ── Derived data (2D map) ──────────────────────────────────────────────────
  const night = useMemo(() => (timestamp && !is3d ? [nightPolygon(timestamp)] : []), [timestamp?.slice(0, 16), is3d]);

  const debrisLength = replay ? replay.debrisLength : liveDebris?.length ?? 0;

  // Which tracked objects are working satellites outside the fleet (the rest are debris). Replay frames
  // don't carry it: borrow the live flags while the object set is the same size.
  const debrisKinds = liveDebris?.kinds && liveDebris.length === debrisLength ? liveDebris.kinds : null;

  /** 2-D map: tracked objects split into debris and other satellites, drawn as separate layers. */
  const [debrisData, trackedSatData] = useMemo(() => {
    if (!debrisLength || is3d) return [null, null];
    let nSat = 0;
    if (debrisKinds) for (let i = 0; i < debrisLength; i++) nSat += debrisKinds[i];
    const deb = new Float32Array((debrisLength - nSat) * 2);
    const sat = new Float32Array(nSat * 2);
    for (let i = 0, d = 0, s = 0; i < debrisLength; i++) {
      const lon = replay ? replay.debrisPositions[i * 2] : liveDebris!.positions[i * 3];
      const lat = replay ? replay.debrisPositions[i * 2 + 1] : liveDebris!.positions[i * 3 + 1];
      if (debrisKinds?.[i]) { sat[s++] = lon; sat[s++] = lat; } else { deb[d++] = lon; deb[d++] = lat; }
    }
    const data = (out: Float32Array) => (out.length
      ? { length: out.length / 2, attributes: { getPosition: { value: out, size: 2 } } } : null);
    return [data(deb), data(sat)];
  }, [replay, liveDebris, debrisLength, debrisKinds, is3d]);

  const threatBySat = useMemo(() => {
    const m = new Map<string, string>();
    for (const [id, d] of Object.entries(details)) if (d.threat === 'CRITICAL' || d.threat === 'WARNING') m.set(id, d.threat);
    return m;
  }, [details]);

  // Full history for the selected satellite; only the recent segment for the rest to keep the view legible.
  const trailData = useMemo(() => {
    if (replay) return [];
    return Object.values(trails)
      .filter(t => t.positions.length > 1)
      .map(t => {
        const alt = (details[t.satelliteId]?.alt_km ?? DEFAULT_SAT_ALT_KM) * 1000;
        const points = t.satelliteId === selectedId ? t.positions : t.positions.slice(-UNSELECTED_TRAIL_POINTS);
        return { id: t.satelliteId, path: points.map(p => ({ lon: p[0], lat: p[1], alt })) };
      });
  }, [trails, selectedId, details, replay]);

  const predictedPath = useMemo(
    () => (selectedTrack && selectedTrack.length > 1 && !replay
      ? selectedTrack.map(p => ({ lon: p.lon, lat: p.lat, alt: p.alt_km * 1000 })) : null),
    [selectedTrack, replay]
  );

  // With a burn queued: the orbit it would fly without the burn (faint), and the post-burn part of the
  // predicted orbit (highlighted), so the change the burn makes is visible where it starts.
  const coastPath = useMemo(
    () => (selectedTrackCoast && selectedTrackBurns?.length && !replay
      ? selectedTrackCoast.map(p => ({ lon: p.lon, lat: p.lat, alt: p.alt_km * 1000 })) : null),
    [selectedTrackCoast, selectedTrackBurns, replay]
  );
  const postBurnPath = useMemo(() => {
    const first = selectedTrackBurns?.[0];
    if (!first || !selectedTrack || replay) return null;
    const pts = selectedTrack.filter(p => p.offset_s >= first.offset_s);
    return pts.length > 1 ? pts.map(p => ({ lon: p.lon, lat: p.lat, alt: p.alt_km * 1000 })) : null;
  }, [selectedTrack, selectedTrackBurns, replay]);

  // Pulsing rings on planned burns until they fire: HTML over the map, animated by CSS on the
  // compositor, so the pulse never makes the WebGL map redraw.
  const plannedBurns = useMemo(() => burnsPlanned(selectedTrackBurns, selectedId, replay), [selectedTrackBurns, selectedId, replay]);
  const pulsePoints = useMemo(() => {
    if (is3d || !plannedBurns.length || !size.width) return [];
    const vp = new WebMercatorViewport({ ...mapState, width: size.width, height: size.height });
    return plannedBurns.flatMap(b => [-360, 0, 360].map(shift => vp.project([b.lon + shift, b.lat])))
      .filter(([x, y]) => x >= -20 && y >= -20 && x <= size.width + 20 && y <= size.height + 20);
  }, [is3d, plannedBurns, mapState, size]);

  // Mission stations always; the reference networks when switched on (Ground stations page).
  const showReferenceStations = useLayoutStore(s => s.showReferenceStations);
  const labelledStations = useMemo<Station[]>(
    () => (showReferenceStations ? [...MISSION_STATIONS, ...REFERENCE_STATIONS] : MISSION_STATIONS),
    [showReferenceStations]);

  // A station picked on the Ground stations page: fly there.
  const focus = useLayoutStore(s => s.focus);
  useEffect(() => {
    if (!focus) return;
    setFollow(false);
    if (is3d) globeRef.current?.flyTo(focus.lon, focus.lat);
    else flyTo({ longitude: focus.lon, latitude: focus.lat, zoom: Math.max(mapState.zoom, 3) }, 1000);
    // only on a new request, not when the view changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  // Summary card next to the selected satellite (2-D map; the globe positions its own).
  const cardAnchor = useMemo(() => {
    if (is3d || !selected || !size.width) return null;
    const vp = new WebMercatorViewport({ ...mapState, width: size.width, height: size.height });
    for (const shift of [0, -360, 360]) {
      const [x, y] = vp.project([selected.lon + shift, selected.lat]);
      if (x >= 0 && y >= 0 && x <= size.width && y <= size.height) return cardPosition(x, y, size.width, size.height);
    }
    return null;
  }, [is3d, selected, mapState, size]);

  const visibleStations = useMemo(() => {
    if (!selected) return [];
    return GROUND_STATIONS.filter(gs =>
      elevationDeg(selected.lat, selected.lon, selected.alt / 1000, gs.coordinates[1], gs.coordinates[0]) >= gs.minElevationAngle
    );
  }, [selected?.lat, selected?.lon, selected?.alt]);

  // Executed burns (fleet-wide) plus the selected satellite's queued burns, placed where they fire on
  // its predicted (post-burn) track.
  const burns = useMemo<MapBurn[]>(() => [
    ...maneuvers
      .filter(m => m.status === 'executed' && Number.isFinite(m.lat) && Number.isFinite(m.lon))
      .map(m => ({ burn_id: m.burn_id, satellite_id: m.satellite_id, lon: m.lon!, lat: m.lat!, alt: 2000,
        dv_mps: m.delta_v_magnitude, planned: false })),
    ...(selectedId && !replay ? selectedTrackBurns ?? [] : []).map(b => ({ burn_id: b.burn_id, satellite_id: selectedId!,
      lon: b.lon, lat: b.lat, alt: b.alt_km * 1000, dv_mps: b.delta_v_mps, planned: true, t: b.t })),
  ], [maneuvers, selectedTrackBurns, selectedId, replay]);

  // ── Derived data (3D Earth) ────────────────────────────────────────────────
  const globeDebris = useMemo(() => {
    if (!debrisLength || !is3d) return null;
    if (!replay) return liveDebris ? { positions: liveDebris.positions, length: liveDebris.length, kinds: debrisKinds } : null;
    const out = new Float32Array(debrisLength * 3);
    const sameSet = liveDebris && liveDebris.length === debrisLength;
    for (let i = 0; i < debrisLength; i++) {
      out[i * 3] = replay.debrisPositions[i * 2];
      out[i * 3 + 1] = replay.debrisPositions[i * 2 + 1];
      out[i * 3 + 2] = sameSet ? liveDebris.positions[i * 3 + 2] : 700000;
    }
    return { positions: out, length: debrisLength, kinds: debrisKinds };
  }, [replay, liveDebris, debrisLength, debrisKinds, is3d]);

  const globeSats = useMemo<GlobeSatellite[]>(() => sats.map(s => ({
    id: s.id, lon: s.lon, lat: s.lat, alt: s.alt,
    color: statusColor(s.status),
    ring: threatBySat.has(s.id) ? (threatBySat.get(s.id) === 'CRITICAL' ? COLORS.crit : COLORS.warn) : null,
  })), [sats, threatBySat]);

  const globeStations = useMemo(() => [
    ...GROUND_STATIONS.map(gs => ({
      lon: gs.coordinates[0], lat: gs.coordinates[1], alt: 0,
      color: visibleStations.includes(gs) ? COLORS.ok : STATION_COLORS.mission,
    })),
    ...(showReferenceStations ? REFERENCE_STATIONS.map(st => ({ lon: st.lon, lat: st.lat, alt: 0, color: STATION_COLORS.reference })) : []),
  ], [visibleStations, showReferenceStations]);
  const contactStation = visibleStations[0] ? visibleStations[0].name.replace(/_/g, ' ') : null;
  const satelliteCard = selected && !replay ? (
    <SatelliteCard id={selected.id} altKm={selected.alt / 1000} fuelKg={selected.fuel} status={selected.status}
      contactStation={contactStation} />
  ) : null;

  const globeVisible = useMemo(
    () => visibleStations.map(gs => ({ lon: gs.coordinates[0], lat: gs.coordinates[1], alt: 0 })),
    [visibleStations]
  );

  const globeBurns = useMemo(
    () => burns.map(b => ({ lon: b.lon, lat: b.lat, alt: b.alt, color: b.planned ? COLORS.accent : undefined })), [burns]);

  // A whole-catalog fleet (thousands of satellites) would merge into one solid band at full size: shrink
  // the dots with fleet density and grow them back as the map zooms in.
  const zoom = mapState.zoom;
  const satStyle = useMemo(() => {
    const dense = sats.length > DENSE_FLEET;
    const radius = dense ? Math.min(5, Math.max(1.6, 1.6 * 2 ** ((zoom - 1.5) / 1.5))) : 5;
    return { radius, stroked: !dense || radius >= 4 };
  }, [sats.length, zoom]);

  // ── Layers (2D map) ────────────────────────────────────────────────────────
  const layers = useMemo(() => (is3d ? [] : [
    new PolygonLayer({
      id: 'night',
      data: night,
      getPolygon: (d: [number, number][]) => d,
      getFillColor: [0, 0, 0, 105],
      stroked: false,
    }),
    debrisData && new ScatterplotLayer({
      id: 'debris',
      data: debrisData,
      getFillColor: [148, 163, 184, 110],
      getRadius: 1,
      radiusUnits: 'pixels',
      radiusMinPixels: 1.1,
    }),
    trackedSatData && new ScatterplotLayer({
      id: 'tracked-satellites',
      data: trackedSatData,
      getFillColor: hexToRgba(OTHER_SAT_COLOR, 170),
      getRadius: 1.5,
      radiusUnits: 'pixels',
      radiusMinPixels: 1.5,
    }),
    new PathLayer({
      id: 'trails',
      data: trailData,
      getPath: (d: (typeof trailData)[number]) => d.path.map(p => [p.lon, p.lat] as Position),
      getColor: (d: { id: string }) => (d.id === selectedId ? hexToRgba(COLORS.accent, 230) : [56, 214, 245, 32]),
      getWidth: (d: { id: string }) => (d.id === selectedId ? 2.5 : 1),
      widthUnits: 'pixels',
      wrapLongitude: true,
      updateTriggers: { getColor: selectedId, getWidth: selectedId },
    }),
    new PathLayer({
      id: 'coast-orbit',
      data: coastPath ? [coastPath] : [],
      getPath: (d: NonNullable<typeof coastPath>) => d.map(p => [p.lon, p.lat] as Position),
      getColor: [154, 168, 182, 110],
      getWidth: 1.25,
      widthUnits: 'pixels',
      wrapLongitude: true,
      getDashArray: [2, 4],
      dashJustified: true,
      extensions: [DASH],
    } as any),
    new PathLayer({
      id: 'post-burn-orbit',
      data: postBurnPath ? [postBurnPath] : [],
      getPath: (d: NonNullable<typeof postBurnPath>) => d.map(p => [p.lon, p.lat] as Position),
      getColor: hexToRgba(COLORS.accent, 170),
      getWidth: 3,
      widthUnits: 'pixels',
      wrapLongitude: true,
    }),
    new PathLayer({
      id: 'predicted-orbit',
      data: predictedPath ? [predictedPath] : [],
      getPath: (d: NonNullable<typeof predictedPath>) => d.map(p => [p.lon, p.lat] as Position),
      getColor: [230, 237, 243, 200],
      getWidth: 1.5,
      widthUnits: 'pixels',
      wrapLongitude: true,
      getDashArray: [6, 5],
      dashJustified: true,
      extensions: [DASH],
    } as any),
    selected && new LineLayer({
      id: 'visibility',
      data: visibleStations,
      getSourcePosition: () => [selected.lon, selected.lat],
      getTargetPosition: (d: (typeof GROUND_STATIONS)[number]) => [d.coordinates[0], d.coordinates[1]],
      getColor: hexToRgba(COLORS.ok, 200),
      getWidth: 1.5,
      widthUnits: 'pixels',
    }),
    new ScatterplotLayer({
      id: 'ground-stations',
      data: GROUND_STATIONS,
      getPosition: (d: (typeof GROUND_STATIONS)[number]) => [d.coordinates[0], d.coordinates[1]],
      getFillColor: (d: (typeof GROUND_STATIONS)[number]) =>
        visibleStations.includes(d) ? hexToRgba(COLORS.ok) : [230, 237, 243, 230],
      getLineColor: [7, 9, 13, 255],
      stroked: true,
      lineWidthMinPixels: 1.5,
      getRadius: 4.5,
      radiusUnits: 'pixels',
      pickable: true,
      updateTriggers: { getFillColor: visibleStations },
    }),
    showReferenceStations && new ScatterplotLayer({
      id: 'reference-stations',
      data: REFERENCE_STATIONS,
      getPosition: (d: Station) => [d.lon, d.lat],
      getFillColor: hexToRgba(STATION_COLORS.reference, 230),
      getLineColor: [7, 9, 13, 255],
      stroked: true,
      lineWidthMinPixels: 1,
      getRadius: 3.5,
      radiusUnits: 'pixels',
      pickable: true,
    }),
    new TextLayer({
      id: 'station-labels',
      data: labelledStations,
      getPosition: (d: Station) => [d.lon, d.lat],
      getText: (d: Station) => d.name,
      getColor: (d: Station) => hexToRgba(STATION_COLORS[d.role], d.role === 'mission' ? 220 : 190),
      getSize: 11,
      getPixelOffset: [8, 0],
      getTextAnchor: 'start',
      getAlignmentBaseline: 'center',
      fontFamily: 'Inter, sans-serif',
      outlineWidth: 3,
      outlineColor: [7, 9, 13, 220],
      fontSettings: { sdf: true },
      characterSet: 'auto',
      // Overlapping labels are dropped, mission stations kept first.
      extensions: [COLLIDE],
      collisionEnabled: true,
      getCollisionPriority: (d: Station) => (d.role === 'mission' ? 1 : 0),
    }),
    new ScatterplotLayer({
      id: 'burns',
      data: burns,
      getPosition: (d: MapBurn) => [d.lon, d.lat],
      getFillColor: (d: MapBurn) => hexToRgba(d.planned ? COLORS.accent : COLORS.warn, 220),
      getLineColor: [7, 9, 13, 255],
      stroked: true,
      lineWidthMinPixels: 1,
      getRadius: (d: MapBurn) => (d.planned ? 5.5 : 3),
      radiusUnits: 'pixels',
      pickable: true,
    }),
    new ScatterplotLayer({
      id: 'threat-rings',
      data: sats.filter(s => threatBySat.has(s.id)),
      getPosition: (d: DisplaySat) => [d.lon, d.lat],
      getLineColor: (d: DisplaySat) => hexToRgba(threatBySat.get(d.id) === 'CRITICAL' ? COLORS.crit : COLORS.warn),
      filled: false,
      stroked: true,
      lineWidthMinPixels: 2,
      getRadius: 9,
      radiusUnits: 'pixels',
      updateTriggers: { getLineColor: threatBySat },
    }),
    new ScatterplotLayer({
      id: 'satellites',
      data: sats,
      getPosition: (d: DisplaySat) => [d.lon, d.lat],
      getFillColor: (d: DisplaySat) => SAT_RGBA[d.status] ?? SAT_RGBA.NOMINAL,
      getLineColor: [7, 9, 13, 255],
      stroked: satStyle.stroked,
      lineWidthMinPixels: 1.5,
      getRadius: satStyle.radius,
      radiusUnits: 'pixels',
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 90],
    }),
    selected && new ScatterplotLayer({
      id: 'selection-ring',
      data: [selected],
      getPosition: (d: DisplaySat) => [d.lon, d.lat],
      getLineColor: hexToRgba(COLORS.accent),
      stroked: true,
      filled: false,
      lineWidthMinPixels: 2,
      getRadius: 13,
      radiusUnits: 'pixels',
    }),
  ]), [is3d, night, debrisData, trackedSatData, trailData, predictedPath, coastPath, postBurnPath, selectedId, selected, visibleStations, burns, sats, threatBySat, satStyle, showReferenceStations, labelledStations]);

  // ── Interaction ────────────────────────────────────────────────────────────
  const onClick = useCallback((info: PickingInfo) => {
    if (info.layer?.id === 'satellites' && info.object) {
      const id = (info.object as DisplaySat).id;
      selectSatellite(id === selectedId ? null : id);
    } else if (!info.picked) {
      selectSatellite(null);
    }
  }, [selectedId, selectSatellite]);

  const tooltipHtml = useCallback((kind: string, object: unknown): string | null => {
    if (kind === 'satellites') {
      const s = object as DisplaySat;
      const meta = statusMeta(s.status);
      const d = details[s.id];
      const threat = d?.threat && d.threat !== 'WATCH' ? ` · <span style="color:${d.threat === 'CRITICAL' ? COLORS.crit : COLORS.warn}">${d.threat.toLowerCase()} threat</span>` : '';
      return `<b>${s.id}</b>${threat}<br/>Fuel ${s.fuel.toFixed(2)} kg · <span style="color:${meta.color}">${meta.label}</span><br/>` +
        `${s.lat.toFixed(2)}°, ${s.lon.toFixed(2)}° · ${(s.alt / 1000).toFixed(0)} km<br/><span style="color:#9aa8b6">Click to select</span>`;
    }
    if (kind === 'ground-stations') {
      const gs = object as (typeof GROUND_STATIONS)[number];
      return `<b>${gs.name.replace(/_/g, ' ')}</b><br/>${gs.id} · min elevation ${gs.minElevationAngle}°`;
    }
    if (kind === 'reference-stations') {
      const st = object as Station;
      return `<b>${st.name}</b><br/>${st.network} · ${st.country}<br/><span style="color:#9aa8b6">Reference only - not used for contact</span>`;
    }
    if (kind === 'burns') {
      const b = object as MapBurn;
      return b.planned
        ? `<b>Planned burn ${b.burn_id}</b><br/>${b.satellite_id} · Δv ${b.dv_mps.toFixed(2)} m/s<br/>` +
          `Fires ${formatUtcTime(b.t!)} UTC · ${(b.alt / 1000).toFixed(0)} km`
        : `<b>Burn ${b.burn_id}</b><br/>${b.satellite_id} · Δv ${b.dv_mps.toFixed(2)} m/s`;
    }
    return null;
  }, [details]);

  const getTooltip = useCallback((info: PickingInfo) => {
    const html = info.picked && info.object && info.layer ? tooltipHtml(info.layer.id, info.object) : null;
    return html ? {
      html,
      style: {
        background: '#0e131a', color: '#e6edf3', border: '1px solid #33404f', borderRadius: '8px',
        padding: '8px 10px', fontSize: '12px', fontFamily: 'Inter, sans-serif', lineHeight: '1.5',
      },
    } : null;
  }, [tooltipHtml]);

  const globeTooltip = useCallback((hit: PickHit) => {
    if (hit.kind === 'satellite') return sats[hit.index] ? tooltipHtml('satellites', sats[hit.index]) : null;
    if (hit.kind === 'station') {
      return hit.index < GROUND_STATIONS.length
        ? tooltipHtml('ground-stations', GROUND_STATIONS[hit.index])
        : tooltipHtml('reference-stations', REFERENCE_STATIONS[hit.index - GROUND_STATIONS.length]);
    }
    return burns[hit.index] ? tooltipHtml('burns', burns[hit.index]) : null;
  }, [sats, burns, tooltipHtml]);

  const onGlobeMove = useCallback(() => setFollow(false), []);

  const fit = () => {
    setFollow(false);
    if (is3d) { globeRef.current?.resetView(); return; }
    const el = containerRef.current;
    userMovedRef.current = false;
    if (el) flyTo(fitWorld(el.clientWidth, el.clientHeight));
  };

  const awaitingTelemetry = !hasData && connection.state !== 'error';
  // The backend already has a mission: telemetry is on its way (a whole-catalog first frame takes a few
  // seconds). Never offer "Load real satellites" then - it would replace that mission.
  const backendFleet = useOrbitalStore(s => s.realWorld?.satellites ?? 0);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-[#0a0d12] overflow-hidden">
      {is3d ? (
        <EarthGlobe
          ref={globeRef}
          timestamp={timestamp}
          satellites={globeSats}
          selectedId={selectedId}
          debris={globeDebris}
          trails={trailData}
          predicted={predictedPath}
          coast={coastPath}
          stations={globeStations}
          stationLabels={labelledStations}
          card={satelliteCard}
          visibleStations={globeVisible}
          burns={globeBurns}
          clouds={clouds}
          models={models}
          follow={follow}
          onSelect={selectSatellite}
          onUserMove={onGlobeMove}
          tooltip={globeTooltip}
        />
      ) : (
        <>
        <Basemap styleUrl={MAP_STYLE} view={mapState} />
        <DeckGL
          views={MAP_VIEW}
          viewState={mapState}
          onViewStateChange={({ viewState: vs, interactionState }) => {
            if (interactionState?.isDragging || interactionState?.isZooming || interactionState?.isPanning) {
              userMovedRef.current = true;
              setFollow(false);
            }
            setMapState(vs as MapViewState);
          }}
          controller={{ dragRotate: false, touchRotate: false, keyboard: true, inertia: 350, scrollZoom: { speed: 0.01, smooth: true } }}
          layers={layers}
          onClick={onClick}
          getTooltip={getTooltip}
          getCursor={({ isHovering, isDragging }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab')}
        />
        </>
      )}

      {/* Map tools */}
      <div className="absolute top-3 right-3 flex flex-wrap justify-end gap-2 max-w-[calc(100%-1.5rem)]">
        {selected && (
          <Button variant={follow ? 'primary' : 'secondary'} onClick={() => setFollow(f => !f)}
            icon={<Crosshair className="w-4 h-4" />} className="shadow-lg">
            {follow ? 'Following' : `Follow ${selected.id}`}
          </Button>
        )}
        <div className="flex rounded-md border border-line overflow-hidden shadow-lg bg-raised" role="radiogroup" aria-label="View mode">
          {([['3d', Globe2, '3D Earth'], ['2d', MapIcon, '2D map']] as const).map(([mode, Icon, label]) => (
            <button key={mode} role="radio" aria-checked={viewMode === mode} onClick={() => setViewMode(mode)}
              className={`flex items-center gap-1.5 px-3 h-8 text-[13px] transition-colors ${viewMode === mode ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'}`}>
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
        {is3d && (
          <Button variant={clouds ? 'primary' : 'secondary'} onClick={() => setClouds(c => !c)} aria-pressed={clouds}
            icon={<Cloud className="w-4 h-4" />} className="shadow-lg" title={clouds ? 'Hide cloud layer' : 'Show cloud layer'}>
            Clouds
          </Button>
        )}
        {is3d && (
          <Button variant={models ? 'primary' : 'secondary'} onClick={() => setModels(m => !m)} aria-pressed={models}
            icon={<Box className="w-4 h-4" />} className="shadow-lg" title={models ? 'Show satellites as dots' : 'Show satellites as 3D models'}>
            3D models
          </Button>
        )}
        <Button onClick={fit} icon={<Maximize2 className="w-4 h-4" />} className="shadow-lg" title={is3d ? 'Reset globe' : 'Fit whole world'}>
          {is3d ? 'Reset' : 'World'}
        </Button>
      </div>

      {pulsePoints.map(([x, y], i) => (
        <span key={i} aria-hidden className="absolute pointer-events-none w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-accent animate-burn-pulse"
          style={{ left: x, top: y }} />
      ))}

      {!replay && <NextBurnChip />}

      {cardAnchor && satelliteCard && (
        <div className="absolute z-20" style={cardAnchor}>{satelliteCard}</div>
      )}

      {/* Replay banner */}
      {replay && (
        <div className="absolute top-14 left-3 flex items-center gap-3 bg-warn/15 border border-warn/50 rounded-lg px-3 py-2 shadow-lg" role="status">
          <History className="w-4 h-4 text-warn" />
          <span className="text-[13px] text-ink">
            <span title={replay.predicted ? 'Satellites only (no debris), with every queued burn applied' : undefined}>
              {replay.predicted ? 'Predicted' : 'Replay'} · <span className="tabular">{formatUtcTime(replay.timestamp)}</span> UTC
            </span>
          </span>
          <Button variant="primary" className="h-7" onClick={() => setReplayIndex(null)}>Back to live</Button>
        </div>
      )}

      {/* Legend */}
      <div className="absolute left-3 bottom-3 bg-panel/90 border border-line rounded-lg px-3 py-2.5 text-[12px] text-muted grid grid-cols-2 gap-x-5 gap-y-1.5 shadow-lg">
        <LegendItem color={COLORS.sat} label="Satellite" />
        <LegendItem color={COLORS.crit} label="Threat / low fuel" shape="ring" />
        <LegendItem color="#94a3b8" label="Debris" />
        {trackedSatData && <LegendItem color={OTHER_SAT_COLOR} label="Other satellite" />}
        <LegendItem color={COLORS.warn} label="Executed burn" />
        <LegendItem color={COLORS.accent} label="Planned burn" />
        <LegendItem color="#e6edf3" label="Ground station" />
        <LegendItem color={COLORS.ok} label="In contact" shape="line" />
        <LegendItem color={COLORS.accent} label="Trail" shape="line" />
        <LegendItem color="#e6edf3" label="Predicted orbit" shape="dash" />
        {coastPath && <LegendItem color={COLORS.accent} label="After planned burn" shape="line" />}
        {coastPath && <LegendItem color="#9aa8b6" label="Without the burn" shape="dash" />}
      </div>

      {/* Empty state */}
      {awaitingTelemetry && backendFleet > 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" role="status">
          <div className="flex items-center gap-2.5 bg-panel/95 border border-line rounded-lg shadow-xl px-4 py-2.5 text-[13px] text-muted animate-fade-in">
            <Loader2 className="w-4 h-4 animate-spin text-accent" />
            Receiving telemetry for <span className="tabular text-ink">{backendFleet.toLocaleString()}</span> satellites…
          </div>
        </div>
      )}
      {awaitingTelemetry && backendFleet === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto bg-panel/95 border border-line rounded-xl shadow-2xl px-7 py-6 max-w-md text-center">
            <div className="w-11 h-11 mx-auto mb-3 rounded-full bg-accent/15 border border-accent/30 flex items-center justify-center">
              <SatelliteIcon className="w-5 h-5 text-accent" />
            </div>
            <h2 className="text-base font-semibold text-ink">Waiting for telemetry</h2>
            <p className="text-[13px] text-muted mt-1.5 leading-relaxed">
              Track real satellites in real time: ISRO Earth-observation satellites and the space stations,
              screened against real debris fields, from live NORAD element sets.
            </p>
            <div className="mt-4 flex gap-2 justify-center">
              <Button
                variant="primary"
                disabled={quickLoad.busy}
                icon={quickLoad.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudDownload className="w-4 h-4" />}
                onClick={async () => {
                  setQuickLoad({ busy: true, error: null });
                  try {
                    await loadCatalog(DEFAULT_CATALOG_REQUEST);
                    setQuickLoad({ busy: false, error: null });
                  } catch (err) {
                    setQuickLoad({ busy: false, error: err instanceof Error ? err.message : 'Load failed' });
                  }
                }}
              >
                {quickLoad.busy ? 'Fetching from CelesTrak…' : 'Load real satellites (live)'}
              </Button>
              <Button onClick={() => setDataSourcesOpen(true)}>Choose data…</Button>
            </div>
            {quickLoad.error && <p className="text-[12px] text-crit mt-2">{quickLoad.error}</p>}
            <p className="text-[13px] text-muted mt-4 leading-relaxed">Or run a simulated scenario from the project folder:</p>
            <div className="mt-4 space-y-2 text-left">
              {['./run.sh --demo', 'python3 scripts/demo.py', 'python3 test.py'].map(cmd => (
                <div key={cmd} className="flex items-center gap-2 bg-canvas border border-line rounded-md px-3 py-2">
                  <Terminal className="w-4 h-4 text-faint flex-shrink-0" />
                  <code className="tabular text-[13px] text-ink">{cmd}</code>
                </div>
              ))}
            </div>
            <p className="text-[12px] text-faint mt-3">The view updates automatically once data arrives.</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default DeckGLMap;
