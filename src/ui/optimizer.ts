/**
 * Galapagos-style optimizer panel: pick genes (model and site parameters),
 * define objectives from saved study setups (maximize / minimize / constraints,
 * weighted), choose a solver, and watch the search. Designs are evaluated in
 * parallel workers, optionally at draft quality with a full-quality check of the
 * best designs at the end.
 */
import type { ModelEditor, ParamDef } from '../model/editor';
import {
  StudySettings, StudyContext, STUDY, sceneData, buildGrid, prepareStudy, makeJob, gridStats, GridStats, Prepared,
} from '../study';
import { describePeriod } from '../core/solar';
import { evolve, anneal, Gene, Genome, genomeKey, Progress, SolverResult, DEFAULT_EVOLVE, DEFAULT_ANNEAL, snap } from '../core/optimize';
import { SimPool } from '../sim/pool';
import { fmt, showTip, hideTip, niceTicks } from './charts';
import { escapeHtml } from './modelPanel';

export interface OptimizerHost {
  editor: ModelEditor;
  readSettings(): StudySettings;
  studyContext(): StudyContext;
  getNorth(): number;
  setNorth(v: number): void;
  getTau(): number;
  setTau(v: number): void;
  toast(msg: string, error?: boolean): void;
  /** called after a solution was applied to the model */
  onApplied(): void;
}

type Metric = 'mean' | 'above' | 'min' | 'max' | 'total';
type Goal = 'max' | 'min' | 'atLeast' | 'atMost';

interface Objective {
  id: number;
  settings: StudySettings;
  metric: Metric;
  threshold: number;
  goal: Goal;
  target: number;
  weight: number;
}

interface GeneRow {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}

interface Design {
  genome: Genome;
  values: number[];
  fitness: number;
  full?: { values: number[]; fitness: number };
}

const METRICS: { key: Metric; label: string }[] = [
  { key: 'mean', label: 'Area-weighted mean' },
  { key: 'above', label: '% of area ≥ threshold' },
  { key: 'min', label: 'Minimum' },
  { key: 'max', label: 'Maximum' },
  { key: 'total', label: 'Total (value × m²)' },
];
const GOALS: { key: Goal; label: string }[] = [
  { key: 'max', label: 'Maximize' },
  { key: 'min', label: 'Minimize' },
  { key: 'atLeast', label: 'Keep at least' },
  { key: 'atMost', label: 'Keep at most' },
];

const $ = (id: string) => document.getElementById(id)!;

function metricValue(m: Metric, s: GridStats): number {
  return m === 'mean' ? s.mean : m === 'above' ? s.above : m === 'min' ? s.min : m === 'max' ? s.max : s.total;
}

function metricUnit(o: Objective): string {
  const u = STUDY[o.settings.type].unit;
  return o.metric === 'above' ? '% area' : o.metric === 'total' ? `${u}·m²` : u;
}

export class OptimizerPanel {
  private genes: GeneRow[] = [];
  private objectives: Objective[] = [];
  private solver: 'evolve' | 'anneal' = 'evolve';
  private evo = { ...DEFAULT_EVOLVE };
  private ann = { ...DEFAULT_ANNEAL };
  private draft = true;
  private pool: SimPool | null = null;
  private running = false;
  private stopRequested = false;
  private history: { generation: number; best: number; mean: number }[] = [];
  private designs = new Map<string, Design>();
  private baseline: number[] = [];
  private fullBaseline: number[] = [];
  private initialGenome: Genome = [];
  private status = '';
  private nextObjectiveId = 1;
  private overrides: { north?: number; tau?: number } = {};
  private prepCache = new Map<string, Prepared>();

  constructor(private host: OptimizerHost) {
    $('btnOptimize').onclick = () => this.toggle();
    $('btnCloseOpt').onclick = () => ($('optDrawer').hidden = true);
  }

