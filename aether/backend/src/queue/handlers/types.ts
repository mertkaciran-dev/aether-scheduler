import type { ZodType } from 'zod';

export interface HandlerContext {
  jobId: string;
  /** 1-based attempt number for this run. */
  attempt: number;
  maxAttempts: number;
  /** Aborted when the job exceeds its timeout or the worker is shutting down hard. */
  signal: AbortSignal;
  progress(percent: number): Promise<void>;
  log(line: string): Promise<void>;
}

export interface JobHandler<T = any> {
  type: string;
  description: string;
  /** Validates + normalises the payload at enqueue time (so bad jobs are rejected with a 400, not retried). */
  schema: ZodType<T, any, any>;
  /** Example payload surfaced in the dashboard's job composer. */
  example: Record<string, unknown>;
  run(payload: T, ctx: HandlerContext): Promise<unknown>;
}

/** Abortable sleep. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
