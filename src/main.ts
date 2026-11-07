import './styles.css';
import * as THREE from 'three';
import { Viewer, Part } from './viewer/viewer';
import { buildSampleModel } from './viewer/sampleModel';
import {
  loadModelFile, collectMeshes, meshLabel, guessRole, worldTriangles, concatFloat32,
  Role, ROLE_LABELS, UNIT_SCALE, SUPPORTED_EXTENSIONS,
} from './viewer/loaders';
import {
  Location, sunPosition, AnalysisPeriod, FULL_YEAR, periodHours, periodSunVectors,
  MONTH_NAMES, DAYS_IN_MONTH, dayOfYear, monthDayFromDoy, hoyIndex, describePeriod,
} from './core/solar';
import { WeatherData, parseEPW, syntheticClearSky } from './core/weather';
import { cumulativeSky, skyPatches, daylightSkyDirections } from './core/sky';
import { surfaceGrid, workPlaneGrid, AnalysisGrid } from './core/grid';
import { LegendSettings, PALETTES, colorFor, gradientCss } from './core/colors';
import { SimClient } from './sim/client';
import { JobData, WeightMode, BounceSettings } from './sim/engine';
import { histogram, fmt, showTip, hideTip } from './ui/charts';
import { initClimate, refreshClimate } from './ui/climate';

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

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- state
type StudyType = 'sunHours' | 'radiation' | 'skyView' | 'daylightFactor' | 'illuminance';

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
}

const STUDY: Record<StudyType, { title: string; unit: string; hint: string; grid: 'surfaces' | 'workplane'; threshold: number; palette: string }> = {
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

const ROLE_SWATCH: Record<Role, string> = {
  context: '#d9d6cf', analysis: '#9fb38f', floor: '#c7a77b', glazing: '#6fb3df', ignore: 'transparent',
};

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
  selectedPart: null as Part | null,
  running: false,
};