  toggle(open?: boolean) {
    const d = $('optDrawer');
    d.hidden = open === undefined ? !d.hidden : !open;
    if (!d.hidden) {
      $('drawer').hidden = true;
      this.renderControls();
      this.renderResults();
    }
  }

  // ------------------------------------------------------------ parameters
  /** Every parameter that can become a gene: site + model. */
  private allDefs(): ParamDef[] {
    const h = this.host;
    const site: ParamDef[] = [
      {
        key: 'site.north', label: 'North angle (site rotation)', owner: 'Site', unit: '°', step: 5, min: -45, max: 45,
        get: () => this.overrides.north ?? h.getNorth(),
        set: (v) => (this.overrides.north = v),
      },
      {
        key: 'site.tau', label: 'Glazing transmittance', owner: 'Materials', unit: '', step: 0.05, min: 0.3, max: 0.8,
        get: () => this.overrides.tau ?? h.getTau(),
        set: (v) => (this.overrides.tau = v),
      },
    ];
    return [...site, ...h.editor.allParams()];
  }

  private defsFor(rows: GeneRow[]): ParamDef[] {
    const all = new Map(this.allDefs().map((d) => [d.key, d]));
    return rows.map((r) => {
      const d = all.get(r.key);
      if (!d) throw new Error(`"${r.label}" no longer exists in the model. Remove it from the genes.`);
      return d;
    });
  }

