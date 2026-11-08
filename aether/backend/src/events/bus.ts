import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { config } from '../config';
import { logger } from '../logger';
import { createRedis, getRedis, K } from '../redis';
import type { AetherEvent } from '../types';

/**
 * Cross-process event bus built on Redis pub/sub.
 *
 * Any process (API or worker) publishes; every API process subscribes and fans the events
 * out to its WebSocket clients. That is what lets N workers on different machines
 * all light up the same dashboard. A capped Redis list keeps recent history so a freshly
 * opened dashboard has context.
 */

export type NewEvent = Omit<AetherEvent, 'id' | 'ts'> & { ts?: number };

/** Fire-and-forget publish. Event delivery must never fail a job, so errors are only logged. */
export function publishEvent(e: NewEvent): void {
  const event: AetherEvent = { id: randomUUID(), ts: Date.now(), ...e };
  const payload = JSON.stringify(event);
  getRedis()
    .multi()
    .publish(K.channel, payload)
    .lpush(K.eventsLog, payload)
    .ltrim(K.eventsLog, 0, config.eventLogSize - 1)
    .exec()
    .catch((err) => logger.warn({ err: err.message }, 'failed to publish event'));
}

/** Most recent events, oldest first. */
export async function recentEvents(limit = 100): Promise<AetherEvent[]> {
  const raw = await getRedis().lrange(K.eventsLog, 0, Math.max(0, limit - 1));
  const out: AetherEvent[] = [];
  for (const line of raw) {
    try {
      out.push(JSON.parse(line) as AetherEvent);
    } catch {
      /* skip corrupt entry */
    }
  }
  return out.reverse();
}

export class EventSubscriber {
  private sub: Redis | undefined;

  async start(handler: (event: AetherEvent) => void): Promise<void> {
    const sub = createRedis('events-sub');
    this.sub = sub;
    sub.on('message', (_channel, message) => {
      try {
        handler(JSON.parse(message) as AetherEvent);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'dropping malformed event');
      }
    });
    await sub.subscribe(K.channel);
  }

  async stop(): Promise<void> {
    if (!this.sub) return;
    const sub = this.sub;
    this.sub = undefined;
    await sub.quit().catch(() => sub.disconnect());
  }
}
