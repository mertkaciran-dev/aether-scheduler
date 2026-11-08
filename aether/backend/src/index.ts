import http from 'node:http';
import { createApp } from './api/server';
import { DEFAULT_API_KEY, config } from './config';
import { EventSubscriber } from './events/bus';
import { logger } from './logger';
import { closeQueues, getJobsQueue } from './queue/queues';
import { startWorkers } from './queue/worker';
import { closeRedis, getRedis } from './redis';
import { MetricsSampler } from './services/metrics';
import { RealtimeServer } from './ws/server';

type Stoppable = { name: string; stop: () => Promise<void> };

async function startApi(): Promise<Stoppable> {
  const sampler = new MetricsSampler();
  const app = createApp(sampler);
  const server = http.createServer(app);
  const realtime = new RealtimeServer(server, sampler);

  // Every API process listens to the shared event channel, so events from any worker reach any dashboard.
  const subscriber = new EventSubscriber();
  await subscriber.start((event) => realtime.pushEvent(event));
  sampler.on('sample', (snapshot) => realtime.broadcastMetrics(snapshot));
  sampler.start();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  logger.info({ port: config.port }, 'api listening (http + ws at /ws)');

  return {
    name: 'api',
    stop: async () => {
      sampler.stop();
      await subscriber.stop();
      await realtime.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 3000).unref();
      });
    },
  };
}

async function main(): Promise<void> {
  logger.info({ env: config.env, version: config.version }, 'starting Aether ⚡');

  if (config.usingDefaultApiKey) {
    logger.warn(
      `API_KEYS is not set — falling back to the public demo key "${DEFAULT_API_KEY}". Set API_KEYS before exposing this service.`,
    );
  }
  if (config.isProd && config.allowPrivateTargets) {
    logger.warn('WEBHOOK_ALLOW_PRIVATE=true: webhooks and http.request jobs can reach private networks (SSRF risk).');
  }

  await getRedis().ping();
  getJobsQueue(); // eager init surfaces misconfiguration at boot

  const running: Stoppable[] = [];
  if (config.role === 'api' || config.role === 'all') running.push(await startApi());
  if (config.role === 'worker' || config.role === 'all') {
    const workers = await startWorkers();
    running.push({ name: 'workers', stop: workers.stop });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down gracefully');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    force.unref();

    for (const s of running) {
      await s.stop().catch((err) => logger.error({ err: err.message, component: s.name }, 'error while stopping'));
    }
    await closeQueues();
    await closeRedis();
    logger.info('bye');
    process.exit(code);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'failed to start');
  process.exit(1);
});
