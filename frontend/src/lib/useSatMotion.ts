// src/lib/useSatMotion.ts
// React binding for SatelliteMotion: feeds it every telemetry frame and re-renders on animation
// frames while satellites are moving, so the map and globe draw continuous motion.

import { useEffect, useRef, useState } from 'react';
import { SatelliteMotion, type MotionFrame } from './satMotion';

const HALF_PIXEL = 0.5;
const MIN_FRAME_MS = 15;   // ~display rate

/** Smoothed [lon, lat, alt] positions in `frame`'s order, or null when disabled. `running` = the
 *  simulation clock runs (always true in live mode); a paused clock never extrapolates.
 *  `pxPerDeg` = current map scale: frames are only drawn when the fastest satellite has moved about
 *  half a pixel, so a zoomed-out map (LEO moves ~0.2 px/s) costs nothing extra, while a zoomed-in or
 *  fast-forwarded one animates at up to the display rate. */
export function useSatMotion(frame: MotionFrame | null, timestamp: string | null, enabled: boolean, running: boolean,
  pxPerDeg = Infinity): Float32Array | null {
  const [reduced] = useState(() => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  enabled = enabled && !reduced;
  const motion = useRef<SatelliteMotion | null>(null);
  motion.current ??= new SatelliteMotion();
  const fed = useRef<MotionFrame | null>(null);
  const [, setTick] = useState(0);

  // Fed during render (not in an effect) so the positions returned below always match `frame`'s
  // order and length. The identity check makes a repeated render (StrictMode) a no-op.
  if (enabled && frame && timestamp && fed.current !== frame) {
    const ts = Date.parse(timestamp);
    if (Number.isFinite(ts)) {
      const now = performance.now();
      motion.current.ingest(frame, ts, now);
      if (!running) motion.current.pause(now);   // a manual step while paused must not start motion
      fed.current = frame;
    }
  }

  useEffect(() => {
    if (!running) motion.current!.pause(performance.now());
  }, [running]);

  const scale = useRef(pxPerDeg);
  scale.current = pxPerDeg;
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      const m = motion.current!;
      const pxPerSec = m.speedDegPerSec() * scale.current;
      // Under half a pixel per second the telemetry frames alone are smooth: draw nothing extra.
      const interval = pxPerSec < HALF_PIXEL ? Infinity : Math.max(MIN_FRAME_MS, (HALF_PIXEL / pxPerSec) * 1000);
      if (!document.hidden && m.animating(now) && now - last >= interval) {
        last = now;
        setTick(t => (t + 1) & 0xffff);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);

  if (!enabled || !frame || fed.current !== frame) return null;
  return motion.current.sample(performance.now()).slice();
}
