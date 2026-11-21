import './styles.css';
import * as THREE from 'three';
import { Viewer } from './viewer/viewer';
import { loadSampleSite } from './viewer/sampleModel';
import { loadModelFile, UNIT_SCALE, SUPPORTED_EXTENSIONS } from './viewer/loaders';
import { ModelEditor } from './model/editor';
import { ModelPanel, escapeHtml } from './ui/modelPanel';
import { OptimizerPanel } from './ui/optimizer';
import {
  Location, sunPosition, AnalysisPeriod, FULL_YEAR, MONTH_NAMES, DAYS_IN_MONTH, dayOfYear, monthDayFromDoy, hoyIndex,
} from './core/solar';
import { WeatherData, parseEPW, syntheticClearSky } from './core/weather';
import { AnalysisGrid } from './core/grid';
import { LegendSettings, PALETTES, colorFor, gradientCss } from './core/colors';
import { SimClient } from './sim/client';
import { StudyType, STUDY, StudySettings, sceneData, buildGrid, prepareStudy, makeJob, gridStats, Prepared } from './study';
import { histogram, fmt, showTip, hideTip } from './ui/charts';
import { initClimate, refreshClimate } from './ui/climate';
import { saveFile } from './ui/save';

// ---------------------------------------------------------------- helpers
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => parseFloat($<HTMLInputElement>(id).value);
const checked = (id: string) => $<HTMLInputElement>(id).checked;
const val = (id: string) => $<HTMLInputElement | HTMLSelectElement>(id).value;

let toastTimer = 0;
export function toast(msg: string, error = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = 'toast'), error ? 6000 : 3000);
}

async function download(name: string, data: BlobPart, type: string) {
  const r = await saveFile(name, new Blob([data], { type }));
  if (r === 'failed') toast(`Could not save ${name}.`, true);
}

// ---------------------------------------------------------------- state
interface ResultRecord {
  id: number;
  type: StudyType;
  title: string;
  unit: string;
  meta: string;
  grid: AnalysisGrid;
  values: Float32Array;
  legend: LegendSettings;
  threshold: number;
  lift: number;
  /** model version the result was computed for */
  modelVersion: number;
}

const state = {
  location: { name: 'San Francisco', latitude: 37.62, longitude: -122.4, timeZone: -8, elevation: 2 } as Location,
  weather: null as WeatherData | null,
  weatherLabel: '',
  northAngle: 0,
  month: 3,
  day: 21,
  hour: 10,
  period: { stMonth: 12, stDay: 21, stHour: 0, endMonth: 12, endDay: 21, endHour: 23 } as AnalysisPeriod,
  results: [] as ResultRecord[],
  current: null as ResultRecord | null,
  running: false,
  modelVersion: 0,
};

// ---------------------------------------------------------------- viewer
const viewer = new Viewer($('viewport'));
const sim = new SimClient();
const editor = new ModelEditor(viewer);
const panel = new ModelPanel(editor, toast);
editor.onChange = () => {
  state.modelVersion++;
  panel.refresh();
  updateSectionRange();
  renderStale();
  $('vpEmpty').hidden = viewer.parts.length > 0;
};

function applyTheme() {
  const forced = document.documentElement.dataset.theme;
  const dark = forced ? forced === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  viewer.setTheme(dark);
  viewer.rebuildSunPathGeometry();
}
try {
  const saved = localStorage.getItem('envsim-theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* storage unavailable */ }
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();
$('btnTheme').onclick = () => {
  const cur = document.documentElement.dataset.theme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('envsim-theme', next); } catch { /* ignore */ }
  applyTheme();
  if (!$('drawer').hidden) refreshClimate();
};

// ---------------------------------------------------------------- model
function addObject(root: THREE.Object3D, opts: { units: string; up: string; recenter: boolean }) {
  const s = UNIT_SCALE[opts.units] ?? 1;
  const wrapper = new THREE.Group();
  wrapper.name = root.name;
  wrapper.add(root);
  root.scale.multiplyScalar(s);
  if (opts.up === 'z') root.rotation.x -= Math.PI / 2;
  wrapper.updateMatrixWorld(true);
  if (opts.recenter) {
    const b = new THREE.Box3().setFromObject(wrapper);
    if (!b.isEmpty()) {
      wrapper.position.set(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
      wrapper.updateMatrixWorld(true);
    }
  }
  editor.recordAnd(() => editor.importObject(wrapper));
  viewer.fit();
}

function loadSample() {
  panel.select(null);
  viewer.clearModel();
  clearResults();
  editor.quietly(() => loadSampleSite(editor));
  editor.clearHistory();
  editor.refresh();
  viewer.fit();
}

async function loadFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    try {
      const obj = await loadModelFile(f);
      addObject(obj, { units: val('selUnits'), up: f.name.toLowerCase().endsWith('.glb') || f.name.toLowerCase().endsWith('.gltf') ? 'y' : val('selUp'), recenter: checked('chkRecenter') });
      toast(`Loaded ${f.name}: ${viewer.parts.length} meshes`);
    } catch (e) {
      toast(`Could not load ${f.name}: ${(e as Error).message}`, true);
    }
  }
}

