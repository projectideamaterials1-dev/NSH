// src/lib/earthScene.ts
// Photorealistic Earth renderer (Three.js, no React): NASA Blue Marble day imagery, Black Marble city
// lights, GEBCO terrain relief, ocean sun glint, clouds, atmospheric scattering and a starfield, lit by
// the real sun position. Orbital objects are drawn at their true altitude in an Earth-fixed frame
// (1 scene unit = 1 Earth radius; +Y = north pole, +X = lon 0°, −Z = lon 90°E).
// Zooming in streams high-resolution satellite imagery (Esri World Imagery) and terrain relief
// (AWS Terrain Tiles) on top of the bundled 8K base; offline, the base imagery is used alone.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { subsolarPoint } from './geo';

const R_EARTH_KM = 6371;
const DEG = Math.PI / 180;
const FOV = 38;
const MIN_DISTANCE = 1.006;   // ~38 km above the surface
const MAX_DISTANCE = 18;

export interface GlobePoint { lon: number; lat: number; alt: number }   // alt in metres
export type PickKind = 'satellite' | 'station' | 'burn';
export interface PickHit { kind: PickKind; index: number }
export type TextureQuality = 'loading' | 'standard' | 'high';

const IMAGERY_TILE_URL = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const TERRAIN_TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const MIN_TILE_ZOOM = 6;         // the 8K base texture matches zoom 5
const MAX_TILE_ZOOM = 13;
const MAX_TILES_IN_VIEW = 64;
const MAX_CACHED_TILES = 220;
const MAX_CONCURRENT_LOADS = 8;
const TILE_RELIEF_EXAGGERATION = 2.2;
const MERCATOR_MAX_LAT = 85.0511;

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

// ── Shaders ──────────────────────────────────────────────────────────────────

