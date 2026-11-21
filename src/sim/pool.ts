/** A small pool of simulation workers so several designs are traced in parallel. */
import { SimClient, RunResult } from './client';
import type { JobData, SceneData } from './engine';

export class SimPool {
  private clients: SimClient[];
  private idle: SimClient[];
  private queue: { scene: SceneData; job: JobData; resolve: (r: RunResult) => void; reject: (e: Error) => void }[] = [];
  private stopped = false;

  constructor(size = SimPool.defaultSize()) {
    this.clients = Array.from({ length: size }, () => new SimClient());
    this.idle = [...this.clients];
  }

  static defaultSize(): number {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    return Math.max(1, Math.min(6, cores - 1));
  }

  get size() {
    return this.clients.length;
  }

  run(scene: SceneData, job: JobData): Promise<RunResult> {
    if (this.stopped) return Promise.reject(new Error('cancelled'));
    return new Promise((resolve, reject) => {
      this.queue.push({ scene, job, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const c = this.idle.pop()!;
      const t = this.queue.shift()!;
      c.run(t.scene, t.job, () => {})
        .then(t.resolve, t.reject)
        .finally(() => {
          this.idle.push(c);
          this.pump();
        });
    }
  }

  /** Abort queued and running jobs; the pool can be reused afterwards. */
  cancel() {
    this.stopped = true;
    for (const t of this.queue.splice(0)) t.reject(new Error('cancelled'));
    for (const c of this.clients) c.cancel();
    this.stopped = false;
  }
}