$('btnSample').onclick = loadSample;
$('btnClear').onclick = () => {
  editor.record();
  panel.select(null);
  for (const p of [...viewer.parts]) viewer.removePart(p);
  clearResults();
  editor.refresh();
};
$('btnExportModel').onclick = async () => {
  if (!viewer.parts.length) return toast('There is no model to export.', true);
  try {
    download('model.glb', await viewer.exportGLB({ result: false, model: true }), 'model/gltf-binary');
  } catch (e) {
    toast(`Model export failed: ${(e as Error).message}`, true);
  }
};
$<HTMLInputElement>('fileModel').onchange = (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) loadFiles(input.files);
  input.value = '';
};
const drop = $('dropZone');
const prevent = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
for (const target of [drop, $('viewport')]) {
  target.addEventListener('dragover', (e) => { prevent(e); drop.classList.add('over'); });
  target.addEventListener('dragleave', () => drop.classList.remove('over'));
  target.addEventListener('drop', (e) => {
    prevent(e);
    drop.classList.remove('over');
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    const epw = files.filter((f) => f.name.toLowerCase().endsWith('.epw'));
    const models = files.filter((f) => SUPPORTED_EXTENSIONS.includes(f.name.split('.').pop()!.toLowerCase()));
    if (epw[0]) loadEpwFile(epw[0]);
    if (models.length) loadFiles(models);
  });
}
$('btnFit').onclick = () => viewer.fit();

// ---------------------------------------------------------------- section cut
function updateSectionRange() {
  const b = viewer.bounds();
  const r = $<HTMLInputElement>('rngSection');
  r.min = String(+b.min.y.toFixed(2));
  r.max = String(+(b.max.y + 0.01).toFixed(2));
  if (+r.value > +r.max || +r.value < +r.min) r.value = String(+(b.min.y + Math.min(2.4, (b.max.y - b.min.y) * 0.75)).toFixed(2));
  applySection();
}
function applySection() {
  const h = num('rngSection');
  $('outSection').textContent = `${h.toFixed(2)} m`;
  viewer.setSection(checked('chkSection'), h);
}
function setSection(on: boolean, height?: number) {
  $<HTMLInputElement>('chkSection').checked = on;
  if (height !== undefined) $<HTMLInputElement>('rngSection').value = String(height);
  applySection();
}
$('chkSection').onchange = applySection;
$('rngSection').oninput = () => {
  $<HTMLInputElement>('chkSection').checked = true;
  applySection();
};
$('btnFitResult').onclick = () => viewer.fitResult();

// ---------------------------------------------------------------- location & weather
const WEATHER_PRESETS: Record<string, string> = {
  sf: 'weather/USA_CA_San.Francisco.Intl.AP.724940_TMY3.epw',
  chicago: 'weather/USA_IL_Chicago-OHare.Intl.AP.725300_TMY3.epw',
};

function setWeather(w: WeatherData, label: string) {
  state.weather = w;
  state.weatherLabel = label;
  state.location = { ...w.location };
  $<HTMLInputElement>('inLat').value = String(w.location.latitude);
  $<HTMLInputElement>('inLon').value = String(w.location.longitude);
  $<HTMLInputElement>('inTz').value = String(w.location.timeZone);
  const lockLoc = w.source === 'epw';
  for (const id of ['inLat', 'inLon', 'inTz']) $<HTMLInputElement>(id).disabled = lockLoc;
  $<HTMLInputElement>('inClear').disabled = lockLoc;
  updateWeatherInfo();
  updateSun();
  viewer.setSunPathParams(state.location, state.northAngle);
  if (!$('drawer').hidden) refreshClimate();
}

