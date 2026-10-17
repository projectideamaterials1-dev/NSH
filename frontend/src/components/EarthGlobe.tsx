// src/components/EarthGlobe.tsx
// React wrapper around the photorealistic Three.js Earth (lib/earthScene): feeds it telemetry,
// handles hover/click picking, the selected-satellite label and texture loading state.

import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { EarthScene, type GlobePoint, type PickHit, type TextureQuality } from '../lib/earthScene';
import { subsolarPoint } from '../lib/geo';
import { STATION_COLORS, type Station } from '../lib/stations';
import { cardPosition } from './SatelliteCard';

export interface GlobeSatellite extends GlobePoint { id: string; color: string; ring: string | null }
export interface GlobeStation extends GlobePoint { color: string }

export interface EarthGlobeHandle {
  resetView: () => void;
  /** Turns the globe to centre on a point. */
  flyTo: (lon: number, lat: number) => void;
}

interface EarthGlobeProps {
  timestamp: string | null;
  satellites: GlobeSatellite[];
  selectedId: string | null;
  /** [lon, lat, alt m] triples. */
  debris: { positions: Float32Array; length: number; kinds?: Uint8Array | null } | null;
  trails: { id: string; path: GlobePoint[] }[];
  predicted: GlobePoint[] | null;
  /** The predicted orbit without the queued burns (shown only when a burn is queued). */
  coast?: GlobePoint[] | null;
  stations: GlobeStation[];
  /** Named stations to label on the globe. */
  stationLabels?: Station[];
  /** Summary card shown next to the selected satellite. */
  card?: ReactNode;
  visibleStations: GlobePoint[];
  burns: (GlobePoint & { color?: string })[];
  clouds: boolean;
  /** Draw satellites as 3D models. */
  models: boolean;
  follow: boolean;
  onSelect: (id: string | null) => void;
  onUserMove: () => void;
  tooltip: (hit: PickHit) => string | null;
}

const TEXTURE_BASE = `${import.meta.env.BASE_URL}textures/earth/`;

