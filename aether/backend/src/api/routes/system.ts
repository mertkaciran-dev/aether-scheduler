import { Router } from 'express';
import { config } from '../../config';
import { listHandlers } from '../../queue/handlers';
import type { MetricsSampler } from '../../services/metrics';
import { recentEvents } from '../../events/bus';
import { cleanQueue, drainQueue, pauseQueue, resumeQueue } from '../../services/queueControl';
import { enqueueWebhook } from '../../services/webhooks';
import { UnsafeTargetError, assertSafeUrl } from '../../services/safeRequest';
import { badRequest } from '../../errors';
import { listWorkers } from '../../services/workerRegistry';
import { cleanQueueSchema, webhookTestSchema } from '../schemas';

export function systemRouter(sampler: MetricsSampler): Router {
  const router = Router();

  /** Deployment capabilities the dashboard adapts to (e.g. whether the webhook sink is available). */
  router.get('/info', (_req, res) => {
    res.json({
      version: config.version,
      role: config.role,
      env: config.env,
      features: {
        webhookSink: config.enableWebhookSink,
        allowPrivateTargets: config.allowPrivateTargets,
        defaultWebhookSigning: config.webhookSigningSecret !== '',
      },
      defaults: {
        attempts: config.defaultAttempts,
        timeoutMs: config.defaultTimeoutMs,
        webhookMaxAttempts: config.webhookMaxAttempts,
      },
      jobTypes: listHandlers(),
    });
  });

  router.get('/metrics', async (_req, res) => {
    res.json(await sampler.snapshotNow());
  });

  router.get('/metrics/history', (_req, res) => {
    res.json({ items: sampler.history() });
  });

  router.get('/workers', async (_req, res) => {
    res.json({ items: await listWorkers() });
  });

  router.get('/events', async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ items: await recentEvents(limit) });
  });

  // ── Queue controls ────────────────────────────────────────────────
  router.post('/queue/pause', async (_req, res) => {
    await pauseQueue();
    res.json({ paused: true });
  });

  router.post('/queue/resume', async (_req, res) => {
    await resumeQueue();
    res.json({ paused: false });
  });

  router.post('/queue/clean', async (req, res) => {
    const { state, graceMs } = cleanQueueSchema.parse(req.body ?? {});
    res.json({ removed: await cleanQueue(state, graceMs) });
  });

  router.post('/queue/drain', async (_req, res) => {
    await drainQueue();
    res.json({ drained: true });
  });

  // ── Webhook tooling ───────────────────────────────────────────────
  /** Sends a signed `webhook.test` delivery through the real dispatcher (retries + signing included). */
  router.post('/webhooks/test', async (req, res) => {
    const { url, secret } = webhookTestSchema.parse(req.body);
    try {
      assertSafeUrl(url);
    } catch (err) {
      if (err instanceof UnsafeTargetError) throw badRequest(`Webhook URL rejected: ${err.message}`);
      throw err;
    }
    const deliveryId = await enqueueWebhook(
      { url, secret, events: ['completed'] },
      'webhook.test',
      { message: 'Hello from Aether ⚡' },
    );
    res.status(202).json({ queued: true, deliveryId });
  });

  return router;
}
