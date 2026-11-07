/**
 * Lightweight SVG / canvas charts for climate data and results
 * (cf. Ladybug Hourly Plot, Monthly Chart, Wind Rose, histogram).
 */
import { MONTH_NAMES, DAYS_IN_MONTH, monthDayFromDoy } from '../core/solar';
import { colorFor, cssColor, LegendSettings, PALETTES, sample } from '../core/colors';

const SVGNS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

// ---------- shared tooltip ----------
let tip: HTMLDivElement | null = null;
export function showTip(html: string, x: number, y: number) {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip';
    document.body.appendChild(tip);
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, x + 14);
  const top = y + 14 + r.height > window.innerHeight ? y - r.height - 10 : y + 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}
export function hideTip() {
  if (tip) tip.style.display = 'none';
}

export function fmt(v: number, digits?: number): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  const d = digits ?? (a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 1 : 2);
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });
}

// ---------- histogram ----------
export function histogram(container: HTMLElement, values: Float32Array, areas: Float32Array, legend: LegendSettings, unit: string, bins = 20) {
  container.innerHTML = '';
  const W = 300, H = 140, pl = 34, pr = 8, pt = 8, pb = 26;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Histogram of results by area' }, container);
  const lo = legend.min, hi = legend.max;
  const step = (hi - lo) / bins || 1;
  const counts = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor((values[i] - lo) / step)));
    counts[b] += areas[i];
    total += areas[i];
  }
  const maxC = Math.max(...counts, 1e-9);
  const bw = (W - pl - pr) / bins;
  // gridlines
  for (const f of [0.5, 1]) {
    const y = pt + (H - pt - pb) * (1 - f);
    svgEl('line', { x1: pl, x2: W - pr, y1: y, y2: y, class: 'grid' }, svg);
    const t = svgEl('text', { x: pl - 4, y: y + 3, class: 'tick', 'text-anchor': 'end' }, svg);
    t.textContent = `${Math.round((maxC * f * 100) / (total || 1))}%`;
  }
  svgEl('line', { x1: pl, x2: W - pr, y1: H - pb, y2: H - pb, class: 'axis' }, svg);
  for (let b = 0; b < bins; b++) {
    const h = ((H - pt - pb) * counts[b]) / maxC;
    const x = pl + b * bw;
    const v0 = lo + b * step;
    const fill = cssColor(colorFor(v0 + step / 2, legend));
    if (h > 0) svgEl('rect', { x: x + 1, y: H - pb - h, width: Math.max(1, bw - 2), height: h, rx: Math.min(2, (bw - 2) / 2), fill }, svg);
    const hit = svgEl('rect', { x, y: pt, width: bw, height: H - pt - pb, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (e) =>
      showTip(`<b>${fmt(v0)} – ${fmt(v0 + step)} ${unit}</b><br>${fmt((counts[b] / (total || 1)) * 100, 1)}% of area`, e.clientX, e.clientY),
    );
    hit.addEventListener('pointerleave', hideTip);
  }
  for (const f of [0, 0.5, 1]) {
    const t = svgEl('text', { x: pl + (W - pl - pr) * f, y: H - 8, class: 'tick', 'text-anchor': f === 0 ? 'start' : f === 1 ? 'end' : 'middle' }, svg);
    t.textContent = fmt(lo + (hi - lo) * f);
  }
}

