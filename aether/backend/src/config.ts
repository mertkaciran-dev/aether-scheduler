import os from 'node:os';

/**
 * Central, validated configuration. Every tunable is an environment variable;
 * invalid values fail fast at boot rather than surfacing as odd runtime behaviour.
 */

function str(key: string, def: string): string {
  const v = process.env[key];
  return v !== undefined && v.trim() !== '' ? v.trim() : def;
}

function int(key: string, def: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${key}="${raw}": expected an integer between ${min} and ${max}`);
  }
  return n;
}

function bool(key: string, def: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function list(key: string): string[] {
  return (process.env[key] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export type Role = 'all' | 'api' | 'worker';

const role = str('ROLE', 'all') as Role;
if (!['all', 'api', 'worker'].includes(role)) {
  throw new Error(`Invalid ROLE="${role}": expected one of all | api | worker`);
}

const nodeEnv = str('NODE_ENV', 'development');

/** Key used when API_KEYS is not set. A loud warning is logged at boot if it is in use. */
export const DEFAULT_API_KEY = 'aether-demo-key';

const apiKeys = list('API_KEYS');

export const config = {
  env: nodeEnv,
  isProd: nodeEnv === 'production',
  role,
  hostname: os.hostname(),
  version: '1.0.0',

  // HTTP / WS
  port: int('PORT', 4000, 1, 65535),
  host: str('HOST', '0.0.0.0'),
  trustProxy: str('TRUST_PROXY', 'loopback,linklocal,uniquelocal'),
  corsOrigins: list('CORS_ORIGINS'),
  rateLimitPerMin: int('RATE_LIMIT_PER_MIN', 600, 1),
  wsMaxClients: int('WS_MAX_CLIENTS', 200, 1),
  wsAuthTimeoutMs: int('WS_AUTH_TIMEOUT_MS', 5000, 500),

  // Auth
  apiKeys: apiKeys.length > 0 ? apiKeys : [DEFAULT_API_KEY],
  usingDefaultApiKey: apiKeys.length === 0,

  // Redis
  redisUrl: str('REDIS_URL', 'redis://127.0.0.1:6379'),
  prefix: str('QUEUE_PREFIX', 'aether'),

  // Queue / workers
  workerConcurrency: int('WORKER_CONCURRENCY', 10, 1, 1000),
  threadPoolSize: int('THREAD_POOL_SIZE', Math.max(1, Math.min(4, os.cpus().length)), 1, 64),
  defaultAttempts: int('DEFAULT_ATTEMPTS', 3, 1, 50),
  defaultTimeoutMs: int('DEFAULT_TIMEOUT_MS', 30_000, 100, 3_600_000),
  keepCompletedCount: int('KEEP_COMPLETED_COUNT', 1000, 0),
  keepCompletedAgeSec: int('KEEP_COMPLETED_AGE_SEC', 86_400, 0),
  dlqMaxSize: int('DLQ_MAX_SIZE', 10_000, 1),
  eventLogSize: int('EVENT_LOG_SIZE', 500, 10, 100_000),
  metricsIntervalMs: int('METRICS_INTERVAL_MS', 1000, 250),
  workerHeartbeatMs: int('WORKER_HEARTBEAT_MS', 5000, 1000),

  // Webhooks
  webhookTimeoutMs: int('WEBHOOK_TIMEOUT_MS', 10_000, 500),
  webhookMaxAttempts: int('WEBHOOK_MAX_ATTEMPTS', 5, 1, 20),
  webhookSigningSecret: str('WEBHOOK_SIGNING_SECRET', ''),
  /** Allow webhooks / http.request jobs to reach private (RFC1918, loopback, link-local) addresses. */
  allowPrivateTargets: bool('WEBHOOK_ALLOW_PRIVATE', false),
  /** Expose POST /hooks/sink, an unauthenticated receiver for testing webhooks end to end. */
  enableWebhookSink: bool('ENABLE_WEBHOOK_SINK', false),

  // Ops
  logLevel: str('LOG_LEVEL', 'info'),
  shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 15_000, 1000),
} as const;

export type Config = typeof config;
