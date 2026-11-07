import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sunPosition, periodHours, FULL_YEAR, dayOfYear, monthDayFromDoy } from '../src/core/solar';
import { skyPatches, countPatches, patchIndex, daylightSkyDirections, cumulativeSky } from '../src/core/sky';
import { pmv, adaptiveComfort } from '../src/core/comfort';
import { parseEPW } from '../src/core/weather';
import { surfaceGrid, workPlaneGrid } from '../src/core/grid';
import { buildContext, runJob } from '../src/sim/engine';

const sf = { name: 'SF', latitude: 37.62, longitude: -122.4, timeZone: -8, elevation: 2 };

describe('solar', () => {
  it('equinox solar-noon altitude ≈ 90 − latitude', () => {
    // solar noon in SF on Mar 20 is ≈ 12:17 PST
    let best = -90;
    for (let h = 11; h < 13.5; h += 0.01) best = Math.max(best, sunPosition(sf, 3, 20, h).altitude);
    expect(best).toBeGreaterThan(90 - 37.62 - 1);
    expect(best).toBeLessThan(90 - 37.62 + 1);
  });
  it('summer solstice morning sun rises north of east', () => {
    const s = sunPosition(sf, 6, 21, 6);
    expect(s.azimuth).toBeGreaterThan(55);
    expect(s.azimuth).toBeLessThan(70);
  });
  it('south sun vector points to -Y north / +Z scene', () => {
    const s = sunPosition(sf, 12, 21, 12.2);
    expect(s.vector[2]).toBeGreaterThan(0.5); // south = +Z
    expect(Math.hypot(...s.vector)).toBeCloseTo(1, 5);
  });
  it('periods', () => {
    expect(periodHours(FULL_YEAR).length).toBe(8760);
    expect(periodHours({ stMonth: 12, stDay: 21, stHour: 9, endMonth: 12, endDay: 21, endHour: 15 }).length).toBe(7);
    expect(monthDayFromDoy(dayOfYear(7, 4))).toEqual({ month: 7, day: 4 });
  });
});

describe('sky', () => {
  it('Tregenza / Reinhart patch counts and solid angles', () => {
    expect(skyPatches(1).length).toBe(145);
    expect(countPatches(2)).toBe(577);
    expect(skyPatches(2).length).toBe(577);
    const total = skyPatches(1).reduce((s, p) => s + p.solidAngle, 0);
    expect(total).toBeCloseTo(2 * Math.PI, 6);
  });
  it('patch lookup', () => {
    expect(patchIndex(5, 0)).toBe(0);
    expect(patchIndex(89, 10)).toBe(144);
    expect(patchIndex(13, 12)).toBe(31);
  });
  it('overcast sky normalises to the requested horizontal illuminance', () => {
    const s = daylightSkyDirections({ sky: 'overcast', mf: 1, northAngle: 0, diffuseHorizontal: 10000, directNormal: 0, groundReflectance: 0.2, includeGround: false });
    let e = 0;
    for (let i = 0; i < s.weights.length; i++) e += s.weights[i] * Math.max(0, s.dirs[i * 3 + 1]);
    expect(e).toBeCloseTo(10000, 0);
  });
});

describe('comfort', () => {
  it('ISO 7730 example (22 °C, 60 %, 1.2 met, 0.5 clo, 0.1 m/s) ≈ −0.75', () => {
    const r = pmv({ ta: 22, tr: 22, vel: 0.1, rh: 60, met: 1.2, clo: 0.5 });
    expect(r.pmv).toBeCloseTo(-0.75, 1);
    expect(r.ppd).toBeGreaterThan(15);
    expect(r.ppd).toBeLessThan(19);
  });
  it('adaptive comfort shape', () => {
    const t = new Float32Array(8760).fill(22);
    const r = adaptiveComfort(t);
    expect(r.condition.every((c) => c === 0)).toBe(true);
  });
});

describe('weather + engine', () => {
  const epw = parseEPW(readFileSync('public/weather/USA_CA_San.Francisco.Intl.AP.724940_TMY3.epw', 'utf8'));
  it('parses EPW', () => {
    expect(epw.location.latitude).toBeCloseTo(37.62, 2);
    expect(epw.dryBulb.length).toBe(8760);
    const ghi = epw.ghi.reduce((a, b) => a + b, 0) / 1000;
    expect(ghi).toBeGreaterThan(1500); // SF ≈ 1,700 kWh/m²·yr
    expect(ghi).toBeLessThan(2000);
  });
  it('unobstructed horizontal radiation ≈ annual GHI', () => {
    const sky = cumulativeSky(epw, { mf: 1, northAngle: 0, includeGround: false, groundReflectance: 0.2, hours: periodHours(FULL_YEAR) });
    let e = 0;
    sky.patches.forEach((p, i) => (e += sky.values[i] * Math.max(0, p.dir[1])));
    const ghi = epw.ghi.reduce((a, b) => a + b, 0) / 1000;
    expect(Math.abs(e - ghi) / ghi).toBeLessThan(0.08);
  });
  it('a roof blocks the sky for a sensor beneath it', () => {
    const roof = new Float32Array([-20, 3, -20, -20, 3, 20, 20, 3, 20, -20, 3, -20, 20, 3, 20, 20, 3, -20]);
    const ctx = buildContext({ opaque: roof, glazing: new Float32Array(0) });
    const sky = daylightSkyDirections({ sky: 'overcast', mf: 1, northAngle: 0, diffuseHorizontal: 100, directNormal: 0, groundReflectance: 0, includeGround: false });
    const job = { sensors: new Float32Array([0, 0, 0, 60, 0, 0]), normals: new Float32Array([0, 1, 0, 0, 1, 0]), dirs: sky.dirs, weights: sky.weights, mode: 'cosine' as const, glazingTransmittance: 0.6, glazingOpaque: false, offset: 0.01 };
    const v = runJob(ctx, job);
    expect(v[0]).toBeLessThan(10);
    expect(v[1]).toBeGreaterThan(80);
    // the same roof as glazing transmits τ
    const ctxG = buildContext({ opaque: new Float32Array(0), glazing: roof });
    const vg = runJob(ctxG, job);
    expect(vg[1]).toBeCloseTo(100, 0);
    expect(vg[0]).toBeGreaterThan(55);
    expect(vg[0]).toBeLessThan(100);
  });
});

describe('grids', () => {
  const quad = new Float32Array([0, 0, 0, 0, 0, 4, 4, 0, 4, 0, 0, 0, 4, 0, 4, 4, 0, 0]);
  it('surface grid preserves area', () => {
    const g = surfaceGrid(quad, 1);
    expect(g.areas.reduce((a, b) => a + b, 0)).toBeCloseTo(16, 5);
    expect(g.normals[1]).toBeCloseTo(1, 5);
  });
  it('work plane grid', () => {
    const g = workPlaneGrid(quad, 1, 0.8);
    expect(g.sensors.length / 3).toBe(16);
    expect(g.sensors[1]).toBeCloseTo(0.8, 5);
  });
});
