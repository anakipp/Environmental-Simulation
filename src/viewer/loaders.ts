import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

export const SUPPORTED_EXTENSIONS = ['obj', 'stl', 'glb', 'gltf', 'ply'];

/** Load a 3D file into a THREE.Object3D (unscaled, as authored). */
export async function loadModelFile(file: File): Promise<THREE.Object3D> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const base = file.name.replace(/\.[^.]+$/, '');
  switch (ext) {
    case 'obj': {
      const obj = new OBJLoader().parse(await file.text());
      obj.name = base;
      return obj;
    }
    case 'stl': {
      const g = new STLLoader().parse(await file.arrayBuffer());
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
      m.name = base;
      return m;
    }
    case 'ply': {
      const g = new PLYLoader().parse(await file.arrayBuffer());
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
      m.name = base;
      return m;
    }
    case 'glb':
    case 'gltf': {
      const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
      const gltf = await new GLTFLoader().parseAsync(data, '');
      gltf.scene.name = base;
      return gltf.scene;
    }
    default:
      throw new Error(`Unsupported file type ".${ext}". Use ${SUPPORTED_EXTENSIONS.map((e) => '.' + e).join(', ')}.`);
  }
}

/** Unit scale factors to metres. */
export const UNIT_SCALE: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };

/** Collect meshes with a usable name. */
export function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry?.attributes?.position) out.push(m);
  });
  return out;
}

export function meshLabel(m: THREE.Mesh, i: number): string {
  const mat = Array.isArray(m.material) ? m.material[0] : m.material;
  return m.name || m.parent?.name || mat?.name || `Mesh ${i + 1}`;
}

export type Role = 'context' | 'glazing' | 'analysis' | 'floor' | 'ignore';

export const ROLE_LABELS: Record<Role, string> = {
  context: 'Context (opaque)',
  analysis: 'Analysis surface',
  floor: 'Floor → work plane',
  glazing: 'Glazing',
  ignore: 'Ignore',
};

export function guessRole(name: string, matName = ''): Role {
  const s = `${name} ${matName}`.toLowerCase();
  if (/glass|glaz|window|vitr|fenster|curtain|pane/.test(s)) return 'glazing';
  if (/floor|slab/.test(s)) return 'floor';
  if (/ground|site|terrain|plaza|landscape/.test(s)) return 'analysis';
  return 'context';
}

/** World-space, non-indexed triangle soup for a mesh. */
export function worldTriangles(mesh: THREE.Mesh): Float32Array {
  mesh.updateWorldMatrix(true, false);
  const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const pos = g.attributes.position;
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  if (g !== mesh.geometry) g.dispose();
  return out;
}

export function concatFloat32(arrays: Float32Array[]): Float32Array {
  const n = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
