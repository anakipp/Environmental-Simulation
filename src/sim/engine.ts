/**
 * Ray-traced visibility engine.
 *
 * Every analysis is expressed as a set of weighted directions (sun vectors,
 * sky patches). For a sensor with normal n, the result is
 *
 *     value = Σ_i  w_i · f(n·d_i) · T(sensor, d_i)
 *
 * where T is 0 when an opaque surface blocks the ray and τ^k after crossing k
 * glazing surfaces. This mirrors how Ladybug's "Incident Radiation",
 * "Direct Sun Hours" and "Sky View" components intersect sky vectors with
 * context geometry, and Honeybee's daylight factor uses a CIE overcast sky.
 *
 * Optionally an approximate inter-reflected component is added: one diffuse
 * bounce via cosine-weighted hemisphere sampling, with an enclosure-based
 * multi-bounce estimate 1 / (1 − ρ·f_enclosed).
 */
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export type WeightMode = 'cosine' | 'count' | 'uniform';

export interface SceneData {
  opaque: Float32Array; // non-indexed triangle soup (xyz * 3 per triangle)
  glazing: Float32Array;
}

export interface BounceSettings {
  rays: number;
  reflectance: number;
  multi: boolean;
  /** sky used to evaluate the illuminance at bounce hit points */
  dirs: Float32Array;
  weights: Float32Array;
}

export interface JobData {
  sensors: Float32Array;
  normals: Float32Array;
  dirs: Float32Array;
  weights: Float32Array;
  mode: WeightMode;
  glazingTransmittance: number;
  glazingOpaque: boolean;
  offset: number;
  bounce?: BounceSettings;
}

export interface EngineContext {
  opaque: MeshBVH | null;
  glazing: MeshBVH | null;
}

function bvhFrom(tris: Float32Array): MeshBVH | null {
  if (!tris || tris.length < 9) return null;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(tris, 3));
  // three-mesh-bvh needs an index buffer; generate a trivial one
  const n = tris.length / 3;
  const index = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) index[i] = i;
  g.setIndex(new BufferAttribute(index, 1));
  return new MeshBVH(g, { targetLeafSize: 8 } as never);
}

export function buildContext(scene: SceneData): EngineContext {
  return { opaque: bvhFrom(scene.opaque), glazing: bvhFrom(scene.glazing) };
}

const ray = new Ray();
const NEAR = 1e-4;

interface TraceResult {
  t: number; // transmission 0..1
  hitDist: number; // Infinity when escaped
  hitNormal: Vector3 | null;
}

const scratchNormal = new Vector3();

function trace(ctx: EngineContext, job: { glazingTransmittance: number; glazingOpaque: boolean }, wantHit: boolean): TraceResult {
  let hitDist = Infinity;
  let hitNormal: Vector3 | null = null;
  if (ctx.opaque) {
    const hit = ctx.opaque.raycastFirst(ray, DoubleSide, NEAR, Infinity);
    if (hit) {
      hitDist = hit.distance;
      if (!wantHit) return { t: 0, hitDist, hitNormal: null };
      if (hit.face) hitNormal = scratchNormal.copy(hit.face.normal);
    }
  }
  let t = 1;
  if (ctx.glazing) {
    if (job.glazingOpaque) {
      const g = ctx.glazing.raycastFirst(ray, DoubleSide, NEAR, hitDist);
      if (g) return { t: 0, hitDist: g.distance, hitNormal: null };
    } else {
      const hits = ctx.glazing.raycast(ray, DoubleSide, NEAR, hitDist);
      if (hits.length) {
        // count distinct panes (coincident/double faces within 1 mm count once)
        hits.sort((a, b) => a.distance - b.distance);
        let k = 0;
        let last = -1;
        for (const h of hits) {
          if (h.distance - last > 1e-3) k++;
          last = h.distance;
        }
        t = Math.pow(job.glazingTransmittance, k);
      }
    }
  }
  if (hitNormal && Number.isFinite(hitDist)) return { t, hitDist, hitNormal };
  return { t, hitDist, hitNormal: null };
}

