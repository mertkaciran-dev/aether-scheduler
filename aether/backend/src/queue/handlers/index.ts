import { createHash, randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { UnsafeTargetError, safeRequest } from '../../services/safeRequest';
import { getPool } from '../../workers/pool';
import { sleep, type JobHandler } from './types';

/**
 * Built-in job types. To add your own: create a JobHandler and append it to `handlers`.
 * The payload schema is enforced when the job is created, so malformed jobs are rejected
 * up front instead of burning retries.
 */

const echo: JobHandler<{ message: string; delayMs: number }> = {
  type: 'echo',
  description: 'Returns its message after an optional delay. Handy for smoke tests.',
  schema: z.object({
    message: z.string().max(10_000).default('hello from Aether'),
    delayMs: z.number().int().min(0).max(60_000).default(0),
  }),
  example: { message: 'hello from Aether', delayMs: 250 },
  async run(p, ctx) {
    if (p.delayMs) await sleep(p.delayMs, ctx.signal);
    return { echo: p.message, at: new Date().toISOString() };
  },
};

const httpRequest: JobHandler<{
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
}> = {
  type: 'http.request',
  description: 'Calls an HTTP endpoint. Non-2xx responses fail the attempt and trigger the retry policy.',
  schema: z.object({
    url: z.string().url().max(2048),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    headers: z.record(z.string(), z.string().max(2048)).optional(),
    body: z.unknown().optional(),
  }),
  example: { url: 'https://example.com', method: 'GET' },
  async run(p, ctx) {
    const hasBody = p.body !== undefined && p.method !== 'GET';
    const body = hasBody ? (typeof p.body === 'string' ? p.body : JSON.stringify(p.body)) : undefined;
    const headers: Record<string, string> = { 'user-agent': 'Aether/1.0', ...p.headers };
    if (hasBody && typeof p.body !== 'string' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    let res;
    try {
      res = await safeRequest(p.url, { method: p.method, headers, body, signal: ctx.signal, timeoutMs: 20_000 });
    } catch (err) {
      // A blocked target is a policy decision, not a transient fault: retrying can never succeed.
      if (err instanceof UnsafeTargetError) throw new UnrecoverableError(err.message);
      throw err;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status} from ${new URL(p.url).host}`);
    }
    return { status: res.status, durationMs: res.durationMs, bodyPreview: res.body.slice(0, 500) };
  },
};

const emailSend: JobHandler<{ to: string; subject: string; body: string; failRate: number }> = {
  type: 'email.send',
  description: 'Simulated transactional email. Set failRate (0–1) to exercise retries.',
  schema: z.object({
    to: z.string().email(),
    subject: z.string().max(300).default('Welcome to Aether'),
    body: z.string().max(100_000).default(''),
    failRate: z.number().min(0).max(1).default(0),
  }),
  example: { to: 'ada@example.com', subject: 'Welcome to Aether ⚡', body: 'Your queue is live.', failRate: 0.2 },
  async run(p, ctx) {
    await sleep(100 + Math.random() * 500, ctx.signal);
    if (Math.random() < p.failRate) throw new Error('SMTP 451: temporary failure, try again later');
    return { messageId: `<${randomUUID()}@aether.local>`, accepted: [p.to] };
  },
};

const reportGenerate: JobHandler<{ name: string; rows: number; durationMs: number }> = {
  type: 'report.generate',
  description: 'Simulated multi-stage report build that reports progress.',
  schema: z.object({
    name: z.string().max(200).default('weekly-summary'),
    rows: z.number().int().min(1).max(10_000_000).default(25_000),
    durationMs: z.number().int().min(100).max(120_000).default(2500),
  }),
  example: { name: 'weekly-summary', rows: 25000, durationMs: 2500 },
  async run(p, ctx) {
    const stages = ['collecting', 'aggregating', 'rendering', 'uploading'];
    for (let i = 0; i < stages.length; i++) {
      await ctx.log(`${stages[i]}…`);
      await sleep(p.durationMs / stages.length, ctx.signal);
      await ctx.progress(Math.round(((i + 1) / stages.length) * 100));
    }
    const checksum = createHash('sha1').update(`${p.name}:${p.rows}`).digest('hex').slice(0, 12);
    return { reportId: `rpt_${checksum}`, rows: p.rows, url: `s3://aether-reports/${p.name}-${checksum}.pdf` };
  },
};

const computePrimes: JobHandler<{ limit: number }> = {
  type: 'compute.primes',
  description: 'CPU-bound prime counting, executed on a worker thread so the event loop stays responsive.',
  schema: z.object({ limit: z.number().int().min(10).max(50_000_000).default(5_000_000) }),
  example: { limit: 8000000 },
  async run(p, ctx) {
    const started = Date.now();
    const result = await getPool().run<{ count: number; largest: number }>('primes', p, { signal: ctx.signal });
    return { limit: p.limit, ...result, elapsedMs: Date.now() - started, thread: true };
  },
};

const flaky: JobHandler<{
  durationMs: number;
  failUntilAttempt: number;
  failRate: number;
  alwaysFail: boolean;
  errorMessage: string;
}> = {
  type: 'flaky',
  description:
    'Chaos job for demoing retries and the DLQ. Fails until attempt N, at a random rate, or always.',
  schema: z.object({
    durationMs: z.number().int().min(0).max(30_000).default(300),
    failUntilAttempt: z.number().int().min(1).max(50).default(1),
    failRate: z.number().min(0).max(1).default(0),
    alwaysFail: z.boolean().default(false),
    errorMessage: z.string().max(500).default('Simulated downstream failure'),
  }),
  example: { durationMs: 300, failUntilAttempt: 3, alwaysFail: false },
  async run(p, ctx) {
    await sleep(p.durationMs, ctx.signal);
    if (p.alwaysFail) throw new Error(p.errorMessage);
    if (ctx.attempt < p.failUntilAttempt) throw new Error(`${p.errorMessage} (attempt ${ctx.attempt})`);
    if (p.failRate > 0 && Math.random() < p.failRate) throw new Error(p.errorMessage);
    return { ok: true, succeededOnAttempt: ctx.attempt };
  },
};

export const handlers: JobHandler[] = [echo, httpRequest, emailSend, reportGenerate, computePrimes, flaky];

const registry = new Map(handlers.map((h) => [h.type, h]));

export function getHandler(type: string): JobHandler | undefined {
  return registry.get(type);
}

export function listHandlers(): Array<Pick<JobHandler, 'type' | 'description' | 'example'>> {
  return handlers.map(({ type, description, example }) => ({ type, description, example }));
}
