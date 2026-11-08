import { Worker, type Job } from 'bullmq';
import { config } from '../config';
import { publishEvent } from '../events/bus';
import { logger } from '../logger';
import { createRedis, getRedis, incrStat, K } from '../redis';
import { addToDlq } from '../services/dlq';
import { enqueueWebhook, shouldFire, startWebhookWorker } from '../services/webhooks';
import { WorkerHeartbeat } from '../services/workerRegistry';
import type { JobEnvelope } from '../types';
import { destroyPool } from '../workers/pool';
import { computeBackoff } from './backoff';
import { processJob, type FailureTag } from './processor';
import { AETHER_BACKOFF, JOBS_QUEUE } from './queues';

type TaggedError = Error & { aether?: FailureTag };

const errorBody = (err: Error) => ({ name: err.name, message: err.message });

/**
 * Starts the job worker and the webhook dispatcher. Everything user-visible that happens
 * to a job (state events, retry bookkeeping, DLQ, webhooks) is driven from BullMQ's worker events,
 * which fire after the state transition has been committed to Redis.
 */
export async function startWorkers(): Promise<{ stop: () => Promise<void> }> {
  const heartbeat = new WorkerHeartbeat();
  /** jobId → backoff chosen for the attempt that just failed (read back in the 'failed' listener). */
  const backoffChosen = new Map<string, number>();

  const worker = new Worker<JobEnvelope>(JOBS_QUEUE, processJob, {
    connection: createRedis('worker'),
    prefix: config.prefix,
    concurrency: config.workerConcurrency,
    lockDuration: 30_000,
    maxStalledCount: 1,
    settings: {
      backoffStrategy: (attemptsMade, type, _err, job) => {
        if (type !== AETHER_BACKOFF || !job) return config.defaultTimeoutMs;
        const delay = computeBackoff(attemptsMade, (job as Job<JobEnvelope>).data.meta.retry);
        backoffChosen.set(String(job.id), delay);
        return delay;
      },
    },
  });

  worker.on('error', (err) => logger.error({ err: err.message }, 'worker error'));

  worker.on('active', (job) => {
    heartbeat.active++;
    const attempt = job.attemptsMade + 1;
    void getRedis().srem(K.retrying, String(job.id));
    publishEvent({
      kind: 'job.active',
      level: 'info',
      jobId: String(job.id),
      jobType: job.data.type,
      message: attempt > 1 ? `started (attempt ${attempt}/${job.opts.attempts ?? 1})` : 'started',
      data: { attempt, workerId: heartbeat.id },
    });
  });

  worker.on('completed', (job, result) => {
    heartbeat.active = Math.max(0, heartbeat.active - 1);
    heartbeat.processed++;
    const durationMs = (job.finishedOn ?? Date.now()) - (job.processedOn ?? Date.now());
    void incrStat('completed');
    publishEvent({
      kind: 'job.completed',
      level: 'success',
      jobId: String(job.id),
      jobType: job.data.type,
      message: `completed in ${durationMs}ms`,
      data: { durationMs, attempts: job.attemptsMade, workerId: heartbeat.id },
    });
    if (shouldFire(job.data.webhook, 'completed')) {
      void enqueueWebhook(
        job.data.webhook,
        'job.completed',
        {
          job: {
            id: String(job.id),
            type: job.data.type,
            attempts: job.attemptsMade,
            durationMs,
            queuedAt: new Date(job.timestamp).toISOString(),
            finishedAt: new Date(job.finishedOn ?? Date.now()).toISOString(),
          },
          result,
        },
        String(job.id),
      ).catch((err) => logger.error({ err: err.message, jobId: job.id }, 'failed to enqueue webhook'));
    }
  });

  worker.on('failed', (job, err) => {
    heartbeat.active = Math.max(0, heartbeat.active - 1);
    heartbeat.failed++;
    void incrStat('failedAttempts');
    if (!job) return;

    const tag = (err as TaggedError).aether;
    // Untagged failures (e.g. exhausted stall limit) never came from the processor, so they are terminal.
    const final = tag?.final ?? true;
    const attempt = tag?.attempt ?? job.attemptsMade;
    const maxAttempts = tag?.maxAttempts ?? job.opts.attempts ?? 1;
    const id = String(job.id);
    const base = { jobId: id, jobType: job.data.type };
    const webhookJob = {
      id,
      type: job.data.type,
      attempts: attempt,
      maxAttempts,
      queuedAt: new Date(job.timestamp).toISOString(),
    };

    if (!final) {
      const nextDelayMs = backoffChosen.get(id) ?? 0;
      backoffChosen.delete(id);
      void getRedis().sadd(K.retrying, id);
      void incrStat('retried');
      publishEvent({
        ...base,
        kind: 'job.retrying',
        level: 'warn',
        message: `attempt ${attempt}/${maxAttempts} failed: ${err.message} — retrying in ${formatMs(nextDelayMs)}`,
        data: { attempt, maxAttempts, nextDelayMs, error: err.message },
      });
      if (shouldFire(job.data.webhook, 'retrying')) {
        void enqueueWebhook(
          job.data.webhook,
          'job.retrying',
          { job: webhookJob, error: errorBody(err), nextRetryInMs: nextDelayMs },
          id,
        ).catch((e) => logger.error({ err: e.message, jobId: id }, 'failed to enqueue webhook'));
      }
      return;
    }

    backoffChosen.delete(id);
    void (async () => {
      try {
        await addToDlq(job, err, attempt);
        await job.remove(); // snapshot is safely in the DLQ; drop it from BullMQ's failed set
        publishEvent({
          ...base,
          kind: 'job.dead',
          level: 'error',
          message: `dead-lettered after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${err.message}`,
          data: { attempt, maxAttempts, error: err.message },
        });
      } catch (e) {
        logger.error({ err: (e as Error).message, jobId: id }, 'failed to dead-letter job');
      }
      if (shouldFire(job.data.webhook, 'failed')) {
        await enqueueWebhook(job.data.webhook, 'job.failed', { job: webhookJob, error: errorBody(err) }, id).catch(
          (e) => logger.error({ err: e.message, jobId: id }, 'failed to enqueue webhook'),
        );
      }
    })();
  });

  worker.on('stalled', (jobId) => {
    publishEvent({
      kind: 'job.stalled',
      level: 'warn',
      jobId,
      message: 'worker stopped renewing its lock; job returned to the queue',
    });
  });

  const webhookWorker = startWebhookWorker();
  heartbeat.start();
  publishEvent({
    kind: 'worker.online',
    level: 'info',
    message: `worker ${heartbeat.id} online (concurrency ${config.workerConcurrency}, ${config.threadPoolSize} threads)`,
  });
  logger.info(
    { workerId: heartbeat.id, concurrency: config.workerConcurrency, threads: config.threadPoolSize },
    'worker started',
  );

  return {
    stop: async () => {
      logger.info('worker draining in-flight jobs…');
      await worker.close(); // waits for active jobs to finish
      await webhookWorker.close();
      await heartbeat.stop();
      await destroyPool();
      publishEvent({ kind: 'worker.offline', level: 'info', message: `worker ${heartbeat.id} offline` });
    },
  };
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
