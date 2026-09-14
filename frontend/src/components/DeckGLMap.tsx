// src/components/DeckGLMap.tsx
// Orbital view: photorealistic 3D Earth (Three.js, see EarthGlobe) or 2D ground-track map (deck.gl +
// MapLibre dark basemap). Both show the debris cloud, satellites (real altitude in 3D), threat rings,
// trails, predicted orbit, ground-station visibility lines, executed burns and replay frames.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import type { MapViewState, PickingInfo, Position } from '@deck.gl/core';
import { LineLayer, PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import { Map as MapGL } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Cloud, CloudDownload, Crosshair, Globe2, History, Loader2, Map as MapIcon, Maximize2, Satellite as SatelliteIcon, Terminal } from 'lucide-react';

import useOrbitalStore, { DEFAULT_CATALOG_REQUEST, selectReplayFrame } from '../store/useOrbitalStore';
import { GROUND_STATIONS } from '../lib/constants';
import { COLORS, formatUtcTime, statusMeta } from '../lib/format';
import { elevationDeg, nightPolygon } from '../lib/geo';
import type { PickHit } from '../lib/earthScene';
import { EarthGlobe, type EarthGlobeHandle, type GlobeSatellite } from './EarthGlobe';
import { Button } from './ui';

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';
const MAP_VIEW = new MapView({ id: 'map', repeat: true });
const DEFAULT_SAT_ALT_KM = 550; // used until /api/satellites reports the real altitude
const UNSELECTED_TRAIL_POINTS = 6;
const DASH = new PathStyleExtension({ dash: true });

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

interface DisplaySat { id: string; lon: number; lat: number; alt: number; status: string; fuel: number }

