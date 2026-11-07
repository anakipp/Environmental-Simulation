/**
 * Climate & comfort drawer: hourly plot, monthly chart, wind rose,
 * ASHRAE-55 adaptive comfort, and a PMV/PPD calculator.
 */
import { WeatherData, WEATHER_FIELDS, WeatherField, monthlyStats } from '../core/weather';
import { AnalysisPeriod, periodHours, describePeriod, FULL_YEAR } from '../core/solar';
import { adaptiveComfort, pmv } from '../core/comfort';
import { PALETTES, gradientCss, LegendSettings } from '../core/colors';
import { heatmap, monthlyChart, windRose, fmt } from './charts';

type Ctx = () => { weather: WeatherData | null; period: AnalysisPeriod };
let getCtx: Ctx;
let tab = 'hourly';
const ui = { field: 'dryBulb' as WeatherField, palette: 'thermal', windPeriod: 'year', mrtOffset: 0 };
const pmvInput = { ta: 24, tr: 24, vel: 0.1, rh: 50, met: 1.1, clo: 0.7 };

const $ = (id: string) => document.getElementById(id)!;

export function initClimate(ctx: Ctx) {
  getCtx = ctx;
  document.querySelectorAll<HTMLButtonElement>('#climateTabs [role=tab]').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.tab!;
      document.querySelectorAll('#climateTabs [role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      refreshClimate();
    };
  });
}

function needsClimate(w: WeatherData | null): boolean {
  if (w?.hasClimate) return false;
  $('climateControls').innerHTML = '';
  $('climateContent').innerHTML = `<p class="summary-line">Climate charts need an EPW weather file. Choose a sample city or upload an EPW in <b>Location &amp; weather</b>.</p>`;
  return true;
}

