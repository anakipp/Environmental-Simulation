import { describe, expect, it } from 'vitest';
import { boxTriangles, roomGeometry, apertureRect, findPanes, flipPane, shadeTriangles, DEFAULT_SHADE } from '../src/model/generators';

function area(tris: Float32Array) {
  let a = 0;
  for (let t = 0; t < tris.length / 9; t++) {
    const v = (k: number) => [tris[t * 9 + k * 3], tris[t * 9 + k * 3 + 1], tris[t * 9 + k * 3 + 2]];
    const [p0, p1, p2] = [v(0), v(1), v(2)];
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    a += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
  }
  return a;
}

describe('box', () => {
  it('has the surface area of the box', () => {
    expect(area(boxTriangles({ width: 2, depth: 3, height: 4 }))).toBeCloseTo(2 * (6 + 8 + 12), 5);
  });
});

describe('room', () => {
  const p = { width: 10, depth: 8, height: 3, sill: 0.9, windowHeight: 1.5, wwr: { s: 0.4, e: 0.2, n: 0, w: 0 } };
  it('hits the target window-to-wall ratio', () => {
    const g = roomGeometry(p);
    expect(g.achieved.s).toBeCloseTo(0.4, 3);
    expect(g.achieved.e).toBeCloseTo(0.2, 3);
    expect(g.achieved.n).toBe(0);
    expect(area(g.glazing)).toBeCloseTo(0.4 * 30 + 0.2 * 24, 3);
  });
  it('walls + glazing cover the full facade area', () => {
    const g = roomGeometry(p);
    expect(area(g.walls) + area(g.glazing)).toBeCloseTo(2 * (10 * 3 + 8 * 3), 3);
  });
  it('glazing faces outward on the south wall', () => {
    const g = roomGeometry({ ...p, wwr: { s: 0.4, e: 0, n: 0, w: 0 } });
    const panes = findPanes(g.glazing);
    expect(panes.length).toBe(1);
    expect(panes[0].normal[2]).toBeCloseTo(1, 5);
  });
  it('very high ratios grow the window and stay inside the wall', () => {
    const r = apertureRect(10, 3, 0.9, 0.9, 1.5)!;
    expect(r[0]).toBeGreaterThanOrEqual(-5);
    expect(r[3]).toBeLessThanOrEqual(3);
    expect(apertureRect(10, 3, 0, 0.9, 1.5)).toBeNull();
  });
});

describe('panes and shading', () => {
  // two separate south-facing windows on z = 4
  const g = roomGeometry({ width: 10, depth: 8, height: 3, sill: 1, windowHeight: 1.5, wwr: { s: 0.3, e: 0.3, n: 0, w: 0 } });
  const panes = findPanes(g.glazing);
  it('finds one pane per window', () => {
    expect(panes.length).toBe(2);
    const south = panes.find((q) => q.normal[2] > 0.9)!;
    expect(south.v1 - south.v0).toBeCloseTo(1.5, 3);
    expect(south.u1 - south.u0).toBeCloseTo((0.3 * 30) / 1.5, 3);
  });
  it('overhang sits above the window head and projects outward', () => {
    const south = panes.find((q) => q.normal[2] > 0.9)!;
    const t = shadeTriangles([south], { ...DEFAULT_SHADE, depth: 1, offset: 0.1, extension: 0 });
    let maxZ = -Infinity, minY = Infinity;
    for (let i = 0; i < t.length; i += 3) { maxZ = Math.max(maxZ, t[i + 2]); minY = Math.min(minY, t[i + 1]); }
    expect(maxZ).toBeCloseTo(4 + 1, 4);
    expect(minY).toBeCloseTo(1 + 1.5 + 0.1, 4);
    expect(area(t)).toBeCloseTo((south.u1 - south.u0) * 1, 4);
  });
  it('louvers and fins produce one quad per element', () => {
    expect(shadeTriangles(panes, { ...DEFAULT_SHADE, type: 'louvers', count: 5 }).length).toBe(2 * 5 * 18);
    expect(shadeTriangles(panes, { ...DEFAULT_SHADE, type: 'fins', count: 3 }).length).toBe(2 * 3 * 18);
  });
  it('flipping a pane keeps its rectangle', () => {
    const f = flipPane(panes[0]);
    expect(f.u1 - f.u0).toBeCloseTo(panes[0].u1 - panes[0].u0, 6);
    expect(f.normal[0] + panes[0].normal[0]).toBeCloseTo(0, 6);
  });
});
