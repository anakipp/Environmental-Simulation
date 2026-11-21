/**
 * Single-objective optimizers in the spirit of Grasshopper's Galapagos:
 * an evolutionary solver (genetic algorithm with elitism, tournament selection,
 * blend crossover and Gaussian mutation) and simulated annealing.
 *
 * Fitness is always MAXIMIZED here; callers negate for minimization.
 * Genes are numeric sliders with min / max / step; every genome is snapped to
 * the step grid, and a genome is never evaluated twice (results are cached).
 */

export interface Gene {
  key: string;
  min: number;
  max: number;
  step: number;
}

export type Genome = number[];

export interface Evaluation {
  genome: Genome;
  fitness: number;
}

export interface Progress {
  /** generation (GA) or batch (SA) number, starting at 0 for the initial population */
  generation: number;
  best: Evaluation;
  mean: number;
  /** evaluations so far (unique genomes) */
  evaluations: number;
  population: Evaluation[];
}

export interface SolverHooks {
  /** Evaluate genomes (any order, may run in parallel). Return fitness per genome, higher is better. */
  evaluate(genomes: Genome[]): Promise<number[]>;
  onProgress?(p: Progress): void;
  shouldStop?(): boolean;
}

export interface SolverResult {
  best: Evaluation;
  /** every unique genome evaluated, best first */
  all: Evaluation[];
  history: { generation: number; best: number; mean: number; evaluations: number }[];
  stoppedBy: 'complete' | 'stagnant' | 'user';
}

/** Small, fast, seedable PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export function snap(v: number, g: Gene): number {
  const lo = Math.min(g.min, g.max), hi = Math.max(g.min, g.max);
  const c = Math.min(hi, Math.max(lo, v));
  if (!(g.step > 0)) return c;
  const n = Math.round((c - lo) / g.step);
  return Math.min(hi, +(lo + n * g.step).toFixed(10));
}

export const genomeKey = (g: Genome) => g.map((v) => +v.toFixed(8)).join('|');

/** Number of distinct values a gene can take (Infinity when continuous). */
function cardinality(g: Gene): number {
  return g.step > 0 ? Math.floor(Math.abs(g.max - g.min) / g.step + 1e-9) + 1 : Infinity;
}

class Archive {
  readonly cache = new Map<string, number>();
  constructor(private hooks: SolverHooks) {}

  /** Evaluate genomes, reusing cached fitness; returns evaluations in input order. */
  async run(genomes: Genome[]): Promise<Evaluation[]> {
    const todo: Genome[] = [];
    const seen = new Set<string>();
    for (const g of genomes) {
      const k = genomeKey(g);
      if (!this.cache.has(k) && !seen.has(k)) {
        seen.add(k);
        todo.push(g);
      }
    }
    if (todo.length) {
      const f = await this.hooks.evaluate(todo);
      todo.forEach((g, i) => this.cache.set(genomeKey(g), Number.isFinite(f[i]) ? f[i] : -Infinity));
    }
    return genomes.map((g) => ({ genome: g, fitness: this.cache.get(genomeKey(g))! }));
  }

  all(): Evaluation[] {
    return [...this.cache.entries()]
      .map(([k, fitness]) => ({ genome: k.split('|').map(Number), fitness }))
      .sort((a, b) => b.fitness - a.fitness);
  }
}

export interface EvolveOptions {
  population: number;
  generations: number;
  /** fraction of the population carried over unchanged (Galapagos "Maintain") */
  elitism: number;
  /** per-gene mutation probability */
  mutationRate: number;
  /** probability that a child is made by crossover rather than copying one parent */
  crossoverRate: number;
  /** stop after this many generations without improvement */
  maxStagnant: number;
  seed?: number;
  /** genome of the current design, included in the first population */
  initial?: Genome;
}