// ---------- hourly heatmap (365 × 24) ----------
export function heatmap(
  container: HTMLElement,
  data: ArrayLike<number>,
  legend: LegendSettings,
  label: string,
  unit: string,
  valueText?: (v: number) => string,
  colorOf?: (v: number) => string,
) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'heatmap';
  const canvas = document.createElement('canvas');
  canvas.width = 365;
  canvas.height = 24;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${label} hourly heatmap`);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(365, 24);
  for (let d = 0; d < 365; d++) {
    for (let h = 0; h < 24; h++) {
      const v = data[d * 24 + h];
      const i = ((23 - h) * 365 + d) * 4;
      let r: number, g: number, b: number;
      if (colorOf) {
        const m = colorOf(v).match(/\d+/g)!.map(Number);
        [r, g, b] = m;
      } else {
        const c = colorFor(v, legend);
        [r, g, b] = [c[0] * 255, c[1] * 255, c[2] * 255];
      }
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const yAxis = document.createElement('div');
  yAxis.className = 'hm-y';
  yAxis.innerHTML = ['24:00', '18:00', '12:00', '6:00', '0:00'].map((t) => `<span>${t}</span>`).join('');
  const xAxis = document.createElement('div');
  xAxis.className = 'hm-x';
  let acc = 0;
  xAxis.innerHTML = MONTH_NAMES.map((m, i) => {
    const left = ((acc + DAYS_IN_MONTH[i] / 2) / 365) * 100;
    acc += DAYS_IN_MONTH[i];
    return `<span style="left:${left}%">${m}</span>`;
  }).join('');
  const plot = document.createElement('div');
  plot.className = 'hm-plot';
  plot.appendChild(canvas);
  plot.appendChild(xAxis);
  wrap.appendChild(yAxis);
  wrap.appendChild(plot);
  container.appendChild(wrap);
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const d = Math.min(364, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 365)));
    const h = Math.min(23, Math.max(0, 23 - Math.floor(((e.clientY - r.top) / r.height) * 24)));
    const { month, day } = monthDayFromDoy(d);
    const v = data[d * 24 + h];
    showTip(`<b>${valueText ? valueText(v) : `${fmt(v)} ${unit}`}</b><br>${MONTH_NAMES[month - 1]} ${day}, ${String(h).padStart(2, '0')}:00`, e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerleave', hideTip);
}

// ---------- monthly range chart ----------
export function monthlyChart(
  container: HTMLElement,
  stats: { mean: number; meanDailyMin: number; meanDailyMax: number; min: number; max: number }[],
  label: string,
  unit: string,
) {
  container.innerHTML = '';
  const W = 640, H = 240, pl = 44, pr = 12, pt = 12, pb = 28;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `${label} monthly profile` }, container);
  const lo = Math.min(...stats.map((s) => s.min));
  const hi = Math.max(...stats.map((s) => s.max));
  const pad = (hi - lo) * 0.08 || 1;
  const y0 = lo - pad, y1 = hi + pad;
  const Y = (v: number) => pt + (H - pt - pb) * (1 - (v - y0) / (y1 - y0));
  const cw = (W - pl - pr) / 12;
  const X = (m: number) => pl + cw * (m + 0.5);
  const ticks = niceTicks(y0, y1, 5);
  for (const t of ticks) {
    svgEl('line', { x1: pl, x2: W - pr, y1: Y(t), y2: Y(t), class: 'grid' }, svg);
    svgEl('text', { x: pl - 6, y: Y(t) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = fmt(t);
  }
  const accent = 'var(--series-1)';
  stats.forEach((s, m) => {
    // full range (thin) and mean daily range (bar)
    svgEl('line', { x1: X(m), x2: X(m), y1: Y(s.min), y2: Y(s.max), stroke: accent, 'stroke-width': 1.5, opacity: 0.45 }, svg);
    const top = Y(s.meanDailyMax), bot = Y(s.meanDailyMin);
    svgEl('rect', { x: X(m) - cw * 0.18, y: top, width: cw * 0.36, height: Math.max(2, bot - top), rx: 4, fill: accent, opacity: 0.35 }, svg);
    svgEl('text', { x: X(m), y: H - 8, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = MONTH_NAMES[m];
  });
  const path = stats.map((s, m) => `${m ? 'L' : 'M'}${X(m)},${Y(s.mean)}`).join('');
  svgEl('path', { d: path, fill: 'none', stroke: accent, 'stroke-width': 2 }, svg);
  stats.forEach((s, m) => {
    svgEl('circle', { cx: X(m), cy: Y(s.mean), r: 4, fill: accent, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
    const hit = svgEl('rect', { x: X(m) - cw / 2, y: pt, width: cw, height: H - pt - pb, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (e) =>
      showTip(
        `<b>${MONTH_NAMES[m]}</b><br>Mean ${fmt(s.mean)} ${unit}<br>Mean daily range ${fmt(s.meanDailyMin)} – ${fmt(s.meanDailyMax)}<br>Extremes ${fmt(s.min)} – ${fmt(s.max)}`,
        e.clientX,
        e.clientY,
      ),
    );
    hit.addEventListener('pointerleave', hideTip);
  });
}

export function niceTicks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

// ---------- wind rose ----------
export function windRose(container: HTMLElement, dir: Float32Array, speed: Float32Array, hours: number[], northUpLabel = 'N') {
  container.innerHTML = '';
  const S = 320, c = S / 2, R = S / 2 - 34;
  const svg = svgEl('svg', { viewBox: `0 0 ${S + 150} ${S}`, class: 'chart windrose', role: 'img', 'aria-label': 'Wind rose' }, container);
  const nDir = 16;
  const bins = [0.5, 2, 4, 6, 8, Infinity];
  const binLabels = ['0.5–2', '2–4', '4–6', '6–8', '≥ 8'];
  const colors = PALETTES.sequential.colors;
  const binColor = (i: number) => cssColor(sample(colors, 0.25 + (0.75 * i) / (binLabels.length - 1)));
  const counts = Array.from({ length: nDir }, () => new Array(binLabels.length).fill(0));
  let calm = 0;
  for (const h of hours) {
    const s = speed[h];
    if (s < bins[0]) {
      calm++;
      continue;
    }
    const d = Math.floor((((dir[h] + 360 / nDir / 2) % 360) / 360) * nDir) % nDir;
    const b = bins.findIndex((lim, i) => i > 0 && s < lim) - 1;
    counts[d][Math.max(0, b)]++;
  }
  const total = hours.length || 1;
  const maxF = Math.max(...counts.map((r) => r.reduce((a, b) => a + b, 0) / total), 0.01);
  const ringStep = niceTicks(0, maxF * 100, 4)[1] ?? 5;
  for (let r = ringStep; r <= maxF * 100 + 1e-9; r += ringStep) {
    svgEl('circle', { cx: c, cy: c, r: (R * r) / (maxF * 100), class: 'grid', fill: 'none' }, svg);
    svgEl('text', { x: c + 3, y: c - (R * r) / (maxF * 100) - 2, class: 'tick' }, svg).textContent = `${fmt(r, 1)}%`;
  }
  const lbl = [[northUpLabel, 0], ['E', 90], ['S', 180], ['W', 270]] as const;
  for (const [t, a] of lbl) {
    const rad = (a * Math.PI) / 180;
    svgEl('text', { x: c + Math.sin(rad) * (R + 16), y: c - Math.cos(rad) * (R + 16) + 4, class: 'tick strong', 'text-anchor': 'middle' }, svg).textContent = t;
  }
  const half = (Math.PI / nDir) * 0.82;
  counts.forEach((row, d) => {
    const a = (d * 2 * Math.PI) / nDir;
    let acc = 0;
    row.forEach((n, b) => {
      if (!n) return;
      const r0 = (R * acc) / total / maxF;
      acc += n;
      const r1 = (R * acc) / total / maxF;
      const p = (r: number, ang: number) => `${c + Math.sin(ang) * r},${c - Math.cos(ang) * r}`;
      const path = `M${p(r0, a - half)} L${p(r1, a - half)} A${r1},${r1} 0 0 1 ${p(r1, a + half)} L${p(r0, a + half)} A${r0},${r0} 0 0 0 ${p(r0, a - half)} Z`;
      const seg = svgEl('path', { d: path, fill: binColor(b), stroke: 'var(--surface)', 'stroke-width': 1 }, svg);
      seg.addEventListener('pointermove', (e) =>
        showTip(`<b>${['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][d]} · ${binLabels[b]} m/s</b><br>${fmt((n / total) * 100, 1)}% of hours`, e.clientX, e.clientY),
      );
      seg.addEventListener('pointerleave', hideTip);
    });
  });
  // legend
  const lx = S + 10;
  svgEl('text', { x: lx, y: 24, class: 'tick strong' }, svg).textContent = 'Wind speed (m/s)';
  binLabels.forEach((t, i) => {
    svgEl('rect', { x: lx, y: 36 + i * 20, width: 12, height: 12, rx: 2, fill: binColor(i) }, svg);
    svgEl('text', { x: lx + 18, y: 46 + i * 20, class: 'tick' }, svg).textContent = t;
  });
  svgEl('text', { x: lx, y: 46 + binLabels.length * 20 + 10, class: 'tick' }, svg).textContent = `Calm: ${fmt((calm / total) * 100, 1)}%`;
}
