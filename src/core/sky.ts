/**
 * Sky subdivision and sky models.
 *
 * - Tregenza (145 patches) / Reinhart (MF 2 → 577 patches) subdivision, as used by
 *   Ladybug's cumulative sky matrix and Honeybee-Radiance.
 * - Cumulative sky for incident radiation (direct + Hay-Davies circumsolar +
 *   isotropic diffuse, optional uniform ground).
 * - CIE standard overcast and CIE clear sky luminance distributions for daylight.
 */
import { WeatherData } from './weather';
import { sunPosition, monthDayFromDoy, directionFromAltAz } from './solar';

export interface SkyPatch {
  altitude: number; // deg (patch centre)
  azimuth: number; // deg (patch centre, clockwise from north)
  solidAngle: number; // sr
  dir: [number, number, number]; // Y-up scene direction
}

const TREGENZA_COUNTS = [30, 30, 24, 24, 18, 12, 6];

/** Reinhart sky subdivision. mf = 1 gives the 145-patch Tregenza sky. */
export function skyPatches(mf = 1, northAngle = 0): SkyPatch[] {
  const rows = 7 * mf;
  const bandH = 90 / (rows + 0.5);
  const patches: SkyPatch[] = [];
  for (let r = 0; r < rows; r++) {
    const count = TREGENZA_COUNTS[Math.floor(r / mf)] * mf;
    const lo = r * bandH;
    const hi = lo + bandH;
    const alt = lo + bandH / 2;
    const solid = (2 * Math.PI * (Math.sin((hi * Math.PI) / 180) - Math.sin((lo * Math.PI) / 180))) / count;
    for (let c = 0; c < count; c++) {
      const az = (c * 360) / count;
      patches.push({ altitude: alt, azimuth: az, solidAngle: solid, dir: directionFromAltAz(alt, az, northAngle) });
    }
  }
  const capLo = rows * bandH;
  patches.push({
    altitude: 90,
    azimuth: 0,
    solidAngle: 2 * Math.PI * (1 - Math.sin((capLo * Math.PI) / 180)),
    dir: [0, 1, 0],
  });
  return patches;
}

/** Mirror the sky patches below the horizon (ground hemisphere). */
export function groundPatches(sky: SkyPatch[]): SkyPatch[] {
  return sky.map((p) => ({ ...p, altitude: -p.altitude, dir: [p.dir[0], -p.dir[1], p.dir[2]] as [number, number, number] }));
}

/** Index of the sky patch containing a given direction (altitude/azimuth in deg). */
export function patchIndex(altitude: number, azimuth: number, mf = 1): number {
  const rows = 7 * mf;
  const bandH = 90 / (rows + 0.5);
  const r = Math.floor(Math.max(0, altitude) / bandH);
  if (r >= rows) return countPatches(mf) - 1;
  let start = 0;
  for (let i = 0; i < r; i++) start += TREGENZA_COUNTS[Math.floor(i / mf)] * mf;
  const count = TREGENZA_COUNTS[Math.floor(r / mf)] * mf;
  const step = 360 / count;
  const c = Math.floor((((azimuth + step / 2) % 360) + 360) % 360 / step) % count;
  return start + c;
}

export function countPatches(mf: number): number {
  let n = 1;
  for (let r = 0; r < 7 * mf; r++) n += TREGENZA_COUNTS[Math.floor(r / mf)] * mf;
  return n;
}

export interface SkyDirections {
  /** directions (Y-up) packed xyz */
  dirs: Float32Array;
  /** weight per direction. Value at a sensor = Σ w_i · max(0, n·d_i)^cosPower · T_i */
  weights: Float32Array;
}

export interface CumulativeSkyOptions {
  mf: number;
  northAngle: number;
  includeGround: boolean;
  groundReflectance: number;
  /** hour-of-year indices to accumulate */
  hours: number[];
}

/**
 * Cumulative sky matrix (kWh/m² per patch, normal to the patch direction).
 * Per hour: beam (DNI + circumsolar part of DHI, Hay-Davies anisotropy index)
 * is binned into the patch that contains the sun; the remaining diffuse is
 * spread isotropically. Sun position is taken at the half-hour (hour midpoint).
 */
