// src/lib/earthScene.ts
// Photorealistic Earth renderer (Three.js, no React): NASA Blue Marble day imagery, Black Marble city
// lights, GEBCO terrain relief, ocean sun glint, clouds, atmospheric scattering and a starfield, lit by
// the real sun position. Orbital objects are drawn at their true altitude in an Earth-fixed frame
// (1 scene unit = 1 Earth radius; +Y = north pole, +X = lon 0°, −Z = lon 90°E).
// Zooming in streams high-resolution satellite imagery (Esri World Imagery) and terrain relief
// (AWS Terrain Tiles) on top of the bundled 8K base; offline, the base imagery is used alone.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Line2 } from 'three/examples/jsm/lines/Line2.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { subsolarPoint } from './geo';
import { SatelliteModelLayer, type ModelInfo } from './satelliteModels';
import { MotionSmoother } from './motionSmoother';
import { DEG, linearRgba, toVector } from './earth/globeMath';
import { ATMOSPHERE_FRAG, ATMOSPHERE_RADIUS, CLOUD_FRAG, EARTH_FRAG, SURFACE_VERT } from './earth/shaders';
import { PointLayer, makeLine, placeholderTexture, setLinePath } from './earth/primitives';
import { TileLayer } from './earth/tileLayer';

export { linearRgba, toVector } from './earth/globeMath';

const FOV = 38;
const MIN_DISTANCE = 1.006;   // ~38 km above the surface
const MAX_DISTANCE = 18;

export interface GlobePoint { lon: number; lat: number; alt: number }   // alt in metres
export type PickKind = 'satellite' | 'station' | 'burn';
export interface PickHit { kind: PickKind; index: number }
export type TextureQuality = 'loading' | 'standard' | 'high';

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
  private readonly motion = new MotionSmoother();   // satellites glide between telemetry snapshots
  private ringIndex: number[] = [];
  private selectedSat = -1;
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
  private readonly models = new SatelliteModelLayer(`${import.meta.env.BASE_URL}models/`);
  private readonly sunLight = new THREE.DirectionalLight(0xffffff, 2.6);
  private readonly fillLight = new THREE.DirectionalLight(0xbcd2ff, 0.9);   // from the camera: night-side models stay readable

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

    // Satellite models are the only lit objects (the Earth uses its own shaders): sunlight + a little fill.
    this.scene.add(this.sunLight, this.fillLight, new THREE.AmbientLight(0xffffff, 0.45), this.models.group);
    // Reflections for the models' metal / foil (only PBR materials use scene.environment; the Earth's shaders don't).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.textures.add(this.scene.environment);
    pmrem.dispose();

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
    this.sunLight.position.copy(this.earthMaterial.uniforms.sunDir.value).multiplyScalar(10);
  }

  /** Draw satellites as 3D models (nearest ones) instead of only dots. */
  setModelsVisible(visible: boolean) {
    this.models.enabled = visible;
  }

  /** Which 3D model a satellite is drawn with (for attribution). */
  modelInfo(id: string): ModelInfo {
    return this.models.modelFor(id);
  }

  setCloudsVisible(visible: boolean) {
    this.cloudsEnabled = visible;
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  setSatellites(sats: (GlobePoint & { id?: string; color: string; ring: string | null })[], selectedIndex: number) {
    const n = sats.length;
    const now = performance.now();
    const ids = sats.map((s, i) => s.id ?? `#${i}`);
    const reported = new Float64Array(n * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) toVector(sats[i].lon, sats[i].lat, sats[i].alt, v).toArray(reported, i * 3);
    const headings = new Map<string, THREE.Vector3>();
    for (const [id, h] of this.motion.update(ids, reported, now)) headings.set(id, new THREE.Vector3(...h));
    this.selectedSat = selectedIndex;
    if (this.satWorld.length < n * 3) this.satWorld = new Float32Array(n * 3);
    this.writeSatWorld(now);

    const colors = new Map<string, [number, number, number, number]>();
    const rgba = (css: string) => colors.get(css) ?? (colors.set(css, linearRgba(css)), colors.get(css)!);
    this.satellites.update(n, (i, pos, col, size) => {
      pos.set(this.satWorld.subarray(i * 3, i * 3 + 3), i * 3);
      col.set(rgba(sats[i].color), i * 4);
      size[i] = i === selectedIndex ? 17 : 13;
    });
    this.satCount = n;
    this.models.setSatellites(ids, ids[selectedIndex] ?? null, headings);

    this.ringIndex = sats.map((s, i) => (s.ring ? i : -1)).filter(i => i >= 0);
    this.threatRings.update(this.ringIndex.length, (i, pos, col, size) => {
      pos.set(this.satWorld.subarray(this.ringIndex[i] * 3, this.ringIndex[i] * 3 + 3), i * 3);
      col.set(rgba(sats[this.ringIndex[i]].ring!), i * 4);
      size[i] = 26;
    });
    this.selectionRing.update(selectedIndex >= 0 && selectedIndex < n ? 1 : 0, (_i, pos, col, size) => {
      pos.set(this.satWorld.subarray(selectedIndex * 3, selectedIndex * 3 + 3), 0);
      col.set(linearRgba('#38d6f5'), 0);
      size[0] = 36;
    });
  }

  /** Smoothed positions at `now` into satWorld (what is drawn and picked). */
  private writeSatWorld(now: number) {
    this.motion.sample(now, this.satWorld);
  }

  /** Per frame while satellites are gliding: moves the dots, rings and selection marker with them. */
  private animateSatellites(now: number) {
    if (this.motion.settled(now)) return;   // nothing moves until the next snapshot
    this.writeSatWorld(now);
    const w = this.satWorld;
    this.satellites.setPositions(this.satCount, (i, pos) => pos.set(w.subarray(i * 3, i * 3 + 3), i * 3));
    this.threatRings.setPositions(this.ringIndex.length, (i, pos) => pos.set(w.subarray(this.ringIndex[i] * 3, this.ringIndex[i] * 3 + 3), i * 3));
    if (this.selectedSat >= 0 && this.selectedSat < this.satCount) {
      this.selectionRing.setPositions(1, (_i, pos) => pos.set(w.subarray(this.selectedSat * 3, this.selectedSat * 3 + 3), 0));
    }
  }

  /** World position of the selected satellite as drawn (smoothed), or null. */
  selectedWorldPosition(): THREE.Vector3 | null {
    if (this.selectedSat < 0 || this.selectedSat >= this.satCount) return null;
    return new THREE.Vector3().fromArray(this.satWorld, this.selectedSat * 3);
  }

  /** Screen position of the selected satellite as drawn (smoothed), for the HTML label. */
  selectedScreenPosition(): { x: number; y: number } | null {
    if (this.selectedSat < 0 || this.selectedSat >= this.satCount) return null;
    return this.project(new THREE.Vector3().fromArray(this.satWorld, this.selectedSat * 3));
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

    this.animateSatellites(performance.now());

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
      const target = this.selectedSat >= 0 && this.selectedSat < this.satCount
        ? new THREE.Vector3().fromArray(this.satWorld, this.selectedSat * 3) : this.followTarget;
      const dir = this.camera.position.clone().normalize().lerp(target.clone().normalize(), 0.07);
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
    this.fillLight.position.copy(this.camera.position);
    this.models.update(this.camera, this.container.clientHeight, p => this.isOccluded(p), this.satWorld);
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
    this.models.dispose();
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
