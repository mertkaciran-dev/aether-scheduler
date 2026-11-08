import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { retrySchema, type CreateJobInput } from '../api/schemas';
import { HttpError, badRequest, notFound } from '../errors';
import { publishEvent } from '../events/bus';
import { getHandler, handlers } from '../queue/handlers';
import { AETHER_BACKOFF, getJobsQueue } from '../queue/queues';
import { getRedis, incrStat, K } from '../redis';
import type { JobEnvelope, RetryPolicy, WebhookConfig } from '../types';
import { getDlqEntry } from './dlq';
import { nextCronRun, validateCron } from './cron';
import { UnsafeTargetError, assertSafeUrl } from './safeRequest';

export type EnqueueResult =
  | { kind: 'job'; id: string; type: string; state: 'waiting' | 'delayed'; scheduledFor: string | null; duplicate: boolean }
  | { kind: 'schedule'; id: string; type: string; cron: string; tz: string | null; limit: number | null; next: string };

export interface JobDto {
  id: string;
  type: string;
  state: string;
  payload: Record<string, unknown>;
  progress: unknown;
  attemptsMade: number;
  maxAttempts: number;
  priority: number | null;
  createdAt: number;
  scheduledFor: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  durationMs: number | null;
  returnValue: unknown;
  failedReason: string | null;
  source: string;
  schedulerId: string | null;
  replayedFrom: string | null;
  webhook: { url: string; events: string[] } | null;
  retry: RetryPolicy | null;
}

/** Strip secrets/headers and query strings (which often carry tokens) from a webhook config. */
export function publicWebhook(hook?: WebhookConfig): { url: string; events: string[] } | null {
  if (!hook) return null;
  try {
    const u = new URL(hook.url);
    return { url: `${u.origin}${u.pathname}${u.search ? '?…' : ''}`, events: hook.events };
  } catch {
    return { url: '(invalid)', events: hook.events };
  }
}

export function toJobDto(job: Job<JobEnvelope>, state: string): JobDto {
  const delay = job.opts.delay ?? 0;
  return {
    id: String(job.id),
    type: job.data.type,
    state: state === 'delayed' && job.attemptsMade > 0 ? 'retrying' : state,
    payload: job.data.payload,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    priority: job.opts.priority ?? null,
    createdAt: job.timestamp,
    scheduledFor: delay > 0 ? job.timestamp + delay : null,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null,
    returnValue: job.returnvalue ?? null,
    failedReason: job.failedReason ?? null,
    source: job.data.meta?.source ?? 'unknown',
    schedulerId: job.data.meta?.schedulerId ?? null,
    replayedFrom: job.data.meta?.replayedFrom ?? null,
    webhook: publicWebhook(job.data.webhook),
    retry: job.data.meta?.retry ?? null,
  };
}

