/**
 * Solar geometry.
 *
 * Sun position uses the NOAA solar calculator equations — the same approach
 * used by Ladybug's `Sunpath` — with an atmospheric refraction correction.
 *
 * Scene convention (three.js, Y-up):
 *   +X = East, +Y = Up, -Z = North  (when the north angle is 0).
 * A model exported from Rhino (Z-up, +Y north) maps (x, y, z) -> (x, z, -y).
 * `northAngle` follows Ladybug: degrees counter-clockwise from the +Y (Rhino)
 * axis, i.e. counter-clockwise from -Z in scene space, seen from above.
 */

export interface Location {
  name: string;
  latitude: number; // deg, + north
  longitude: number; // deg, + east
  timeZone: number; // hours from UTC, e.g. -8 for PST
  elevation: number; // m
}

export interface SunPosition {
  altitude: number; // deg above horizon (refraction-corrected)
  azimuth: number; // deg clockwise from north
  /** unit vector pointing from the scene towards the sun (Y-up scene space) */
  vector: [number, number, number];
  isUp: boolean;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 0-based day of year for a (non-leap) month 1-12 / day 1-31. */
export function dayOfYear(month: number, day: number): number {
  let doy = 0;
  for (let m = 0; m < month - 1; m++) doy += DAYS_IN_MONTH[m];
  return doy + day - 1;
}

/** month (1-12) and day (1-31) from 0-based day of year (non-leap). */
export function monthDayFromDoy(doy: number): { month: number; day: number } {
  let d = ((Math.floor(doy) % 365) + 365) % 365;
  for (let m = 0; m < 12; m++) {
    if (d < DAYS_IN_MONTH[m]) return { month: m + 1, day: d + 1 };
    d -= DAYS_IN_MONTH[m];
  }
  return { month: 12, day: 31 };
}

/** Hour-of-year index (0..8759) for a month/day and an integer hour 0..23. */
export function hoyIndex(month: number, day: number, hour: number): number {
  return dayOfYear(month, day) * 24 + hour;
}

/**
 * Convert altitude/azimuth (degrees) into a Y-up scene direction vector
 * pointing towards the sky position.
 */
export function directionFromAltAz(altitude: number, azimuth: number, northAngle = 0): [number, number, number] {
  const alt = rad(altitude);
  // azimuth clockwise from north; rotating the north direction counter-clockwise by northAngle
  const az = rad(azimuth - northAngle);
  // Z-up "plan" coordinates: x east, y north
  const px = Math.sin(az) * Math.cos(alt);
  const py = Math.cos(az) * Math.cos(alt);
  const pz = Math.sin(alt);
  return [px, pz, -py];
}

/** Calculate the sun position for a local standard time. Year defaults to a non-leap year. */
export function sunPosition(
  loc: Location,
  month: number,
  day: number,
  hour: number,
  northAngle = 0,
  year = 2017,
): SunPosition {
  const utcMs = Date.UTC(year, month - 1, day, 0, 0, 0) + (hour - loc.timeZone) * 3600_000;
  const julianDay = utcMs / 86_400_000 + 2440587.5;
  const jc = (julianDay - 2451545) / 36525;

  const geomMeanLongSun = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const geomMeanAnomSun = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const eccentOrbit = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const sunEqOfCtr =
    Math.sin(rad(geomMeanAnomSun)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(rad(2 * geomMeanAnomSun)) * (0.019993 - 0.000101 * jc) +
    Math.sin(rad(3 * geomMeanAnomSun)) * 0.000289;
  const sunTrueLong = geomMeanLongSun + sunEqOfCtr;
  const sunAppLong = sunTrueLong - 0.00569 - 0.00478 * Math.sin(rad(125.04 - 1934.136 * jc));
  const meanObliqEcliptic = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliqEcliptic + 0.00256 * Math.cos(rad(125.04 - 1934.136 * jc));
  const solDec = deg(Math.asin(Math.sin(rad(obliqCorr)) * Math.sin(rad(sunAppLong))));
  const varY = Math.tan(rad(obliqCorr / 2)) ** 2;
  const eqOfTime =
    4 *
    deg(
      varY * Math.sin(2 * rad(geomMeanLongSun)) -
        2 * eccentOrbit * Math.sin(rad(geomMeanAnomSun)) +
        4 * eccentOrbit * varY * Math.sin(rad(geomMeanAnomSun)) * Math.cos(2 * rad(geomMeanLongSun)) -
        0.5 * varY * varY * Math.sin(4 * rad(geomMeanLongSun)) -
        1.25 * eccentOrbit * eccentOrbit * Math.sin(2 * rad(geomMeanAnomSun)),
    );

  const trueSolarTime = (((hour * 60 + eqOfTime + 4 * loc.longitude - 60 * loc.timeZone) % 1440) + 1440) % 1440;
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const lat = rad(loc.latitude);
  const dec = rad(solDec);
  let cosZen = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(rad(hourAngle));
  cosZen = Math.min(1, Math.max(-1, cosZen));
  const zenith = deg(Math.acos(cosZen));
  const elev = 90 - zenith;

  // atmospheric refraction (NOAA)
  let refraction = 0;
  if (elev <= 85) {
    const te = Math.tan(rad(elev));
    if (elev > 5) refraction = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
    else if (elev > -0.575) refraction = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
    else refraction = -20.772 / te;
    refraction /= 3600;
  }
  const altitude = elev + refraction;

  let azimuth: number;
  const denom = Math.cos(lat) * Math.sin(rad(zenith));
  if (Math.abs(denom) < 1e-9) {
    azimuth = 180;
  } else {
    const c = Math.min(1, Math.max(-1, (Math.sin(lat) * Math.cos(rad(zenith)) - Math.sin(dec)) / denom));
    azimuth = hourAngle > 0 ? (deg(Math.acos(c)) + 180) % 360 : (540 - deg(Math.acos(c))) % 360;
  }

  return {
    altitude,
    azimuth,
    vector: directionFromAltAz(altitude, azimuth, northAngle),
    isUp: altitude > 0,
  };
}

/** Ladybug-style analysis period (inclusive). */
export interface AnalysisPeriod {
  stMonth: number;
  stDay: number;
  stHour: number; // 0-23
  endMonth: number;
  endDay: number;
  endHour: number; // 0-23
}

export const FULL_YEAR: AnalysisPeriod = { stMonth: 1, stDay: 1, stHour: 0, endMonth: 12, endDay: 31, endHour: 23 };

/** Hour-of-year indices (0..8759) contained in the analysis period. */
export function periodHours(p: AnalysisPeriod): number[] {
  const st = dayOfYear(p.stMonth, p.stDay);
  const en = dayOfYear(p.endMonth, p.endDay);
  const days: number[] = [];
  if (st <= en) for (let d = st; d <= en; d++) days.push(d);
  else {
    // wraps over new year (e.g. Dec -> Feb)
    for (let d = st; d < 365; d++) days.push(d);
    for (let d = 0; d <= en; d++) days.push(d);
  }
  const hours: number[] = [];
  for (const d of days) {
    if (p.stHour <= p.endHour) {
      for (let h = p.stHour; h <= p.endHour; h++) hours.push(d * 24 + h);
    } else {
      for (let h = 0; h <= p.endHour; h++) hours.push(d * 24 + h);
      for (let h = p.stHour; h < 24; h++) hours.push(d * 24 + h);
    }
  }
  return hours;
}

export function describePeriod(p: AnalysisPeriod): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${MONTH_NAMES[p.stMonth - 1]} ${p.stDay} – ${MONTH_NAMES[p.endMonth - 1]} ${p.endDay}, ${pad(p.stHour)}:00–${pad(p.endHour)}:00`;
}

/** Sun vectors (above horizon) for every hour in a period, sampled at `hourOffset` past the hour. */
export function periodSunVectors(
  loc: Location,
  period: AnalysisPeriod,
  northAngle: number,
  hourOffset = 0,
): { hoy: number; sun: SunPosition }[] {
  const out: { hoy: number; sun: SunPosition }[] = [];
  for (const hoy of periodHours(period)) {
    const doy = Math.floor(hoy / 24);
    const { month, day } = monthDayFromDoy(doy);
    const sun = sunPosition(loc, month, day, (hoy % 24) + hourOffset, northAngle);
    if (sun.isUp) out.push({ hoy, sun });
  }
  return out;
}
