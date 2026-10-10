// src/lib/satelliteModels.ts
// 3D satellite models on the globe. Satellites listed in public/models/manifest.json get their glTF
// model (NASA 3D Resources, or your own); every other satellite gets a built-in model of its type
// (Starlink flat-panel, OneWeb, CubeSat, Earth-observation, SAR, GNSS, GEO comsat, station module,
// crew/cargo capsule). Models are drawn at a constant on-screen size - at true scale a 100 m
// spacecraft would be far smaller than a pixel - oriented with +Y away from Earth and +X along-track.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

export type BuiltinKind = 'starlink' | 'oneweb' | 'cubesat' | 'eo' | 'sar' | 'gnss' | 'geo' | 'station' | 'capsule' | 'rocketbody';

export interface ModelInfo {
  /** glTF model from the manifest, or null for a built-in model. */
  file: string | null;
  kind: BuiltinKind | null;
  title: string;
  exact: boolean;
  credit: string | null;
  /** Node-name prefixes to drop from the glTF (stray parts some source files contain). */
  hide?: string[];
}

interface ManifestEntry { match: RegExp; file: string; title: string; exact: boolean; credit: string | null; hide: string[] }

const BUILTIN_RULES: [RegExp, BuiltinKind, string][] = [
  [/^STARLINK/i, 'starlink', 'Starlink (flat-panel bus)'],
  [/^ONEWEB/i, 'oneweb', 'OneWeb'],
  [/\b(DEB|R\/B)\b|ROCKET BODY/i, 'rocketbody', 'Rocket body'],
  [/^CSS\b|TIANGONG|TIANHE|WENTIAN|MENGTIAN|NAUKA|POISK|ZARYA/i, 'station', 'Space station module'],
  [/DRAGON|SOYUZ|PROGRESS|CYGNUS|SHENZHOU|TIANZHOU|HTV|STARLINER/i, 'capsule', 'Crew / cargo vehicle'],
  [/FLOCK|LEMUR|CUBESAT|DOVE|KNACKSAT|TIGRISAT|GXIBA|UITMSAT|HMU-SAT/i, 'cubesat', 'CubeSat'],
  [/^GPS|NAVSTAR|BEIDOU|GALILEO|GLONASS|IRNSS|NAVIC|QZS/i, 'gnss', 'Navigation satellite'],
  [/INSAT|GSAT|EWS-G|METEOSAT|HIMAWARI|ELEKTRO|FENGYUN-4|GEO-KOMPSAT|INTELSAT|SES-|ASTRA/i, 'geo', 'Geostationary satellite'],
  [/RISAT|RADARSAT|TERRASAR|TANDEM-X|SENTINEL-1|ICEYE|CAPELLA|COSMO|SAOCOM|EOS-0[14]\b|PAZ\b|NISAR/i, 'sar', 'Radar imaging satellite'],
];
const CUBESAT_GLB = 'nasa/cubesat.glb';   // NASA's generic CubeSat, used for the 'cubesat' kind

const MAX_MODELS = 140;                      // nearest satellites shown as models; the rest stay dots
const BASE_PX = 15;                          // on-screen radius of a model, whole-Earth view
const SELECTED_PX = 42;
const DOCKED = 4e-4;                         // ~2.5 km: objects this close are one stack - draw one model

// ── Built-in models ──────────────────────────────────────────────────────────

const mat = {
  gold: new THREE.MeshStandardMaterial({ color: '#c99a3e', metalness: 0.85, roughness: 0.32 }),
  silver: new THREE.MeshStandardMaterial({ color: '#c3c9d1', metalness: 0.9, roughness: 0.28 }),
  white: new THREE.MeshStandardMaterial({ color: '#e9ecef', metalness: 0.1, roughness: 0.55 }),
  dark: new THREE.MeshStandardMaterial({ color: '#1d2228', metalness: 0.4, roughness: 0.5 }),
  panel: new THREE.MeshStandardMaterial({ color: '#1c3270', metalness: 0.35, roughness: 0.35, emissive: '#071233' }),
};

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
}

