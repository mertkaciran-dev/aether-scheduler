import { createHmac, randomUUID } from 'node:crypto';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { config } from '../config';
import { publishEvent } from '../events/bus';
import { logger } from '../logger';
import { WEBHOOKS_QUEUE, getWebhookQueue } from '../queue/queues';
import { createRedis, incrStat } from '../redis';
import type { WebhookConfig, WebhookEvent } from '../types';
import { UnsafeTargetError, assertSafeUrl, safeRequest } from './safeRequest';

export interface DeliveryData {
  deliveryId: string;
  event: string;
  jobId?: string;
  url: string;
  headers?: Record<string, string>;
  secret?: string;
  body: string;
}

/** `sha256=<hex>` over `${timestamp}.${body}`. Receivers should also reject stale timestamps. */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export async function enqueueWebhook(
  hook: WebhookConfig,
  event: string,
  payload: Record<string, unknown>,
  jobId?: string,
): Promise<string> {
  const deliveryId = randomUUID();
  const body = JSON.stringify({ event, deliveryId, timestamp: new Date().toISOString(), ...payload });
  const data: DeliveryData = {
    deliveryId,
    event,
    jobId,
    url: hook.url,
    headers: hook.headers,
    secret: hook.secret ?? (config.webhookSigningSecret || undefined),
    body,
  };
  await getWebhookQueue().add('deliver', data, { jobId: `wh_${deliveryId}` });
  return deliveryId;
}

export function shouldFire(hook: WebhookConfig | undefined, event: WebhookEvent): hook is WebhookConfig {
  return !!hook && hook.events.includes(event);
}

async function deliver(job: Job<DeliveryData>): Promise<{ status: number; durationMs: number }> {
  const d = job.data;
  const maxAttempts = job.opts.attempts ?? 1;
  const attempt = job.attemptsMade + 1;
  const timestamp = String(Math.floor(Date.now() / 1000));

  const headers: Record<string, string> = {
    ...d.headers,
    'content-type': 'application/json',
    'user-agent': 'Aether-Webhooks/1.0',
    'x-aether-event': d.event,
    'x-aether-delivery': d.deliveryId,
    'x-aether-timestamp': timestamp,
  };
  if (d.secret) headers['x-aether-signature'] = signPayload(d.secret, timestamp, d.body);

  const host = (() => {
    try {
      return new URL(d.url).host;
    } catch {
      return d.url;
    }
  })();

  try {
    assertSafeUrl(d.url);
    const res = await safeRequest(d.url, {
      method: 'POST',
      headers,
      body: d.body,
      timeoutMs: config.webhookTimeoutMs,
      maxBytes: 4096,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`Receiver responded HTTP ${res.status}`);

    void incrStat('webhooksDelivered');
    publishEvent({
      kind: 'webhook.delivered',
      level: 'success',
      jobId: d.jobId,
      message: `${d.event} → ${host} (HTTP ${res.status}, ${res.durationMs}ms)`,
      data: { deliveryId: d.deliveryId, attempt, status: res.status },
    });
    return { status: res.status, durationMs: res.durationMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const blocked = err instanceof UnsafeTargetError; // policy violation: never retry
    const final = blocked || attempt >= maxAttempts;
    if (final) void incrStat('webhooksFailed');
    publishEvent({
      kind: 'webhook.failed',
      level: final ? 'error' : 'warn',
      jobId: d.jobId,
      message: `${d.event} → ${host} failed (attempt ${attempt}/${maxAttempts}): ${message}${final ? ' — giving up' : ''}`,
      data: { deliveryId: d.deliveryId, attempt, final },
    });
    throw blocked ? new UnrecoverableError(message) : err;
  }
}

/** Webhook dispatcher: its own queue so deliveries get independent retries with exponential backoff. */
export function startWebhookWorker(): Worker<DeliveryData> {
  const worker = new Worker<DeliveryData>(WEBHOOKS_QUEUE, deliver, {
    connection: createRedis('webhook-worker'),
    prefix: config.prefix,
    concurrency: 10,
  });
  worker.on('error', (err) => logger.error({ err: err.message }, 'webhook worker error'));
  return worker;
}
