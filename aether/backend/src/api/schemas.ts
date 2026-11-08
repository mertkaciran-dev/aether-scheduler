import { z } from 'zod';
import { config } from '../config';

export const webhookSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.enum(['completed', 'failed', 'retrying'])).min(1).max(3).default(['completed', 'failed']),
  secret: z.string().min(8).max(256).optional(),
  headers: z.record(z.string().max(128), z.string().max(2048)).optional(),
});

export const retrySchema = z.object({
  attempts: z.number().int().min(1).max(50).default(config.defaultAttempts),
  strategy: z.enum(['exponential', 'fixed']).default('exponential'),
  baseDelayMs: z.number().int().min(100).max(3_600_000).default(1000),
  maxDelayMs: z.number().int().min(100).max(86_400_000).default(300_000),
  jitter: z.boolean().default(true),
});

const MAX_DELAY_MS = 30 * 24 * 3600 * 1000;

export const createJobSchema = z
  .object({
    type: z.string().min(1).max(64),
    payload: z.record(z.string(), z.unknown()).default({}),

    // When to run (mutually exclusive)
    delayMs: z.number().int().min(0).max(MAX_DELAY_MS).optional(),
    runAt: z.string().datetime({ offset: true }).optional(),
    cron: z.string().min(1).max(120).optional(),
    tz: z.string().max(64).optional(),
    /** Max number of cron runs. `limit: 1` makes a one-off cron task. */
    limit: z.number().int().min(1).max(1_000_000).optional(),
    scheduleId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'scheduleId may contain letters, digits, "_" and "-" (max 64)')
      .optional(),

    priority: z.number().int().min(1).max(2_097_152).optional(),
    timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
    retry: retrySchema.optional(),
    webhook: webhookSchema.optional(),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'idempotencyKey may contain letters, digits, "_" and "-" (max 64)')
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.cron && (v.delayMs !== undefined || v.runAt)) {
      ctx.addIssue({ code: 'custom', path: ['cron'], message: 'cron cannot be combined with delayMs or runAt' });
    }
    if (v.delayMs !== undefined && v.runAt) {
      ctx.addIssue({ code: 'custom', path: ['runAt'], message: 'use either delayMs or runAt, not both' });
    }
    if (!v.cron && (v.limit !== undefined || v.scheduleId || v.tz)) {
      ctx.addIssue({ code: 'custom', path: ['cron'], message: 'limit, scheduleId and tz require a cron expression' });
    }
    if (v.cron && v.idempotencyKey) {
      ctx.addIssue({ code: 'custom', path: ['idempotencyKey'], message: 'idempotencyKey is not supported for cron schedules; use scheduleId' });
    }
  });

export type CreateJobInput = z.infer<typeof createJobSchema>;

export const bulkJobsSchema = z.object({
  jobs: z.array(createJobSchema).min(1).max(500),
});

const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
};

export const listJobsQuery = z.object({
  state: z.enum(['waiting', 'active', 'delayed', 'retrying', 'completed']).default('waiting'),
  ...page,
});

export const listDlqQuery = z.object({
  type: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
  ...page,
});

export const cleanQueueSchema = z.object({
  state: z.enum(['completed', 'delayed', 'waiting']).default('completed'),
  graceMs: z.number().int().min(0).default(0),
});

export const webhookTestSchema = z.object({
  url: z.string().url().max(2048),
  secret: z.string().min(8).max(256).optional(),
});
