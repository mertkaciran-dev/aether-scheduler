import { EventEmitter } from 'node:events';
import { config } from '../config';
import { logger } from '../logger';
import { getJobsQueue } from '../queue/queues';
import { getRedis, K } from '../redis';
import type { MetricsSample, MetricsSnapshot } from '../types';
import { reconcileRetrying } from './queueControl';
import { listWorkers } from './workerRegistry';

const HISTORY_POINTS = 180;

const num = (v: string | undefined) => Number(v ?? 0) || 0;

export async function collectSnapshot(): Promise<Omit<MetricsSnapshot, 'rates'>> {
  const redis = getRedis();
  const queue = getJobsQueue();

  const [counts, paused, stats, retrying, dlq, schedules, workers] = await Promise.all([
    queue.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'paused'),
    queue.isPaused(),
    redis.hgetall(K.stats),
    redis.scard(K.retrying),
    redis.zcard(K.dlqIndex),
    queue.getJobSchedulersCount(),
    listWorkers(),
  ]);

  return {
    ts: Date.now(),
    queue: {
      waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.paused ?? 0),
      active: counts.active ?? 0,
      delayed: Math.max(0, (counts.delayed ?? 0) - retrying),
      retrying,
      completed: num(stats.completed),
      failed: dlq,
      paused,
    },
    totals: {
      enqueued: num(stats.enqueued),
      completed: num(stats.completed),
      failedAttempts: num(stats.failedAttempts),
      retried: num(stats.retried),
      dead: num(stats.dead),
      webhooksDelivered: num(stats.webhooksDelivered),
      webhooksFailed: num(stats.webhooksFailed),
    },
    schedules,
    workers,
  };
}

/**
 * Samples queue state on an interval, derives throughput rates from lifetime-counter deltas, and
 * keeps a ring buffer so newly connected dashboards can render history immediately.
 */
export class MetricsSampler extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private ring: MetricsSample[] = [];
  private prev?: Omit<MetricsSnapshot, 'rates'>;
  private latestSnapshot?: MetricsSnapshot;
  private busy = false;
  private ticks = 0;

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), config.metricsIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  latest(): MetricsSnapshot | undefined {
    return this.latestSnapshot;
  }

  history(): MetricsSample[] {
    return this.ring;
  }

  /**
   * A snapshot no older than `maxAgeMs`. Reuses the sampler's latest when fresh enough, otherwise
   * collects anew (carrying over the last known rates), so REST reads never serve stale state.
   */
  async snapshotNow(maxAgeMs = 250): Promise<MetricsSnapshot> {
    const last = this.latestSnapshot;
    if (last && Date.now() - last.ts <= maxAgeMs) return last;
    const fresh = await collectSnapshot();
    return { ...fresh, rates: last?.rates ?? { enqueued: 0, completed: 0, failed: 0 } };
  }

  private async tick(): Promise<void> {
    if (this.busy) return; // never let slow Redis calls pile up
    this.busy = true;
    try {
      const snap = await collectSnapshot();
      const prev = this.prev;
      const dt = prev ? Math.max(0.001, (snap.ts - prev.ts) / 1000) : 0;
      const rate = (a: number, b: number | undefined) => (prev && b !== undefined ? Math.max(0, (a - b) / dt) : 0);
      const rates = {
        enqueued: round(rate(snap.totals.enqueued, prev?.totals.enqueued)),
        completed: round(rate(snap.totals.completed, prev?.totals.completed)),
        failed: round(rate(snap.totals.failedAttempts, prev?.totals.failedAttempts)),
      };
      this.prev = snap;
      const full: MetricsSnapshot = { ...snap, rates };
      this.latestSnapshot = full;

      this.ring.push({
        ts: snap.ts,
        waiting: snap.queue.waiting,
        active: snap.queue.active,
        delayed: snap.queue.delayed,
        retrying: snap.queue.retrying,
        failed: snap.queue.failed,
        completedRate: rates.completed,
        failedRate: rates.failed,
        enqueuedRate: rates.enqueued,
      });
      if (this.ring.length > HISTORY_POINTS) this.ring.splice(0, this.ring.length - HISTORY_POINTS);

      this.emit('sample', full);

      if (++this.ticks % 30 === 0) await reconcileRetrying();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'metrics sample failed');
    } finally {
      this.busy = false;
    }
  }
}

const round = (n: number) => Math.round(n * 10) / 10;
