/// <reference lib="webworker" />
import { buildContext, runJob, JobData, SceneData, EngineContext } from './engine';

let ctx: EngineContext | null = null;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: 'scene'; scene: SceneData } | { type: 'job'; id: number; job: JobData };
  try {
    if (msg.type === 'scene') {
      ctx = buildContext(msg.scene);
      (self as unknown as Worker).postMessage({ type: 'sceneReady' });
    } else if (msg.type === 'job') {
      if (!ctx) throw new Error('Scene not loaded in worker');
      const t0 = performance.now();
      let lastPost = 0;
      const values = runJob(ctx, msg.job, (f) => {
        const now = performance.now();
        if (now - lastPost > 100 || f >= 1) {
          lastPost = now;
          (self as unknown as Worker).postMessage({ type: 'progress', id: msg.id, fraction: f });
        }
      });
      (self as unknown as Worker).postMessage(
        { type: 'result', id: msg.id, values, ms: performance.now() - t0 },
        [values.buffer],
      );
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', id: (msg as { id?: number }).id, message: String((err as Error)?.message ?? err) });
  }
};