function updateWeatherInfo() {
  const w = state.weather;
  if (!w) return;
  const ghi = w.ghi.reduce((a, b) => a + b, 0) / 1000;
  const t = w.hasClimate ? w.dryBulb.reduce((a, b) => a + b, 0) / 8760 : NaN;
  $('weatherInfo').innerHTML = `<div class="kv">
    <span>Source</span><b>${escapeHtml(state.weatherLabel)}</b>
    <span>Location</span><b>${w.location.latitude.toFixed(2)}°, ${w.location.longitude.toFixed(2)}° · UTC${w.location.timeZone >= 0 ? '+' : ''}${w.location.timeZone}</b>
    <span>Annual GHI</span><b>${fmt(ghi, 0)} kWh/m²</b>
    ${w.hasClimate ? `<span>Mean temp.</span><b>${fmt(t, 1)} °C</b>` : '<span>Climate</span><b>radiation only (no EPW)</b>'}
  </div>`;
}

async function loadPresetWeather(key: string) {
  const url = WEATHER_PRESETS[key];
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const w = parseEPW(await res.text());
    setWeather(w, `${w.location.name} (EPW)`);
  } catch (e) {
    toast(`Could not fetch sample weather (${(e as Error).message}); using synthetic clear sky.`, true);
    $<HTMLSelectElement>('selWeather').value = 'synthetic';
    useSynthetic();
  }
}

function useSynthetic() {
  const loc: Location = {
    name: 'Custom location',
    latitude: num('inLat') || 0,
    longitude: num('inLon') || 0,
    timeZone: Number.isFinite(num('inTz')) ? num('inTz') : 0,
    elevation: 0,
  };
  setWeather(syntheticClearSky(loc, num('inClear') || 1), 'Synthetic clear sky');
}

async function loadEpwFile(f: File) {
  try {
    const w = parseEPW(await f.text());
    const sel = $<HTMLSelectElement>('selWeather');
    const opt = sel.querySelector('option[value="custom"]') as HTMLOptionElement;
    opt.disabled = false;
    opt.textContent = `Uploaded: ${w.location.name || f.name}`;
    sel.value = 'custom';
    setWeather(w, `${w.location.name || f.name} (uploaded EPW)`);
    toast(`Weather loaded: ${w.location.name}`);
  } catch (e) {
    toast(`EPW error: ${(e as Error).message}`, true);
  }
}
let uploadedEpw: File | null = null;
$<HTMLInputElement>('fileEpw').onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) {
    uploadedEpw = f;
    loadEpwFile(f);
  }
  (e.target as HTMLInputElement).value = '';
};
$('selWeather').onchange = () => {
  const v = val('selWeather');
  if (v === 'synthetic') {
    for (const id of ['inLat', 'inLon', 'inTz', 'inClear']) $<HTMLInputElement>(id).disabled = false;
    useSynthetic();
  } else if (v === 'custom' && uploadedEpw) loadEpwFile(uploadedEpw);
  else loadPresetWeather(v);
};
for (const id of ['inLat', 'inLon', 'inTz', 'inClear']) {
  $(id).addEventListener('change', () => {
    if (val('selWeather') === 'synthetic') useSynthetic();
  });
}
$('inNorth').addEventListener('change', () => setNorth(num('inNorth') || 0));

// ---------------------------------------------------------------- sun & shadows
const selMonth = $<HTMLSelectElement>('selMonth');
MONTH_NAMES.forEach((m, i) => selMonth.add(new Option(m, String(i + 1))));