export const EarthGlobe = forwardRef<EarthGlobeHandle, EarthGlobeProps>((props, ref) => {
  const { timestamp, satellites, selectedId, debris, trails, predicted, coast = null, stations, visibleStations, burns, clouds, models, follow } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const stationLabelRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const sceneRef = useRef<EarthScene | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [quality, setQuality] = useState<TextureQuality>('loading');
  const [failure, setFailure] = useState<string | null>(null);
  const [detailImagery, setDetailImagery] = useState(false);

  const selected = selectedId ? satellites.find(s => s.id === selectedId) ?? null : null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // ── Scene lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let scene: EarthScene;
    try {
      scene = new EarthScene(host);
    } catch (err) {
      setFailure('WebGL is not available in this browser, so the 3D Earth cannot be displayed.');
      return;
    }
    sceneRef.current = scene;
    if (import.meta.env.DEV) (host as HTMLDivElement & { __scene?: EarthScene }).__scene = scene;   // inspection hook for dev / e2e
    const sun = subsolarPoint(propsRef.current.timestamp ?? new Date().toISOString());
    scene.resetView(sun.lon - 25, Math.max(-35, Math.min(35, sun.lat + 12)), false);
    scene.onUserInteract = () => propsRef.current.onUserMove();
    scene.onDetailImagery = setDetailImagery;
    scene.onFrame = () => {
      // Station labels: hidden behind the Earth, and where they would overlap a label already placed
      // (mission stations come first, so they win over nearby reference sites).
      const labels = propsRef.current.stationLabels ?? [];
      const placed: { x: number; y: number; w: number }[] = [];
      labels.forEach((st, i) => {
        const el = stationLabelRefs.current[i];
        if (!el) return;
        const p = scene.projectPoint({ lon: st.lon, lat: st.lat, alt: 0 });
        const x = p ? p.x + 8 : 0, y = p ? p.y - 7 : 0, w = el.offsetWidth;
        if (!p || placed.some(q => Math.abs(q.y - y) < 14 && x < q.x + q.w + 4 && q.x < x + w + 4)) {
          el.style.visibility = 'hidden';
          return;
        }
        placed.push({ x, y, w });
        el.style.visibility = 'visible';
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      });
      const label = labelRef.current;
      const sel = selectedRef.current;
      if (!label) return;
      const screen = sel ? scene.selectedScreenPosition() : null;   // follows the smoothed motion
      if (!screen) { label.style.visibility = 'hidden'; return; }
      label.style.visibility = 'visible';
      const { left, top } = cardPosition(screen.x, screen.y, host.clientWidth, host.clientHeight);
      label.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    };
    scene.loadTextures(TEXTURE_BASE, setQuality).catch(() => {
      setFailure('Earth imagery could not be loaded. Check that /textures/earth is being served.');
    });

    // Picking: hover tooltip, click to select (ignoring drags).
    const canvas = scene.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    let hoverFrame = 0;
    const local = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons) { hideTooltip(); return; }
      cancelAnimationFrame(hoverFrame);
      hoverFrame = requestAnimationFrame(() => {
        const { x, y } = local(e);
        const hit = scene.pick(x, y);
        const html = hit ? propsRef.current.tooltip(hit) : null;
        const tip = tooltipRef.current;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        if (!tip) return;
        if (!html) { hideTooltip(); return; }
        tip.innerHTML = html;
        tip.style.visibility = 'visible';
        const flip = x + 260 > host.clientWidth;
        tip.style.transform = `translate(${flip ? x - tip.offsetWidth - 14 : x + 14}px, ${y + 14}px)`;
      });
    };
    const hideTooltip = () => { if (tooltipRef.current) tooltipRef.current.style.visibility = 'hidden'; };
    const onDown = (e: PointerEvent) => { down = local(e); canvas.style.cursor = 'grabbing'; hideTooltip(); };
    const onUp = (e: PointerEvent) => {
      canvas.style.cursor = 'grab';
      if (!down) return;
      const { x, y } = local(e);
      const moved = Math.hypot(x - down.x, y - down.y);
      down = null;
      if (moved > 4) return;
      const hit = scene.pick(x, y);
      const { onSelect, selectedId: current, satellites: sats } = propsRef.current;
      if (hit?.kind === 'satellite') {
        const id = sats[hit.index]?.id ?? null;
        onSelect(id === current ? null : id);
      } else if (!hit) {
        onSelect(null);
      }
    };
    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', hideTooltip);

    return () => {
      cancelAnimationFrame(hoverFrame);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', hideTooltip);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    resetView: () => {
      const sun = subsolarPoint(propsRef.current.timestamp ?? new Date().toISOString());
      sceneRef.current?.resetView(sun.lon - 25, Math.max(-35, Math.min(35, sun.lat + 12)));
    },
    flyTo: (lon, lat) => sceneRef.current?.resetView(lon, lat),
  }), []);

  // ── Data → scene ───────────────────────────────────────────────────────────
  const minute = timestamp?.slice(0, 16) ?? null;
  useEffect(() => { sceneRef.current?.setSun(timestamp); }, [minute]);

  useEffect(() => {
    sceneRef.current?.setSatellites(satellites, selectedId ? satellites.findIndex(s => s.id === selectedId) : -1);
  }, [satellites, selectedId]);

  useEffect(() => { sceneRef.current?.setDebris(debris?.positions ?? null, debris?.length ?? 0, debris?.kinds ?? null); }, [debris]);

  useEffect(() => {
    sceneRef.current?.setTrails(
      trails.filter(t => t.id !== selectedId).map(t => t.path),
      trails.find(t => t.id === selectedId)?.path ?? null,
    );
  }, [trails, selectedId]);

  useEffect(() => { sceneRef.current?.setPredicted(predicted, coast); }, [predicted, coast]);
  useEffect(() => { sceneRef.current?.setStations(stations); }, [stations]);
  useEffect(() => { sceneRef.current?.setVisibility(selected, visibleStations); }, [selected?.lon, selected?.lat, selected?.alt, visibleStations]);
  useEffect(() => { sceneRef.current?.setBurns(burns); }, [burns]);
  useEffect(() => { sceneRef.current?.setCloudsVisible(clouds); }, [clouds]);
  useEffect(() => { sceneRef.current?.setModelsVisible(models); }, [models]);
  const selectedModel = models && selectedId ? sceneRef.current?.modelInfo(selectedId) ?? null : null;
  useEffect(() => { sceneRef.current?.setFollow(follow ? selected : null); }, [follow, selected?.lon, selected?.lat, selected?.alt]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-[#010204]">
      <div ref={hostRef} className="absolute inset-0" data-testid="earth-globe" />

      {(props.stationLabels ?? []).map((st, i) => (
        <span key={st.id} ref={el => { stationLabelRefs.current[i] = el; }} aria-hidden
          className="absolute left-0 top-0 pointer-events-none text-[11px] font-medium whitespace-nowrap"
          style={{ visibility: 'hidden', color: STATION_COLORS[st.role], textShadow: '0 0 3px #000, 0 0 3px #000' }}>
          {st.name}
        </span>
      ))}

      <div ref={labelRef} className="absolute left-0 top-0 z-20 pointer-events-none" style={{ visibility: 'hidden' }}>
        {selected && (props.card ?? (
          <div className="px-2 py-0.5 rounded bg-panel/85 border border-accent/60 text-[12px] font-medium text-ink tabular whitespace-nowrap shadow-lg">
            {selected.id} · {(selected.alt / 1000).toFixed(0)} km
          </div>
        ))}
      </div>

      <div
        ref={tooltipRef}
        className="absolute left-0 top-0 pointer-events-none max-w-[260px]"
        style={{
          visibility: 'hidden', background: '#0e131a', color: '#e6edf3', border: '1px solid #33404f', borderRadius: 8,
          padding: '8px 10px', fontSize: 12, lineHeight: 1.5, boxShadow: '0 8px 24px rgba(0,0,0,.45)',
        }}
      />

      <div className="absolute bottom-3 right-3 flex flex-col items-end gap-1.5 pointer-events-none">
        {quality === 'loading' && !failure && (
          <div className="flex items-center gap-2 bg-panel/90 border border-line rounded-md px-3 py-1.5 text-[12px] text-muted shadow-lg">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading Earth imagery…
          </div>
        )}
        {models && (
          <div className="text-[10px] text-white/45 [text-shadow:0_1px_2px_#000] text-right">
            {selectedModel
              ? `3D model: ${selectedModel.title}${selectedModel.exact ? '' : ' (representative)'} · ${selectedModel.credit ?? 'illustrative model'}`
              : '3D models: NASA 3D Resources · others illustrative · not to scale'}
          </div>
        )}
        <div className="text-[10px] text-white/45 [text-shadow:0_1px_2px_#000]">
          {detailImagery
            ? 'Imagery © Esri, Maxar, Earthstar Geographics · Terrain: AWS Terrain Tiles'
            : 'Imagery: NASA Blue Marble & Black Marble · Relief: GEBCO'}
        </div>
      </div>

      {failure && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-2 bg-panel/95 border border-line rounded-lg px-4 py-3 text-[13px] text-muted shadow-2xl max-w-sm">
            <AlertTriangle className="w-4 h-4 text-warn flex-shrink-0" /> {failure}
          </div>
        </div>
      )}
    </div>
  );
});

EarthGlobe.displayName = 'EarthGlobe';
export default EarthGlobe;
