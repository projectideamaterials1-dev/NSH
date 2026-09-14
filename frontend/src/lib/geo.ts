// src/lib/geo.ts
// Lightweight geodesy helpers for the map and panels (display-level accuracy).

import type { DebrisBinaryData } from '../store/useOrbitalStore';

const DEG = Math.PI / 180;
const R_EARTH_KM = 6371;

export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial great-circle bearing from point 1 to point 2, degrees clockwise from north. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG);
  const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) - Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Elevation angle (deg) of a satellite seen from a ground station (spherical Earth). */
export function elevationDeg(satLat: number, satLon: number, satAltKm: number, gsLat: number, gsLon: number): number {
  const central = greatCircleKm(satLat, satLon, gsLat, gsLon) / R_EARTH_KM;
  if (central < 1e-9) return 90;
  const ratio = R_EARTH_KM / (R_EARTH_KM + satAltKm);
  return Math.atan((Math.cos(central) - ratio) / Math.sin(central)) / DEG;
}

/** Sub-solar point for a UTC timestamp (NOAA low-precision formulae). */
export function subsolarPoint(timestamp: string): { lat: number; lon: number } {
  const date = new Date(timestamp);
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const epsilon = (23.439 - 0.0000004 * n) * DEG;
  const decl = Math.asin(Math.sin(epsilon) * Math.sin(lambda)) / DEG;
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda)) / DEG;
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra - gmst;
  lon = ((lon + 540) % 360) - 180;
  return { lat: decl, lon };
}

/** Night-side polygon (lon/lat ring) for the day/night terminator overlay. */
export function nightPolygon(timestamp: string): [number, number][] {
  const sun = subsolarPoint(timestamp);
  // Avoid the singularity exactly at the equinox.
  const decl = Math.abs(sun.lat) < 0.05 ? (sun.lat >= 0 ? 0.05 : -0.05) : sun.lat;
  const tanDecl = Math.tan(decl * DEG);
  const ring: [number, number][] = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const lat = Math.atan(-Math.cos((lon - sun.lon) * DEG) / tanDecl) / DEG;
    ring.push([lon, lat]);
  }
  const darkPole = decl > 0 ? -90 : 90;
  ring.push([180, darkPole], [-180, darkPole]);
  return ring;
}

export interface ProximityEntry {
  debrisId: string;
  distanceKm: number;
  bearing: number;
  altitudeKm: number;
}

/** Debris within `radiusKm` ground distance of a point, nearest first. */
export function nearbyDebris(lat: number, lon: number, debris: DebrisBinaryData | null, radiusKm: number, limit = 40): ProximityEntry[] {
  if (!debris || debris.length === 0) return [];
  const latWindow = radiusKm / 111 + 0.5;
  const out: ProximityEntry[] = [];
  for (let i = 0; i < debris.length; i++) {
    const dLat = debris.positions[i * 3 + 1];
    if (Math.abs(dLat - lat) > latWindow) continue;
    const dLon = debris.positions[i * 3];
    const dist = greatCircleKm(lat, lon, dLat, dLon);
    if (dist > radiusKm) continue;
    out.push({
      debrisId: debris.ids[i],
      distanceKm: dist,
      bearing: bearingDeg(lat, lon, dLat, dLon),
      altitudeKm: debris.positions[i * 3 + 2] / 1000,
    });
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit);
}