function syncSunInputs() {
  selMonth.value = String(state.month);
  $<HTMLInputElement>('inDay').value = String(state.day);
  $<HTMLInputElement>('rngHour').value = String(state.hour);
  $<HTMLInputElement>('rngDoy').value = String(dayOfYear(state.month, state.day));
  const hh = Math.floor(state.hour);
  const mm = Math.round((state.hour - hh) * 60);
  $('outHour').textContent = `${MONTH_NAMES[state.month - 1]} ${state.day}, ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function updateSun() {
  const s = sunPosition(state.location, state.month, state.day, state.hour, state.northAngle);
  viewer.setSun(s.vector, s.isUp);
  syncSunInputs();
  // sunrise / sunset by scanning
  let rise = NaN, set = NaN, prev = sunPosition(state.location, state.month, state.day, 0).altitude;
  for (let h = 0.05; h <= 24; h += 0.05) {
    const a = sunPosition(state.location, state.month, state.day, h).altitude;
    if (prev <= 0 && a > 0 && Number.isNaN(rise)) rise = h;
    if (prev > 0 && a <= 0) set = h;
    prev = a;
  }
  const hm = (h: number) => (Number.isNaN(h) ? '—' : `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`);
  const w = state.weather;
  const hoy = hoyIndex(state.month, state.day, Math.floor(state.hour));
  $('sunInfo').innerHTML = `<div class="kv">
    <span>Altitude</span><b>${s.altitude.toFixed(1)}°${s.isUp ? '' : ' (below horizon)'}</b>
    <span>Azimuth</span><b>${s.azimuth.toFixed(1)}°</b>
    <span>Sunrise / set</span><b>${hm(rise)} / ${hm(set)} (standard time)</b>
    ${w?.hasClimate ? `<span>Weather</span><b>${fmt(w.dryBulb[hoy], 1)} °C · ${fmt(w.relHumidity[hoy], 0)}% RH · GHI ${fmt(w.ghi[hoy], 0)} W/m²</b>` : ''}
  </div>`;
}

selMonth.onchange = () => {
  state.month = +selMonth.value;
  state.day = Math.min(state.day, DAYS_IN_MONTH[state.month - 1]);
  updateSun();
};
$('inDay').onchange = () => {
  state.day = Math.max(1, Math.min(DAYS_IN_MONTH[state.month - 1], Math.round(num('inDay')) || 1));
  updateSun();
};
$('rngHour').oninput = () => {
  state.hour = num('rngHour');
  updateSun();
};
$('rngDoy').oninput = () => {
  const md = monthDayFromDoy(num('rngDoy'));
  state.month = md.month;
  state.day = md.day;
  updateSun();
};
let playTimer = 0;
$('btnPlay').onclick = () => {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = 0;
    $('btnPlay').textContent = '▶ Animate day';
    return;
  }
  $('btnPlay').textContent = '❚❚ Pause';
  playTimer = window.setInterval(() => {
    state.hour = (state.hour + 0.25) % 24;
    updateSun();
  }, 90);
};
$('chkPath').onchange = () => viewer.setSunPathVisible(checked('chkPath'));
$('chkShadow').onchange = () => viewer.setShadows(checked('chkShadow'));

// ---------------------------------------------------------------- analysis settings UI
const PERIODS: Record<string, AnalysisPeriod> = {
  year: FULL_YEAR,
  mar21: { stMonth: 3, stDay: 21, stHour: 0, endMonth: 3, endDay: 21, endHour: 23 },
  jun21: { stMonth: 6, stDay: 21, stHour: 0, endMonth: 6, endDay: 21, endHour: 23 },
  dec21: { stMonth: 12, stDay: 21, stHour: 0, endMonth: 12, endDay: 21, endHour: 23 },
  summer: { stMonth: 6, stDay: 1, stHour: 0, endMonth: 8, endDay: 31, endHour: 23 },
  winter: { stMonth: 12, stDay: 1, stHour: 0, endMonth: 2, endDay: 28, endHour: 23 },
};

function writePeriod(p: AnalysisPeriod) {
  state.period = p;
  $<HTMLInputElement>('inPStart').value = `${p.stMonth}/${p.stDay}`;
  $<HTMLInputElement>('inPEnd').value = `${p.endMonth}/${p.endDay}`;
  $<HTMLInputElement>('inPHours').value = `${p.stHour}-${p.endHour}`;
}

function readPeriod(): AnalysisPeriod {
  const md = (s: string, fallback: [number, number]) => {
    const m = s.match(/(\d{1,2})\s*[/.-]\s*(\d{1,2})/);
    if (!m) return fallback;
    const mo = Math.min(12, Math.max(1, +m[1]));
    return [mo, Math.min(DAYS_IN_MONTH[mo - 1], Math.max(1, +m[2]))] as [number, number];
  };
  const [sm, sd] = md(val('inPStart'), [1, 1]);
  const [em, ed] = md(val('inPEnd'), [12, 31]);
  const h = val('inPHours').match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/);
  const sh = h ? Math.min(23, +h[1]) : 0;
  const eh = h ? Math.min(23, +h[2]) : 23;
  return { stMonth: sm, stDay: sd, stHour: sh, endMonth: em, endDay: ed, endHour: eh };
}

$('selPeriod').onchange = () => {
  const p = PERIODS[val('selPeriod')];
  if (p) writePeriod(p);
};
for (const id of ['inPStart', 'inPEnd', 'inPHours']) {
  $(id).addEventListener('change', () => {
    $<HTMLSelectElement>('selPeriod').value = 'custom';
    writePeriod(readPeriod());
  });
}

function applyVisibility() {
  const type = val('selType');
  const grid = val('selGrid');
  document.querySelectorAll<HTMLElement>('[data-show]').forEach((el) => {
    const keys = el.dataset.show!.split(' ');
    const show = keys.includes(type) || keys.includes(grid);
    if (show) el.removeAttribute('data-hidden-by-type');
    else el.setAttribute('data-hidden-by-type', '');
  });
  $('typeHint').textContent = STUDY[type as StudyType].hint;
}

$('selType').onchange = () => {
  const t = val('selType') as StudyType;
  $<HTMLSelectElement>('selGrid').value = STUDY[t].grid;
  $<HTMLInputElement>('inGrid').value = STUDY[t].grid === 'workplane' ? '0.5' : '1';
  if (t === 'sunHours') {
    $<HTMLSelectElement>('selPeriod').value = 'dec21';
    writePeriod(PERIODS.dec21);
  }
  if (t === 'radiation') {
    $<HTMLSelectElement>('selPeriod').value = 'year';
    writePeriod(PERIODS.year);
  }
  applyVisibility();
};
$('selGrid').onchange = applyVisibility;

// ---------------------------------------------------------------- run simulation
/** Current study settings from the sidebar. */
function readSettings(): StudySettings {
  return {
    type: val('selType') as StudyType,
    gridKind: val('selGrid') as 'surfaces' | 'workplane',
    gridSize: Math.max(0.02, num('inGrid') || 1),
    offset: Math.max(0, num('inOffset') || 0),
    wpHeight: num('inWp') || 0,
    flip: checked('chkFlip'),
    period: readPeriod(),
    mf: +val('selMf'),
    skyViewMetric: val('selSkyView') as 'exposure' | 'view',
    sky: val('selSky') as 'auto' | 'clear' | 'overcast',
    includeGround: checked('chkGround'),
    groundReflectance: num('inGroundR'),
    diffuseHorizontal: num('inEdh'),
    directNormal: num('inEdn'),
    illumFromWeather: checked('chkIllumWeather'),
    tau: num('inTau'),
    glazingOpaque: checked('chkGlassOpaque'),
    bounce: +val('selBounce') as 0 | 1 | 2,
    reflectance: num('inRefl'),
    rays: num('inRays'),
    month: state.month,
    day: state.day,
    hour: state.hour,
  };
}

function studyContext() {
  if (!state.weather) throw new Error('Weather data is still loading.');
  return { weather: state.weather, location: state.location, northAngle: state.northAngle, weatherLabel: state.weatherLabel };
}

async function run() {
  if (state.running) return;
  if (!viewer.parts.length) {
    toast('Load a model first (try "Load sample site").', true);
    return;
  }
  const settings = readSettings();
  const type = settings.type;
  let grid: AnalysisGrid, prep: Prepared;
  try {
    grid = buildGrid(settings, viewer.parts);
    if (!grid.areas.length) throw new Error('The sensor grid is empty — check the grid size and the selected surfaces.');
    prep = prepareStudy(settings, studyContext());
    if (prep.warning) toast(prep.warning, true);
  } catch (e) {
    toast((e as Error).message, true);
    return;
  }
  const job = makeJob(grid, prep, settings);
  state.running = true;
  $<HTMLButtonElement>('btnRun').disabled = true;
  $('btnCancel').hidden = false;
  $('progress').hidden = false;
  const bar = $('progress').firstElementChild as HTMLElement;
  bar.style.width = '0%';
  const sensors = grid.areas.length;
  $('runInfo').textContent = `Tracing ${sensors.toLocaleString()} sensors × ${prep.weights.length.toLocaleString()} directions${prep.bounce ? ` (+${prep.bounce.rays} bounce rays)` : ''}…`;
  try {
    const res = await sim.run(sceneData(viewer.parts), job, (f) => (bar.style.width = `${(f * 100).toFixed(1)}%`));
    const values = res.values;
    const st = STUDY[type];
    const rec: ResultRecord = {
      id: (state.results.at(-1)?.id ?? 0) + 1,
      type,
      title: st.title,
      unit: st.unit,
      meta: prep.meta,
      grid,
      values,
      legend: { palette: st.palette, min: 0, max: 1, segments: 0 },
      threshold: st.threshold,
      lift: Math.min(0.03, Math.max(0.002, (num('inGrid') || 1) * 0.01)),
      modelVersion: state.modelVersion,
    };
    autoRange(rec);
    state.results.push(rec);
    showResult(rec);
    if (settings.gridKind === 'workplane') {
      // cut away roofs/ceilings so the interior work plane is visible
      let top = -Infinity;
      for (let i = 1; i < grid.sensors.length; i += 3) top = Math.max(top, grid.sensors[i]);
      setSection(true, +(top + 1.4).toFixed(2));
      viewer.fitResult();
    } else if (checked('chkSection')) {
      setSection(false);
    }
    $('runInfo').textContent = `Done in ${(res.ms / 1000).toFixed(1)} s · ${sensors.toLocaleString()} sensors.`;
  } catch (e) {
    const msg = (e as Error).message;
    $('runInfo').textContent = msg === 'cancelled' ? 'Cancelled.' : `Error: ${msg}`;
    if (msg !== 'cancelled') toast(msg, true);
  } finally {
    state.running = false;
    $<HTMLButtonElement>('btnRun').disabled = false;
    $('btnCancel').hidden = true;
    $('progress').hidden = true;
  }
}
$('btnRun').onclick = run;
$('btnCancel').onclick = () => sim.cancel();

// ---------------------------------------------------------------- results
function autoRange(r: ResultRecord) {
  let lo = Infinity, hi = -Infinity;
  for (const v of r.values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (r.type === 'daylightFactor') { lo = 0; hi = Math.max(5, Math.min(10, Math.ceil(hi))); }
  else if (r.type === 'skyView') { lo = 0; hi = 100; }
  else if (r.type === 'sunHours') { lo = 0; hi = Math.max(1, Math.ceil(hi)); }
  else { lo = Math.min(0, lo) === 0 ? 0 : lo; hi = hi > lo ? hi : lo + 1; }
  r.legend.min = +lo.toPrecision(4);
  r.legend.max = +hi.toPrecision(4);
}

function faceColors(r: ResultRecord): Float32Array {
  const n = r.grid.triSensor.length;
  const out = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const c = colorFor(r.values[r.grid.triSensor[t]], r.legend);
    for (let k = 0; k < 3; k++) out.set(c, t * 9 + k * 3);
  }
  return out;
}

function showResult(r: ResultRecord) {
  state.current = r;
  viewer.setResult(r.grid.triangles.slice(), faceColors(r), r.lift);
  viewer.setResultVisible(checked('chkShowResult'));
  renderHistorySelect();
  renderResultPanel();
}

function recolor() {
  const r = state.current;
  if (!r) return;
  viewer.updateResultColors(faceColors(r));
  renderResultPanel(false);
}

function renderHistorySelect() {
  const sel = $<HTMLSelectElement>('selHistory');
  sel.innerHTML = '';
  for (const r of state.results) sel.add(new Option(`#${r.id} ${r.title}`, String(r.id), false, r === state.current));
}
$('selHistory').onchange = () => {
  const r = state.results.find((x) => x.id === +val('selHistory'));
  if (r) showResult(r);
};