/** Illuminance-style weighted visibility for one point. */
function evaluatePoint(
  ctx: EngineContext,
  job: JobData,
  px: number, py: number, pz: number,
  nx: number, ny: number, nz: number,
  dirs: Float32Array, weights: Float32Array, mode: WeightMode,
): number {
  let sum = 0;
  const nd = weights.length;
  for (let i = 0; i < nd; i++) {
    const w = weights[i];
    if (w === 0) continue;
    const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
    const cos = nx * dx + ny * dy + nz * dz;
    if (cos <= 1e-6) continue;
    ray.origin.set(px, py, pz);
    ray.direction.set(dx, dy, dz);
    const r = trace(ctx, job, false);
    if (r.t <= 0 || Number.isFinite(r.hitDist)) continue;
    if (mode === 'cosine') sum += w * cos * r.t;
    else if (mode === 'uniform') sum += w * r.t;
    else sum += w; // count: visible at all
  }
  return sum;
}

/** Deterministic low-discrepancy (Hammersley) cosine-weighted hemisphere samples. */
function hemisphereSamples(n: number): Float32Array {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let bits = i;
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
    bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
    bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
    const u = (i + 0.5) / n;
    const v = bits / 4294967296;
    const r = Math.sqrt(u);
    const phi = 2 * Math.PI * v;
    out[i * 3] = r * Math.cos(phi);
    out[i * 3 + 1] = r * Math.sin(phi);
    out[i * 3 + 2] = Math.sqrt(Math.max(0, 1 - u));
  }
  return out;
}

/**
 * Compute sensors [start, end) into `out`. Separated so callers can chunk
 * work (progress reporting / keeping a main-thread fallback responsive).
 */
export function computeRange(ctx: EngineContext, job: JobData, start: number, end: number, out: Float32Array, samples?: Float32Array) {
  const { sensors, normals, offset } = job;
  for (let s = start; s < end; s++) {
    const nx = normals[s * 3], ny = normals[s * 3 + 1], nz = normals[s * 3 + 2];
    const px = sensors[s * 3] + nx * offset;
    const py = sensors[s * 3 + 1] + ny * offset;
    const pz = sensors[s * 3 + 2] + nz * offset;
    let v = evaluatePoint(ctx, job, px, py, pz, nx, ny, nz, job.dirs, job.weights, job.mode);

    if (job.bounce && samples && ctx.opaque) {
      const b = job.bounce;
      // tangent frame around n
      const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
      let tx = ny * 0 - nz * ay, ty = nz * ax - nx * 0, tz = nx * ay - ny * ax;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      let reflected = 0;
      let hits = 0;
      const n = samples.length / 3;
      for (let k = 0; k < n; k++) {
        const a = samples[k * 3], c = samples[k * 3 + 1], h = samples[k * 3 + 2];
        const dx = tx * a + bx * c + nx * h;
        const dy = ty * a + by * c + ny * h;
        const dz = tz * a + bz * c + nz * h;
        ray.origin.set(px, py, pz);
        ray.direction.set(dx, dy, dz);
        const r = trace(ctx, job, true);
        if (!Number.isFinite(r.hitDist) || !r.hitNormal || r.t <= 0) continue;
        hits++;
        let hnx = r.hitNormal.x, hny = r.hitNormal.y, hnz = r.hitNormal.z;
        if (hnx * dx + hny * dy + hnz * dz > 0) { hnx = -hnx; hny = -hny; hnz = -hnz; }
        const pathT = r.t;
        const hx = px + dx * r.hitDist + hnx * 1e-3;
        const hy = py + dy * r.hitDist + hny * 1e-3;
        const hz = pz + dz * r.hitDist + hnz * 1e-3;
        const eHit = evaluatePoint(ctx, job, hx, hy, hz, hnx, hny, hnz, b.dirs, b.weights, 'cosine');
        reflected += b.reflectance * eHit * pathT;
      }
      if (n > 0) {
        let e = reflected / n;
        if (b.multi) e /= Math.max(0.05, 1 - b.reflectance * (hits / n));
        v += e;
      }
    }
    out[s] = v;
  }
}

export function makeSamples(job: JobData): Float32Array | undefined {
  return job.bounce ? hemisphereSamples(Math.max(4, job.bounce.rays)) : undefined;
}

/** Synchronous whole-job run with progress callback (used inside the worker). */
export function runJob(ctx: EngineContext, job: JobData, onProgress?: (f: number) => void): Float32Array {
  const n = job.sensors.length / 3;
  const out = new Float32Array(n);
  const samples = makeSamples(job);
  const chunk = Math.max(1, Math.floor(n / 100));
  for (let s = 0; s < n; s += chunk) {
    computeRange(ctx, job, s, Math.min(n, s + chunk), out, samples);
    onProgress?.(Math.min(1, (s + chunk) / n));
  }
  return out;
}
