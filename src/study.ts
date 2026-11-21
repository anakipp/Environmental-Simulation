/**
 * Study setup independent of the page: a plain settings object in, sensor grid
 * and ray-tracing job out. Used by the "Run simulation" button and the optimizer.
 */
import type { Part } from './viewer/viewer';
import { worldTriangles, concatFloat32 } from './viewer/loaders';
import {
  Location, AnalysisPeriod, sunPosition, periodHours, periodSunVectors, hoyIndex, describePeriod, MONTH_NAMES,
} from './core/solar';
import type { WeatherData } from './core/weather';
import { cumulativeSky, skyPatches, daylightSkyDirections } from './core/sky';
import { surfaceGrid, workPlaneGrid, AnalysisGrid } from './core/grid';
import type { JobData, WeightMode, BounceSettings, SceneData } from './sim/engine';

export type StudyType = 'sunHours' | 'radiation' | 'skyView' | 'daylightFactor' | 'illuminance';

export const STUDY: Record<StudyType, { title: string; unit: string; hint: string; grid: 'surfaces' | 'workplane'; threshold: number; palette: string }> = {
  sunHours: {
    title: 'Direct sun hours', unit: 'h', grid: 'surfaces', threshold: 2, palette: 'ladybug',
    hint: 'Hours of direct sun each sensor receives in the period (LB Direct Sun Hours). Use a single day such as Mar 21 for BRE-style "2 hours of sun" checks.',
  },
  radiation: {
    title: 'Incident radiation', unit: 'kWh/m²', grid: 'surfaces', threshold: 800, palette: 'ladybug',
    hint: 'Cumulative solar energy on surfaces from the weather file\'s sky (LB Incident Radiation): direct + circumsolar + diffuse sky patches, optional ground reflection.',
  },
  skyView: {
    title: 'Sky view', unit: '%', grid: 'surfaces', threshold: 50, palette: 'ladybug',
    hint: 'Percentage of the sky dome visible from each sensor (LB Sky View). Exposure weighs all patches equally; view factor weighs by cosine.',
  },
  daylightFactor: {
    title: 'Daylight factor', unit: '%', grid: 'workplane', threshold: 2, palette: 'ladybug',
    hint: 'Interior illuminance as a percentage of the unobstructed exterior under a CIE overcast sky (HB Daylight Factor). Assign floors and glazing first.',
  },
  illuminance: {
    title: 'Illuminance', unit: 'lux', grid: 'workplane', threshold: 300, palette: 'ladybug',
    hint: 'Point-in-time illuminance at the date/time chosen in "Sun path & shadows" (HB Point-in-Time Grid), using the weather-file sky or manual values.',
  },
};

export interface StudySettings {
  type: StudyType;
  gridKind: 'surfaces' | 'workplane';
  gridSize: number;
  offset: number;
  wpHeight: number;
  flip: boolean;
  period: AnalysisPeriod;
  mf: number;
  skyViewMetric: 'exposure' | 'view';
  sky: 'auto' | 'clear' | 'overcast';
  includeGround: boolean;
  groundReflectance: number;
  /** manual illuminance (lux) for point-in-time studies */
  diffuseHorizontal: number;
  directNormal: number;
  illumFromWeather: boolean;
  tau: number;
  glazingOpaque: boolean;
  bounce: 0 | 1 | 2;
  reflectance: number;
  rays: number;
  /** date/time for point-in-time illuminance */
  month: number;
  day: number;
  hour: number;
  /** only analyse surfaces/floors of these part ids (empty = all of that role) */
  partIds?: number[];
}

export interface StudyContext {
  weather: WeatherData;
  location: Location;
  northAngle: number;
  weatherLabel: string;
}

export interface Prepared {
  dirs: Float32Array;
  weights: Float32Array;
  mode: WeightMode;
  meta: string;
  bounce?: BounceSettings;
  /** non-fatal note, e.g. a fallback was used */
  warning?: string;
}

export function sceneData(parts: Part[]): SceneData {
  const opaque: Float32Array[] = [];
  const glazing: Float32Array[] = [];
  for (const p of parts) {
    if (p.role === 'ignore') continue;
    (p.role === 'glazing' ? glazing : opaque).push(worldTriangles(p.mesh));
  }
  return { opaque: concatFloat32(opaque), glazing: concatFloat32(glazing) };
}

export function buildGrid(s: StudySettings, parts: Part[]): AnalysisGrid {
  const size = Math.max(0.02, s.gridSize || 1);
  const pick = (role: string) =>
    parts.filter((p) => p.role === role && (!s.partIds?.length || s.partIds.includes(p.id))).map((p) => worldTriangles(p.mesh));
  if (s.gridKind === 'workplane') {
    const floors = pick('floor');
    if (!floors.length) throw new Error('No floor meshes. Set a mesh\'s role to "Floor → work plane" or switch the sensor grid to "On analysis surfaces".');
    return workPlaneGrid(concatFloat32(floors), size, s.wpHeight || 0);
  }
  const surfs = pick('analysis');
  if (!surfs.length) throw new Error('No analysis surfaces. Set at least one mesh\'s role to "Analysis surface".');
  return surfaceGrid(concatFloat32(surfs), size, s.flip);
}

function packPatches(patches: { dir: [number, number, number] }[], weights: ArrayLike<number>) {
  const dirs = new Float32Array(patches.length * 3);
  const w = new Float32Array(patches.length);
  patches.forEach((p, i) => {
    dirs.set(p.dir, i * 3);
    w[i] = weights[i];
  });
  return { dirs, weights: w };
}

