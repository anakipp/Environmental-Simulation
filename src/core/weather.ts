/**
 * Weather data: EnergyPlus Weather (EPW) parsing, in the spirit of Ladybug's
 * `EPW` class, plus a synthetic clear-sky generator used when no EPW is loaded.
 */
import { Location, sunPosition, monthDayFromDoy } from './solar';

export interface WeatherData {
  source: 'epw' | 'synthetic';
  location: Location;
  /** 8760 hourly values each. Hour index i covers [i, i+1) local standard time. */
  dryBulb: Float32Array; // °C
  dewPoint: Float32Array; // °C
  relHumidity: Float32Array; // %
  pressure: Float32Array; // Pa
  ghi: Float32Array; // global horizontal radiation, Wh/m²
  dni: Float32Array; // direct normal radiation, Wh/m²
  dhi: Float32Array; // diffuse horizontal radiation, Wh/m²
  ghIllum: Float32Array; // global horizontal illuminance, lux
  dnIllum: Float32Array; // direct normal illuminance, lux
  dhIllum: Float32Array; // diffuse horizontal illuminance, lux
  windDir: Float32Array; // deg from north
  windSpeed: Float32Array; // m/s
  skyCover: Float32Array; // tenths
  /** true when the data set includes meaningful temperature/wind data */
  hasClimate: boolean;
}

export type WeatherField = keyof Pick<
  WeatherData,
  | 'dryBulb'
  | 'dewPoint'
  | 'relHumidity'
  | 'pressure'
  | 'ghi'
  | 'dni'
  | 'dhi'
  | 'ghIllum'
  | 'dhIllum'
  | 'windDir'
  | 'windSpeed'
  | 'skyCover'
>;

export const WEATHER_FIELDS: { key: WeatherField; label: string; unit: string }[] = [
  { key: 'dryBulb', label: 'Dry bulb temperature', unit: '°C' },
  { key: 'dewPoint', label: 'Dew point temperature', unit: '°C' },
  { key: 'relHumidity', label: 'Relative humidity', unit: '%' },
  { key: 'ghi', label: 'Global horizontal radiation', unit: 'Wh/m²' },
  { key: 'dni', label: 'Direct normal radiation', unit: 'Wh/m²' },
  { key: 'dhi', label: 'Diffuse horizontal radiation', unit: 'Wh/m²' },
  { key: 'ghIllum', label: 'Global horizontal illuminance', unit: 'lux' },
  { key: 'dhIllum', label: 'Diffuse horizontal illuminance', unit: 'lux' },
  { key: 'windSpeed', label: 'Wind speed', unit: 'm/s' },
  { key: 'windDir', label: 'Wind direction', unit: '°' },
  { key: 'skyCover', label: 'Total sky cover', unit: 'tenths' },
  { key: 'pressure', label: 'Atmospheric pressure', unit: 'Pa' },
];

const MISSING: Record<number, number> = {
  6: 99.9, 7: 99.9, 8: 999, 9: 999999, 13: 9999, 14: 9999, 15: 9999,
  16: 999999, 17: 999999, 18: 999999, 20: 999, 21: 999, 22: 99,
};