export function cumulativeSky(weather: WeatherData, opt: CumulativeSkyOptions): { patches: SkyPatch[]; values: Float64Array; ground: SkyPatch[]; groundValues: Float64Array } {
  const patches = skyPatches(opt.mf, opt.northAngle);
  const values = new Float64Array(patches.length);
  let isoNorm = 0;
  for (const p of patches) isoNorm += p.solidAngle * Math.sin((p.altitude * Math.PI) / 180);
  let ghiSum = 0;
  for (const h of opt.hours) {
    const dni = weather.dni[h];
    const dhi = weather.dhi[h];
    ghiSum += weather.ghi[h];
    if (dni <= 0 && dhi <= 0) continue;
    const doy = Math.floor(h / 24);
    const { month, day } = monthDayFromDoy(doy);
    const sun = sunPosition(weather.location, month, day, (h % 24) + 0.5, opt.northAngle);
    let beam = 0;
    let iso = dhi;
    if (sun.altitude > 0) {
      const i0 = 1367 * (1 + 0.033 * Math.cos((2 * Math.PI * (doy + 1)) / 365));
      const ai = Math.min(1, Math.max(0, dni / i0));
      const sinAlt = Math.max(0.05, Math.sin((sun.altitude * Math.PI) / 180));
      const circumsolar = (ai * dhi) / sinAlt; // normal-incidence equivalent
      beam = dni + circumsolar;
      iso = dhi * (1 - ai);
      values[patchIndex(sun.altitude, sun.azimuth, opt.mf)] += beam / 1000;
    }
    if (iso > 0) {
      const L = iso / isoNorm; // radiance-like (Wh/m²/sr)
      for (let i = 0; i < patches.length; i++) values[i] += (L * patches[i].solidAngle) / 1000;
    }
  }
  const ground = opt.includeGround ? groundPatches(patches) : [];
  const groundValues = new Float64Array(ground.length);
  if (opt.includeGround) {
    // uniform ground: radiance = rho * GHI / pi
    const Lg = (opt.groundReflectance * ghiSum) / Math.PI / 1000;
    for (let i = 0; i < ground.length; i++) groundValues[i] = Lg * ground[i].solidAngle;
  }
  return { patches, values, ground, groundValues };
}

/** Relative luminance of the CIE standard overcast sky (zenith = 1). */
export function cieOvercast(altitudeDeg: number): number {
  return (1 + 2 * Math.sin((altitudeDeg * Math.PI) / 180)) / 3;
}

/** Relative luminance of the CIE clear sky (zenith = 1). */
export function cieClear(altDeg: number, azDeg: number, sunAltDeg: number, sunAzDeg: number): number {
  const Z = ((90 - Math.max(altDeg, 0.5)) * Math.PI) / 180;
  const Zs = ((90 - Math.max(sunAltDeg, 0.5)) * Math.PI) / 180;
  const dAz = ((azDeg - sunAzDeg) * Math.PI) / 180;
  const cosChi = Math.cos(Zs) * Math.cos(Z) + Math.sin(Zs) * Math.sin(Z) * Math.cos(dAz);
  const chi = Math.acos(Math.min(1, Math.max(-1, cosChi)));
  const f = (x: number) => 0.91 + 10 * Math.exp(-3 * x) + 0.45 * Math.cos(x) ** 2;
  const phi = (z: number) => 1 - Math.exp(-0.32 / Math.cos(z));
  return (f(chi) * phi(Z)) / (f(Zs) * phi(0));
}

export type DaylightSky = 'overcast' | 'clear';

export interface DaylightSkyOptions {
  sky: DaylightSky;
  mf: number;
  northAngle: number;
  /** unobstructed diffuse horizontal illuminance of the sky (lux) */
  diffuseHorizontal: number;
  /** direct normal illuminance of the sun (lux), clear sky only */
  directNormal: number;
  sun?: { altitude: number; azimuth: number; vector: [number, number, number] };
  groundReflectance: number;
  includeGround: boolean;
}

/**
 * Build weighted sky directions for illuminance. Each weight is L_i·Ω_i (lux at
 * normal incidence), scaled so the unobstructed sky gives `diffuseHorizontal`
 * on a horizontal plane. The sun is appended as a separate direction.
 */
export function daylightSkyDirections(opt: DaylightSkyOptions): SkyDirections & { horizontal: number } {
  const patches = skyPatches(opt.mf, opt.northAngle);
  const rel = patches.map((p) =>
    opt.sky === 'overcast' || !opt.sun
      ? cieOvercast(p.altitude)
      : cieClear(p.altitude, p.azimuth, opt.sun.altitude, opt.sun.azimuth),
  );
  let horiz = 0;
  patches.forEach((p, i) => (horiz += rel[i] * p.solidAngle * Math.sin((p.altitude * Math.PI) / 180)));
  const scale = opt.diffuseHorizontal / horiz;
  const sunUp = opt.sky === 'clear' && opt.sun && opt.sun.altitude > 0 && opt.directNormal > 0;
  const ground = opt.includeGround ? groundPatches(patches) : [];
  const n = patches.length + ground.length + (sunUp ? 1 : 0);
  const dirs = new Float32Array(n * 3);
  const weights = new Float32Array(n);
  let k = 0;
  patches.forEach((p, i) => {
    dirs.set(p.dir, k * 3);
    weights[k++] = rel[i] * p.solidAngle * scale;
  });
  const globalH = opt.diffuseHorizontal + (sunUp ? opt.directNormal * Math.sin((opt.sun!.altitude * Math.PI) / 180) : 0);
  const Lg = (opt.groundReflectance * globalH) / Math.PI;
  for (const g of ground) {
    dirs.set(g.dir, k * 3);
    weights[k++] = Lg * g.solidAngle;
  }
  if (sunUp) {
    dirs.set(opt.sun!.vector, k * 3);
    weights[k++] = opt.directNormal;
  }
  return { dirs, weights, horizontal: globalH };
}