function describeDelay(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

/** Validate + normalise a create-job request into a job envelope and BullMQ options. */
function prepare(input: CreateJobInput, source: string) {
  const handler = getHandler(input.type);
  if (!handler) {
    throw badRequest(`Unknown job type "${input.type}"`, { available: handlers.map((h) => h.type) });
  }
  const parsed = handler.schema.safeParse(input.payload);
  if (!parsed.success) {
    throw badRequest(
      `Invalid payload for job type "${input.type}"`,
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }

  if (input.webhook) {
    try {
      assertSafeUrl(input.webhook.url);
    } catch (err) {
      if (err instanceof UnsafeTargetError) throw badRequest(`Webhook URL rejected: ${err.message}`);
      throw err;
    }
  }

  const retry: RetryPolicy = retrySchema.parse(input.retry ?? {});
  const envelope: JobEnvelope = {
    type: input.type,
    payload: parsed.data as Record<string, unknown>,
    webhook: input.webhook,
    meta: { source, createdAt: Date.now(), retry, timeoutMs: input.timeoutMs },
  };
  const opts = {
    attempts: retry.attempts,
    backoff: { type: AETHER_BACKOFF, delay: retry.baseDelayMs },
    priority: input.priority,
  };
  return { envelope, opts, retry };
}

export async function enqueueJob(input: CreateJobInput, source = 'api'): Promise<EnqueueResult> {
  const { envelope, opts } = prepare(input, source);
  const queue = getJobsQueue();

  // ── Recurring (cron) ────────────────────────────────────────────────
  if (input.cron) {
    const problem = validateCron(input.cron, input.tz);
    if (problem) throw badRequest(`Invalid cron expression: ${problem}`);

    const id = input.scheduleId ?? `sch_${randomUUID().slice(0, 8)}`;
    envelope.meta.schedulerId = id;
    await queue.upsertJobScheduler(
      id,
      { pattern: input.cron, tz: input.tz, limit: input.limit },
      { name: input.type, data: envelope, opts },
    );
    const next = nextCronRun(input.cron, input.tz);
    publishEvent({
      kind: 'schedule.created',
      level: 'info',
      jobType: input.type,
      message: `schedule ${id} created (${input.cron}${input.tz ? ` ${input.tz}` : ''}${input.limit ? `, ${input.limit} run${input.limit > 1 ? 's' : ''}` : ''}) — next ${next.toISOString()}`,
      data: { scheduleId: id, cron: input.cron, next: next.getTime() },
    });
    return {
      kind: 'schedule',
      id,
      type: input.type,
      cron: input.cron,
      tz: input.tz ?? null,
      limit: input.limit ?? null,
      next: next.toISOString(),
    };
  }

  // ── One-off (immediate or delayed) ──────────────────────────────────
  let delay = input.delayMs ?? 0;
  if (input.runAt) delay = Math.max(0, new Date(input.runAt).getTime() - Date.now());

  const jobId = input.idempotencyKey ? `idem_${input.idempotencyKey}` : undefined;
  if (jobId) {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const delayed = (existing.opts.delay ?? 0) > 0;
      return {
        kind: 'job',
        id: jobId,
        type: input.type,
        state: delayed ? 'delayed' : 'waiting',
        scheduledFor: delayed ? new Date(existing.timestamp + (existing.opts.delay ?? 0)).toISOString() : null,
        duplicate: true,
      };
    }
  }

  const job = await queue.add(input.type, envelope, { ...opts, delay: delay || undefined, jobId });
  void incrStat('enqueued');
  const id = String(job.id);
  publishEvent({
    kind: delay > 0 ? 'job.scheduled' : 'job.queued',
    level: 'info',
    jobId: id,
    jobType: input.type,
    message: delay > 0 ? `scheduled to run in ${describeDelay(delay)}` : 'queued',
    data: { delayMs: delay, source },
  });
  return {
    kind: 'job',
    id,
    type: input.type,
    state: delay > 0 ? 'delayed' : 'waiting',
    scheduledFor: delay > 0 ? new Date(Date.now() + delay).toISOString() : null,
    duplicate: false,
  };
}

export type BulkItemResult = { index: number; ok: true; result: EnqueueResult } | { index: number; ok: false; error: string };

export async function enqueueMany(inputs: CreateJobInput[], source = 'api'): Promise<BulkItemResult[]> {
  const results: BulkItemResult[] = new Array(inputs.length);
  const CONCURRENCY = 25;
  for (let i = 0; i < inputs.length; i += CONCURRENCY) {
    await Promise.all(
      inputs.slice(i, i + CONCURRENCY).map(async (input, j) => {
        const index = i + j;
        try {
          results[index] = { index, ok: true, result: await enqueueJob(input, source) };
        } catch (err) {
          results[index] = { index, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }
  return results;
}

// ── Reads ───────────────────────────────────────────────────────────────

export type ListState = 'waiting' | 'active' | 'delayed' | 'retrying' | 'completed';

export async function listJobs(state: ListState, page: number, limit: number): Promise<{ items: JobDto[]; total: number }> {
  const queue = getJobsQueue();
  const start = (page - 1) * limit;
  const end = start + limit - 1;

  if (state === 'retrying') {
    const ids = (await getRedis().smembers(K.retrying)).sort();
    const jobs = await Promise.all(ids.slice(start, end + 1).map((id) => queue.getJob(id)));
    return {
      items: jobs.flatMap((j) => (j ? [toJobDto(j as Job<JobEnvelope>, 'delayed')] : [])),
      total: ids.length,
    };
  }

  const bullStates = state === 'waiting' ? (['waiting', 'prioritized', 'paused'] as const) : ([state] as const);
  const [jobs, counts] = await Promise.all([
    queue.getJobs([...bullStates], start, end, state === 'delayed'),
    queue.getJobCounts(...bullStates),
  ]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { items: jobs.map((j) => toJobDto(j as Job<JobEnvelope>, state)), total };
}

export async function getJobDetail(id: string): Promise<{ job: JobDto; logs: string[] }> {
  const queue = getJobsQueue();
  const job = await queue.getJob(id);
  if (!job) {
    const dead = await getDlqEntry(id);
    if (dead) {
      const dto: JobDto = {
        id: dead.id,
        type: dead.type,
        state: 'dead',
        payload: dead.payload,
        progress: 0,
        attemptsMade: dead.attemptsMade,
        maxAttempts: dead.opts.attempts,
        priority: dead.opts.priority ?? null,
        createdAt: dead.queuedAt,
        scheduledFor: null,
        processedOn: null,
        finishedOn: dead.failedAt,
        durationMs: null,
        returnValue: null,
        failedReason: dead.error.message,
        source: dead.meta.source,
        schedulerId: dead.meta.schedulerId ?? null,
        replayedFrom: dead.meta.replayedFrom ?? null,
        webhook: publicWebhook(dead.webhook),
        retry: dead.meta.retry,
      };
      return { job: dto, logs: [] };
    }
    throw notFound('Job', id);
  }
  const [state, logs] = await Promise.all([job.getState(), queue.getJobLogs(id, 0, 99)]);
  return { job: toJobDto(job as Job<JobEnvelope>, state), logs: logs.logs };
}

export async function removeJob(id: string): Promise<void> {
  const job = await getJobsQueue().getJob(id);
  if (!job) throw notFound('Job', id);
  try {
    await job.remove();
  } catch {
    throw new HttpError(409, 'conflict', `Job "${id}" is currently being processed and cannot be removed`);
  }
  await getRedis().srem(K.retrying, id);
  publishEvent({ kind: 'job.removed', level: 'warn', jobId: id, jobType: job.data.type, message: 'removed by operator' });
}
