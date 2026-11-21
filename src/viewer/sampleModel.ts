/**
 * Sample site: a parametric single-storey studio (south & east glazing) between
 * three neighbouring blocks, on a 60 × 60 m ground plane. Units: metres, Y-up, −Z = north.
 * Everything except the ground is a generated part, so it can be edited and optimized.
 */
import * as THREE from 'three';
import type { ModelEditor } from '../model/editor';

export function loadSampleSite(editor: ModelEditor) {
  const ground = new THREE.BufferGeometry();
  ground.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-30, -0.02, -30, -30, -0.02, 30, 30, -0.02, 30, -30, -0.02, -30, 30, -0.02, 30, 30, -0.02, -30], 3),
  );
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(ground);
  mesh.name = 'Ground';
  g.add(mesh);
  editor.importObject(g, { Ground: 'analysis' });

  editor.addRoom(
    { width: 10, depth: 8, height: 3.2, sill: 0.9, windowHeight: 1.7, wwr: { s: 0.45, e: 0.2, n: 0, w: 0 } },
    new THREE.Vector3(0, 0, 0), 0, 'Studio',
  );
  editor.addBox({ width: 12, depth: 12, height: 9 }, new THREE.Vector3(15, 0, 16), 'Context block SE');
  editor.addBox({ width: 8, depth: 10, height: 18 }, new THREE.Vector3(-18, 0, -3), 'Context tower W');
  editor.addBox({ width: 18, depth: 10, height: 12 }, new THREE.Vector3(1, 0, -19), 'Context block N');
}
