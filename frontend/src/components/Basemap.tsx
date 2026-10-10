// src/components/Basemap.tsx
// Non-interactive MapLibre basemap drawn under the deck.gl 2D view. deck.gl owns the camera and
// interaction; this component only mirrors its view state (replaces react-map-gl, which does not
// support MapLibre 6).

import React, { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 runs tile parsing in an ES-module worker that imports a shared chunk; Vite bundles it
// (with its imports) as a worker and hands back its URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

maplibregl.setWorkerUrl(workerUrl);

export interface BasemapView {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing?: number;
  pitch?: number;
}

export const Basemap: React.FC<{ styleUrl: string; view: BasemapView }> = ({ styleUrl, view }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl,
      interactive: false,
      attributionControl: false,
      center: [view.longitude, view.latitude],
      zoom: view.zoom,
      renderWorldCopies: true,
    });
    mapRef.current = map;
    map.on('error', e => console.warn('[basemap]', e.error?.message ?? e));
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // The map is created once per style; camera changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl]);

  useEffect(() => {
    // deck.gl's WebMercator zoom matches MapLibre's 512-px tile zoom, so values carry over directly.
    mapRef.current?.jumpTo({
      center: [view.longitude, view.latitude],
      zoom: view.zoom,
      bearing: view.bearing ?? 0,
      pitch: view.pitch ?? 0,
    });
  }, [view.longitude, view.latitude, view.zoom, view.bearing, view.pitch]);

  // MapLibre's stylesheet makes its container `position: relative`, so position a wrapper instead.
  return (
    <div className="absolute inset-0" aria-hidden>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
};

export default Basemap;