function stats(r: ResultRecord) {
  return gridStats(r.values, r.grid.areas, r.threshold);
}

function renderStale() {
  const r = state.current;
  $('staleNote').hidden = !r || r.modelVersion === state.modelVersion;
}
$('btnRerun').onclick = () => run();

function renderResultPanel(full = true) {
  const r = state.current;
  renderStale();
  $('resultsEmpty').hidden = !!r;
  $('resultsBody').hidden = !r;
  $('legendOverlay').hidden = !r;
  if (!r) return;
  const s = stats(r);
  $('stats').innerHTML = `
    <div class="stat wide"><div class="k">${escapeHtml(r.title)}</div><div class="hint">${escapeHtml(r.meta)}</div></div>
    <div class="stat"><div class="k">Area-weighted mean</div><div class="v">${fmt(s.mean)}<small>${r.unit}</small></div></div>
    <div class="stat"><div class="k">Area ≥ ${fmt(r.threshold)} ${r.unit}</div><div class="v">${fmt(s.above, 1)}<small>%</small></div></div>
    <div class="stat"><div class="k">Minimum</div><div class="v">${fmt(s.min)}<small>${r.unit}</small></div></div>
    <div class="stat"><div class="k">Maximum</div><div class="v">${fmt(s.max)}<small>${r.unit}</small></div></div>
    <div class="stat wide"><div class="k">Sensors · analysed area</div><div class="v">${r.values.length.toLocaleString()} <small>pts</small> · ${fmt(s.area, 0)}<small>m²</small></div></div>`;
  histogram($('hist'), r.values, r.grid.areas, r.legend, r.unit);
  if (full) {
    $<HTMLSelectElement>('selPalette').value = r.legend.palette;
    $<HTMLSelectElement>('selSegments').value = String(r.legend.segments);
    $<HTMLInputElement>('inLMin').value = String(r.legend.min);
    $<HTMLInputElement>('inLMax').value = String(r.legend.max);
    $<HTMLInputElement>('inThresh').value = String(r.threshold);
  }
  // viewport legend
  const L = r.legend;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span style="bottom:${f * 100}%">${fmt(L.min + (L.max - L.min) * f)}</span>`).join('');
  const segs = L.segments > 1
    ? `linear-gradient(to top, ${Array.from({ length: L.segments }, (_, i) => {
        const c = colorFor(L.min + ((i + 0.5) / L.segments) * (L.max - L.min), L).map((x) => Math.round(x * 255)).join(',');
        return `rgb(${c}) ${(i / L.segments) * 100}% ${((i + 1) / L.segments) * 100}%`;
      }).join(', ')})`
    : gradientCss(L.palette);
  $('legendOverlay').innerHTML = `<div class="title">${escapeHtml(r.title)} (${r.unit})</div><div class="bar" style="background:${segs}"></div><div class="ticks">${ticks}</div>`;
}

const selPalette = $<HTMLSelectElement>('selPalette');
for (const [k, p] of Object.entries(PALETTES)) selPalette.add(new Option(p.label, k));
selPalette.onchange = () => { if (state.current) { state.current.legend.palette = selPalette.value; recolor(); } };
$('selSegments').onchange = () => { if (state.current) { state.current.legend.segments = +val('selSegments'); recolor(); } };
$('inLMin').onchange = () => { if (state.current) { state.current.legend.min = num('inLMin'); recolor(); } };
$('inLMax').onchange = () => { if (state.current) { state.current.legend.max = num('inLMax'); recolor(); } };
$('inThresh').onchange = () => { if (state.current) { state.current.threshold = num('inThresh'); renderResultPanel(false); } };
$('btnAutoRange').onclick = () => { if (state.current) { autoRange(state.current); recolor(); renderResultPanel(); } };
$('chkShowResult').onchange = () => viewer.setResultVisible(checked('chkShowResult'));

function clearResults() {
  state.results = [];
  state.current = null;
  viewer.clearResult();
  renderHistorySelect();
  renderResultPanel();
}

viewer.onPick = (hit) => {
  const r = state.current;
  if (!hit || !r) return hideTip();
  const s = r.grid.triSensor[hit.face];
  const v = r.values[s];
  showTip(`<b>${fmt(v)} ${r.unit}</b><br>${escapeHtml(r.title)}<br><span style="color:var(--ink-3)">sensor #${s} · (${fmt(hit.point.x, 2)}, ${fmt(hit.point.y, 2)}, ${fmt(hit.point.z, 2)})</span>`, hit.clientX, hit.clientY);
};

