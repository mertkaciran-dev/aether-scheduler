import { UnrecoverableError, type Job } from 'bullmq';
import { TimeoutError } from '../errors';
import type { JobEnvelope } from '../types';
import { config } from '../config';
import { getHandler } from './handlers';
import type { HandlerContext } from './handlers/types';

/** Metadata attached to errors thrown from the processor so the 'failed' listener can tell retry from dead. */
export interface FailureTag {
  attempt: number;
  maxAttempts: number;
  final: boolean;
}

const MAX_RESULT_BYTES = 16 * 1024;

function boundResult(result: unknown): unknown {
  if (result === undefined) return null;
  try {
    const json = JSON.stringify(result);
    if (json.length <= MAX_RESULT_BYTES) return result;
    return { truncated: true, bytes: json.length, preview: json.slice(0, 1024) };
  } catch {
    return { unserializable: true };
  }
}

/**
 * The queue processor. Resolves the handler, enforces the per-job timeout, and tags any
 * failure with whether this attempt was the last one.
 */
export async function processJob(job: Job<JobEnvelope>): Promise<unknown> {
  const maxAttempts = job.opts.attempts ?? 1;
  const attempt = job.attemptsMade + 1;
  const handler = getHandler(job.data.type);

  const tag = (err: unknown, unrecoverable = false): Error => {
    const e = err instanceof Error ? err : new Error(String(err));
    const final = unrecoverable || e instanceof UnrecoverableError || attempt >= maxAttempts;
    (e as Error & { aether?: FailureTag }).aether = { attempt, maxAttempts, final };
    return e;
  };

  if (!handler) {
    throw tag(new UnrecoverableError(`No handler registered for job type "${job.data.type}"`), true);
  }

  const timeoutMs = job.data.meta.timeoutMs ?? config.defaultTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs);

  const ctx: HandlerContext = {
    jobId: String(job.id),
    attempt,
    maxAttempts,
    signal: controller.signal,
    progress: async (percent) => {
      await job.updateProgress(Math.max(0, Math.min(100, percent)));
    },
    log: async (line) => {
      await job.log(line);
    },
  };

  try {
    const run = handler.run(job.data.payload, ctx);
    // Race the handler against the abort signal so even handlers that ignore `signal` are cut off.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    run.catch(() => undefined); // avoid unhandled rejection if the race is lost
    return boundResult(await Promise.race([run, aborted]));
  } catch (err) {
    throw tag(err);
  } finally {
    clearTimeout(timer);
  }
}