  // ------------------------------------------------------------ controls
  private renderControls() {
    const el = $('optControls');
    const defs = this.allDefs();
    const used = new Set(this.genes.map((g) => g.key));
    const groups = new Map<string, ParamDef[]>();
    for (const d of defs) if (!used.has(d.key)) (groups.get(d.owner) ?? groups.set(d.owner, []).get(d.owner)!).push(d);
    const geneOptions = [...groups.entries()]
      .map(([owner, ds]) => `<optgroup label="${escapeHtml(owner)}">${ds.map((d) => `<option value="${d.key}">${escapeHtml(d.label)}</option>`).join('')}</optgroup>`)
      .join('');
    const cur = new Map(defs.map((d) => [d.key, d]));
    const geneRows = this.genes
      .map((g, i) => {
        const d = cur.get(g.key);
        return `<div class="opt-row" data-gene="${i}">
          <div class="opt-row-head"><b>${escapeHtml(g.label)}</b><button class="btn ghost small icon" data-remove-gene="${i}" aria-label="Remove gene">✕</button></div>
          <div class="row three">
            <label>Min${g.unit ? ` (${g.unit})` : ''}<input type="number" step="any" data-g="min" value="${g.min}" /></label>
            <label>Max<input type="number" step="any" data-g="max" value="${g.max}" /></label>
            <label>Step<input type="number" step="any" min="0" data-g="step" value="${g.step}" /></label>
          </div>
          <span class="hint">Now: ${d ? fmt(d.get(), 3) : 'missing'}</span>
        </div>`;
      })
      .join('');
    const objRows = this.objectives
      .map((o, i) => {
        const st = STUDY[o.settings.type];
        const where = o.settings.gridKind === 'workplane' ? 'work plane' : 'analysis surfaces';
        const when = o.settings.type === 'sunHours' || o.settings.type === 'radiation' ? ` · ${describePeriod(o.settings.period)}` : '';
        const constraint = o.goal === 'atLeast' || o.goal === 'atMost';
        return `<div class="opt-row" data-obj="${i}">
          <div class="opt-row-head"><b>${escapeHtml(st.title)}</b><button class="btn ghost small icon" data-remove-obj="${i}" aria-label="Remove objective">✕</button></div>
          <span class="hint">${where}${escapeHtml(when)} · grid ${o.settings.gridSize} m</span>
          <div class="row">
            <label>Goal<select data-o="goal">${GOALS.map((g) => `<option value="${g.key}"${g.key === o.goal ? ' selected' : ''}>${g.label}</option>`).join('')}</select></label>
            <label>Measure<select data-o="metric">${METRICS.map((m) => `<option value="${m.key}"${m.key === o.metric ? ' selected' : ''}>${m.label}</option>`).join('')}</select></label>
          </div>
          <div class="row three">
            <label${o.metric === 'above' ? '' : ' class="dim"'}>Threshold (${st.unit})<input type="number" step="any" data-o="threshold" value="${o.threshold}" /></label>
            <label${constraint ? '' : ' class="dim"'}>Target<input type="number" step="any" data-o="target" value="${o.target}" /></label>
            <label>Weight<input type="number" step="any" min="0" data-o="weight" value="${o.weight}" /></label>
          </div>
        </div>`;
      })
      .join('');
    const pool = SimPool.defaultSize();
    el.innerHTML = `
      <section>
        <h4>1 · Genes <span class="hint">what may change</span></h4>
        ${geneRows || '<p class="hint">No genes yet. Pick model or site parameters the optimizer may vary.</p>'}
        <div class="add-gene">
          <select id="optGenePick" aria-label="Parameter to add as a gene"><option value="">Add a parameter…</option>${geneOptions}</select>
        </div>
      </section>
      <section>
        <h4>2 · Objectives <span class="hint">what “better” means</span></h4>
        ${objRows || '<p class="hint">Set up a study in <b>4 · Analysis</b> (type, grid, period…), then add it here. Combine several with weights, or use one as a constraint.</p>'}
        <button class="btn ghost small" id="optAddObj">+ Add current study as objective</button>
      </section>
      <section>
        <h4>3 · Solver</h4>
        <div class="row">
          <label>Method<select id="optSolver">
            <option value="evolve"${this.solver === 'evolve' ? ' selected' : ''}>Evolutionary (genetic)</option>
            <option value="anneal"${this.solver === 'anneal' ? ' selected' : ''}>Simulated annealing</option>
          </select></label>
          <label class="check"><input type="checkbox" id="optDraft"${this.draft ? ' checked' : ''} /> Draft quality, verify best 5</label>
        </div>
        ${this.solver === 'evolve'
          ? `<div class="row three">
              <label>Population<input type="number" min="4" step="1" id="optPop" value="${this.evo.population}" /></label>
              <label>Generations<input type="number" min="1" step="1" id="optGen" value="${this.evo.generations}" /></label>
              <label>Stop if stagnant<input type="number" min="1" step="1" id="optStag" value="${this.evo.maxStagnant}" /></label>
            </div>
            <div class="row">
              <label>Keep best (%)<input type="number" min="0" max="90" step="5" id="optElite" value="${Math.round(this.evo.elitism * 100)}" /></label>
              <label>Mutation (%)<input type="number" min="0" max="100" step="5" id="optMut" value="${Math.round(this.evo.mutationRate * 100)}" /></label>
            </div>`
          : `<div class="row">
              <label>Designs to try<input type="number" min="5" step="5" id="optIter" value="${this.ann.iterations}" /></label>
              <label>Cooling<input type="number" min="0.5" max="0.995" step="0.01" id="optCool" value="${this.ann.cooling}" /></label>
            </div>`}
        <p class="hint">${pool} design${pool > 1 ? 's' : ''} evaluated in parallel. ${this.estimate()}</p>
      </section>
      <div class="run">
        <button class="btn primary" id="optStart"${this.running ? ' disabled' : ''}>Start optimization</button>
        <button class="btn ghost" id="optStop"${this.running ? '' : ' hidden'}>Stop</button>
      </div>`;

    const pick = el.querySelector<HTMLSelectElement>('#optGenePick')!;
    pick.onchange = () => {
      const d = defs.find((x) => x.key === pick.value);
      if (!d) return;
      const v = d.get();
      const lo = Math.min(d.min, v), hi = Math.max(d.max, v);
      this.genes.push({ key: d.key, label: `${d.owner} · ${d.label}`, unit: d.unit, min: +lo.toFixed(4), max: +hi.toFixed(4), step: d.step });
      this.renderControls();
    };
    el.querySelectorAll<HTMLButtonElement>('[data-remove-gene]').forEach((b) => (b.onclick = () => {
      this.genes.splice(+b.dataset.removeGene!, 1);
      this.renderControls();
    }));
    el.querySelectorAll<HTMLElement>('[data-gene]').forEach((row) => {
      const g = this.genes[+row.dataset.gene!];
      row.querySelectorAll<HTMLInputElement>('input[data-g]').forEach((inp) => (inp.onchange = () => {
        const v = parseFloat(inp.value);
        if (Number.isFinite(v)) g[inp.dataset.g as 'min' | 'max' | 'step'] = v;
        this.renderEstimate();
      }));
    });
    el.querySelector<HTMLButtonElement>('#optAddObj')!.onclick = () => {
      const s = this.host.readSettings();
      const st = STUDY[s.type];
      const goal: Goal = s.type === 'radiation' ? 'min' : 'max';
      this.objectives.push({ id: this.nextObjectiveId++, settings: s, metric: s.type === 'daylightFactor' || s.type === 'illuminance' ? 'above' : 'mean', threshold: st.threshold, goal, target: st.threshold, weight: 1 });
      this.renderControls();
    };
    el.querySelectorAll<HTMLButtonElement>('[data-remove-obj]').forEach((b) => (b.onclick = () => {
      this.objectives.splice(+b.dataset.removeObj!, 1);
      this.renderControls();
    }));
    el.querySelectorAll<HTMLElement>('[data-obj]').forEach((row) => {
      const o = this.objectives[+row.dataset.obj!];
      row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-o]').forEach((inp) => (inp.onchange = () => {
        const k = inp.dataset.o!;
        if (k === 'goal') o.goal = inp.value as Goal;
        else if (k === 'metric') o.metric = inp.value as Metric;
        else {
          const v = parseFloat(inp.value);
          if (Number.isFinite(v)) (o as unknown as Record<string, number>)[k] = v;
        }
        if (k === 'goal' || k === 'metric') this.renderControls();
      }));
    });
    el.querySelector<HTMLSelectElement>('#optSolver')!.onchange = (e) => {
      this.solver = (e.target as HTMLSelectElement).value as 'evolve' | 'anneal';
      this.renderControls();
    };
    el.querySelector<HTMLInputElement>('#optDraft')!.onchange = (e) => (this.draft = (e.target as HTMLInputElement).checked);
    const bindNum = (id: string, fn: (v: number) => void) => {
      const i = el.querySelector<HTMLInputElement>(id);
      if (i) i.onchange = () => {
        const v = parseFloat(i.value);
        if (Number.isFinite(v)) fn(v);
        this.renderEstimate();
      };
    };
    bindNum('#optPop', (v) => (this.evo.population = Math.max(4, Math.round(v))));
    bindNum('#optGen', (v) => (this.evo.generations = Math.max(1, Math.round(v))));
    bindNum('#optStag', (v) => (this.evo.maxStagnant = Math.max(1, Math.round(v))));
    bindNum('#optElite', (v) => (this.evo.elitism = Math.min(0.9, Math.max(0, v / 100))));
    bindNum('#optMut', (v) => (this.evo.mutationRate = Math.min(1, Math.max(0, v / 100))));
    bindNum('#optIter', (v) => (this.ann.iterations = Math.max(5, Math.round(v))));
    bindNum('#optCool', (v) => (this.ann.cooling = Math.min(0.995, Math.max(0.5, v))));
    el.querySelector<HTMLButtonElement>('#optStart')!.onclick = () => this.start();
    el.querySelector<HTMLButtonElement>('#optStop')!.onclick = () => this.stop();
  }

  private maxDesigns() {
    return this.solver === 'evolve' ? this.evo.population * (this.evo.generations + 1) : this.ann.iterations;
  }

  private estimate(): string {
    const n = this.maxDesigns();
    const runs = n * Math.max(1, this.objectives.length);
    return `Up to ${n.toLocaleString()} designs (${runs.toLocaleString()} simulations).`;
  }

  private renderEstimate() {
    const p = $('optControls').querySelector('section:nth-of-type(3) .hint:last-child');
    if (p) p.textContent = `${SimPool.defaultSize()} designs evaluated in parallel. ${this.estimate()}`;
  }

  // ------------------------------------------------------------ evaluation
  private settingsFor(o: Objective, full: boolean): StudySettings {
    const s: StudySettings = { ...o.settings, period: { ...o.settings.period } };
    if (this.overrides.tau !== undefined) s.tau = this.overrides.tau;
    if (this.draft && !full) {
      s.gridSize = Math.min(o.settings.gridKind === 'workplane' ? 1.5 : 4, s.gridSize * 2);
      s.mf = 1;
      s.bounce = 0;
    }
    return s;
  }

  private context(): StudyContext {
    const c = this.host.studyContext();
    return this.overrides.north !== undefined ? { ...c, northAngle: this.overrides.north } : c;
  }

  private prepared(o: Objective, s: StudySettings, ctx: StudyContext): Prepared {
    const key = `${o.id}|${ctx.northAngle}|${s.mf}|${s.bounce}`;
    let p = this.prepCache.get(key);
    if (!p) {
      p = prepareStudy(s, ctx);
      this.prepCache.set(key, p);
    }
    return p;
  }

  /** Apply a genome to the model (quietly) and launch its simulations. */
  private launch(defs: ParamDef[], genome: Genome, full: boolean): Promise<number[]> {
    const editor = this.host.editor;
    editor.quietly(() => defs.forEach((d, i) => d.set(genome[i])));
    const parts = editor.viewer.parts;
    const scene = sceneData(parts);
    const ctx = this.context();
    return Promise.all(
      this.objectives.map((o) => {
        const s = this.settingsFor(o, full);
        const grid = buildGrid(s, parts);
        if (!grid.areas.length) return Promise.resolve(NaN);
        const job = makeJob(grid, this.prepared(o, s, ctx), s);
        return this.pool!.run(scene, job).then((r) => metricValue(o.metric, gridStats(r.values, grid.areas, o.threshold)));
      }),
    );
  }

  private fitness(values: number[], base: number[]): number {
    let f = 0;
    this.objectives.forEach((o, i) => {
      const v = values[i];
      if (!Number.isFinite(v)) {
        f = -Infinity;
        return;
      }
      const scale = Math.abs(base[i]) > 1e-9 ? Math.abs(base[i]) : 1;
      const tScale = Math.abs(o.target) > 1e-9 ? Math.abs(o.target) : 1;
      if (o.goal === 'max') f += (o.weight * v) / scale;
      else if (o.goal === 'min') f -= (o.weight * v) / scale;
      else if (o.goal === 'atLeast') f -= (10 * o.weight * Math.max(0, o.target - v)) / tScale;
      else f -= (10 * o.weight * Math.max(0, v - o.target)) / tScale;
    });
    return f;
  }

  private async evaluateBatch(defs: ParamDef[], genomes: Genome[]): Promise<number[]> {
    const pending: Promise<number[]>[] = [];
    for (const g of genomes) pending.push(this.launch(defs, g, false));
    const results = await Promise.all(pending);
    return results.map((values, i) => {
      const fitness = this.fitness(values, this.baseline);
      this.designs.set(genomeKey(genomes[i]), { genome: genomes[i], values, fitness });
      return fitness;
    });
  }

  // ------------------------------------------------------------ run
  private async start() {
    if (this.running) return;
    if (!this.genes.length) return this.host.toast('Add at least one gene: a parameter the optimizer may change.', true);
    if (!this.objectives.length) return this.host.toast('Add at least one objective from a study setup.', true);
    if (!this.objectives.some((o) => o.goal === 'max' || o.goal === 'min')) {
      this.host.toast('Only constraints are set: the search will just look for any design that meets them.');
    }
    let defs: ParamDef[];
    try {
      this.host.studyContext();
      defs = this.defsFor(this.genes);
    } catch (e) {
      return this.host.toast((e as Error).message, true);
    }
    const genes: Gene[] = this.genes.map((g) => ({ key: g.key, min: Math.min(g.min, g.max), max: Math.max(g.min, g.max), step: Math.max(0, g.step) }));
    this.running = true;
    this.stopRequested = false;
    this.history = [];
    this.designs.clear();
    this.prepCache.clear();
    this.fullBaseline = [];
    this.overrides = {};
    this.pool ??= new SimPool();
    this.initialGenome = defs.map((d, i) => snap(d.get(), genes[i]));
    const rawInitial = defs.map((d) => d.get());
    document.body.classList.add('optimizing');
    this.renderControls();
    const t0 = performance.now();
    let result: SolverResult | null = null;
    try {
      this.status = 'Measuring the starting design…';
      this.renderResults();
      this.baseline = await this.launch(defs, this.initialGenome, false);
      if (this.baseline.some((v) => !Number.isFinite(v))) throw new Error('A study produced no sensors for the starting design — check its grid settings.');
      const hooks = {
        evaluate: (gs: Genome[]) => this.evaluateBatch(defs, gs),
        shouldStop: () => this.stopRequested,
        onProgress: (p: Progress) => {
          this.history.push({ generation: p.generation, best: p.best.fitness, mean: p.mean });
          const sec = (performance.now() - t0) / 1000;
          const per = sec / Math.max(1, p.evaluations);
          const left = Math.max(0, this.maxDesigns() - p.evaluations) * per;
          this.status = `${this.solver === 'evolve' ? `Generation ${p.generation}` : `Step ${p.generation}`} · ${p.evaluations} designs · ${fmt(sec, 0)} s elapsed${left > 1 ? ` · ≤ ${fmt(left / 60, 1)} min left` : ''}`;
          this.renderResults();
        },
      };
      result = this.solver === 'evolve'
        ? await evolve(genes, hooks, { ...this.evo, initial: this.initialGenome, seed: (Date.now() & 0xffff) + 1 })
        : await anneal(genes, hooks, { ...this.ann, batch: this.pool.size, initial: this.initialGenome, seed: (Date.now() & 0xffff) + 1 });
      if (this.draft && !this.stopRequested) {
        this.status = 'Checking the best designs at full quality…';
        this.renderResults();
        this.fullBaseline = await this.launch(defs, this.initialGenome, true);
        const top = this.ranked().slice(0, 5);
        const fulls = await Promise.all(top.map((d) => this.launch(defs, d.genome, true)));
        top.forEach((d, i) => (d.full = { values: fulls[i], fitness: this.fitness(fulls[i], this.fullBaseline) }));
      }
      const sec = (performance.now() - t0) / 1000;
      const why = result.stoppedBy === 'stagnant' ? 'no improvement for several generations' : result.stoppedBy === 'user' ? 'stopped' : 'finished';
      this.status = `Done (${why}) · ${this.designs.size} designs in ${fmt(sec, 0)} s. Apply a design below to load it into the model.`;
    } catch (e) {
      const msg = (e as Error).message;
      this.status = msg === 'cancelled' ? 'Stopped. Results so far are listed below.' : `Error: ${msg}`;
      if (msg !== 'cancelled') this.host.toast(msg, true);
    } finally {
      // put the model back the way it was
      this.host.editor.quietly(() => defs.forEach((d, i) => d.set(rawInitial[i])));
      this.overrides = {};
      this.host.editor.refresh();
      this.running = false;
      document.body.classList.remove('optimizing');
      this.renderControls();
      this.renderResults();
    }
  }

  private stop() {
    this.stopRequested = true;
    this.status = 'Stopping…';
    this.pool?.cancel();
    this.renderResults();
  }

  private ranked(): Design[] {
    const score = (d: Design) => (d.full ? d.full.fitness : d.fitness);
    return [...this.designs.values()].filter((d) => Number.isFinite(d.fitness)).sort((a, b) => {
      // verified designs first, then by fitness
      if (!!a.full !== !!b.full) return a.full ? -1 : 1;
      return score(b) - score(a);
    });
  }

  private apply(d: Design) {
    let defs: ParamDef[];
    try {
      defs = this.defsFor(this.genes);
    } catch (e) {
      return this.host.toast((e as Error).message, true);
    }
    const editor = this.host.editor;
    editor.record();
    editor.quietly(() => defs.forEach((def, i) => {
      if (def.key === 'site.north') this.host.setNorth(d.genome[i]);
      else if (def.key === 'site.tau') this.host.setTau(d.genome[i]);
      else def.set(d.genome[i]);
    }));
    editor.refresh();
    this.host.toast('Design applied to the model. Undo (Ctrl+Z) restores the previous one.');
    this.host.onApplied();
  }

  // ------------------------------------------------------------ results view
  private renderResults() {
    const el = $('optContent');
    if (!this.history.length && !this.running && !this.designs.size) {
      el.innerHTML = `<div class="opt-empty">
        <p><b>How it works.</b> Like Galapagos in Grasshopper: the solver changes the <b>genes</b> (model and site parameters), runs your <b>objective</b> studies for every design, and breeds better designs from the best ones.</p>
        <p>Typical setups: maximize daylight factor area ≥ 2 % while keeping summer radiation on glazing at most a target · minimize winter shadow on a plaza by moving a block · find the overhang depth and window ratio that balance daylight and sun.</p>
        <p class="hint">The fitness is a weighted sum relative to the starting design (1.0 = as good as now for a single maximize goal); constraint violations subtract a penalty. Results are approximations for comparing options; check the chosen design with a full simulation.</p>
      </div>`;
      return;
    }
    const designs = this.ranked();
    const top = designs.slice(0, 10);
    const objHead = this.objectives.map((o) => `<th>${escapeHtml(STUDY[o.settings.type].title)}<br><small>${escapeHtml(METRICS.find((m) => m.key === o.metric)!.label)}${o.metric === 'above' ? ` ${o.threshold}` : ''} · ${metricUnit(o)}</small></th>`).join('');
    const geneHead = this.genes.map((g) => `<th>${escapeHtml(g.label)}${g.unit ? ` <small>${g.unit}</small>` : ''}</th>`).join('');
    const vals = (d: Design) => (d.full ? d.full.values : d.values);
    const base = this.baseline;
    const startKey = genomeKey(this.initialGenome);
    const rows = top
      .map((d, i) => `<tr${genomeKey(d.genome) === startKey ? ' class="start"' : ''}>
        <td>${i + 1}${genomeKey(d.genome) === startKey ? ' <small>start</small>' : ''}</td>
        <td class="v"><b>${fmt(d.full ? d.full.fitness : d.fitness, 3)}</b>${d.full ? '<br><small>full quality</small>' : this.draft ? '<br><small>draft</small>' : ''}</td>
        ${vals(d).map((v) => `<td class="v">${fmt(v)}</td>`).join('')}
        ${d.genome.map((v) => `<td class="v">${fmt(v, 3)}</td>`).join('')}
        <td>${this.running ? '' : `<button class="btn ghost small" data-apply="${i}">Apply</button>`}</td>
      </tr>`)
      .join('');
    const baseLine = (label: string, values: number[]) =>
      `<tr class="baseline"><td colspan="2">${label}</td>${values.map((v) => `<td class="v">${fmt(v)}</td>`).join('')}${this.initialGenome.map((v) => `<td class="v">${fmt(v, 3)}</td>`).join('')}<td></td></tr>`;
    const baseRow = (base.length ? baseLine(`Starting design${this.draft ? ' (draft)' : ''}`, base) : '')
      + (this.draft && this.fullBaseline.length ? baseLine('Starting design (full quality)', this.fullBaseline) : '');
    el.innerHTML = `
      <p class="summary-line" role="status">${escapeHtml(this.status)}</p>
      <div class="opt-legend" aria-hidden="true"><span><i class="ln best"></i>Best so far</span><span><i class="ln mean"></i>Population mean</span></div>
      <div class="opt-chart" id="optChart"></div>
      <div class="table-wrap">
        <table class="opt-table">
          <thead><tr><th>#</th><th>Fitness</th>${objHead}${geneHead}<th></th></tr></thead>
          <tbody>${baseRow}${rows}</tbody>
        </table>
      </div>`;
    el.querySelectorAll<HTMLButtonElement>('[data-apply]').forEach((b) => (b.onclick = () => this.apply(top[+b.dataset.apply!])));
    this.renderChart($('optChart'));
  }

  private renderChart(el: HTMLElement) {
    const h = this.history;
    if (h.length < 1) return;
    const W = 640, H = 170, pl = 46, pr = 12, pt = 10, pb = 26;
    const vals = h.flatMap((p) => [p.best, p.mean]).filter(Number.isFinite);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const n = Math.max(1, h.length - 1);
    const X = (i: number) => pl + ((W - pl - pr) * i) / n;
    const Y = (v: number) => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
    const ticks = niceTicks(lo, hi, 4);
    const path = (k: 'best' | 'mean') => h.map((p, i) => (Number.isFinite(p[k]) ? `${i && Number.isFinite(h[i - 1][k]) ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p[k]).toFixed(1)}` : '')).join('');
    const label = this.solver === 'evolve' ? 'Generation' : 'Step';
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Fitness by ${label.toLowerCase()}: best and population mean">
      ${ticks.map((t) => `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(t)}" y2="${Y(t)}"/><text class="tick" x="${pl - 6}" y="${Y(t) + 3}" text-anchor="end">${fmt(t, 2)}</text>`).join('')}
      <line class="axis" x1="${pl}" x2="${W - pr}" y1="${H - pb}" y2="${H - pb}"/>
      <text class="tick" x="${pl}" y="${H - 8}">${label} 0</text>
      <text class="tick" x="${W - pr}" y="${H - 8}" text-anchor="end">${h[h.length - 1].generation}</text>
      <path d="${path('mean')}" fill="none" stroke="var(--ink-3)" stroke-width="1.5" stroke-dasharray="4 3"/>
      <path d="${path('best')}" fill="none" stroke="var(--series-1)" stroke-width="2"/>
      <circle cx="${X(h.length - 1)}" cy="${Y(h[h.length - 1].best)}" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>
      <rect id="optHit" x="${pl}" y="${pt}" width="${W - pl - pr}" height="${H - pt - pb}" fill="transparent"/>
    </svg>`;
    const hit = el.querySelector('#optHit')!;
    const svg = el.querySelector('svg')!;
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const x = ((e as PointerEvent).clientX - r.left) / r.width * W;
      const i = Math.min(h.length - 1, Math.max(0, Math.round(((x - pl) / (W - pl - pr)) * n)));
      showTip(`<b>${label} ${h[i].generation}</b><br>Best ${fmt(h[i].best, 3)}<br>Mean ${fmt(h[i].mean, 3)}`, (e as PointerEvent).clientX, (e as PointerEvent).clientY);
    });
    hit.addEventListener('pointerleave', hideTip);
  }
}