function cylinder(r: number, len: number, m: THREE.Material, axis: 'x' | 'y' | 'z' = 'x', x = 0, y = 0, z = 0, r2 = r) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, 20), m);
  if (axis === 'x') mesh.rotation.z = Math.PI / 2;
  if (axis === 'z') mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
}

/** Solar wing along ±Z: a yoke plus `segments` panels. */
function wing(side: 1 | -1, length: number, width: number, segments = 3, offset = 0.5) {
  const g = new THREE.Group();
  g.add(box(0.04, 0.04, offset, mat.silver, 0, 0, side * offset / 2));
  const seg = length / segments;
  for (let i = 0; i < segments; i++) {
    g.add(box(width, 0.02, seg * 0.94, mat.panel, 0, 0, side * (offset + seg * (i + 0.5))));
  }
  return g;
}

function dish(r: number, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 3.2), mat.white);
  mesh.position.set(x, y, z);
  return mesh;
}

function builtin(kind: BuiltinKind): THREE.Object3D {
  const g = new THREE.Group();
  switch (kind) {
    case 'starlink':   // flat-pack bus with one long wing
      g.add(box(1.4, 0.12, 0.7, mat.silver), box(1.38, 0.02, 0.68, mat.dark, 0, -0.07, 0), wing(1, 2.6, 0.9, 4, 0.4));
      break;
    case 'oneweb':
      g.add(box(0.6, 0.7, 0.6, mat.gold), wing(1, 1.1, 0.5, 2), wing(-1, 1.1, 0.5, 2), cylinder(0.08, 0.2, mat.white, 'y', 0, -0.45, 0));
      break;
    case 'cubesat':
      g.add(box(0.3, 0.3, 0.9, mat.silver), box(0.6, 0.02, 0.9, mat.panel, 0.45, 0.15, 0), box(0.6, 0.02, 0.9, mat.panel, -0.45, 0.15, 0));
      break;
    case 'sar':        // bus with a large flat radar antenna
      g.add(box(0.7, 0.7, 0.7, mat.gold), box(2.4, 0.06, 0.8, mat.dark, 0, -0.45, 0), wing(1, 1.2, 0.6, 2));
      break;
    case 'gnss':
      g.add(box(0.8, 0.9, 0.8, mat.gold), wing(1, 1.6, 0.7), wing(-1, 1.6, 0.7), box(0.5, 0.05, 0.5, mat.white, 0, -0.5, 0));
      for (const [x, z] of [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]]) g.add(cylinder(0.05, 0.2, mat.white, 'y', x, -0.6, z));
      break;
    case 'geo':
      g.add(box(0.9, 1.0, 0.9, mat.gold), wing(1, 2.4, 0.8, 4), wing(-1, 2.4, 0.8, 4), dish(0.45, 0.55, -0.2, 0), dish(0.35, -0.55, -0.2, 0));
      break;
    case 'station':    // pressurised modules with large arrays
      g.add(cylinder(0.35, 2.2, mat.white), cylinder(0.3, 0.8, mat.white, 'x', 1.5), box(0.5, 0.5, 0.5, mat.white, -1.3));
      g.add(wing(1, 1.8, 0.8, 3, 0.35), wing(-1, 1.8, 0.8, 3, 0.35));
      break;
    case 'capsule':
      g.add(cylinder(0.32, 0.9, mat.white, 'x', -0.2), cylinder(0.32, 0.5, mat.silver, 'x', 0.5, 0, 0, 0.12));
      g.add(wing(1, 0.9, 0.35, 2, 0.35), wing(-1, 0.9, 0.35, 2, 0.35));
      break;
    case 'rocketbody':
      g.add(cylinder(0.3, 1.8, mat.white), cylinder(0.3, 0.3, mat.dark, 'x', 1.05, 0, 0, 0.18));
      break;
    case 'eo':
    default:           // Earth-observation: bus, camera looking down, one wing
      g.add(box(0.8, 0.9, 0.8, mat.gold), cylinder(0.18, 0.4, mat.dark, 'y', 0.15, -0.6, 0), wing(1, 1.8, 0.7));
      g.add(box(0.06, 0.4, 0.06, mat.silver, -0.3, 0.6, 0));
      break;
  }
  return g;
}