export const DEFAULT_EVOLVE: EvolveOptions = {
  population: 16, generations: 12, elitism: 0.15, mutationRate: 0.25, crossoverRate: 0.8, maxStagnant: 5,
};

export async function evolve(genes: Gene[], hooks: SolverHooks, opt: EvolveOptions): Promise<SolverResult> {
  if (!genes.length) throw new Error('Add at least one gene.');
  const rand = mulberry32(opt.seed ?? 12345);
  const archive = new Archive(hooks);
  const P = Math.max(2, Math.round(opt.population));
  const space = genes.reduce((s, g) => s * cardinality(g), 1);
  const randomGenome = () => genes.map((g) => snap(g.min + rand() * (g.max - g.min), g));
  const history: SolverResult['history'] = [];

  // initial population: current design + random designs (distinct where the space allows)
  const pop0: Genome[] = [];
  const keys = new Set<string>();
  const pushUnique = (g: Genome) => {
    const k = genomeKey(g);
    if (keys.has(k)) return false;
    keys.add(k);
    pop0.push(g);
    return true;
  };
  if (opt.initial) pushUnique(opt.initial.map((v, i) => snap(v, genes[i])));
  for (let tries = 0; pop0.length < Math.min(P, space) && tries < P * 50; tries++) pushUnique(randomGenome());
  let population = await archive.run(pop0);

  const report = (generation: number) => {
    const sorted = [...population].sort((a, b) => b.fitness - a.fitness);
    const finite = population.filter((e) => Number.isFinite(e.fitness));
    const mean = finite.reduce((s, e) => s + e.fitness, 0) / (finite.length || 1);
    const best = archive.all()[0];
    history.push({ generation, best: best.fitness, mean, evaluations: archive.cache.size });
    hooks.onProgress?.({ generation, best, mean, evaluations: archive.cache.size, population: sorted });
    return best.fitness;
  };

  let bestSoFar = report(0);
  let stagnant = 0;
  let stoppedBy: SolverResult['stoppedBy'] = 'complete';

  const tournament = (pool: Evaluation[]) => {
    let w = pool[Math.floor(rand() * pool.length)];
    for (let i = 0; i < 2; i++) {
      const c = pool[Math.floor(rand() * pool.length)];
      if (c.fitness > w.fitness) w = c;
    }
    return w.genome;
  };

  for (let gen = 1; gen <= opt.generations; gen++) {
    if (hooks.shouldStop?.()) {
      stoppedBy = 'user';
      break;
    }
    if (archive.cache.size >= space) break; // every design has been tried
    const sorted = [...population].sort((a, b) => b.fitness - a.fitness);
    const eliteN = Math.max(1, Math.min(P - 1, Math.round(opt.elitism * P)));
    const next: Genome[] = sorted.slice(0, eliteN).map((e) => e.genome);
    const nextKeys = new Set(next.map(genomeKey));
    const progress = gen / Math.max(1, opt.generations);
    let guard = 0;
    while (next.length < P && guard++ < P * 40) {
      const a = tournament(sorted);
      const b = tournament(sorted);
      let child: Genome;
      if (rand() < opt.crossoverRate) {
        child = genes.map((g, i) => {
          const t = rand() * 1.5 - 0.25; // BLX-0.25 blend
          return snap(a[i] + t * (b[i] - a[i]), g);
        });
      } else child = [...a];
      const sigmaScale = 0.2 * (1 - 0.6 * progress);
      genes.forEach((g, i) => {
        if (rand() < opt.mutationRate) child[i] = snap(child[i] + gaussian(rand) * sigmaScale * (g.max - g.min), g);
      });
      // Galapagos-style: never re-evaluate a known genome, mutate it instead
      for (let k = 0; k < 6 && (archive.cache.has(genomeKey(child)) || nextKeys.has(genomeKey(child))); k++) {
        const i = Math.floor(rand() * genes.length);
        const g = genes[i];
        child[i] = snap(child[i] + (rand() < 0.5 ? -1 : 1) * Math.max(g.step || 0, rand() * 0.3 * (g.max - g.min)), g);
      }
      const key = genomeKey(child);
      if (nextKeys.has(key)) continue;
      nextKeys.add(key);
      next.push(child);
    }
    population = await archive.run(next);
    const best = report(gen);
    if (best > bestSoFar + 1e-9 * Math.max(1, Math.abs(bestSoFar))) {
      bestSoFar = best;
      stagnant = 0;
    } else if (++stagnant >= opt.maxStagnant) {
      stoppedBy = 'stagnant';
      break;
    }
  }
  const all = archive.all();
  return { best: all[0], all, history, stoppedBy };
}