function select(label: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLLabelElement {
  const l = document.createElement('label');
  l.textContent = label;
  const s = document.createElement('select');
  for (const [v, t] of options) s.add(new Option(t, v, false, v === value));
  s.onchange = () => onChange(s.value);
  l.appendChild(s);
  return l;
}

function numberInput(label: string, value: number, step: number, onChange: (v: number) => void, min?: number, max?: number): HTMLLabelElement {
  const l = document.createElement('label');
  l.textContent = label;
  const i = document.createElement('input');
  i.type = 'number';
  i.step = String(step);
  if (min !== undefined) i.min = String(min);
  if (max !== undefined) i.max = String(max);
  i.value = String(value);
  i.oninput = () => {
    const v = parseFloat(i.value);
    if (Number.isFinite(v)) onChange(v);
  };
  l.appendChild(i);
  return l;
}

export function refreshClimate() {
  if (!getCtx) return;
  const { weather, period } = getCtx();
  const controls = $('climateControls');
  const content = $('climateContent');
  if (tab === 'pmv') return renderPmv(controls, content);
  if (needsClimate(weather)) return;
  const w = weather!;
  controls.innerHTML = '';
  content.innerHTML = '';
  const fieldMeta = () => WEATHER_FIELDS.find((f) => f.key === ui.field)!;

  if (tab === 'hourly') {
    controls.append(
      select('Data', WEATHER_FIELDS.map((f) => [f.key, f.label]), ui.field, (v) => { ui.field = v as WeatherField; refreshClimate(); }),
      select('Colors', Object.entries(PALETTES).map(([k, p]) => [k, p.label]), ui.palette, (v) => { ui.palette = v; refreshClimate(); }),
    );
    const data = w[ui.field];
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const v of data) { lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; }
    const legend: LegendSettings = { palette: ui.palette, min: lo, max: hi, segments: 0 };
    const meta = fieldMeta();
    const head = document.createElement('p');
    head.className = 'summary-line';
    head.innerHTML = `<b>${meta.label}</b> · ${w.location.name} · annual mean ${fmt(sum / data.length)} ${meta.unit}, range ${fmt(lo)} – ${fmt(hi)} ${meta.unit}`;
    const box = document.createElement('div');
    content.append(head, box);
    heatmap(box, data, legend, meta.label, meta.unit);
    content.appendChild(legendBar(legend, meta.unit));
  } else if (tab === 'monthly') {
    controls.append(select('Data', WEATHER_FIELDS.filter((f) => f.key !== 'windDir').map((f) => [f.key, f.label]), ui.field === 'windDir' ? 'dryBulb' : ui.field, (v) => { ui.field = v as WeatherField; refreshClimate(); }));
    const f = ui.field === 'windDir' ? 'dryBulb' : ui.field;
    const meta = WEATHER_FIELDS.find((x) => x.key === f)!;
    const head = document.createElement('p');
    head.className = 'summary-line';
    head.innerHTML = `<b>${meta.label}</b> by month — line: monthly mean · bar: mean daily min–max · whisker: extremes`;
    const box = document.createElement('div');
    content.append(head, box);
    monthlyChart(box, monthlyStats(w[f]), meta.label, meta.unit);
  } else if (tab === 'wind') {
    controls.append(select('Period', [['year', 'Full year'], ['analysis', 'Analysis period (sidebar)'], ['summer', 'Summer (Jun–Aug)'], ['winter', 'Winter (Dec–Feb)'], ['day', 'Daytime 8–18 h']], ui.windPeriod, (v) => { ui.windPeriod = v; refreshClimate(); }));
    const p: AnalysisPeriod = ui.windPeriod === 'analysis' ? period
      : ui.windPeriod === 'summer' ? { stMonth: 6, stDay: 1, stHour: 0, endMonth: 8, endDay: 31, endHour: 23 }
      : ui.windPeriod === 'winter' ? { stMonth: 12, stDay: 1, stHour: 0, endMonth: 2, endDay: 28, endHour: 23 }
      : ui.windPeriod === 'day' ? { ...FULL_YEAR, stHour: 8, endHour: 18 }
      : FULL_YEAR;
    const hours = periodHours(p);
    let s = 0;
    for (const h of hours) s += w.windSpeed[h];
    const head = document.createElement('p');
    head.className = 'summary-line';
    head.innerHTML = `<b>Wind rose</b> · ${describePeriod(p)} · ${hours.length.toLocaleString()} h · mean speed ${fmt(s / hours.length, 1)} m/s · directions are where the wind blows <i>from</i>`;
    const box = document.createElement('div');
    content.append(head, box);
    windRose(box, w.windDir, w.windSpeed, hours);
  } else if (tab === 'adaptive') {
    controls.append(
      numberInput('Indoor offset vs outdoor (°C)', ui.mrtOffset, 0.5, (v) => { ui.mrtOffset = v; drawAdaptive(); }),
    );
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Screening for a naturally ventilated (free-running) space: operative temperature ≈ outdoor dry bulb + offset. ASHRAE 55 adaptive model, 80 % acceptability (±3.5 °C).';
    controls.appendChild(note);
    const drawAdaptive = () => {
      content.innerHTML = '';
      const to = new Float32Array(w.dryBulb.length);
      for (let i = 0; i < to.length; i++) to[i] = w.dryBulb[i] + ui.mrtOffset;
      const r = adaptiveComfort(w.dryBulb, to);
      let cold = 0, ok = 0, hot = 0, occ = 0;
      for (let i = 0; i < r.condition.length; i++) {
        const h = i % 24;
        if (h < 8 || h > 18) continue;
        occ++;
        if (r.condition[i] < 0) cold++;
        else if (r.condition[i] > 0) hot++;
        else ok++;
      }
      const head = document.createElement('p');
      head.className = 'summary-line';
      head.innerHTML = `Daytime hours (8–18 h): <b>${fmt((ok / occ) * 100, 1)}% comfortable</b> · ${fmt((cold / occ) * 100, 1)}% too cold · ${fmt((hot / occ) * 100, 1)}% too hot`;
      const box = document.createElement('div');
      content.append(head, box);
      const COLD = 'rgb(69,117,180)', OK = 'rgb(214,214,206)', HOT = 'rgb(215,48,39)';
      heatmap(box, r.condition, { palette: 'thermal', min: -1, max: 1, segments: 0 }, 'Adaptive comfort', '',
        (v) => (v < 0 ? 'Too cold' : v > 0 ? 'Too hot' : 'Comfortable'),
        (v) => (v < 0 ? COLD : v > 0 ? HOT : OK));
      const lg = document.createElement('div');
      lg.className = 'hm-legend';
      lg.innerHTML = `<span class="key"><i style="background:${COLD}"></i>Too cold</span><span class="key"><i style="background:${OK}"></i>Comfortable (80 %)</span><span class="key"><i style="background:${HOT}"></i>Too hot</span>`;
      content.appendChild(lg);
    };
    drawAdaptive();
  }
}

