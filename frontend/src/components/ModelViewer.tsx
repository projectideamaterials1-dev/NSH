// src/components/ModelViewer.tsx
// Full-size, rotatable view of the 3D model a satellite is drawn with on the globe.

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Loader2 } from 'lucide-react';
import { ModelLibrary } from '../lib/satelliteModels';
import { Modal } from './ui';

export const ModelViewer: React.FC<{ satelliteId: string; onClose: () => void }> = ({ satelliteId, onClose }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const library = ModelLibrary.get();
  const [info, setInfo] = useState(() => library.modelFor(satelliteId));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    library.ready.then(() => { if (!cancelled) setInfo(library.modelFor(satelliteId)); });
    return () => { cancelled = true; };
  }, [library, satelliteId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
    camera.position.set(3.2, 1.8, 3.6);
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.position.set(5, 6, 4);
    const rim = new THREE.DirectionalLight(0x8fb4ff, 1.2);
    rim.position.set(-6, -2, -4);
    scene.add(sun, rim, new THREE.AmbientLight(0xffffff, 0.4));
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envMap;
    pmrem.dispose();

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.2;
    controls.minDistance = 1.5;
    controls.maxDistance = 12;
    controls.addEventListener('start', () => { controls.autoRotate = false; });

    let model: THREE.Object3D | null = null;
    let disposed = false;
    library.template(info).then(t => {
      if (disposed) return;
      model = t.clone(true);
      scene.add(model);
      setLoading(false);
    });

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      if (model) scene.remove(model);   // the template's geometry/materials are shared with the globe
      envMap.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [library, info]);

  return (
    <Modal
      title={`${satelliteId} — 3D model`}
      subtitle={`${info.title}${info.exact ? '' : ' (representative of its type)'} · ${info.credit ?? 'illustrative model built into the dashboard'}`}
      onClose={onClose}
      width={900}
    >
      <div className="p-4">
        <div ref={hostRef} className="relative h-[60vh] rounded-lg overflow-hidden"
          style={{ background: 'radial-gradient(ellipse at 50% 40%, #16202c 0%, #06080c 75%)' }}>
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-muted">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading model…
            </div>
          )}
        </div>
        <p className="text-[12px] text-faint mt-2">Drag to rotate · scroll to zoom. On the globe the same model is drawn at a constant on-screen size (not to scale).</p>
      </div>
    </Modal>
  );
};

export default ModelViewer;
