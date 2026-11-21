import { describe, expect, it } from 'vitest';
import { evolve, anneal, snap, genomeKey, Gene, Genome, DEFAULT_EVOLVE, DEFAULT_ANNEAL } from '../src/core/optimize';

const genes: Gene[] = [
  { key: 'x', min: -10, max: 10, step: 0.1 },
  { key: 'y', min: -10, max: 10, step: 0.1 },
];
// peak at (3, -1)
const f = (g: Genome) => -((g[0] - 3) ** 2) - (g[1] + 1) ** 2;

function hooksFor(fn: (g: Genome) => number) {
  const seen = new Set<string>();
  let calls = 0;
  let duplicates = 0;
  return {
    stats: () => ({ calls, duplicates }),
    hooks: {
      evaluate: async (gs: Genome[]) => {
        return gs.map((g) => {
          calls++;
          const k = genomeKey(g);
          if (seen.has(k)) duplicates++;
          seen.add(k);
          for (let i = 0; i < g.length; i++) {
            const q = snap(g[i], genes[i]);
            if (Math.abs(q - g[i]) > 1e-9) throw new Error('genome not snapped to step');
          }
          return fn(g);
        });
      },
    },
  };
}

describe('snap', () => {
  it('clamps and quantizes', () => {
    expect(snap(3.14159, { key: 'a', min: 0, max: 10, step: 0.5 })).toBe(3);
    expect(snap(12, { key: 'a', min: 0, max: 10, step: 0.5 })).toBe(10);
    expect(snap(0.26, { key: 'a', min: 0.1, max: 0.9, step: 0.05 })).toBeCloseTo(0.25, 10);
  });
});

describe('evolutionary solver', () => {
  it('finds the optimum of a smooth function and never re-evaluates a genome', async () => {
    const h = hooksFor(f);
    const r = await evolve(genes, h.hooks, { ...DEFAULT_EVOLVE, population: 30, generations: 40, maxStagnant: 15, seed: 7, initial: [-8, 8] });
    expect(r.best.genome[0]).toBeCloseTo(3, 0);
    expect(r.best.genome[1]).toBeCloseTo(-1, 0);
    expect(r.best.fitness).toBeGreaterThan(-0.5);
    expect(h.stats().duplicates).toBe(0);
    expect(r.history.length).toBeGreaterThan(2);
    // best-so-far never decreases
    for (let i = 1; i < r.history.length; i++) expect(r.history[i].best).toBeGreaterThanOrEqual(r.history[i - 1].best);
  });

  it('includes the initial design and stops when asked', async () => {
    const h = hooksFor(f);
    let n = 0;
    const r = await evolve(genes, { ...h.hooks, shouldStop: () => ++n > 2 }, { ...DEFAULT_EVOLVE, initial: [1, 1], seed: 3 });
    expect(r.stoppedBy).toBe('user');
    expect(r.all.some((e) => e.genome[0] === 1 && e.genome[1] === 1)).toBe(true);
  });

  it('handles a tiny discrete space without looping forever', async () => {
    const small: Gene[] = [{ key: 'n', min: 1, max: 3, step: 1 }];
    const r = await evolve(small, { evaluate: async (gs) => gs.map((g) => g[0]) }, { ...DEFAULT_EVOLVE, population: 10, generations: 20 });
    expect(r.best.genome[0]).toBe(3);
    expect(r.all.length).toBe(3);
  });
});

describe('simulated annealing', () => {
  it('improves on the starting design', async () => {
    const h = hooksFor(f);
    const r = await anneal(genes, h.hooks, { ...DEFAULT_ANNEAL, iterations: 300, batch: 4, cooling: 0.95, seed: 11, initial: [-8, 8] });
    expect(r.best.fitness).toBeGreaterThan(f([-8, 8]) + 100);
    expect(r.best.fitness).toBeGreaterThan(-2);
    expect(h.stats().duplicates).toBe(0);
  });
});
