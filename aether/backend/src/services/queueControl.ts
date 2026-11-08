import { publishEvent } from '../events/bus';
import { getJobsQueue } from '../queue/queues';
import { getRedis, K } from '../redis';

export async function pauseQueue(): Promise<void> {
  await getJobsQueue().pause();
  publishEvent({ kind: 'queue.paused', level: 'warn', message: 'queue paused — workers will finish in-flight jobs and stop taking new ones' });
}

export async function resumeQueue(): Promise<void> {
  await getJobsQueue().resume();
  publishEvent({ kind: 'queue.resumed', level: 'success', message: 'queue resumed' });
}

export async function cleanQueue(state: 'completed' | 'delayed' | 'waiting', graceMs: number): Promise<number> {
  const bullState = state === 'waiting' ? 'wait' : state;
  const removed = await getJobsQueue().clean(graceMs, 10_000, bullState);
  if (state === 'delayed') await reconcileRetrying();
  publishEvent({ kind: 'queue.cleaned', level: 'warn', message: `cleaned ${removed.length} ${state} job${removed.length === 1 ? '' : 's'}` });
  return removed.length;
}

/** Remove everything that is waiting or delayed (active jobs are left alone). */
export async function drainQueue(): Promise<void> {
  await getJobsQueue().drain(true);
  await getRedis().del(K.retrying);
  publishEvent({ kind: 'queue.cleaned', level: 'warn', message: 'queue drained — waiting and delayed jobs removed' });
}

/** Drop ids from the "retrying" set whose job no longer sits in the delayed state. */
export async function reconcileRetrying(): Promise<void> {
  const redis = getRedis();
  const queue = getJobsQueue();
  const ids = await redis.smembers(K.retrying);
  if (ids.length === 0) return;
  const states = await Promise.all(ids.map(async (id) => ((await queue.getJob(id))?.getState() ?? 'missing')));
  const stale = ids.filter((_, i) => states[i] !== 'delayed');
  if (stale.length > 0) await redis.srem(K.retrying, ...stale);
}