// ---------------------------------------------------------------- viewer
const viewer = new Viewer($('viewport'));
const sim = new SimClient();

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
function addObject(root: THREE.Object3D, opts: { units: string; up: string; recenter: boolean; roles?: Record<string, Role> }) {
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
  const meshes = collectMeshes(wrapper);
  if (!meshes.length) throw new Error('No mesh geometry found in the file.');
  const parts = meshes.map((m, i) => {
    const name = meshLabel(m, i);
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    const role = opts.roles?.[name] ?? guessRole(name, mat?.name ?? '');
    const tris = (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    return { name, mesh: m, role, visible: true, triangles: Math.round(tris) };
  });
  viewer.addModel(wrapper, parts);
  renderParts();
  updateSectionRange();
  viewer.fit();
  $('vpEmpty').hidden = viewer.parts.length > 0;
}

function loadSample() {
  viewer.clearModel();
  clearResults();
  addObject(buildSampleModel(), {
    units: 'm', up: 'y', recenter: false,
    roles: { Ground: 'analysis', Studio_Floor: 'floor', Studio_Window_Glass: 'glazing' },
  });
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

function renderParts() {
  const list = $('partList');
  list.innerHTML = '';
  for (const p of viewer.parts) {
    const row = document.createElement('div');
    row.className = 'part' + (p === state.selectedPart ? ' sel' : '');
    const vis = document.createElement('input');
    vis.type = 'checkbox';
    vis.checked = p.visible;
    vis.title = 'Show / hide';
    vis.setAttribute('aria-label', `Show ${p.name}`);
    vis.onchange = () => {
      p.visible = vis.checked;
      viewer.styleMesh(p);
    };
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = ROLE_SWATCH[p.role];
    const name = document.createElement('span');
    name.className = 'name';
    name.innerHTML = `${escapeHtml(p.name)} <small>${p.triangles.toLocaleString()} tris</small>`;
    name.title = p.name;
    name.onclick = () => selectPart(p);
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `Role of ${p.name}`);
    for (const [k, label] of Object.entries(ROLE_LABELS)) sel.add(new Option(label, k, false, k === p.role));
    sel.onchange = () => {
      p.role = sel.value as Role;
      viewer.styleMesh(p);
      viewer.updateBounds();
      renderParts();
    };
    row.append(vis, sw, name, sel);
    list.appendChild(row);
  }
}

function selectPart(p: Part | null) {
  state.selectedPart = p;
  viewer.highlight(p);
  renderParts();
  if (p) {
    const idx = viewer.parts.indexOf(p);
    ($('partList').children[idx] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }
}
viewer.onSelectPart = (p) => selectPart(state.selectedPart === p ? null : p);

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

$('btnSample').onclick = loadSample;
$('btnClear').onclick = () => {
  viewer.clearModel();
  clearResults();
  renderParts();
  $('vpEmpty').hidden = false;
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
$('inNorth').addEventListener('change', () => {
  state.northAngle = num('inNorth') || 0;
  viewer.setSunPathParams(state.location, state.northAngle);
  updateSun();
});

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
function sceneData() {
  const opaque: Float32Array[] = [];
  const glazing: Float32Array[] = [];
  for (const p of viewer.parts) {
    if (p.role === 'ignore') continue;
    (p.role === 'glazing' ? glazing : opaque).push(worldTriangles(p.mesh));
  }
  return { opaque: concatFloat32(opaque), glazing: concatFloat32(glazing) };
}

function buildGrid(kind: string): AnalysisGrid {
  const size = Math.max(0.02, num('inGrid') || 1);
  if (kind === 'workplane') {
    const floors = viewer.parts.filter((p) => p.role === 'floor').map((p) => worldTriangles(p.mesh));
    if (!floors.length) throw new Error('No floor meshes. Set a mesh\'s role to "Floor → work plane" or switch the sensor grid to "On analysis surfaces".');
    return workPlaneGrid(concatFloat32(floors), size, num('inWp') || 0);
  }
  const surfs = viewer.parts.filter((p) => p.role === 'analysis').map((p) => worldTriangles(p.mesh));
  if (!surfs.length) throw new Error('No analysis surfaces. Set at least one mesh\'s role to "Analysis surface".');
  return surfaceGrid(concatFloat32(surfs), size, checked('chkFlip'));
}

interface Prepared {
  dirs: Float32Array;
  weights: Float32Array;
  mode: WeightMode;
  scale: number;
  meta: string;
  bounce?: BounceSettings;
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

function prepare(type: StudyType): Prepared {
  const w = state.weather;
  if (!w) throw new Error('Weather data is still loading.');
  const mf = +val('selMf');
  const north = state.northAngle;
  const period = readPeriod();
  const includeGround = checked('chkGround');
  const groundR = num('inGroundR');

  if (type === 'sunHours') {
    const suns = periodSunVectors(state.location, period, north, 0);
    if (!suns.length) throw new Error('The sun is never above the horizon in this analysis period.');
    const dirs = new Float32Array(suns.length * 3);
    suns.forEach((s, i) => dirs.set(s.sun.vector, i * 3));
    return { dirs, weights: new Float32Array(suns.length).fill(1), mode: 'count', scale: 1, meta: `${describePeriod(period)} · ${suns.length} sun-up hours` };
  }
  if (type === 'radiation') {
    const sky = cumulativeSky(w, { mf, northAngle: north, includeGround, groundReflectance: groundR, hours: periodHours(period) });
    const all = [...sky.patches, ...sky.ground];
    const vals = [...sky.values, ...sky.groundValues];
    return { ...packPatches(all, vals), mode: 'cosine', scale: 1, meta: `${describePeriod(period)} · ${state.weatherLabel} · ${sky.patches.length} sky patches` };
  }
  if (type === 'skyView') {
    const patches = skyPatches(mf, north);
    const metric = val('selSkyView');
    const weights = patches.map((p) => (metric === 'view' ? (p.solidAngle / Math.PI) * 100 : (p.solidAngle / (2 * Math.PI)) * 100));
    return { ...packPatches(patches, weights), mode: metric === 'view' ? 'cosine' : 'uniform', scale: 1, meta: `${metric === 'view' ? 'Sky view factor' : 'Sky exposure'} · ${patches.length} patches` };
  }
  // daylight
  const bounceMode = +val('selBounce');
  let sky: ReturnType<typeof daylightSkyDirections>;
  let meta: string;
  if (type === 'daylightFactor') {
    sky = daylightSkyDirections({ sky: 'overcast', mf, northAngle: north, diffuseHorizontal: 100, directNormal: 0, groundReflectance: groundR, includeGround });
    meta = 'CIE overcast sky';
  } else {
    const sun = sunPosition(state.location, state.month, state.day, state.hour, north);
    const hoy = hoyIndex(state.month, state.day, Math.floor(state.hour));
    let dh = num('inEdh'), dn = num('inEdn');
    if (checked('chkIllumWeather')) {
      dh = w.dhIllum[hoy];
      dn = w.dnIllum[hoy];
      if (!(dh > 0) && sun.altitude > 0) {
        toast('Weather file has no daylight at this hour; using manual illuminance values.', true);
        dh = num('inEdh');
        dn = num('inEdn');
      }
    }
    let skyType = val('selSky') as 'auto' | 'clear' | 'overcast';
    if (skyType === 'auto') skyType = dn > 2000 ? 'clear' : 'overcast';
    if (sun.altitude <= 0 && skyType === 'clear') skyType = 'overcast';
    sky = daylightSkyDirections({ sky: skyType, mf, northAngle: north, diffuseHorizontal: dh, directNormal: dn, sun, groundReflectance: groundR, includeGround });
    const hh = Math.floor(state.hour), mm = Math.round((state.hour % 1) * 60);
    meta = `${MONTH_NAMES[state.month - 1]} ${state.day} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · CIE ${skyType} · Ed ${fmt(dh, 0)} lx${skyType === 'clear' ? ` · En ${fmt(dn, 0)} lx` : ''}`;
  }
  let bounce: BounceSettings | undefined;
  if (bounceMode > 0) {
    // evaluate hit-point illuminance with the coarse (Tregenza) sky for speed
    const coarse = mf === 1 ? sky : type === 'daylightFactor'
      ? daylightSkyDirections({ sky: 'overcast', mf: 1, northAngle: north, diffuseHorizontal: 100, directNormal: 0, groundReflectance: groundR, includeGround })
      : sky;
    bounce = {
      rays: Math.max(8, Math.round(num('inRays') || 48)),
      reflectance: Math.min(0.95, Math.max(0, num('inRefl'))),
      multi: bounceMode === 2,
      dirs: coarse.dirs,
      weights: coarse.weights,
    };
    meta += ` · ${bounceMode === 2 ? 'multi-bounce' : '1 bounce'} ρ=${bounce.reflectance}`;
  }
  return { dirs: sky.dirs, weights: sky.weights, mode: 'cosine', scale: 1, meta, bounce };
}

async function run() {
  if (state.running) return;
  if (!viewer.parts.length) {
    toast('Load a model first (try "Load sample site").', true);
    return;
  }
  const type = val('selType') as StudyType;
  let grid: AnalysisGrid, prep: Prepared;
  try {
    grid = buildGrid(val('selGrid'));
    if (!grid.areas.length) throw new Error('The sensor grid is empty — check the grid size and the selected surfaces.');
    prep = prepare(type);
  } catch (e) {
    toast((e as Error).message, true);
    return;
  }
  const job: JobData = {
    sensors: grid.sensors,
    normals: grid.normals,
    dirs: prep.dirs,
    weights: prep.weights,
    mode: prep.mode,
    glazingTransmittance: Math.min(1, Math.max(0, num('inTau'))),
    glazingOpaque: checked('chkGlassOpaque'),
    offset: Math.max(0, num('inOffset') || 0),
    bounce: prep.bounce,
  };
  state.running = true;
  $<HTMLButtonElement>('btnRun').disabled = true;
  $('btnCancel').hidden = false;
  $('progress').hidden = false;
  const bar = $('progress').firstElementChild as HTMLElement;
  bar.style.width = '0%';
  const sensors = grid.areas.length;
  $('runInfo').textContent = `Tracing ${sensors.toLocaleString()} sensors × ${prep.weights.length.toLocaleString()} directions${prep.bounce ? ` (+${prep.bounce.rays} bounce rays)` : ''}…`;
  try {
    const res = await sim.run(sceneData(), job, (f) => (bar.style.width = `${(f * 100).toFixed(1)}%`));
    const values = res.values;
    if (prep.scale !== 1) for (let i = 0; i < values.length; i++) values[i] *= prep.scale;
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
    };
    autoRange(rec);
    state.results.push(rec);
    showResult(rec);
    if (val('selGrid') === 'workplane') {
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
  let sumA = 0, sumVA = 0, above = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < r.values.length; i++) {
    const v = r.values[i], a = r.grid.areas[i];
    sumA += a;
    sumVA += v * a;
    if (v >= r.threshold) above += a;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { mean: sumVA / (sumA || 1), area: sumA, above: (above / (sumA || 1)) * 100, min: lo, max: hi };
}

function renderResultPanel(full = true) {
  const r = state.current;
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
    download(exportName('glb'), await viewer.exportGLB(true), 'model/gltf-binary');
  } catch (e) {
    toast(`GLB export failed: ${(e as Error).message}`, true);
  }
};
const savePng = () => {
  const url = viewer.screenshot();
  const a = document.createElement('a');
  a.href = url;
  a.download = state.current ? exportName('png') : 'view.png';
  a.click();
};
$('btnPng').onclick = savePng;
$('btnShot').onclick = savePng;

// ---------------------------------------------------------------- climate drawer
$('btnClimate').onclick = () => {
  const d = $('drawer');
  d.hidden = !d.hidden;
  if (!d.hidden) refreshClimate();
};
$('btnCloseDrawer').onclick = () => ($('drawer').hidden = true);
initClimate(() => ({ weather: state.weather, period: readPeriod() }));

// ---------------------------------------------------------------- responsive
$('btnPanels').onclick = () => $('sidebar').classList.toggle('open');

// ---------------------------------------------------------------- boot
writePeriod(state.period);
$<HTMLSelectElement>('selPeriod').value = 'dec21';
applyVisibility();
syncSunInputs();
loadSample();
loadPresetWeather('sf');

// expose for automation / debugging
(window as unknown as { envsim: unknown }).envsim = { state, viewer, run };
