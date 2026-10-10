// src/lib/earth/globeMath.ts
// Scene-space geometry shared by the Earth renderer: 1 unit = 1 Earth radius, +Y = north pole,
// +X = lon 0°, −Z = lon 90°E.

import * as THREE from 'three';

export const R_EARTH_KM = 6371;
export const DEG = Math.PI / 180;

export function toVector(lon: number, lat: number, altM = 0, out = new THREE.Vector3()): THREE.Vector3 {
  const r = 1 + altM / 1000 / R_EARTH_KM;
  const la = lat * DEG;
  const lo = lon * DEG;
  return out.set(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}

/** sRGB CSS colour → linear RGBA components (matches the renderer's output colour management). */
export function linearRgba(css: string, alpha = 1): [number, number, number, number] {
  const c = new THREE.Color(css);
  return [c.r, c.g, c.b, alpha];
}