export interface AnnealOptions {
  /** total number of designs to evaluate */
  iterations: number;
  /** neighbours evaluated together per step (lets workers run in parallel) */
  batch: number;
  /** temperature multiplier per step (0.8–0.98) */
  cooling: number;
  seed?: number;
  initial?: Genome;
}

export const DEFAULT_ANNEAL: AnnealOptions = { iterations: 120, batch: 4, cooling: 0.9 };

export async function anneal(genes: Gene[], hooks: SolverHooks, opt: AnnealOptions): Promise<SolverResult> {
  if (!genes.length) throw new Error('Add at least one gene.');
  const rand = mulberry32(opt.seed ?? 54321);
  const archive = new Archive(hooks);
  const history: SolverResult['history'] = [];
  const start = opt.initial ? opt.initial.map((v, i) => snap(v, genes[i])) : genes.map((g) => snap(g.min + rand() * (g.max - g.min), g));
  let [current] = await archive.run([start]);
  let T = 1;
  let scale = 0; // running mean |Δfitness|, sets the acceptance scale
  let deltas = 0;
  let step = 0;
  let stoppedBy: SolverResult['stoppedBy'] = 'complete';
  const report = (pop: Evaluation[]) => {
    const best = archive.all()[0];
    const finite = pop.filter((e) => Number.isFinite(e.fitness));
    const mean = finite.reduce((s, e) => s + e.fitness, 0) / (finite.length || 1);
    history.push({ generation: step, best: best.fitness, mean, evaluations: archive.cache.size });
    hooks.onProgress?.({ generation: step, best, mean, evaluations: archive.cache.size, population: [...pop].sort((a, b) => b.fitness - a.fitness) });
  };
  report([current]);
  const batch = Math.max(1, Math.round(opt.batch));
  while (archive.cache.size < opt.iterations) {
    if (hooks.shouldStop?.()) {
      stoppedBy = 'user';
      break;
    }
    step++;
    const neighbours: Genome[] = [];
    for (let b = 0; b < batch; b++) {
      const n = [...current.genome];
      const k = 1 + Math.floor(rand() * Math.min(3, genes.length));
      for (let j = 0; j < k; j++) {
        const i = Math.floor(rand() * genes.length);
        const g = genes[i];
        const sigma = Math.max(g.step || 0, (g.max - g.min) * 0.35 * Math.max(0.05, T));
        n[i] = snap(n[i] + gaussian(rand) * sigma, g);
      }
      neighbours.push(n);
    }
    const before = archive.cache.size;
    const evals = await archive.run(neighbours);
    if (archive.cache.size === before && step > 4 * opt.iterations) break; // space exhausted
    const cand = evals.reduce((a, b) => (b.fitness > a.fitness ? b : a));
    const d = cand.fitness - current.fitness;
    if (Number.isFinite(d)) {
      scale = (scale * deltas + Math.abs(d)) / ++deltas;
    }
    if (d >= 0 || (Number.isFinite(d) && rand() < Math.exp(d / Math.max(1e-12, scale * T)))) current = cand;
    T *= opt.cooling;
    report(evals);
  }
  const all = archive.all();
  return { best: all[0], all, history, stoppedBy };
}
