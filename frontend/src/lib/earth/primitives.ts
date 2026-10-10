// src/lib/earth/primitives.ts
// Point-sprite layers, fat lines and placeholder textures used by the Earth scene.

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { POINT_FRAG, POINT_VERT } from './shaders';

export class PointLayer {
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

  /** Rewrites only the positions of the first `count` points (per-frame motion; colours/sizes unchanged). */
  setPositions(count: number, fill: (i: number, pos: Float32Array) => void) {
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos || count === 0) return;
    for (let i = 0; i < count; i++) fill(i, pos.array as Float32Array);
    pos.needsUpdate = true;
  }

  setPixelRatio(ratio: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.pixelRatio.value = ratio;
  }

  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

export const placeholderTexture = (rgb: [number, number, number]) => {
  const t = new THREE.DataTexture(new Uint8Array([...rgb, 255]), 1, 1);
  t.name = 'placeholder';
  t.needsUpdate = true;
  return t;
};

export function makeLine(color: string, width: number, opacity: number, dashed = false): Line2 {
  const material = new LineMaterial({
    color: new THREE.Color(color).getHex(), linewidth: width, transparent: true, opacity, depthWrite: false,
    dashed, dashSize: 0.025, gapSize: 0.018,
  });
  const line = new Line2(new LineGeometry(), material);
  line.frustumCulled = false;
  line.visible = false;
  return line;
}

export function setLinePath(line: Line2, points: THREE.Vector3[]) {
  if (points.length < 2) { line.visible = false; return; }
  const flat = new Float32Array(points.length * 3);
  points.forEach((p, i) => p.toArray(flat, i * 3));
  line.geometry.dispose();
  line.geometry = new LineGeometry();
  line.geometry.setPositions(flat);
  if ((line.material as LineMaterial).dashed) line.computeLineDistances();
  line.visible = true;
}