/** Centres a model and scales it so its largest half-extent is 1. */
function normalise(obj: THREE.Object3D): THREE.Object3D {
  const bounds = new THREE.Box3().setFromObject(obj);
  const size = bounds.getSize(new THREE.Vector3());
  const centre = bounds.getCenter(new THREE.Vector3());
  const scale = 2 / Math.max(size.x, size.y, size.z, 1e-9);
  const wrapper = new THREE.Group();
  obj.position.sub(centre);
  wrapper.add(obj);
  wrapper.scale.setScalar(scale);
  const outer = new THREE.Group();
  outer.add(wrapper);
  return outer;
}

// ── Library: manifest + model templates, shared by the globe and the model viewer ──

export class ModelLibrary {
  private manifest: ManifestEntry[] = [];
  private readonly loader = new GLTFLoader();
  private readonly templates = new Map<string, THREE.Object3D | null>();   // null: file failed to load
  private readonly pending = new Map<string, Promise<THREE.Object3D>>();
  private readonly info = new Map<string, ModelInfo>();
  /** Resolves once the manifest has been read (or failed to load). */
  readonly ready: Promise<void>;

  private static libraries = new Map<string, ModelLibrary>();
  static get(baseUrl = `${import.meta.env.BASE_URL}models/`): ModelLibrary {
    let lib = ModelLibrary.libraries.get(baseUrl);
    if (!lib) ModelLibrary.libraries.set(baseUrl, (lib = new ModelLibrary(baseUrl)));
    return lib;
  }

