/**
 * Runs simulation jobs in a Web Worker, falling back to chunked main-thread
 * execution where workers are unavailable (e.g. restrictive sandboxes).
 */
import { buildContext, computeRange, makeSamples, JobData, SceneData } from './engine';
import SimWorker from './worker?worker&inline';

export interface RunResult {
  values: Float32Array;
  ms: number;
}

export class SimClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private cancelled = false;
  private rejectCurrent: ((e: Error) => void) | null = null;

  private makeWorker(): Worker | null {
    try {
      return new SimWorker();
    } catch {
      return null;
    }
  }

  async run(scene: SceneData, job: JobData, onProgress: (f: number) => void): Promise<RunResult> {
    this.cancelled = false;
    if (!this.worker) this.worker = this.makeWorker();
    if (this.worker) {
      try {
        return await this.runInWorker(this.worker, scene, job, onProgress);
      } catch (e) {
        if ((e as Error).message === 'cancelled') throw e;
        if ((e as Error).message !== 'worker-failed') throw e;
        this.worker?.terminate();
        this.worker = null;
      }
    }
    return this.runOnMainThread(scene, job, onProgress);
  }

  cancel() {
    this.cancelled = true;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.rejectCurrent?.(new Error('cancelled'));
  }

  private runInWorker(w: Worker, scene: SceneData, job: JobData, onProgress: (f: number) => void): Promise<RunResult> {
    const id = this.nextId++;
    return new Promise<RunResult>((resolve, reject) => {
      this.rejectCurrent = reject;
      let ready = false;
      const timer = setTimeout(() => {
        if (!ready) {
          cleanup();
          reject(new Error('worker-failed'));
        }
      }, 15000);
      const cleanup = () => {
        clearTimeout(timer);
        w.removeEventListener('message', onMsg);
        w.removeEventListener('error', onErr);
        this.rejectCurrent = null;
      };
      const onErr = () => {
        cleanup();
        reject(new Error('worker-failed'));
      };
      const onMsg = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === 'sceneReady') {
          ready = true;
          clearTimeout(timer);
          w.postMessage({ type: 'job', id, job });
        } else if (m.type === 'progress' && m.id === id) onProgress(m.fraction);
        else if (m.type === 'result' && m.id === id) {
          cleanup();
          resolve({ values: m.values, ms: m.ms });
        } else if (m.type === 'error') {
          cleanup();
          reject(new Error(m.message));
        }
      };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      w.postMessage({ type: 'scene', scene });
    });
  }

  private async runOnMainThread(scene: SceneData, job: JobData, onProgress: (f: number) => void): Promise<RunResult> {
    const t0 = performance.now();
    const ctx = buildContext(scene);
    const n = job.sensors.length / 3;
    const out = new Float32Array(n);
    const samples = makeSamples(job);
    let s = 0;
    while (s < n) {
      if (this.cancelled) throw new Error('cancelled');
      const sliceStart = performance.now();
      while (s < n && performance.now() - sliceStart < 30) {
        const e = Math.min(n, s + 4);
        computeRange(ctx, job, s, e, out, samples);
        s = e;
      }
      onProgress(s / n);
      await new Promise((r) => setTimeout(r, 0));
    }
    return { values: out, ms: performance.now() - t0 };
  }
}