const SURFACE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vPos;
void main() {
  vUv = uv;
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const EARTH_FRAG = /* glsl */ `
uniform sampler2D dayMap;
uniform sampler2D nightMap;
uniform sampler2D normalMap;
uniform sampler2D waterMap;
uniform sampler2D cloudMap;
uniform vec3 sunDir;
uniform float cloudShadow;
varying vec2 vUv;
varying vec3 vPos;
#ifdef TILE
uniform sampler2D tileNormalMap;
uniform float tileNormal;
uniform float opacity;
varying vec2 vTileUv;
#endif

void main() {
  vec3 N = normalize(vPos);
  vec3 east = vec3(N.z, 0.0, -N.x);
  east = length(east) < 1e-4 ? vec3(0.0, 0.0, -1.0) : normalize(east);
  vec3 north = cross(N, east);
#ifdef TILE
  vec3 tn = (tileNormal > 0.5 ? texture2D(tileNormalMap, vTileUv).xyz : texture2D(normalMap, vUv).xyz) * 2.0 - 1.0;
  vec3 day = texture2D(dayMap, vTileUv).rgb;
#else
  vec3 tn = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
  vec3 day = texture2D(dayMap, vUv).rgb;
#endif
  float water = texture2D(waterMap, vUv).r;
  vec3 Nb = normalize(mix(tn.x * east + tn.y * north + tn.z * N, N, water));

  vec3 V = normalize(cameraPosition - vPos);
  float cosSun = dot(N, sunDir);
  float cloud = texture2D(cloudMap, vUv).r;

  // Day side: imagery with terrain relief, cloud shadows and warm twilight near the terminator.
  day *= 1.0 - cloudShadow * smoothstep(0.2, 0.9, cloud) * 0.45;
  float diffuse = max(dot(Nb, sunDir), 0.0);
  float relief = mix(1.0, clamp(diffuse / max(cosSun, 0.08), 0.35, 1.8), 0.85);
  float light = smoothstep(-0.08, 0.35, cosSun) * relief;
  vec3 twilight = mix(vec3(1.0, 0.55, 0.32), vec3(1.0), smoothstep(0.0, 0.3, cosSun));
  vec3 color = day * light * twilight * 1.35;

  // Ocean sun glint.
  vec3 H = normalize(sunDir + V);
  float nh = max(dot(N, H), 0.0);
  float glint = (pow(nh, 900.0) * 0.55 + pow(nh, 70.0) * 0.06) * smoothstep(0.6, 0.95, water) * smoothstep(-0.02, 0.15, cosSun);
  color += mix(vec3(0.55, 0.62, 0.7), vec3(1.0, 0.95, 0.85), glint) * glint * (1.0 - cloud * cloudShadow * 0.8);

  // Night side: city lights fade in past the terminator.
  vec3 night = texture2D(nightMap, vUv).rgb;
  float dark = 1.0 - smoothstep(-0.18, 0.06, cosSun);
  color += pow(night, vec3(1.25)) * vec3(1.0, 0.82, 0.56) * 2.4 * dark * (1.0 - smoothstep(0.3, 0.9, cloud) * 0.7);
  color += day * 0.018 * (1.0 - light);   // faint earthshine

  // Rayleigh-like haze toward the limb on the lit hemisphere.
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.5);
  vec3 sky = mix(vec3(0.85, 0.5, 0.35), vec3(0.32, 0.6, 1.0), smoothstep(-0.12, 0.1, cosSun));
  color = mix(color, sky, fres * smoothstep(-0.15, 0.35, cosSun) * 0.6);

#ifdef TILE
  gl_FragColor = vec4(color, opacity);
#else
  gl_FragColor = vec4(color, 1.0);
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const CLOUD_FRAG = /* glsl */ `
uniform sampler2D cloudMap;
uniform vec3 sunDir;
uniform float opacity;
varying vec2 vUv;
varying vec3 vPos;
void main() {
  vec3 N = normalize(vPos);
  float c = smoothstep(0.18, 0.95, texture2D(cloudMap, vUv).r);
  float cosSun = dot(N, sunDir);
  float lit = smoothstep(-0.12, 0.3, cosSun);
  vec3 tint = mix(vec3(1.0, 0.6, 0.4), vec3(1.0), smoothstep(0.0, 0.3, cosSun));
  vec3 color = tint * (0.04 + 0.96 * lit);
  gl_FragColor = vec4(color, c * opacity * mix(0.12, 0.92, lit));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const ATMOSPHERE_RADIUS = 1.035;
const ATMOSPHERE_FRAG = /* glsl */ `
uniform vec3 sunDir;
varying vec3 vPos;
void main() {
  vec3 N = normalize(vPos);
  vec3 V = normalize(cameraPosition - vPos);
  float limb = sqrt(${(ATMOSPHERE_RADIUS ** 2 - 1).toFixed(6)}) / ${ATMOSPHERE_RADIUS.toFixed(3)};
  float t = clamp(-dot(N, V) / limb, 0.0, 1.0);
  float glow = pow(t, 2.2) * (1.0 - smoothstep(0.92, 1.0, t) * 0.35);
  float cosSun = dot(N, sunDir);
  vec3 col = mix(vec3(0.9, 0.5, 0.3), vec3(0.3, 0.58, 1.0), smoothstep(-0.15, 0.1, cosSun));
  float intensity = 1.25 * smoothstep(-0.22, 0.3, cosSun);
  gl_FragColor = vec4(col * glow * intensity, 1.0);
  #include <colorspace_fragment>
}`;

const TILE_VERT = /* glsl */ `
attribute vec2 tileUv;
varying vec2 vUv;
varying vec2 vTileUv;
varying vec3 vPos;
void main() {
  vUv = uv;
  vTileUv = tileUv;
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const POINT_VERT = /* glsl */ `
attribute vec4 aColor;
attribute float aSize;
uniform float pixelRatio;
uniform float farPlane;
varying vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  if (farPlane > 0.5) gl_Position.z = gl_Position.w * 0.99999;
  gl_PointSize = aSize * pixelRatio;
}`;

// shape 0: filled marker with dark outline and halo · 1: ring · 2: soft dot
const POINT_FRAG = /* glsl */ `
uniform int shape;
varying vec4 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float aa = fwidth(r) * 1.2;
  vec4 c;
  if (shape == 0) {
    float core = 1.0 - smoothstep(0.42 - aa, 0.42 + aa, r);
    float outline = 1.0 - smoothstep(0.56 - aa, 0.56 + aa, r);
    float halo = (1.0 - smoothstep(0.56, 1.0, r)) * 0.35;
    vec3 rgb = mix(vec3(0.02, 0.03, 0.05), vColor.rgb, core);
    c = vec4(mix(vColor.rgb, rgb, outline), max(outline, halo) * vColor.a);
  } else if (shape == 1) {
    float ring = smoothstep(0.72 - aa, 0.72 + aa, r) * (1.0 - smoothstep(0.92 - aa, 0.92 + aa, r));
    c = vec4(vColor.rgb, ring * vColor.a);
  } else {
    c = vec4(vColor.rgb, (1.0 - smoothstep(0.2, 1.0, r)) * vColor.a);
  }
  if (c.a < 0.01) discard;
  gl_FragColor = c;
  #include <colorspace_fragment>
}`;

// ── Helpers ──────────────────────────────────────────────────────────────────

class PointLayer {
  readonly points: THREE.Points;
  private capacity = 0;

  constructor(shape: 0 | 1 | 2, renderOrder: number, opts: { far?: boolean; depthTest?: boolean } = {}) {
    const material = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: { shape: { value: shape }, pixelRatio: { value: 1 }, farPlane: { value: opts.far ? 1 : 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: opts.depthTest ?? true,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
  }

  /** Writes `count` points; `fill` receives the index and the typed-array offsets to write into. */
  update(count: number, fill: (i: number, pos: Float32Array, col: Float32Array, size: Float32Array) => void) {
    let geometry = this.points.geometry;
    if (count > this.capacity) {
      geometry.dispose();
      this.capacity = Math.max(count, Math.ceil(this.capacity * 1.5), 16);
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3));
      geometry.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(this.capacity * 4), 4));
      geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(this.capacity), 1));
      this.points.geometry = geometry;
    }
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = geometry.getAttribute('aColor') as THREE.BufferAttribute;
    const size = geometry.getAttribute('aSize') as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) fill(i, pos.array as Float32Array, col.array as Float32Array, size.array as Float32Array);
    if (count > 0) {
      pos.needsUpdate = col.needsUpdate = size.needsUpdate = true;
    }
    geometry.setDrawRange(0, count);
  }

  setPixelRatio(ratio: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.pixelRatio.value = ratio;
  }

  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

const placeholderTexture = (rgb: [number, number, number]) => {
  const t = new THREE.DataTexture(new Uint8Array([...rgb, 255]), 1, 1);
  t.name = 'placeholder';
  t.needsUpdate = true;
  return t;
};

function makeLine(color: string, width: number, opacity: number, dashed = false): Line2 {
  const material = new LineMaterial({
    color: new THREE.Color(color).getHex(), linewidth: width, transparent: true, opacity, depthWrite: false,
    dashed, dashSize: 0.025, gapSize: 0.018,
  });
  const line = new Line2(new LineGeometry(), material);
  line.frustumCulled = false;
  line.visible = false;
  return line;
}

function setLinePath(line: Line2, points: THREE.Vector3[]) {
  if (points.length < 2) { line.visible = false; return; }
  const flat = new Float32Array(points.length * 3);
  points.forEach((p, i) => p.toArray(flat, i * 3));
  line.geometry.dispose();
  line.geometry = new LineGeometry();
  line.geometry.setPositions(flat);
  if ((line.material as LineMaterial).dashed) line.computeLineDistances();
  line.visible = true;
}

// ── High-resolution tiles ────────────────────────────────────────────────────

interface Tile {
  key: string;
  z: number; x: number; y: number;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  mesh: THREE.Mesh | null;
  lastUsed: number;
  readyAt: number;
}

const mercatorRow = (lat: number, n: number) => {
  const r = Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
  return Math.min(n - 1, Math.max(0, Math.floor(((1 - r / Math.PI) / 2) * n)));
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`tile failed: ${url}`));
    img.src = url;
  });
}

/** Spherical patch for a Web Mercator tile, with global (equirectangular) and tile UVs. */
function tileGeometry(z: number, x: number, y: number): THREE.BufferGeometry {
  const n = 2 ** z;
  const seg = Math.min(24, Math.max(2, Math.ceil(360 / n / 0.75)));
  const lonW = (x / n) * 360 - 180;
  const lonE = ((x + 1) / n) * 360 - 180;
  const mercN = Math.PI * (1 - (2 * y) / n);
  const mercS = Math.PI * (1 - (2 * (y + 1)) / n);
  const positions = new Float32Array((seg + 1) ** 2 * 3);
  const uvs = new Float32Array((seg + 1) ** 2 * 2);
  const tileUvs = new Float32Array((seg + 1) ** 2 * 2);
  const v = new THREE.Vector3();
  for (let j = 0, k = 0; j <= seg; j++) {
    const lat = Math.atan(Math.sinh(mercN + ((mercS - mercN) * j) / seg)) / DEG;
    for (let i = 0; i <= seg; i++, k++) {
      const lon = lonW + ((lonE - lonW) * i) / seg;
      toVector(lon, lat, 0, v).toArray(positions, k * 3);
      uvs[k * 2] = (lon + 180) / 360;
      uvs[k * 2 + 1] = (lat + 90) / 180;
      tileUvs[k * 2] = i / seg;
      tileUvs[k * 2 + 1] = 1 - j / seg;
    }
  }
  const index: number[] = [];
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('tileUv', new THREE.BufferAttribute(tileUvs, 2));
  geometry.setIndex(index);
  return geometry;
}

/** Tangent-space normal texture (x = east, y = north) from a Terrarium-encoded elevation tile. */
function terrainNormalTexture(img: HTMLImageElement, z: number, y: number): THREE.DataTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  const centreLat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 2 ** z)));
  const texelM = (40_075_016 * Math.cos(centreLat)) / (2 ** z * size);
  const k = TILE_RELIEF_EXAGGERATION / (2 * texelM);
  const out = new Uint8Array(size * size * 4);
  for (let r = 0; r < size; r++) {
    const up = Math.max(0, r - 1) * size, down = Math.min(size - 1, r + 1) * size, row = r * size;
    const dst = (size - 1 - r) * size;   // DataTexture row 0 is the bottom (south) edge
    for (let c = 0; c < size; c++) {
      const left = Math.max(0, c - 1), right = Math.min(size - 1, c + 1);
      const nx = -(h[row + right] - h[row + left]) * k;
      const ny = -(h[up + c] - h[down + c]) * k;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (dst + c) * 4;
      out[o] = (nx * inv * 0.5 + 0.5) * 255;
      out[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      out[o + 2] = (inv * 0.5 + 0.5) * 255;
      out[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(out, size, size);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

class TileLayer {
  readonly group = new THREE.Group();
  /** Called when high-resolution tiles start or stop being displayed. */
  onActiveChange?: (active: boolean) => void;

  private readonly tiles = new Map<string, Tile>();
  private readonly queue: Tile[] = [];
  private loading = 0;
  private active = false;
  private disposed = false;
  private stamp = 0;
  private lastKey = '';

  constructor(private readonly shared: Record<string, THREE.IUniform>, private readonly anisotropy: number) {}

  update(camera: THREE.PerspectiveCamera, viewportHeight: number, now: number) {
    // Fade newly loaded tiles in.
    for (const tile of this.tiles.values()) {
      if (tile.mesh?.visible) {
        (tile.mesh.material as THREE.ShaderMaterial).uniforms.opacity.value = Math.min(1, (now - tile.readyAt) / 300);
      }
    }

    const key = `${camera.position.toArray().map(c => c.toFixed(5)).join()}|${camera.aspect.toFixed(3)}|${viewportHeight}|${this.loading}|${this.queue.length}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.stamp++;

    const d = camera.position.length();
    const alt = d - 1;
    const dir = camera.position.clone().normalize();
    const lat = Math.asin(dir.y) / DEG;
    const lon = Math.atan2(-dir.z, dir.x) / DEG;
    const halfFov = (camera.fov / 2) * DEG;
    const pxAngle = (alt * 2 * Math.tan(halfFov)) / Math.max(1, viewportHeight);
    let z = Math.min(MAX_TILE_ZOOM, Math.round(Math.log2((2 * Math.PI * Math.max(Math.cos(lat * DEG), 0.1)) / (256 * pxAngle))));

    const halfDiag = Math.atan(Math.tan(halfFov) * Math.sqrt(1 + camera.aspect ** 2));
    const horizon = Math.acos(1 / d);
    const s = d * Math.sin(halfDiag);
    const theta = Math.min(horizon, s >= 1 ? horizon : Math.asin(s) - halfDiag) / DEG;

    const wanted: { tile: Tile; dist: number }[] = [];
    while (z >= MIN_TILE_ZOOM) {
      const n = 2 ** z;
      const latMax = Math.min(MERCATOR_MAX_LAT, lat + theta);
      const latMin = Math.max(-MERCATOR_MAX_LAT, lat - theta);
      const polar = lat + theta > 88 || lat - theta < -88;
      const lonSpan = polar ? 180 : Math.min(180, theta / Math.max(Math.cos(Math.max(Math.abs(latMin), Math.abs(latMax)) * DEG), 0.02));
      let x0 = Math.floor(((lon - lonSpan + 180) / 360) * n);
      let x1 = Math.floor(((lon + lonSpan + 180) / 360) * n);
      if (x1 - x0 + 1 >= n) { x0 = 0; x1 = n - 1; }
      const y0 = mercatorRow(latMax, n);
      const y1 = mercatorRow(latMin, n);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES_IN_VIEW) { z--; continue; }
      const cx = ((lon + 180) / 360) * n;
      const cy = mercatorRow(lat, n) + 0.5;
      for (let xi = x0; xi <= x1; xi++) {
        const x = ((xi % n) + n) % n;
        for (let y = y0; y <= y1; y++) {
          wanted.push({ tile: this.tile(z, x, y), dist: Math.hypot(xi + 0.5 - cx, y + 0.5 - cy) });
        }
      }
      break;
    }

    // Show ready tiles, falling back to the nearest loaded ancestor while children stream in.
    const shown = new Set<Tile>();
    for (const { tile } of wanted) {
      tile.lastUsed = this.stamp;
      if (tile.state === 'ready') { shown.add(tile); continue; }
      for (let k = 1; k <= 4 && tile.z - k >= MIN_TILE_ZOOM; k++) {
        const parent = this.tiles.get(`${tile.z - k}/${tile.x >> k}/${tile.y >> k}`);
        if (parent?.state === 'ready') { parent.lastUsed = this.stamp; shown.add(parent); break; }
      }
    }
    for (const tile of this.tiles.values()) if (tile.mesh) tile.mesh.visible = shown.has(tile);

    const active = shown.size > 0;
    if (active !== this.active) { this.active = active; this.onActiveChange?.(active); }

    this.queue.length = 0;
    this.queue.push(...wanted.filter(w => w.tile.state === 'idle').sort((a, b) => a.dist - b.dist).map(w => w.tile));
    this.pump();
    this.evict(shown);
  }

  private tile(z: number, x: number, y: number): Tile {
    const key = `${z}/${x}/${y}`;
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = { key, z, x, y, state: 'idle', mesh: null, lastUsed: this.stamp, readyAt: 0 };
      this.tiles.set(key, tile);
    }
    return tile;
  }

  private pump() {
    while (this.loading < MAX_CONCURRENT_LOADS && this.queue.length) {
      const tile = this.queue.shift()!;
      if (tile.state !== 'idle') continue;
      void this.load(tile);
    }
  }

  private async load(tile: Tile) {
    tile.state = 'loading';
    this.loading++;
    try {
      const { z, x, y } = tile;
      const [imagery, terrain] = await Promise.all([
        loadImage(IMAGERY_TILE_URL(z, x, y)),
        loadImage(TERRAIN_TILE_URL(Math.min(z, 15), x, y)).catch(() => null),
      ]);
      if (this.disposed || !this.tiles.has(tile.key)) return;

      const day = new THREE.Texture(imagery);
      day.colorSpace = THREE.SRGBColorSpace;
      day.anisotropy = this.anisotropy;
      day.needsUpdate = true;
      const normal = terrain ? terrainNormalTexture(terrain, z, y) : null;
      const material = new THREE.ShaderMaterial({
        vertexShader: TILE_VERT,
        fragmentShader: EARTH_FRAG,
        defines: { TILE: '' },
        uniforms: {
          ...this.shared,
          dayMap: { value: day },
          tileNormalMap: { value: normal ?? day },
          tileNormal: { value: normal ? 1 : 0 },
          opacity: { value: 0 },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      tile.mesh = new THREE.Mesh(tileGeometry(z, x, y), material);
      tile.mesh.renderOrder = 0.1 + z * 0.01;
      tile.mesh.frustumCulled = false;
      tile.mesh.visible = false;
      this.group.add(tile.mesh);
      tile.state = 'ready';
      tile.readyAt = performance.now();
    } catch {
      tile.state = 'failed';
    } finally {
      this.loading--;
      this.lastKey = '';   // re-evaluate the visible set on the next frame
    }
  }

  private evict(shown: Set<Tile>) {
    if (this.tiles.size <= MAX_CACHED_TILES) return;
    const candidates = [...this.tiles.values()]
      .filter(t => t.state !== 'loading' && !shown.has(t) && t.lastUsed !== this.stamp)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const tile of candidates.slice(0, this.tiles.size - MAX_CACHED_TILES)) this.release(tile);
  }

  private release(tile: Tile) {
    this.tiles.delete(tile.key);
    if (!tile.mesh) return;
    const material = tile.mesh.material as THREE.ShaderMaterial;
    const day = material.uniforms.dayMap.value as THREE.Texture;
    const normal = material.uniforms.tileNormalMap.value as THREE.Texture;
    day.dispose();
    if (normal !== day) normal.dispose();
    material.dispose();
    tile.mesh.geometry.dispose();
    this.group.remove(tile.mesh);
  }

  dispose() {
    this.disposed = true;
    for (const tile of [...this.tiles.values()]) this.release(tile);
  }
}

// ── Scene ────────────────────────────────────────────────────────────────────

export class EarthScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Called when the user starts dragging or zooming. */
  onUserInteract?: () => void;
  /** Called after every rendered frame (for positioning HTML overlays). */
  onFrame?: () => void;
  /** Called when streamed high-resolution imagery starts or stops being displayed. */
  onDetailImagery?: (active: boolean) => void;

  private readonly scene = new THREE.Scene();
  private readonly container: HTMLElement;
  private readonly earthMaterial: THREE.ShaderMaterial;
  private readonly cloudMesh: THREE.Mesh;
  private readonly atmosphereMaterial: THREE.ShaderMaterial;
  private readonly textures = new Set<THREE.Texture>();
  private readonly pointLayers: PointLayer[] = [];
  private readonly lines: Line2[] = [];

  private readonly stars = new PointLayer(2, -1, { far: true });
  private readonly debris = new PointLayer(2, 4);
  private readonly stations = new PointLayer(0, 5);
  private readonly burns = new PointLayer(0, 5);
  private readonly threatRings = new PointLayer(1, 6);
  private readonly satellites = new PointLayer(0, 7);
  private readonly selectionRing = new PointLayer(1, 8);
  private readonly trails: THREE.LineSegments;
  private readonly visibility: THREE.LineSegments;
  private readonly selectedTrail = makeLine('#38d6f5', 2.5, 0.95);
  private readonly predicted = makeLine('#e6edf3', 1.6, 0.85, true);

  private satWorld = new Float32Array(0);
  private stationWorld = new Float32Array(0);
  private burnWorld = new Float32Array(0);
  private satCount = 0;
  private stationCount = 0;
  private burnCount = 0;
  private followTarget: THREE.Vector3 | null = null;
  private flight: { from: THREE.Vector3; to: THREE.Vector3; start: number; duration: number } | null = null;
  private frame = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver;
  private userMoved = false;
  private cloudsEnabled = true;
  private zoomTarget: number | null = null;
  private readonly tileLayer: TileLayer;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.setClearColor(0x010204, 1);
    this.renderer.domElement.style.display = 'block';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 50);
    this.camera.position.copy(toVector(20, 15).multiplyScalar(3.4));

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = MIN_DISTANCE;
    this.controls.maxDistance = MAX_DISTANCE;
    this.controls.enableZoom = false;   // altitude-proportional wheel zoom below
    this.controls.addEventListener('start', () => this.userInteracted());
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });

    const dark = placeholderTexture([6, 14, 28]);
    const black = placeholderTexture([0, 0, 0]);
    const flat = placeholderTexture([128, 128, 255]);
    [dark, black, flat].forEach(t => this.textures.add(t));
    const sunDir = { value: new THREE.Vector3(1, 0, 0) };
    const cloudMap = { value: black as THREE.Texture };

    this.earthMaterial = new THREE.ShaderMaterial({
      vertexShader: SURFACE_VERT,
      fragmentShader: EARTH_FRAG,
      uniforms: {
        dayMap: { value: dark }, nightMap: { value: black }, normalMap: { value: flat },
        waterMap: { value: black }, cloudMap, sunDir, cloudShadow: { value: 1 },
      },
    });
    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 384, 192), this.earthMaterial);
    earth.renderOrder = 0;
    this.scene.add(earth);

    this.cloudMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.0045, 256, 128),
      new THREE.ShaderMaterial({
        vertexShader: SURFACE_VERT, fragmentShader: CLOUD_FRAG,
        uniforms: { cloudMap, sunDir, opacity: { value: 0.85 } },
        transparent: true, depthWrite: false,
      }),
    );
    this.cloudMesh.renderOrder = 1;
    this.scene.add(this.cloudMesh);

    this.atmosphereMaterial = new THREE.ShaderMaterial({
      vertexShader: SURFACE_VERT, fragmentShader: ATMOSPHERE_FRAG, uniforms: { sunDir },
      side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.tileLayer = new TileLayer(
      {
        nightMap: this.earthMaterial.uniforms.nightMap, normalMap: this.earthMaterial.uniforms.normalMap,
        waterMap: this.earthMaterial.uniforms.waterMap, cloudMap, sunDir, cloudShadow: this.earthMaterial.uniforms.cloudShadow,
      },
      this.renderer.capabilities.getMaxAnisotropy(),
    );
    this.tileLayer.onActiveChange = active => this.onDetailImagery?.(active);
    this.scene.add(this.tileLayer.group);

    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(ATMOSPHERE_RADIUS, 128, 64), this.atmosphereMaterial);
    atmosphere.renderOrder = 2;
    this.scene.add(atmosphere);

    this.trails = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: '#38d6f5', transparent: true, opacity: 0.3, depthWrite: false }),
    );
    this.visibility = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: '#3fb950', transparent: true, opacity: 0.85, depthWrite: false }),
    );
    for (const obj of [this.trails, this.visibility]) { obj.frustumCulled = false; obj.renderOrder = 3; this.scene.add(obj); }
    for (const line of [this.selectedTrail, this.predicted]) { line.renderOrder = 3; this.lines.push(line); this.scene.add(line); }

    this.pointLayers.push(this.stars, this.debris, this.stations, this.burns, this.threatRings, this.satellites, this.selectionRing);
    for (const layer of this.pointLayers) this.scene.add(layer.points);
    this.buildStars();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.setSun(null);
    this.animate();
  }

  // ── Imagery ────────────────────────────────────────────────────────────────

  /** Loads 4K imagery first, then upgrades to 8K where the GPU supports it. */
  async loadTextures(baseUrl: string, onQuality?: (q: TextureQuality) => void): Promise<void> {
    const loader = new THREE.TextureLoader();
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const load = async (name: string, srgb: boolean) => {
      const texture = await loader.loadAsync(`${baseUrl}${name}`);
      texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.anisotropy = maxAniso;
      texture.wrapS = THREE.RepeatWrapping;
      return texture;
    };
    const swap = (uniform: { value: THREE.Texture }, next: THREE.Texture) => {
      if (this.disposed) { next.dispose(); return; }
      const prev = uniform.value;
      uniform.value = next;
      this.textures.add(next);
      if (prev && prev.name !== 'placeholder') { this.textures.delete(prev); prev.dispose(); }
    };
    const u = this.earthMaterial.uniforms;

    const [day, night, normal, water, clouds] = await Promise.all([
      load('day_4k.jpg', true), load('night_4k.jpg', true), load('normal_4k.jpg', false),
      load('water_4k.png', false), load('clouds_4k.jpg', false),
    ]);
    swap(u.dayMap, day); swap(u.nightMap, night); swap(u.normalMap, normal); swap(u.waterMap, water); swap(u.cloudMap, clouds);
    if (this.disposed) return;
    onQuality?.('standard');

    const gl = this.renderer.getContext();
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const smallScreen = Math.min(window.screen.width, window.screen.height) < 700;
    if (maxSize < 8192 || smallScreen) return;
    const [day8, night8, normal8] = await Promise.all([
      load('day_8k.jpg', true), load('night_8k.jpg', true), load('normal_8k.jpg', false),
    ]);
    swap(u.dayMap, day8); swap(u.nightMap, night8); swap(u.normalMap, normal8);
    if (!this.disposed) onQuality?.('high');
  }

  setSun(timestamp: string | null) {
    const sun = subsolarPoint(timestamp ?? new Date().toISOString());
    toVector(sun.lon, sun.lat, 0, this.earthMaterial.uniforms.sunDir.value).normalize();
  }

  setCloudsVisible(visible: boolean) {
    this.cloudsEnabled = visible;
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  setSatellites(sats: (GlobePoint & { color: string; ring: string | null })[], selectedIndex: number) {
    if (this.satWorld.length < sats.length * 3) this.satWorld = new Float32Array(sats.length * 3);
    const v = new THREE.Vector3();
    const colors = new Map<string, [number, number, number, number]>();
    const rgba = (css: string) => colors.get(css) ?? (colors.set(css, linearRgba(css)), colors.get(css)!);

    this.satellites.update(sats.length, (i, pos, col, size) => {
      const s = sats[i];
      toVector(s.lon, s.lat, s.alt, v).toArray(pos, i * 3);
      v.toArray(this.satWorld, i * 3);
      col.set(rgba(s.color), i * 4);
      size[i] = i === selectedIndex ? 17 : 13;
    });
    this.satCount = sats.length;

    const ringed = sats.map((s, i) => [s, i] as const).filter(([s]) => s.ring);
    this.threatRings.update(ringed.length, (i, pos, col, size) => {
      const [s, idx] = ringed[i];
      pos.set(this.satWorld.subarray(idx * 3, idx * 3 + 3), i * 3);
      col.set(rgba(s.ring!), i * 4);
      size[i] = 26;
    });

    const selected = sats[selectedIndex];
    this.selectionRing.update(selected ? 1 : 0, (_i, pos, col, size) => {
      pos.set(this.satWorld.subarray(selectedIndex * 3, selectedIndex * 3 + 3), 0);
      col.set(linearRgba('#38d6f5'), 0);
      size[0] = 36;
    });
  }

  /** `positions` holds [lon, lat, alt m] triples. */
  setDebris(positions: Float32Array | null, count: number) {
    const v = new THREE.Vector3();
    const color = linearRgba('#a8b5c4', 0.75);
    this.debris.update(positions ? count : 0, (i, pos, col, size) => {
      toVector(positions![i * 3], positions![i * 3 + 1], positions![i * 3 + 2], v).toArray(pos, i * 3);
      col.set(color, i * 4);
      size[i] = 3.2;
    });
  }

  setTrails(unselected: GlobePoint[][], selected: GlobePoint[] | null) {
    const segments: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const path of unselected) {
      for (let i = 1; i < path.length; i++) {
        toVector(path[i - 1].lon, path[i - 1].lat, path[i - 1].alt, a);
        toVector(path[i].lon, path[i].lat, path[i].alt, b);
        segments.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    this.trails.geometry.dispose();
    this.trails.geometry = new THREE.BufferGeometry();
    this.trails.geometry.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3));
    setLinePath(this.selectedTrail, (selected ?? []).map(p => toVector(p.lon, p.lat, p.alt)));
  }

  setPredicted(points: GlobePoint[] | null) {
    setLinePath(this.predicted, (points ?? []).map(p => toVector(p.lon, p.lat, p.alt)));
  }

  setStations(stations: (GlobePoint & { color: string })[]) {
    if (this.stationWorld.length < stations.length * 3) this.stationWorld = new Float32Array(stations.length * 3);
    const v = new THREE.Vector3();
    this.stations.update(stations.length, (i, pos, col, size) => {
      const s = stations[i];
      toVector(s.lon, s.lat, 2000, v).toArray(pos, i * 3);
      v.toArray(this.stationWorld, i * 3);
      col.set(linearRgba(s.color), i * 4);
      size[i] = 11;
    });
    this.stationCount = stations.length;
  }

  setVisibility(from: GlobePoint | null, to: GlobePoint[]) {
    const segments: number[] = [];
    if (from) {
      const a = toVector(from.lon, from.lat, from.alt);
      for (const p of to) {
        const b = toVector(p.lon, p.lat, 2000);
        segments.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    this.visibility.geometry.dispose();
    this.visibility.geometry = new THREE.BufferGeometry();
    this.visibility.geometry.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3));
  }

  setBurns(burns: GlobePoint[]) {
    if (this.burnWorld.length < burns.length * 3) this.burnWorld = new Float32Array(burns.length * 3);
    const v = new THREE.Vector3();
    const color = linearRgba('#d29922', 0.95);
    this.burns.update(burns.length, (i, pos, col, size) => {
      toVector(burns[i].lon, burns[i].lat, burns[i].alt, v).toArray(pos, i * 3);
      v.toArray(this.burnWorld, i * 3);
      col.set(color, i * 4);
      size[i] = 9;
    });
    this.burnCount = burns.length;
  }

  // ── Camera ─────────────────────────────────────────────────────────────────

  /** Keeps the camera centred over `target` (null stops following). */
  setFollow(target: GlobePoint | null) {
    this.followTarget = target ? toVector(target.lon, target.lat, target.alt) : null;
  }

  /** Flies to a whole-Earth view centred on the given point. */
  resetView(lon: number, lat: number, animate = true) {
    this.userMoved = false;
    this.zoomTarget = null;
    const to = toVector(lon, lat).multiplyScalar(this.fitDistance());
    if (!animate) { this.camera.position.copy(to); this.flight = null; return; }
    this.flight = { from: this.camera.position.clone(), to, start: performance.now(), duration: 1200 };
  }

  private fitDistance(): number {
    const aspect = this.camera.aspect || 1;
    const tanHalf = Math.tan((FOV / 2) * DEG) * Math.min(1, aspect);
    return 1.1 / Math.sin(Math.atan(0.82 * tanHalf));
  }

  private userInteracted() {
    this.flight = null;
    this.userMoved = true;
    this.onUserInteract?.();
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const current = this.zoomTarget ?? this.camera.position.length() - 1;
    const next = current * Math.exp(THREE.MathUtils.clamp(delta, -240, 240) * 0.0016);
    this.zoomTarget = THREE.MathUtils.clamp(next, MIN_DISTANCE - 1, MAX_DISTANCE - 1);
    this.userInteracted();
  };

  // ── Picking & projection ───────────────────────────────────────────────────

  /** Screen position (container pixels) of a world point, or null when behind the Earth / off-screen. */
  project(world: THREE.Vector3): { x: number; y: number } | null {
    if (this.isOccluded(world)) return null;
    const p = world.clone().project(this.camera);
    if (p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) return null;
    const { clientWidth: w, clientHeight: h } = this.container;
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
  }

  projectPoint(p: GlobePoint) {
    return this.project(toVector(p.lon, p.lat, p.alt));
  }

  pick(x: number, y: number, radiusPx = 11): PickHit | null {
    let best: PickHit | null = null;
    let bestDist = radiusPx;
    const v = new THREE.Vector3();
    const scan = (kind: PickKind, world: Float32Array, count: number, bias: number) => {
      for (let i = 0; i < count; i++) {
        const s = this.project(v.fromArray(world, i * 3));
        if (!s) continue;
        const d = Math.hypot(s.x - x, s.y - y) + bias;
        if (d < bestDist) { bestDist = d; best = { kind, index: i }; }
      }
    };
    scan('satellite', this.satWorld, this.satCount, 0);
    scan('station', this.stationWorld, this.stationCount, 2);
    scan('burn', this.burnWorld, this.burnCount, 3);
    return best;
  }

  private isOccluded(p: THREE.Vector3): boolean {
    const c = this.camera.position;
    const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    const a = dx * dx + dy * dy + dz * dz;
    const b = 2 * (c.x * dx + c.y * dy + c.z * dz);
    const cc = c.lengthSq() - 1;
    const disc = b * b - 4 * a * cc;
    if (disc <= 0) return false;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t > 0 && t < 0.998;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private buildStars() {
    let seed = 1337;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const count = 7000;
    const tints = ['#9bb0ff', '#cad7ff', '#f8f7ff', '#fff4ea', '#ffd2a1'].map(c => linearRgba(c));
    this.stars.update(count, (i, pos, col, size) => {
      const z = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      pos.set([r * Math.cos(phi) * 40, z * 40, r * Math.sin(phi) * 40], i * 3);
      const mag = rand() ** 6;
      const tint = tints[Math.floor(rand() * tints.length)];
      col.set([tint[0], tint[1], tint[2], 0.25 + 0.75 * mag], i * 4);
      size[i] = 1.2 + mag * 3.6;
    });
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    const ratio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const layer of this.pointLayers) layer.setPixelRatio(ratio);
    for (const line of this.lines) (line.material as LineMaterial).resolution.set(w, h);
    if (!this.userMoved && !this.flight) {
      this.camera.position.setLength(this.fitDistance());
    }
  }

  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);

    if (this.flight) {
      const t = Math.min(1, (performance.now() - this.flight.start) / this.flight.duration);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const dist = THREE.MathUtils.lerp(this.flight.from.length(), this.flight.to.length(), e);
      const dir = this.flight.from.clone().normalize().lerp(this.flight.to.clone().normalize(), e);
      if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
      this.camera.position.copy(dir.normalize().multiplyScalar(dist));
      if (t >= 1) this.flight = null;
    } else if (this.followTarget) {
      const dist = this.camera.position.length();
      const dir = this.camera.position.clone().normalize().lerp(this.followTarget.clone().normalize(), 0.07);
      this.camera.position.copy(dir.normalize().multiplyScalar(dist));
    }

    if (this.zoomTarget !== null) {
      const alt = this.camera.position.length() - 1;
      const next = alt + (this.zoomTarget - alt) * 0.2;
      this.camera.position.setLength(1 + next);
      if (Math.abs(next - this.zoomTarget) < this.zoomTarget * 0.002) this.zoomTarget = null;
    }

    const altitude = this.camera.position.length() - 1;
    this.controls.rotateSpeed = THREE.MathUtils.clamp(altitude * 0.16, 0.0006, 0.8);
    this.controls.update();

    // Clouds would hide the terrain close to the surface: fade them out as the camera descends.
    const cloudFade = this.cloudsEnabled ? THREE.MathUtils.smoothstep(altitude, 0.04, 0.3) : 0;
    this.cloudMesh.visible = cloudFade > 0.01;
    (this.cloudMesh.material as THREE.ShaderMaterial).uniforms.opacity.value = 0.85 * cloudFade;
    this.earthMaterial.uniforms.cloudShadow.value = cloudFade;
    this.tileLayer.update(this.camera, this.container.clientHeight, performance.now());
    this.camera.near = Math.max(0.002, altitude * 0.3);
    this.camera.far = altitude + 3;
    this.camera.updateProjectionMatrix();

    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('wheel', this.onWheel);
    this.tileLayer.dispose();
    this.controls.dispose();
    this.scene.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach(m => m.dispose()); else material?.dispose();
    });
    this.textures.forEach(t => t.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
