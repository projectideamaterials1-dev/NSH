// src/lib/earth/tileLayer.ts
// Streams high-resolution satellite imagery (Esri World Imagery) and terrain relief (AWS Terrain
// Tiles) for the part of the globe in view, on top of the bundled 8K base texture.

import * as THREE from 'three';
import { DEG, toVector } from './globeMath';
import { EARTH_FRAG, TILE_VERT } from './shaders';

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

export class TileLayer {
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