  private constructor(private readonly baseUrl: string) {
    // NASA 3D Resources models are Draco-compressed; the decoder is served from public/draco (works offline).
    this.loader.setDRACOLoader(new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`));
    this.ready = fetch(`${baseUrl}manifest.json`)
      .then(r => (r.ok ? r.json() : { models: [] }))
      .then((m: { models?: { match: string; file: string; title: string; exact?: boolean; credit?: string; hide?: string[] }[] }) => {
        this.manifest = (m.models ?? []).flatMap(e => {
          try {
            return [{ match: new RegExp(e.match, 'i'), file: e.file, title: e.title, exact: e.exact ?? false,
                      credit: e.credit ?? null, hide: e.hide ?? [] }];
          } catch {
            return [];   // a malformed regex in a hand-edited manifest shouldn't break the globe
          }
        });
        this.info.clear();
      })
      .catch(() => { /* no manifest: built-in models only */ });
  }

  /** Which model a satellite gets. */
  modelFor(id: string): ModelInfo {
    let info = this.info.get(id);
    if (info) return info;
    const entry = this.manifest.find(e => e.match.test(id));
    if (entry) {
      info = { file: entry.file, kind: null, title: entry.title, exact: entry.exact, credit: entry.credit, hide: entry.hide };
    } else {
      const rule = BUILTIN_RULES.find(([re]) => re.test(id));
      const kind = rule?.[1] ?? 'eo';
      info = kind === 'cubesat'
        ? { file: CUBESAT_GLB, kind, title: 'Generic CubeSat', exact: false, credit: 'NASA 3D Resources' }
        : { file: null, kind, title: rule?.[2] ?? 'Earth-observation satellite', exact: false, credit: null };
    }
    this.info.set(id, info);
    return info;
  }

  static key(info: ModelInfo): string {
    return info.file ? `glb:${info.file}` : `builtin:${info.kind}`;
  }

  private builtinFor(info: ModelInfo): THREE.Object3D {
    const key = `builtin:${info.kind ?? 'eo'}`;
    let t = this.templates.get(key);
    if (!t) this.templates.set(key, (t = normalise(builtin(info.kind ?? 'eo'))));
    return t;
  }

  /** The normalised template if it is ready (built-ins always are); otherwise starts loading and returns null. */
  templateNow(info: ModelInfo): THREE.Object3D | null {
    if (!info.file) return this.builtinFor(info);
    const t = this.templates.get(ModelLibrary.key(info));
    if (t === null) return this.builtinFor(info);   // broken / missing file
    if (t) return t;
    void this.template(info);
    return null;
  }

  /** The normalised template, loading it if needed (falls back to the built-in model if the file fails). */
  template(info: ModelInfo): Promise<THREE.Object3D> {
    const now = info.file ? this.templates.get(ModelLibrary.key(info)) : this.builtinFor(info);
    if (now) return Promise.resolve(now);
    if (now === null) return Promise.resolve(this.builtinFor(info));
    const key = ModelLibrary.key(info);
    let p = this.pending.get(key);
    if (!p) {
      p = this.loader.loadAsync(`${this.baseUrl}${info.file}`)
        .then(gltf => {
          if (info.hide?.length) {
            const drop: THREE.Object3D[] = [];
            gltf.scene.traverse(o => { if (info.hide!.some(prefix => o.name.startsWith(prefix))) drop.push(o); });
            drop.forEach(o => o.removeFromParent());
          }
          const obj = normalise(gltf.scene);
          this.templates.set(key, obj);
          return obj;
        })
        .catch(err => {
          console.warn(`3D model ${info.file} failed to load; using the built-in model`, err);
          this.templates.set(key, null);
          return this.builtinFor(info);
        });
      this.pending.set(key, p);
    }
    return p;
  }
}

// ── Layer ────────────────────────────────────────────────────────────────────

export class SatelliteModelLayer {
  readonly group = new THREE.Group();
  enabled = true;
  private readonly library: ModelLibrary;
  private readonly instances = new Map<string, { key: string; obj: THREE.Object3D }>();
  private readonly heading = new Map<string, THREE.Vector3>();   // along-track unit vector per satellite
  private readonly shownLast = new Set<string>();
  private readonly guessed = new Set<string>();   // oriented by the placeholder (no direction of travel yet)
  private ids: string[] = [];
  private selectedId: string | null = null;
  private lastFrame = 0;

  constructor(baseUrl?: string) {
    this.group.renderOrder = 3;
    this.library = ModelLibrary.get(baseUrl);
    this.library.ready.then(() => this.clearInstances());   // re-resolve once the manifest is known
  }

  modelFor(id: string): ModelInfo {
    return this.library.modelFor(id);
  }

  /** On each telemetry update: the satellites and their along-track directions (from the scene's motion). */
  setSatellites(ids: string[], selectedId: string | null, headings: Map<string, THREE.Vector3>) {
    this.selectedId = selectedId;
    for (const [id, h] of headings) this.heading.set(id, h);
    const live = new Set(ids);
    for (const id of [...this.instances.keys()]) if (!live.has(id)) this.removeInstance(id);
    for (const id of [...this.heading.keys()]) if (!live.has(id)) this.heading.delete(id);
    for (const id of [...this.guessed]) if (!live.has(id)) this.guessed.delete(id);
    this.ids = ids;
  }

  /** Per frame: picks the satellites to draw as models (with hysteresis, so they don't flicker as the
   * camera moves), places them at the smoothed positions, sizes them to a constant on-screen size and
   * eases their orientation towards the direction of travel. */
  update(camera: THREE.PerspectiveCamera, viewportHeight: number, occluded: (p: THREE.Vector3) => boolean, world: ArrayLike<number>) {

    this.group.visible = this.enabled;
    if (!this.enabled || !viewportHeight) return;
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(now - this.lastFrame, 100) : 16;
    this.lastFrame = now;
    const cam = camera.position;
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    const at = (i: number, out: THREE.Vector3) => out.set(world[i * 3], world[i * 3 + 1], world[i * 3 + 2]);

    const candidates: { i: number; rank: number; priority: number }[] = [];
    for (let i = 0; i < this.ids.length; i++) {
      at(i, p);
      if (occluded(p)) continue;
      const id = this.ids[i];
      const info = this.modelFor(id);
      const selected = id === this.selectedId;
      // Already-drawn models get a 25% head start so small camera moves don't swap them in and out.
      const rank = p.distanceTo(cam) * (this.shownLast.has(id) ? 0.75 : 1) * (selected ? 0 : 1);
      candidates.push({ i, rank, priority: selected ? 0 : info.exact ? 1 : info.file ? 2 : 3 });
    }
    candidates.sort((x, y) => x.rank - y.rank || x.i - y.i);

    const shown: { i: number; priority: number }[] = [];
    for (const c of candidates) {
      at(c.i, p);
      // Docked vehicles share the station's position: draw one model per stack - always the best one,
      // so which model represents the stack doesn't change from frame to frame.
      const k = shown.findIndex(s2 => at(s2.i, q).distanceToSquared(p) < DOCKED * DOCKED);
      if (k >= 0) {
        if (c.priority < shown[k].priority || (c.priority === shown[k].priority && this.ids[c.i] < this.ids[shown[k].i])) shown[k] = c;
        continue;
      }
      if (shown.length < MAX_MODELS) shown.push(c);
    }

    const keep = new Set<string>();
    const tanHalf = Math.tan((camera.fov / 2) * Math.PI / 180);
    const up = new THREE.Vector3(), fwd = new THREE.Vector3(), side = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    const target = new THREE.Quaternion();
    const ease = 1 - Math.exp(-dt / 350);   // orientation settles over ~1 s instead of snapping
    for (const { i } of shown) {
      const id = this.ids[i];
      const obj = this.instanceFor(id);
      if (!obj) continue;
      const fresh = !obj.visible || !this.shownLast.has(id);
      keep.add(id);
      at(i, p);
      obj.position.copy(p);
      const dist = p.distanceTo(cam);
      const px = id === this.selectedId ? SELECTED_PX : BASE_PX * THREE.MathUtils.clamp(0.35 / dist, 1, 2.6);
      obj.scale.setScalar((px * 2 * dist * tanHalf) / viewportHeight);
      up.copy(p).normalize();
      const h = this.heading.get(id);
      fwd.copy(h ?? side.set(0, 1, 0).cross(up)).addScaledVector(up, -fwd.dot(up));
      if (fwd.lengthSq() < 1e-10) fwd.set(1, 0, 0).addScaledVector(up, -up.x);
      fwd.normalize();
      side.crossVectors(fwd, up);
      basis.makeBasis(fwd, up, side);
      target.setFromRotationMatrix(basis);
      // Snap (don't swing) when the model first appears or gets its first real direction of travel.
      if (fresh || (h && this.guessed.has(id))) obj.quaternion.copy(target); else obj.quaternion.slerp(target, ease);
      if (h) this.guessed.delete(id); else this.guessed.add(id);
      obj.visible = true;
    }
    for (const [id, inst] of this.instances) if (!keep.has(id)) inst.obj.visible = false;
    this.shownLast.clear();
    keep.forEach(id => this.shownLast.add(id));
  }

  private instanceFor(id: string): THREE.Object3D | null {
    const info = this.modelFor(id);
    const key = ModelLibrary.key(info);
    const existing = this.instances.get(id);
    if (existing && existing.key === key) return existing.obj;
    const template = this.library.templateNow(info);
    if (!template) return null;   // still loading (the dot stays visible meanwhile)
    if (existing) this.removeInstance(id);
    const obj = template.clone(true);
    this.group.add(obj);
    this.instances.set(id, { key, obj });
    return obj;
  }

  private removeInstance(id: string) {
    const inst = this.instances.get(id);
    if (!inst) return;
    this.group.remove(inst.obj);
    this.instances.delete(id);
  }

  private clearInstances() {
    for (const id of [...this.instances.keys()]) this.removeInstance(id);
  }

  /** Templates live in the shared library (reused by the next scene), so only the clones are dropped. */
  dispose() {
    this.clearInstances();
  }
}