export const DeckGLMap: React.FC = () => {
  const liveDebris = useOrbitalStore(s => s.debris);
  const liveSatellites = useOrbitalStore(s => s.satellites);
  const liveTimestamp = useOrbitalStore(s => s.timestamp);
  const trails = useOrbitalStore(s => s.trails);
  const maneuvers = useOrbitalStore(s => s.maneuvers);
  const connection = useOrbitalStore(s => s.connectionStatus);
  const details = useOrbitalStore(s => s.satelliteDetails);
  const selectedTrack = useOrbitalStore(s => s.selectedTrack);
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
  const [clouds, setClouds] = useState(true);
  const globeRef = useRef<EarthGlobeHandle>(null);
  const userMovedRef = useRef(false);
  const is3d = viewMode === '3d';

  // Fit the 2D world map to the available space until the user pans/zooms (the globe fits itself).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!userMovedRef.current) setMapState(fitWorld(width, height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const timestamp = replay?.timestamp ?? liveTimestamp;

  // ── Satellites to display (live or replay frame) ──────────────────────────
  const sats = useMemo<DisplaySat[]>(() => {
    const src = replay
      ? { ids: replay.satIds, positions: replay.satPositions, statuses: replay.satStatuses, fuels: replay.satFuels, length: replay.satIds.length }
      : liveSatellites;
    if (!src) return [];
    const out: DisplaySat[] = [];
    for (let i = 0; i < src.length; i++) {
      const id = src.ids[i];
      out.push({
        id, lon: src.positions[i * 3], lat: src.positions[i * 3 + 1],
        alt: (details[id]?.alt_km ?? DEFAULT_SAT_ALT_KM) * 1000,
        status: src.statuses[i], fuel: src.fuels[i],
      });
    }
    return out;
  }, [replay, liveSatellites, details]);

  const selected = useMemo(() => sats.find(s => s.id === selectedId) ?? null, [sats, selectedId]);

  useEffect(() => {
    if (!follow || !selected || is3d) return;   // the globe follows inside EarthGlobe
    setMapState(v => ({ ...v, longitude: selected.lon, latitude: selected.lat }));
  }, [follow, selected?.lon, selected?.lat, is3d]);

  useEffect(() => {
    if (!selectedId) setFollow(false);
  }, [selectedId]);

  const hasData = sats.length > 0;

  // ── Derived data (2D map) ──────────────────────────────────────────────────
  const night = useMemo(() => (timestamp && !is3d ? [nightPolygon(timestamp)] : []), [timestamp?.slice(0, 16), is3d]);

  const debrisLength = replay ? replay.debrisLength : liveDebris?.length ?? 0;

  const debrisData = useMemo(() => {
    if (!debrisLength || is3d) return null;
    const out = new Float32Array(debrisLength * 2);
    for (let i = 0; i < debrisLength; i++) {
      out[i * 2] = replay ? replay.debrisPositions[i * 2] : liveDebris!.positions[i * 3];
      out[i * 2 + 1] = replay ? replay.debrisPositions[i * 2 + 1] : liveDebris!.positions[i * 3 + 1];
    }
    return { length: debrisLength, attributes: { getPosition: { value: out, size: 2 } } };
  }, [replay, liveDebris, debrisLength, is3d]);

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

  const visibleStations = useMemo(() => {
    if (!selected) return [];
    return GROUND_STATIONS.filter(gs =>
      elevationDeg(selected.lat, selected.lon, selected.alt / 1000, gs.coordinates[1], gs.coordinates[0]) >= gs.minElevationAngle
    );
  }, [selected?.lat, selected?.lon, selected?.alt]);

  const burns = useMemo(
    () => maneuvers.filter(m => m.status === 'executed' && Number.isFinite(m.lat) && Number.isFinite(m.lon)),
    [maneuvers]
  );

  // ── Derived data (3D Earth) ────────────────────────────────────────────────
  const globeDebris = useMemo(() => {
    if (!debrisLength || !is3d) return null;
    if (!replay) return liveDebris ? { positions: liveDebris.positions, length: liveDebris.length } : null;
    const out = new Float32Array(debrisLength * 3);
    const sameSet = liveDebris && liveDebris.length === debrisLength;
    for (let i = 0; i < debrisLength; i++) {
      out[i * 3] = replay.debrisPositions[i * 2];
      out[i * 3 + 1] = replay.debrisPositions[i * 2 + 1];
      out[i * 3 + 2] = sameSet ? liveDebris.positions[i * 3 + 2] : 700000;
    }
    return { positions: out, length: debrisLength };
  }, [replay, liveDebris, debrisLength, is3d]);

  const globeSats = useMemo<GlobeSatellite[]>(() => sats.map(s => ({
    id: s.id, lon: s.lon, lat: s.lat, alt: s.alt,
    color: statusColor(s.status),
    ring: threatBySat.has(s.id) ? (threatBySat.get(s.id) === 'CRITICAL' ? COLORS.crit : COLORS.warn) : null,
  })), [sats, threatBySat]);

  const globeStations = useMemo(() => GROUND_STATIONS.map(gs => ({
    lon: gs.coordinates[0], lat: gs.coordinates[1], alt: 0,
    color: visibleStations.includes(gs) ? COLORS.ok : '#e6edf3',
  })), [visibleStations]);

  const globeVisible = useMemo(
    () => visibleStations.map(gs => ({ lon: gs.coordinates[0], lat: gs.coordinates[1], alt: 0 })),
    [visibleStations]
  );

  const globeBurns = useMemo(() => burns.map(b => ({ lon: b.lon!, lat: b.lat!, alt: 2000 })), [burns]);

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
    new ScatterplotLayer({
      id: 'burns',
      data: burns,
      getPosition: (d: (typeof burns)[number]) => [d.lon!, d.lat!],
      getFillColor: hexToRgba(COLORS.warn, 220),
      getRadius: 3,
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
      stroked: true,
      lineWidthMinPixels: 1.5,
      getRadius: 5,
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
  ]), [is3d, night, debrisData, trailData, predictedPath, selectedId, selected, visibleStations, burns, sats, threatBySat]);

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
    if (kind === 'burns') {
      const b = object as (typeof burns)[number];
      return `<b>Burn ${b.burn_id}</b><br/>${b.satellite_id} · Δv ${b.delta_v_magnitude.toFixed(2)} m/s`;
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
    if (hit.kind === 'station') return tooltipHtml('ground-stations', GROUND_STATIONS[hit.index]);
    return burns[hit.index] ? tooltipHtml('burns', burns[hit.index]) : null;
  }, [sats, burns, tooltipHtml]);

  const onGlobeMove = useCallback(() => setFollow(false), []);

  const fit = () => {
    setFollow(false);
    if (is3d) { globeRef.current?.resetView(); return; }
    const el = containerRef.current;
    userMovedRef.current = false;
    if (el) setMapState(fitWorld(el.clientWidth, el.clientHeight));
  };

  const awaitingTelemetry = !hasData && connection.state !== 'error';

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
          stations={globeStations}
          visibleStations={globeVisible}
          burns={globeBurns}
          clouds={clouds}
          follow={follow}
          onSelect={selectSatellite}
          onUserMove={onGlobeMove}
          tooltip={globeTooltip}
        />
      ) : (
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
          controller={{ dragRotate: false, touchRotate: false, keyboard: true }}
          layers={layers}
          onClick={onClick}
          getTooltip={getTooltip}
          getCursor={({ isHovering, isDragging }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab')}
        >
          <MapGL mapStyle={MAP_STYLE} reuseMaps attributionControl={false} />
        </DeckGL>
      )}

      {/* Map tools */}
      <div className="absolute top-3 right-3 flex gap-2">
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
        <Button onClick={fit} icon={<Maximize2 className="w-4 h-4" />} className="shadow-lg" title={is3d ? 'Reset globe' : 'Fit whole world'}>
          {is3d ? 'Reset' : 'World'}
        </Button>
      </div>

      {/* Replay banner */}
      {replay && (
        <div className="absolute top-3 left-3 flex items-center gap-3 bg-warn/15 border border-warn/50 rounded-lg px-3 py-2 shadow-lg">
          <History className="w-4 h-4 text-warn" />
          <span className="text-[13px] text-ink">Replay · <span className="tabular">{formatUtcTime(replay.timestamp)}</span> UTC</span>
          <Button variant="primary" className="h-7" onClick={() => setReplayIndex(null)}>Back to live</Button>
        </div>
      )}

      {/* Legend */}
      <div className="absolute left-3 bottom-3 bg-panel/90 border border-line rounded-lg px-3 py-2.5 text-[12px] text-muted grid grid-cols-2 gap-x-5 gap-y-1.5 shadow-lg">
        <LegendItem color={COLORS.sat} label="Satellite" />
        <LegendItem color={COLORS.crit} label="Threat / low fuel" shape="ring" />
        <LegendItem color="#94a3b8" label="Debris" />
        <LegendItem color={COLORS.warn} label="Executed burn" />
        <LegendItem color="#e6edf3" label="Ground station" />
        <LegendItem color={COLORS.ok} label="In contact" shape="line" />
        <LegendItem color={COLORS.accent} label="Trail" shape="line" />
        <LegendItem color="#e6edf3" label="Predicted orbit" shape="dash" />
      </div>

      {/* Empty state */}
      {awaitingTelemetry && (
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
