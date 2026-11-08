import type { Job } from 'bullmq';
import { config } from '../config';
import { HttpError, notFound } from '../errors';
import { publishEvent } from '../events/bus';
import { defaultJobOptions, getJobsQueue } from '../queue/queues';
import { getRedis, incrStat, K } from '../redis';
import type { DlqEntry, JobEnvelope } from '../types';

/**
 * Dead-letter queue. When a job exhausts its retries, a full snapshot (payload, options, error,
 * stack traces) is written here and the job is removed from BullMQ's failed set. From the
 * DLQ it can be inspected, replayed as a brand-new job with a fresh retry budget, or discarded.
 */

const truncate = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n) + '…' : s);

export async function addToDlq(job: Job<JobEnvelope>, err: Error, attemptsMade: number): Promise<void> {
  const id = String(job.id);
  const entry: DlqEntry = {
    id,
    type: job.data.type,
    payload: job.data.payload,
    webhook: job.data.webhook,
    meta: job.data.meta,
    opts: { attempts: job.opts.attempts ?? 1, priority: job.opts.priority, backoff: job.opts.backoff },
    error: { name: err.name, message: truncate(err.message, 2000) ?? '', stack: truncate(err.stack, 4000) },
    attemptsMade,
    failedAt: Date.now(),
    queuedAt: job.timestamp,
    stacktrace: (job.stacktrace ?? []).slice(-10).map((s) => truncate(s, 2000) ?? ''),
  };

  const redis = getRedis();
  await redis
    .multi()
    .set(K.dlqEntry(id), JSON.stringify(entry))
    .zadd(K.dlqIndex, entry.failedAt, id)
    .hincrby(K.stats, 'dead', 1)
    .exec();

  // Bound memory: evict the oldest entries beyond DLQ_MAX_SIZE.
  const size = await redis.zcard(K.dlqIndex);
  if (size > config.dlqMaxSize) {
    const old = await redis.zrange(K.dlqIndex, 0, size - config.dlqMaxSize - 1);
    if (old.length > 0) await redis.multi().zrem(K.dlqIndex, ...old).unlink(...old.map(K.dlqEntry)).exec();
  }
}

export async function getDlqEntry(id: string): Promise<DlqEntry | null> {
  const raw = await getRedis().get(K.dlqEntry(id));
  return raw ? (JSON.parse(raw) as DlqEntry) : null;
}

export async function dlqSize(): Promise<number> {
  return getRedis().zcard(K.dlqIndex);
}

export interface DlqListOptions {
  offset: number;
  limit: number;
  type?: string;
  q?: string;
}

export async function listDlq(opts: DlqListOptions): Promise<{ items: DlqEntry[]; total: number }> {
  const redis = getRedis();
  const filtered = !!(opts.type || opts.q);

  // Without filters we can page straight off the sorted set; with filters we scan a bounded window.
  const ids = filtered
    ? await redis.zrevrange(K.dlqIndex, 0, 4999)
    : await redis.zrevrange(K.dlqIndex, opts.offset, opts.offset + opts.limit - 1);
  if (ids.length === 0) return { items: [], total: 0 };

  const raws = await redis.mget(ids.map(K.dlqEntry));
  let items = raws.flatMap((r) => (r ? [JSON.parse(r) as DlqEntry] : []));

  if (!filtered) return { items, total: await redis.zcard(K.dlqIndex) };

  const q = opts.q?.toLowerCase();
  items = items.filter(
    (e) =>
      (!opts.type || e.type === opts.type) &&
      (!q || e.error.message.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)),
  );
  return { items: items.slice(opts.offset, opts.offset + opts.limit), total: items.length };
}

/** Re-enqueue a dead job as a new job with a fresh retry budget, then drop it from the DLQ. */
export async function replayDlq(id: string): Promise<string> {
  const entry = await getDlqEntry(id);
  if (!entry) throw notFound('DLQ entry', id);

  const envelope: JobEnvelope = {
    type: entry.type,
    payload: entry.payload,
    webhook: entry.webhook,
    meta: {
      ...entry.meta,
      source: 'dlq-replay',
      createdAt: Date.now(),
      replayedFrom: entry.id,
      replayCount: (entry.meta.replayCount ?? 0) + 1,
    },
  };

  const job = await getJobsQueue().add(entry.type, envelope, {
    ...defaultJobOptions,
    attempts: entry.opts.attempts,
    backoff: entry.opts.backoff as never,
    priority: entry.opts.priority,
  });

  // Add first, delete second: a crash in between yields a duplicate, never a lost job.
  await getRedis().multi().zrem(K.dlqIndex, id).unlink(K.dlqEntry(id)).exec();
  void incrStat('enqueued');
  publishEvent({
    kind: 'job.replayed',
    level: 'info',
    jobId: String(job.id),
    jobType: entry.type,
    message: `replayed from DLQ (was ${entry.id}) as #${job.id}`,
    data: { replayedFrom: entry.id },
  });
  return String(job.id);
}

export async function replayAllDlq(limit = 1000): Promise<{ replayed: number; failed: number }> {
  const ids = await getRedis().zrange(K.dlqIndex, 0, limit - 1);
  let replayed = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    const results = await Promise.allSettled(batch.map((id) => replayDlq(id)));
    for (const r of results) r.status === 'fulfilled' ? replayed++ : failed++;
  }
  return { replayed, failed };
}

export async function removeDlq(id: string): Promise<void> {
  const removed = await getRedis().zrem(K.dlqIndex, id);
  await getRedis().unlink(K.dlqEntry(id));
  if (!removed) throw new HttpError(404, 'not_found', `DLQ entry "${id}" not found`);
}

export async function clearDlq(): Promise<number> {
  const redis = getRedis();
  let cleared = 0;
  for (;;) {
    const ids = await redis.zrange(K.dlqIndex, 0, 499);
    if (ids.length === 0) break;
    await redis.multi().zrem(K.dlqIndex, ...ids).unlink(...ids.map(K.dlqEntry)).exec();
    cleared += ids.length;
  }
  publishEvent({ kind: 'dlq.cleared', level: 'warn', message: `dead-letter queue cleared (${cleared} jobs discarded)` });
  return cleared;
}
