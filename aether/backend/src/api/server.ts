import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { config } from '../config';
import { HttpError } from '../errors';
import { publishEvent } from '../events/bus';
import { logger } from '../logger';
import { getJobsQueue } from '../queue/queues';
import { getRedis } from '../redis';
import type { MetricsSampler } from '../services/metrics';
import { requireApiKey } from './auth';
import { dlqRouter } from './routes/dlq';
import { jobsRouter } from './routes/jobs';
import { schedulesRouter } from './routes/schedules';
import { systemRouter } from './routes/system';

const requestLogger: RequestHandler = (req, res, next) => {
  const started = process.hrtime.bigint();
  const id = req.header('x-request-id') ?? randomUUID();
  res.setHeader('x-request-id', id);
  res.on('finish', () => {
    if (req.path === '/api/health') return;
    logger.info(
      {
        reqId: id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Number(process.hrtime.bigint() - started) / 1e6,
      },
      'http',
    );
  });
  next();
};

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large' } });
    return;
  }
  logger.error({ err: err?.message, stack: err?.stack, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
};

export function createApp(sampler: MetricsSampler): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  if (config.corsOrigins.length > 0) {
    app.use(cors({ origin: config.corsOrigins, allowedHeaders: ['content-type', 'x-api-key', 'authorization'] }));
  }
  app.use(requestLogger);

  /** Liveness/readiness: unauthenticated so orchestrators can probe it. Reveals nothing sensitive. */
  app.get('/api/health', async (_req, res) => {
    try {
      const started = Date.now();
      await getRedis().ping();
      await getJobsQueue().isPaused();
      res.json({ status: 'ok', redisMs: Date.now() - started, role: config.role, version: config.version, uptime: Math.round(process.uptime()) });
    } catch (err) {
      res.status(503).json({ status: 'unavailable', error: (err as Error).message });
    }
  });

  /**
   * Optional receiver for exercising webhooks end to end (ENABLE_WEBHOOK_SINK=true).
   * It accepts any JSON and echoes it into the live event stream. Do not enable on a public deployment.
   */
  if (config.enableWebhookSink) {
    app.post(
      '/hooks/sink',
      rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }),
      express.json({ limit: '256kb' }),
      (req, res) => {
        const event = req.header('x-aether-event') ?? req.body?.event ?? 'unknown';
        const jobId = req.body?.job?.id ? String(req.body.job.id) : undefined;
        publishEvent({
          kind: 'webhook.received',
          level: 'info',
          jobId,
          jobType: req.body?.job?.type,
          message: `sink received ${event}${req.header('x-aether-signature') ? ' (signed)' : ''}`,
          data: { deliveryId: req.header('x-aether-delivery') },
        });
        res.json({ ok: true });
      },
    );
  }

  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: config.rateLimitPerMin,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'rate_limited', message: 'Too many requests, slow down.' } },
    }),
    requireApiKey,
    express.json({ limit: '1mb' }),
    jobsRouter,
    schedulesRouter,
    dlqRouter,
    systemRouter(sampler),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });
  app.use(errorHandler);
  return app;
}
