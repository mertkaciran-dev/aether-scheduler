import { Queue, type JobsOptions } from 'bullmq';
import { config } from '../config';
import { getRedis } from '../redis';
import type { JobEnvelope } from '../types';

export const JOBS_QUEUE = 'jobs';
export const WEBHOOKS_QUEUE = 'webhooks';

/** The `aether` custom backoff type is resolved by the worker's backoffStrategy (see worker.ts). */
export const AETHER_BACKOFF = 'aether';

export const defaultJobOptions: JobsOptions = {
  removeOnComplete: {
    count: config.keepCompletedCount,
    age: config.keepCompletedAgeSec,
  },
  // Failed jobs are moved into the Aether DLQ (with a full snapshot) and then removed explicitly.
  removeOnFail: false,
};

let jobsQueue: Queue<JobEnvelope> | undefined;
let webhookQueue: Queue | undefined;

export function getJobsQueue(): Queue<JobEnvelope> {
  if (!jobsQueue) {
    jobsQueue = new Queue<JobEnvelope>(JOBS_QUEUE, {
      connection: getRedis(),
      prefix: config.prefix,
      defaultJobOptions,
    });
    jobsQueue.on('error', () => undefined); // connection errors are logged by the redis client
  }
  return jobsQueue;
}

export function getWebhookQueue(): Queue {
  if (!webhookQueue) {
    webhookQueue = new Queue(WEBHOOKS_QUEUE, {
      connection: getRedis(),
      prefix: config.prefix,
      defaultJobOptions: {
        attempts: config.webhookMaxAttempts,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    });
    webhookQueue.on('error', () => undefined);
  }
  return webhookQueue;
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([jobsQueue?.close(), webhookQueue?.close()]);
  jobsQueue = undefined;
  webhookQueue = undefined;
}