function legendBar(l: LegendSettings, unit: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'hm-legend';
  d.innerHTML = `<span>${fmt(l.min)} ${unit}</span><span class="grad" style="background:${gradientCss(l.palette, 'to right')}"></span><span>${fmt(l.max)} ${unit}</span>`;
  return d;
}

function renderPmv(controls: HTMLElement, content: HTMLElement) {
  controls.innerHTML = '';
  const fields: [keyof typeof pmvInput, string, number, number?, number?][] = [
    ['ta', 'Air temperature (°C)', 0.5, 10, 40],
    ['tr', 'Mean radiant temp. (°C)', 0.5, 10, 50],
    ['rh', 'Relative humidity (%)', 5, 0, 100],
    ['vel', 'Air speed (m/s)', 0.05, 0, 2],
    ['met', 'Metabolic rate (met)', 0.1, 0.8, 4],
    ['clo', 'Clothing (clo)', 0.1, 0, 2],
  ];
  for (const [k, label, step, min, max] of fields) controls.appendChild(numberInput(label, pmvInput[k], step, (v) => { pmvInput[k] = v; draw(); }, min, max));
  const presets = document.createElement('p');
  presets.className = 'hint';
  presets.innerHTML = 'Typical: seated office 1.0–1.2 met; summer clothing 0.5 clo, winter 1.0 clo. Use the weather readout in "Sun path & shadows" for outdoor conditions.';
  controls.appendChild(presets);
  const draw = () => {
    const r = pmv(pmvInput);
    const ok = Math.abs(r.pmv) <= 0.5;
    const pos = Math.min(100, Math.max(0, ((r.pmv + 3) / 6) * 100));
    content.innerHTML = `
      <p class="summary-line"><b>PMV / PPD</b> — Fanger model (ISO 7730 / ASHRAE 55). Comfortable when −0.5 ≤ PMV ≤ +0.5 (PPD ≤ 10 %).</p>
      <div class="pmv-out">
        <div class="stat"><div class="k">PMV</div><div class="v">${r.pmv >= 0 ? '+' : ''}${r.pmv.toFixed(2)}</div></div>
        <div class="stat"><div class="k">PPD</div><div class="v">${r.ppd.toFixed(1)}<small>%</small></div></div>
        <div class="stat"><div class="k">Sensation</div><div class="v" style="font-size:15px">${ok ? '✓ ' : '⚠ '}${r.category}</div></div>
      </div>
      <div class="pmv-scale" role="img" aria-label="PMV scale from cold (−3) to hot (+3)">
        <div class="track" style="background:${gradientCss('thermal', 'to right')}"></div>
        <div class="mark" style="left:${pos}%"></div>
      </div>
      <div class="pmv-labels"><span>−3 Cold</span><span>−2 Cool</span><span>−1 Slightly cool</span><span>0 Neutral</span><span>+1 Slightly warm</span><span>+2 Warm</span><span>+3 Hot</span></div>`;
  };
  draw();
}
