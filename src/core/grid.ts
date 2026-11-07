/**
 * Analysis grid generation (cf. Ladybug "Generate Point Grid" / Honeybee room
 * floor grids). Works on world-space triangle soups (xyz * 3 per triangle).
 */

export interface AnalysisGrid {
  sensors: Float32Array; // xyz per sensor
  normals: Float32Array; // xyz per sensor
  areas: Float32Array; // area represented by each sensor
  /** display mesh triangles (xyz * 3 per triangle) */
  triangles: Float32Array;
  /** sensor index for each display triangle */
  triSensor: Uint32Array;
}

class Builder {
  sensors: number[] = [];
  normals: number[] = [];
  areas: number[] = [];
  tris: number[] = [];
  triSensor: number[] = [];
  addSensor(p: number[], n: number[], area: number): number {
    this.sensors.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.areas.push(area);
    return this.areas.length - 1;
  }
  addTri(a: number[], b: number[], c: number[], sensor: number) {
    this.tris.push(...a, ...b, ...c);
    this.triSensor.push(sensor);
  }
  build(): AnalysisGrid {
    return {
      sensors: new Float32Array(this.sensors),
      normals: new Float32Array(this.normals),
      areas: new Float32Array(this.areas),
      triangles: new Float32Array(this.tris),
      triSensor: new Uint32Array(this.triSensor),
    };
  }
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);

/**
 * Subdivide each triangle into a barycentric lattice whose edges are ≤ gridSize;
 * one sensor per sub-triangle at its centroid, normal = face normal.
 */
export function surfaceGrid(tris: Float32Array, gridSize: number, flip = false, maxSensors = 60000): AnalysisGrid {
  const b = new Builder();
  const nt = tris.length / 9;
  for (let t = 0; t < nt; t++) {
    const A = [tris[t * 9], tris[t * 9 + 1], tris[t * 9 + 2]];
    let B = [tris[t * 9 + 3], tris[t * 9 + 4], tris[t * 9 + 5]];
    let C = [tris[t * 9 + 6], tris[t * 9 + 7], tris[t * 9 + 8]];
    if (flip) [B, C] = [C, B];
    const ab = sub(B, A), ac = sub(C, A);
    const cr = cross(ab, ac);
    const area2 = len(cr);
    if (area2 < 1e-10) continue;
    const nrm = [cr[0] / area2, cr[1] / area2, cr[2] / area2];
    const maxEdge = Math.max(len(ab), len(ac), len(sub(C, B)));
    const n = Math.min(500, Math.max(1, Math.ceil(maxEdge / gridSize)));
    const P = (i: number, j: number) => [A[0] + (ab[0] * i + ac[0] * j) / n, A[1] + (ab[1] * i + ac[1] * j) / n, A[2] + (ab[2] * i + ac[2] * j) / n];
    const subArea = area2 / 2 / (n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        const p0 = P(i, j), p1 = P(i + 1, j), p2 = P(i, j + 1);
        const c = [(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3, (p0[2] + p1[2] + p2[2]) / 3];
        b.addTri(p0, p1, p2, b.addSensor(c, nrm, subArea));
        if (i + j < n - 1) {
          const q0 = P(i + 1, j), q1 = P(i + 1, j + 1), q2 = P(i, j + 1);
          const d = [(q0[0] + q1[0] + q2[0]) / 3, (q0[1] + q1[1] + q2[1]) / 3, (q0[2] + q1[2] + q2[2]) / 3];
          b.addTri(q0, q1, q2, b.addSensor(d, nrm, subArea));
        }
        if (b.areas.length > maxSensors) throw new Error(`Grid exceeds ${maxSensors} sensors — increase the grid size.`);
      }
    }
  }
  return b.build();
}

/**
 * Horizontal work-plane grid above floor geometry (Honeybee-style room grid).
 * Upward-facing floor triangles are sampled on a regular XZ grid; each sensor
 * sits `height` above the floor and faces up.
 */
export function workPlaneGrid(tris: Float32Array, gridSize: number, height: number, maxSensors = 60000): AnalysisGrid {
  const b = new Builder();
  const nt = tris.length / 9;
  let minX = Infinity, minZ = Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    minX = Math.min(minX, tris[i]);
    minZ = Math.min(minZ, tris[i + 2]);
  }
  const seen = new Set<string>();
  const h = gridSize / 2;
  for (let t = 0; t < nt; t++) {
    const ax = tris[t * 9], ay = tris[t * 9 + 1], az = tris[t * 9 + 2];
    const bx = tris[t * 9 + 3], by = tris[t * 9 + 4], bz = tris[t * 9 + 5];
    const cx = tris[t * 9 + 6], cy = tris[t * 9 + 7], cz = tris[t * 9 + 8];
    const cr = cross([bx - ax, by - ay, bz - az], [cx - ax, cy - ay, cz - az]);
    const l = len(cr);
    if (l < 1e-10 || Math.abs(cr[1] / l) < 0.7) continue; // not horizontal enough
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-12) continue;
    const i0 = Math.floor((Math.min(ax, bx, cx) - minX) / gridSize);
    const i1 = Math.floor((Math.max(ax, bx, cx) - minX) / gridSize);
    const k0 = Math.floor((Math.min(az, bz, cz) - minZ) / gridSize);
    const k1 = Math.floor((Math.max(az, bz, cz) - minZ) / gridSize);
    for (let i = i0; i <= i1; i++) {
      for (let k = k0; k <= k1; k++) {
        const x = minX + (i + 0.5) * gridSize;
        const z = minZ + (k + 0.5) * gridSize;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        const y = l1 * ay + l2 * by + l3 * cy + height;
        const key = `${i},${k},${Math.round(y * 50)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const s = b.addSensor([x, y, z], [0, 1, 0], gridSize * gridSize);
        b.addTri([x - h, y, z + h], [x + h, y, z + h], [x + h, y, z - h], s);
        b.addTri([x - h, y, z + h], [x + h, y, z - h], [x - h, y, z - h], s);
        if (b.areas.length > maxSensors) throw new Error(`Grid exceeds ${maxSensors} sensors — increase the grid size.`);
      }
    }
  }
  return b.build();
}
