import { Redis, type RedisOptions } from 'ioredis';
import { config } from './config';
import { logger } from './logger';

/** Redis key / channel names that Aether owns (BullMQ manages its own `<prefix>:<queue>:*` keys). */
export const K = {
  stats: `${config.prefix}:stats`,
  retrying: `${config.prefix}:retrying`,
  dlqIndex: `${config.prefix}:dlq:index`,
  dlqEntry: (id: string) => `${config.prefix}:dlq:entry:${id}`,
  workers: `${config.prefix}:workers`,
  eventsLog: `${config.prefix}:events:log`,
  channel: `${config.prefix}:events`,
} as const;

/**
 * Create a new Redis connection. BullMQ requires `maxRetriesPerRequest: null`
 * for blocking connections, so it is applied to every connection we create.
 */
export function createRedis(name: string, overrides: RedisOptions = {}): Redis {
  const client = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: `aether:${config.role}:${name}`,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    ...overrides,
  });
  client.on('error', (err) => logger.error({ err: err.message, conn: name }, 'redis connection error'));
  return client;
}

let shared: Redis | undefined;

/** Shared command connection (publish, counters, DLQ storage). */
export function getRedis(): Redis {
  if (!shared) shared = createRedis('main');
  return shared;
}

export async function closeRedis(): Promise<void> {
  if (shared) {
    const r = shared;
    shared = undefined;
    await r.quit().catch(() => r.disconnect());
  }
}

/** Increment one of the lifetime counters in the stats hash. */
export function incrStat(field: string, by = 1): Promise<number> {
  return getRedis().hincrby(K.stats, field, by);
}
