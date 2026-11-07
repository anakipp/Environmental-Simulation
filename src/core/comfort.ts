/**
 * Thermal comfort models (cf. Ladybug-Comfort):
 *  - PMV / PPD, ISO 7730 / ASHRAE 55 (Fanger) iterative clothing surface temperature.
 *  - ASHRAE 55 adaptive comfort for naturally ventilated spaces.
 */

export interface PMVInput {
  ta: number; // air temperature °C
  tr: number; // mean radiant temperature °C
  vel: number; // relative air speed m/s
  rh: number; // relative humidity %
  met: number; // metabolic rate (met)
  clo: number; // clothing insulation (clo)
  wme?: number; // external work (met), usually 0
}

export interface PMVResult {
  pmv: number;
  ppd: number;
  category: string;
}

/** Saturation vapour pressure (kPa) of water at temperature t (°C). */
function pSat(t: number): number {
  return Math.exp(16.6536 - 4030.183 / (t + 235));
}

export function pmv(inp: PMVInput): PMVResult {
  const { ta, tr, vel, rh, met, clo } = inp;
  const wme = inp.wme ?? 0;
  const pa = rh * 10 * pSat(ta); // Pa
  const icl = 0.155 * clo; // m²K/W
  const m = met * 58.15; // W/m²
  const w = wme * 58.15;
  const mw = m - w;
  const fcl = icl <= 0.078 ? 1 + 1.29 * icl : 1.05 + 0.645 * icl;
  const hcf = 12.1 * Math.sqrt(vel);
  const taa = ta + 273;
  const tra = tr + 273;
  let tcla = taa + (35.5 - ta) / (3.5 * icl + 0.1);
  const p1 = icl * fcl;
  const p2 = p1 * 3.96;
  const p3 = p1 * 100;
  const p4 = p1 * taa;
  const p5 = 308.7 - 0.028 * mw + p2 * Math.pow(tra / 100, 4);
  let xn = tcla / 100;
  let xf = tcla / 50;
  const eps = 0.00015;
  let n = 0;
  let hc = hcf;
  while (Math.abs(xn - xf) > eps) {
    xf = (xf + xn) / 2;
    const hcn = 2.38 * Math.pow(Math.abs(100 * xf - taa), 0.25);
    hc = hcf > hcn ? hcf : hcn;
    xn = (p5 + p4 * hc - p2 * Math.pow(xf, 4)) / (100 + p3 * hc);
    if (++n > 150) break;
  }
  const tcl = 100 * xn - 273;
  const hl1 = 3.05 * 0.001 * (5733 - 6.99 * mw - pa);
  const hl2 = mw > 58.15 ? 0.42 * (mw - 58.15) : 0;
  const hl3 = 1.7 * 0.00001 * m * (5867 - pa);
  const hl4 = 0.0014 * m * (34 - ta);
  const hl5 = 3.96 * fcl * (Math.pow(xn, 4) - Math.pow(tra / 100, 4));
  const hl6 = fcl * hc * (tcl - ta);
  const ts = 0.303 * Math.exp(-0.036 * m) + 0.028;
  const value = ts * (mw - hl1 - hl2 - hl3 - hl4 - hl5 - hl6);
  const ppd = 100 - 95 * Math.exp(-0.03353 * value ** 4 - 0.2179 * value ** 2);
  return { pmv: value, ppd, category: pmvCategory(value) };
}

export function pmvCategory(v: number): string {
  if (v < -2.5) return 'Cold';
  if (v < -1.5) return 'Cool';
  if (v < -0.5) return 'Slightly cool';
  if (v <= 0.5) return 'Neutral (comfortable)';
  if (v <= 1.5) return 'Slightly warm';
  if (v <= 2.5) return 'Warm';
  return 'Hot';
}

/**
 * ASHRAE 55 adaptive model. Prevailing mean outdoor temperature uses an
 * exponentially weighted running mean of daily mean temperatures (alpha 0.8, 7 days).
 * Returns per-hour: -1 too cold, 0 comfortable (80 % acceptability), +1 too hot,
 * and the neutral temperature, assuming operative temperature = outdoor dry bulb
 * (i.e. a free-running, well-ventilated space screening study).
 */
export function adaptiveComfort(dryBulb: Float32Array, operative?: Float32Array, band = 3.5) {
  const days = Math.floor(dryBulb.length / 24);
  const dailyMean = new Float64Array(days);
  for (let d = 0; d < days; d++) {
    let s = 0;
    for (let h = 0; h < 24; h++) s += dryBulb[d * 24 + h];
    dailyMean[d] = s / 24;
  }
  const alpha = 0.8;
  const prevailing = new Float64Array(days);
  for (let d = 0; d < days; d++) {
    let num = 0, den = 0;
    for (let k = 1; k <= 7; k++) {
      const wgt = Math.pow(alpha, k - 1);
      num += wgt * dailyMean[(d - k + days) % days];
      den += wgt;
    }
    prevailing[d] = num / den;
  }
  const to = operative ?? dryBulb;
  const condition = new Int8Array(dryBulb.length);
  const neutral = new Float32Array(dryBulb.length);
  for (let i = 0; i < dryBulb.length; i++) {
    const tp = Math.min(33.5, Math.max(10, prevailing[Math.floor(i / 24)]));
    const tn = 0.31 * tp + 17.8;
    neutral[i] = tn;
    condition[i] = to[i] < tn - band ? -1 : to[i] > tn + band ? 1 : 0;
  }
  return { condition, neutral, prevailing };
}
