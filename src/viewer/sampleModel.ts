/**
 * Procedural sample: a single-storey studio (south & east glazing) on a site
 * with neighbouring buildings. Units: metres, Y-up, -Z = north.
 */
import * as THREE from 'three';

type V3 = [number, number, number];

function quads(qs: V3[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const [a, b, c, d] of qs) pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Axis-aligned box as 6 outward quads. */
function boxQuads(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, withBottom = false): V3[][] {
  const q: V3[][] = [
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], // top
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], // south (+z)
    [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], // north
    [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], // east
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], // west
  ];
  if (withBottom) q.push([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
  return q;
}

/**
 * A wall in a vertical plane with rectangular openings, decomposed into quads.
 * `axis` 'x': wall runs along x at constant z; 'z': runs along z at constant x.
 * Openings are [u0, u1, v0, v1] in wall-local coordinates (u along wall, v up).
 */
function wallWithOpenings(axis: 'x' | 'z', c: number, u0: number, u1: number, h: number, openings: number[][], facing: 1 | -1): { wall: V3[][]; glass: V3[][] } {
  const P = (u: number, v: number): V3 => (axis === 'x' ? [u, v, c] : [c, v, u]);
  const rect = (a: number, b: number, v0: number, v1: number): V3[] => {
    // order so the face normal points along `facing` on the wall's normal axis
    const flip = axis === 'x' ? facing < 0 : facing > 0;
    return flip ? [P(b, v0), P(a, v0), P(a, v1), P(b, v1)] : [P(a, v0), P(b, v0), P(b, v1), P(a, v1)];
  };
  const wall: V3[][] = [];
  const glass: V3[][] = [];
  const ops = [...openings].sort((a, b) => a[0] - b[0]);
  let cur = u0;
  for (const [a, b, v0, v1] of ops) {
    if (a > cur) wall.push(rect(cur, a, 0, h));
    wall.push(rect(a, b, 0, v0));
    wall.push(rect(a, b, v1, h));
    glass.push(rect(a, b, v0, v1));
    cur = b;
  }
  if (cur < u1) wall.push(rect(cur, u1, 0, h));
  return { wall, glass };
}

export function buildSampleModel(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Sample site';
  const add = (name: string, g: THREE.BufferGeometry) => {
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xdddddd }));
    m.name = name;
    group.add(m);
  };

  // site ground (slightly below the studio floor to avoid coincident faces)
  add('Ground', quads([[[-30, -0.02, -30], [-30, -0.02, 30], [30, -0.02, 30], [30, -0.02, -30]]]));

  // studio 10 m (x) × 8 m (z) × 3.2 m, origin at (-5..5, 0, -4..4)
  const H = 3.2;
  add('Studio_Floor', quads([[[-5, 0, -4], [-5, 0, 4], [5, 0, 4], [5, 0, -4]]]));
  add('Studio_Roof', quads([[[-5, H, -4], [-5, H, 4], [5, H, 4], [5, H, -4]]]));
  const south = wallWithOpenings('x', 4, -5, 5, H, [[-4, -1.2, 0.9, 2.6], [-0.6, 2.2, 0.9, 2.6], [2.8, 4.2, 0.9, 2.6]], 1);
  const east = wallWithOpenings('z', 5, -4, 4, H, [[-1.5, 1.5, 1.0, 2.4]], 1);
  const north = wallWithOpenings('x', -4, -5, 5, H, [], -1);
  const west = wallWithOpenings('z', -5, -4, 4, H, [], -1);
  add('Studio_Walls', quads([...south.wall, ...east.wall, ...north.wall, ...west.wall]));
  add('Studio_Window_Glass', quads([...south.glass, ...east.glass]));

  // context buildings
  add('Context_Block_SouthEast', quads(boxQuads(9, 0, 10, 21, 9, 22)));
  add('Context_Tower_West', quads(boxQuads(-22, 0, -8, -14, 18, 2)));
  add('Context_Block_North', quads(boxQuads(-8, 0, -24, 10, 12, -14)));
  return group;
}
