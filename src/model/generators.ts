/**
 * Parametric geometry generators (pure, no three.js).
 * All output is a triangle soup: Float32Array of xyz per vertex, 3 vertices per triangle.
 *
 * Local frames: Y up, metres. A room's local +Z is its "south" facade before rotation
 * (matches the scene convention where −Z is north at north angle 0).
 *
 * References: Honeybee "HB Room from Solid" + "HB Apertures by Ratio" for rooms,
 * "HB Louver Shades" / "HB Extruded Border Shades" for shading devices.
 */

export type V3 = [number, number, number];

function pushQuad(out: number[], a: V3, b: V3, c: V3, d: V3) {
  out.push(...a, ...b, ...c, ...a, ...c, ...d);
}

// ---------------------------------------------------------------- box
export interface BoxParams {
  width: number; // x
  depth: number; // z
  height: number; // y
}

/** Closed box with its base centred on the origin, outward-facing quads. */
export function boxTriangles(p: BoxParams): Float32Array {
  const x0 = -p.width / 2, x1 = p.width / 2, z0 = -p.depth / 2, z1 = p.depth / 2, y0 = 0, y1 = p.height;
  const o: number[] = [];
  pushQuad(o, [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); // top
  pushQuad(o, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // bottom
  pushQuad(o, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z
  pushQuad(o, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -z
  pushQuad(o, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +x
  pushQuad(o, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -x
  return new Float32Array(o);
}

// ---------------------------------------------------------------- room
export type Facade = 's' | 'e' | 'n' | 'w';
export const FACADES: { key: Facade; label: string }[] = [
  { key: 's', label: 'South (+Z)' },
  { key: 'e', label: 'East (+X)' },
  { key: 'n', label: 'North (−Z)' },
  { key: 'w', label: 'West (−X)' },
];

export interface RoomParams {
  width: number; // x
  depth: number; // z
  height: number; // floor to ceiling
  sill: number; // window sill height
  windowHeight: number; // preferred strip-window height
  /** window-to-wall ratio per facade, 0..0.9 */
  wwr: Record<Facade, number>;
}

export interface RoomGeometry {
  floor: Float32Array;
  roof: Float32Array;
  walls: Float32Array;
  glazing: Float32Array;
  /** achieved window-to-wall ratio per facade */
  achieved: Record<Facade, number>;
}

/**
 * Window rectangle in wall coordinates (u along the wall centred on 0, v up from the floor),
 * sized to the target ratio like HB Apertures by Ratio: a centred strip window of the
 * preferred height, widened to the target area, growing taller only if the wall runs out.
 */
export function apertureRect(wallW: number, wallH: number, ratio: number, sill: number, windowHeight: number): [number, number, number, number] | null {
  const r = Math.min(0.95, Math.max(0, ratio));
  if (r < 0.005 || wallW <= 0.3 || wallH <= 0.4) return null;
  const margin = 0.1;
  const maxW = wallW - 2 * margin;
  const head = wallH - margin;
  const area = Math.min(r * wallW * wallH, maxW * (head - 0.02));
  let s = Math.min(Math.max(0.02, sill), head - 0.2);
  let h = Math.min(Math.max(0.2, windowHeight), head - s);
  let w = area / h;
  if (w > maxW) {
    w = maxW;
    h = area / w;
    if (s + h > head) s = Math.max(0.02, head - h);
    h = Math.min(h, head - s);
  }
  return [-w / 2, w / 2, s, s + h];
}

/** Wall plane with an optional opening, as quads. Wall faces along `normal` (unit x or z axis). */
function wallQuads(
  out: number[],
  glass: number[],
  axis: 'x' | 'z',
  c: number,
  half: number,
  h: number,
  facing: 1 | -1,
  opening: [number, number, number, number] | null,
) {
  // u runs along the wall: for an 'x' wall (constant z) u = x; for a 'z' wall (constant x) u = z
  const P = (u: number, v: number): V3 => (axis === 'x' ? [u, v, c] : [c, v, u]);
  const flip = axis === 'x' ? facing < 0 : facing > 0;
  const rect = (o: number[], a: number, b: number, v0: number, v1: number) => {
    if (b - a < 1e-6 || v1 - v0 < 1e-6) return;
    if (flip) pushQuad(o, P(b, v0), P(a, v0), P(a, v1), P(b, v1));
    else pushQuad(o, P(a, v0), P(b, v0), P(b, v1), P(a, v1));
  };
  if (!opening) {
    rect(out, -half, half, 0, h);
    return;
  }
  // wall-local u is measured with u increasing along +x / +z
  const [u0, u1, v0, v1] = opening;
  rect(out, -half, u0, 0, h);
  rect(out, u1, half, 0, h);
  rect(out, u0, u1, 0, v0);
  rect(out, u0, u1, v1, h);
  rect(glass, u0, u1, v0, v1);
}

export function roomGeometry(p: RoomParams): RoomGeometry {
  const W = Math.max(0.5, p.width), D = Math.max(0.5, p.depth), H = Math.max(1, p.height);
  const hx = W / 2, hz = D / 2;
  const floor: number[] = [], roof: number[] = [], walls: number[] = [], glass: number[] = [];
  pushQuad(floor, [-hx, 0, -hz], [-hx, 0, hz], [hx, 0, hz], [hx, 0, -hz]);
  pushQuad(roof, [-hx, H, -hz], [-hx, H, hz], [hx, H, hz], [hx, H, -hz]);
  const achieved = { s: 0, e: 0, n: 0, w: 0 } as Record<Facade, number>;
  const spec: [Facade, 'x' | 'z', number, number, 1 | -1][] = [
    ['s', 'x', hz, W, 1],
    ['n', 'x', -hz, W, -1],
    ['e', 'z', hx, D, 1],
    ['w', 'z', -hx, D, -1],
  ];
  for (const [f, axis, c, len, facing] of spec) {
    const op = apertureRect(len, H, p.wwr[f] ?? 0, p.sill, p.windowHeight);
    achieved[f] = op ? ((op[1] - op[0]) * (op[3] - op[2])) / (len * H) : 0;
    wallQuads(walls, glass, axis, c, len / 2, H, facing, op);
  }
  return {
    floor: new Float32Array(floor),
    roof: new Float32Array(roof),
    walls: new Float32Array(walls),
    glazing: new Float32Array(glass),
    achieved,
  };
}

// ---------------------------------------------------------------- panes
export interface Pane {
  center: V3;
  normal: V3; // unit, sign as authored (orient before use)
  right: V3;
  up: V3;
  /** extents in (right, up) about `center` */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  area: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Split a glazing triangle soup into planar panes: triangles that share a vertex
 * (1 mm tolerance) and are parallel are merged. Only vertical-ish panes
 * (|normal.y| < 0.5) are returned — shading devices are for wall windows.
 */
export function findPanes(tris: Float32Array): Pane[] {
  const nt = Math.floor(tris.length / 9);
  const parent = Array.from({ length: nt }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const normals: V3[] = [];
  const areas: number[] = [];
  const vtx = (t: number, k: number): V3 => [tris[t * 9 + k * 3], tris[t * 9 + k * 3 + 1], tris[t * 9 + k * 3 + 2]];
  for (let t = 0; t < nt; t++) {
    const c = cross(sub(vtx(t, 1), vtx(t, 0)), sub(vtx(t, 2), vtx(t, 0)));
    const l = Math.hypot(...c);
    areas.push(l / 2);
    normals.push(l > 1e-12 ? [c[0] / l, c[1] / l, c[2] / l] : [0, 0, 0]);
  }
  const byVertex = new Map<string, number[]>();
  for (let t = 0; t < nt; t++) {
    if (areas[t] < 1e-10) continue;
    for (let k = 0; k < 3; k++) {
      const v = vtx(t, k);
      const key = `${Math.round(v[0] * 1000)},${Math.round(v[1] * 1000)},${Math.round(v[2] * 1000)}`;
      const list = byVertex.get(key);
      if (list) {
        for (const o of list) if (Math.abs(dot(normals[t], normals[o])) > 0.98) parent[find(t)] = find(o);
        list.push(t);
      } else byVertex.set(key, [t]);
    }
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) {
    if (areas[t] < 1e-10) continue;
    const r = find(t);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(t);
  }
  const panes: Pane[] = [];
  for (const ts of groups.values()) {
    const ref = normals[ts[0]];
    let n: V3 = [0, 0, 0];
    let area = 0;
    let c: V3 = [0, 0, 0];
    for (const t of ts) {
      const s = dot(normals[t], ref) < 0 ? -1 : 1;
      n = add(n, mul(normals[t], s * areas[t]));
      area += areas[t];
      const cen = mul(add(add(vtx(t, 0), vtx(t, 1)), vtx(t, 2)), 1 / 3);
      c = add(c, mul(cen, areas[t]));
    }
    if (area < 1e-6) continue;
    n = norm(n);
    if (Math.abs(n[1]) >= 0.5) continue;
    c = mul(c, 1 / area);
    const up = norm(sub([0, 1, 0], mul(n, n[1])));
    const right = cross(up, n);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const t of ts) {
      for (let k = 0; k < 3; k++) {
        const d = sub(vtx(t, k), c);
        const u = dot(d, right), v = dot(d, up);
        u0 = Math.min(u0, u); u1 = Math.max(u1, u);
        v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
    }
    panes.push({ center: c, normal: n, right, up, u0, u1, v0, v1, area });
  }
  return panes;
}

/** Flip a pane so `normal` points the other way (keeps a right-handed frame). */
export function flipPane(p: Pane): Pane {
  const normal = mul(p.normal, -1);
  const right = cross(p.up, normal);
  // u coordinates mirror when right flips
  return { ...p, normal, right, u0: -p.u1, u1: -p.u0 };
}

// ---------------------------------------------------------------- shading devices
export type ShadeType = 'overhang' | 'fins' | 'louvers';

export interface ShadeParams {
  type: ShadeType;
  depth: number; // how far the device projects from the glass (m)
  count: number; // louvers: number of slats; fins: number of fins across the window
  angle: number; // deg. louvers: downward tilt; fins: rotation about vertical; overhang: downward tilt
  offset: number; // overhang: height above the window head; louvers/fins: gap from the glass
  extension: number; // overhang: extension beyond each side of the window
}

export const DEFAULT_SHADE: ShadeParams = { type: 'overhang', depth: 0.8, count: 4, angle: 0, offset: 0.1, extension: 0.3 };

/** Shading-device surfaces (thin, single-sided quads) for outward-oriented panes. */
export function shadeTriangles(panes: Pane[], p: ShadeParams): Float32Array {
  const o: number[] = [];
  const a = (p.angle * Math.PI) / 180;
  const depth = Math.max(0.01, p.depth);
  for (const pane of panes) {
    const { center: c, normal: n, right: r, up } = pane;
    const at = (u: number, v: number, w = 0): V3 => add(add(add(c, mul(r, u)), mul(up, v)), mul(n, w));
    if (p.type === 'overhang') {
      const v = pane.v1 + Math.max(0, p.offset);
      const e = Math.max(0, p.extension);
      // tilt downward by angle as the overhang projects outward
      const dir = add(mul(n, Math.cos(a) * depth), mul(up, -Math.sin(a) * depth));
      const b0 = at(pane.u0 - e, v), b1 = at(pane.u1 + e, v);
      pushQuad(o, b0, b1, add(b1, dir), add(b0, dir));
    } else if (p.type === 'louvers') {
      const k = Math.max(1, Math.round(p.count));
      const gap = Math.max(0, p.offset);
      const dir = add(mul(n, Math.cos(a) * depth), mul(up, -Math.sin(a) * depth));
      for (let i = 0; i < k; i++) {
        const v = pane.v0 + ((i + 1) / k) * (pane.v1 - pane.v0);
        const b0 = at(pane.u0, v, gap), b1 = at(pane.u1, v, gap);
        pushQuad(o, b0, b1, add(b1, dir), add(b0, dir));
      }
    } else {
      const k = Math.max(1, Math.round(p.count));
      const gap = Math.max(0, p.offset);
      const dir = add(mul(n, Math.cos(a) * depth), mul(r, Math.sin(a) * depth));
      for (let i = 0; i < k; i++) {
        const u = k === 1 ? (pane.u0 + pane.u1) / 2 : pane.u0 + (i / (k - 1)) * (pane.u1 - pane.u0);
        const b0 = at(u, pane.v0, gap), b1 = at(u, pane.v1 + 0.05, gap);
        pushQuad(o, b0, add(b0, dir), add(b1, dir), b1);
      }
    }
  }
  return new Float32Array(o);
}