// exports
function exportName(ext: string) {
  const r = state.current!;
  return `${r.type}_${r.id}.${ext}`;
}
$('btnCsv').onclick = () => {
  const r = state.current;
  if (!r) return;
  const g = r.grid;
  const lines = [`# ${r.title} (${r.unit}) — ${r.meta}`, 'sensor,x,y,z,nx,ny,nz,area_m2,value'];
  for (let i = 0; i < r.values.length; i++) {
    lines.push([i, g.sensors[i * 3], g.sensors[i * 3 + 1], g.sensors[i * 3 + 2], g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2], g.areas[i]].map((x) => +(+x).toFixed(4)).join(',') + ',' + +r.values[i].toFixed(4));
  }
  download(exportName('csv'), lines.join('\n'), 'text/csv');
};
$('btnJson').onclick = () => {
  const r = state.current;
  if (!r) return;
  const s = stats(r);
  const data = {
    study: r.title, unit: r.unit, settings: r.meta,
    location: state.location, northAngle: state.northAngle,
    coordinateSystem: 'Y-up metres; -Z = north before north-angle rotation (Rhino: x, -z, y)',
    statistics: s, threshold: r.threshold, legend: r.legend,
    sensors: Array.from(r.grid.sensors).map((v) => +v.toFixed(4)),
    normals: Array.from(r.grid.normals).map((v) => +v.toFixed(4)),
    areas: Array.from(r.grid.areas).map((v) => +v.toFixed(5)),
    values: Array.from(r.values).map((v) => +v.toFixed(4)),
  };
  download(exportName('json'), JSON.stringify(data), 'application/json');
};
$('btnGlb').onclick = async () => {
  if (!state.current) return;
  try {
    download(exportName('glb'), await viewer.exportGLB({ result: true, model: true }), 'model/gltf-binary');
  } catch (e) {
    toast(`GLB export failed: ${(e as Error).message}`, true);
  }
};
const savePng = async () => {
  const blob = await (await fetch(viewer.screenshot())).blob();
  download(state.current ? exportName('png') : 'view.png', blob, 'image/png');
};
$('btnPng').onclick = savePng;
$('btnShot').onclick = savePng;