const fmt0 = (v: number) => Math.round(v).toLocaleString();

export function prepareStudy(s: StudySettings, ctx: StudyContext): Prepared {
  const w = ctx.weather;
  const { mf, includeGround } = s;
  const north = ctx.northAngle;
  const groundR = s.groundReflectance;

  if (s.type === 'sunHours') {
    const suns = periodSunVectors(ctx.location, s.period, north, 0);
    if (!suns.length) throw new Error('The sun is never above the horizon in this analysis period.');
    const dirs = new Float32Array(suns.length * 3);
    suns.forEach((x, i) => dirs.set(x.sun.vector, i * 3));
    return { dirs, weights: new Float32Array(suns.length).fill(1), mode: 'count', meta: `${describePeriod(s.period)} · ${suns.length} sun-up hours` };
  }
  if (s.type === 'radiation') {
    const sky = cumulativeSky(w, { mf, northAngle: north, includeGround, groundReflectance: groundR, hours: periodHours(s.period) });
    return {
      ...packPatches([...sky.patches, ...sky.ground], [...sky.values, ...sky.groundValues]),
      mode: 'cosine',
      meta: `${describePeriod(s.period)} · ${ctx.weatherLabel} · ${sky.patches.length} sky patches`,
    };
  }
  if (s.type === 'skyView') {
    const patches = skyPatches(mf, north);
    const view = s.skyViewMetric === 'view';
    const weights = patches.map((p) => (view ? (p.solidAngle / Math.PI) * 100 : (p.solidAngle / (2 * Math.PI)) * 100));
    return { ...packPatches(patches, weights), mode: view ? 'cosine' : 'uniform', meta: `${view ? 'Sky view factor' : 'Sky exposure'} · ${patches.length} patches` };
  }
  let sky: ReturnType<typeof daylightSkyDirections>;
  let meta: string;
  let warning: string | undefined;
  if (s.type === 'daylightFactor') {
    sky = daylightSkyDirections({ sky: 'overcast', mf, northAngle: north, diffuseHorizontal: 100, directNormal: 0, groundReflectance: groundR, includeGround });
    meta = 'CIE overcast sky';
  } else {
    const sun = sunPosition(ctx.location, s.month, s.day, s.hour, north);
    const hoy = hoyIndex(s.month, s.day, Math.floor(s.hour));
    let dh = s.diffuseHorizontal, dn = s.directNormal;
    if (s.illumFromWeather) {
      dh = w.dhIllum[hoy];
      dn = w.dnIllum[hoy];
      if (!(dh > 0) && sun.altitude > 0) {
        warning = 'Weather file has no daylight at this hour; using manual illuminance values.';
        dh = s.diffuseHorizontal;
        dn = s.directNormal;
      }
    }
    let skyType = s.sky;
    if (skyType === 'auto') skyType = dn > 2000 ? 'clear' : 'overcast';
    if (sun.altitude <= 0 && skyType === 'clear') skyType = 'overcast';
    sky = daylightSkyDirections({ sky: skyType, mf, northAngle: north, diffuseHorizontal: dh, directNormal: dn, sun, groundReflectance: groundR, includeGround });
    const hh = Math.floor(s.hour), mm = Math.round((s.hour % 1) * 60);
    meta = `${MONTH_NAMES[s.month - 1]} ${s.day} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · CIE ${skyType} · Ed ${fmt0(dh)} lx${skyType === 'clear' ? ` · En ${fmt0(dn)} lx` : ''}`;
  }
  let bounce: BounceSettings | undefined;
  if (s.bounce > 0) {
    // evaluate hit-point illuminance with the coarse (Tregenza) sky for speed
    const coarse = mf === 1 ? sky : s.type === 'daylightFactor'
      ? daylightSkyDirections({ sky: 'overcast', mf: 1, northAngle: north, diffuseHorizontal: 100, directNormal: 0, groundReflectance: groundR, includeGround })
      : sky;
    bounce = {
      rays: Math.max(8, Math.round(s.rays || 48)),
      reflectance: Math.min(0.95, Math.max(0, s.reflectance)),
      multi: s.bounce === 2,
      dirs: coarse.dirs,
      weights: coarse.weights,
    };
    meta += ` · ${s.bounce === 2 ? 'multi-bounce' : '1 bounce'} ρ=${bounce.reflectance}`;
  }
  return { dirs: sky.dirs, weights: sky.weights, mode: 'cosine', meta, bounce, warning };
}

export function makeJob(grid: AnalysisGrid, prep: Prepared, s: StudySettings): JobData {
  return {
    sensors: grid.sensors,
    normals: grid.normals,
    dirs: prep.dirs,
    weights: prep.weights,
    mode: prep.mode,
    glazingTransmittance: Math.min(1, Math.max(0, s.tau)),
    glazingOpaque: s.glazingOpaque,
    offset: Math.max(0, s.offset || 0),
    bounce: prep.bounce,
  };
}

export interface GridStats {
  mean: number; // area-weighted
  area: number;
  above: number; // % of area ≥ threshold
  min: number;
  max: number;
  total: number; // Σ value·area (e.g. kWh for radiation)
}

export function gridStats(values: ArrayLike<number>, areas: ArrayLike<number>, threshold: number): GridStats {
  let sumA = 0, sumVA = 0, above = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i], a = areas[i];
    sumA += a;
    sumVA += v * a;
    if (v >= threshold) above += a;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { mean: sumVA / (sumA || 1), area: sumA, above: (above / (sumA || 1)) * 100, min: lo, max: hi, total: sumVA };
}