export function parseEPW(text: string): WeatherData {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(',');
  if (!header[0] || header[0].trim().toUpperCase() !== 'LOCATION') {
    throw new Error('Not a valid EPW file: first line must start with LOCATION');
  }
  const location: Location = {
    name: [header[1], header[2], header[3]].filter((s) => s && s.trim() && s.trim() !== '-').join(', ').trim(),
    latitude: parseFloat(header[6]),
    longitude: parseFloat(header[7]),
    timeZone: parseFloat(header[8]),
    elevation: parseFloat(header[9]) || 0,
  };
  if (![location.latitude, location.longitude, location.timeZone].every(Number.isFinite)) {
    throw new Error('EPW LOCATION header is missing latitude/longitude/time zone');
  }

  const N = 8760;
  const make = () => new Float32Array(N);
  const w: WeatherData = {
    source: 'epw',
    location,
    dryBulb: make(), dewPoint: make(), relHumidity: make(), pressure: make(),
    ghi: make(), dni: make(), dhi: make(), ghIllum: make(), dnIllum: make(), dhIllum: make(),
    windDir: make(), windSpeed: make(), skyCover: make(),
    hasClimate: true,
  };
  const cols: [keyof WeatherData, number][] = [
    ['dryBulb', 6], ['dewPoint', 7], ['relHumidity', 8], ['pressure', 9], ['ghi', 13], ['dni', 14],
    ['dhi', 15], ['ghIllum', 16], ['dnIllum', 17], ['dhIllum', 18], ['windDir', 20], ['windSpeed', 21], ['skyCover', 22],
  ];

  let i = 0;
  const last: Record<string, number> = {};
  for (let li = 8; li < lines.length && i < N; li++) {
    const line = lines[li];
    if (!line || !line.trim()) continue;
    const f = line.split(',');
    if (f.length < 23) continue;
    const month = parseInt(f[1], 10);
    const day = parseInt(f[2], 10);
    if (month === 2 && day === 29) continue; // drop leap day to keep 8760
    for (const [key, col] of cols) {
      let v = parseFloat(f[col]);
      if (!Number.isFinite(v) || (MISSING[col] !== undefined && v >= MISSING[col])) v = last[key as string] ?? 0;
      last[key as string] = v;
      (w[key] as Float32Array)[i] = v;
    }
    i++;
  }
  if (i < N) throw new Error(`EPW contains only ${i} hourly records (8760 expected)`);
  return w;
}

/**
 * Synthetic clear-sky year for a location (radiation only).
 * DNI: Meinel air-mass model; DHI: Liu & Jordan transmittance relation.
 * `clearness` scales the beam component (1 = clear, ~0.6 = hazy).
 */
export function syntheticClearSky(location: Location, clearness = 1): WeatherData {
  const N = 8760;
  const make = () => new Float32Array(N);
  const w: WeatherData = {
    source: 'synthetic',
    location,
    dryBulb: make(), dewPoint: make(), relHumidity: make(), pressure: make().fill(101325),
    ghi: make(), dni: make(), dhi: make(), ghIllum: make(), dnIllum: make(), dhIllum: make(),
    windDir: make(), windSpeed: make(), skyCover: make(),
    hasClimate: false,
  };
  for (let h = 0; h < N; h++) {
    const doy = Math.floor(h / 24);
    const { month, day } = monthDayFromDoy(doy);
    const sun = sunPosition(location, month, day, (h % 24) + 0.5);
    if (sun.altitude <= 0.5) continue;
    const sinAlt = Math.sin((sun.altitude * Math.PI) / 180);
    const i0 = 1367 * (1 + 0.033 * Math.cos((2 * Math.PI * (doy + 1)) / 365));
    const am = 1 / (sinAlt + 0.50572 * Math.pow(sun.altitude + 6.07995, -1.6364));
    const dni = clearness * i0 * Math.pow(0.7, Math.pow(am, 0.678));
    const dhi = Math.max(0, (0.271 * i0 - 0.294 * dni) * sinAlt);
    w.dni[h] = dni;
    w.dhi[h] = dhi;
    w.ghi[h] = dni * sinAlt + dhi;
    // luminous efficacy ~ 105 lm/W direct, ~ 120 lm/W diffuse (typical clear-sky values)
    w.dnIllum[h] = dni * 105;
    w.dhIllum[h] = dhi * 120;
    w.ghIllum[h] = w.dnIllum[h] * sinAlt + w.dhIllum[h];
  }
  return w;
}

/** Daily statistics of a field: per-month mean/min/max of daily means etc. */
export function monthlyStats(data: Float32Array): { mean: number; min: number; max: number; meanDailyMin: number; meanDailyMax: number }[] {
  const out = [];
  let h = 0;
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let m = 0; m < 12; m++) {
    let sum = 0, min = Infinity, max = -Infinity, dMinSum = 0, dMaxSum = 0;
    for (let d = 0; d < dim[m]; d++) {
      let dmin = Infinity, dmax = -Infinity;
      for (let k = 0; k < 24; k++, h++) {
        const v = data[h];
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
        if (v < dmin) dmin = v;
        if (v > dmax) dmax = v;
      }
      dMinSum += dmin;
      dMaxSum += dmax;
    }
    out.push({ mean: sum / (dim[m] * 24), min, max, meanDailyMin: dMinSum / dim[m], meanDailyMax: dMaxSum / dim[m] });
  }
  return out;
}