// ---------------------------------------------------------------- climate drawer
$('btnClimate').onclick = () => {
  const d = $('drawer');
  d.hidden = !d.hidden;
  if (!d.hidden) {
    $('optDrawer').hidden = true;
    refreshClimate();
  }
};

// ---------------------------------------------------------------- optimizer
function setNorth(v: number) {
  state.northAngle = v;
  $<HTMLInputElement>('inNorth').value = String(v);
  viewer.setSunPathParams(state.location, state.northAngle);
  updateSun();
}
const optimizer = new OptimizerPanel({
  editor,
  readSettings,
  studyContext,
  getNorth: () => state.northAngle,
  setNorth,
  getTau: () => num('inTau'),
  setTau: (v) => ($<HTMLInputElement>('inTau').value = String(v)),
  toast,
  onApplied: () => renderStale(),
});
$('btnCloseDrawer').onclick = () => ($('drawer').hidden = true);
initClimate(() => ({ weather: state.weather, period: readPeriod() }));

// ---------------------------------------------------------------- responsive
$('btnPanels').onclick = () => $('sidebar').classList.toggle('open');
document.querySelectorAll<HTMLButtonElement>('[data-proxy]').forEach((b) => (b.onclick = () => {
  $('sidebar').classList.remove('open');
  $(b.dataset.proxy!).click();
}));

// ---------------------------------------------------------------- boot
writePeriod(state.period);
$<HTMLSelectElement>('selPeriod').value = 'dec21';
applyVisibility();
syncSunInputs();
loadSample();
loadPresetWeather('sf');

// expose for automation / debugging
(window as unknown as { envsim: unknown }).envsim = { state, viewer, editor, panel, optimizer, run };
