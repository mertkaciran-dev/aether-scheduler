import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { getRedis, K } from '../redis';
import type { WorkerInfo } from '../types';

const STALE_AFTER_MS = config.workerHeartbeatMs * 3;

/** Live per-process counters, written to Redis on every heartbeat. */
export class WorkerHeartbeat {
  readonly id = `${config.hostname}-${process.pid}-${randomUUID().slice(0, 4)}`;
  active = 0;
  processed = 0;
  failed = 0;
  private readonly startedAt = Date.now();
  private timer?: NodeJS.Timeout;

  start(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), config.workerHeartbeatMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await getRedis()
      .hdel(K.workers, this.id)
      .catch(() => undefined);
  }

  private async beat(): Promise<void> {
    const info: WorkerInfo = {
      id: this.id,
      host: config.hostname,
      pid: process.pid,
      concurrency: config.workerConcurrency,
      active: this.active,
      processed: this.processed,
      failed: this.failed,
      startedAt: this.startedAt,
      lastSeen: Date.now(),
      version: config.version,
    };
    await getRedis()
      .hset(K.workers, this.id, JSON.stringify(info))
      .catch(() => undefined);
  }
}

/** Workers whose heartbeat is fresh. Stale registrations are pruned as a side effect. */
export async function listWorkers(): Promise<WorkerInfo[]> {
  const redis = getRedis();
  const all = await redis.hgetall(K.workers);
  const now = Date.now();
  const live: WorkerInfo[] = [];
  const stale: string[] = [];
  for (const [id, raw] of Object.entries(all)) {
    try {
      const info = JSON.parse(raw) as WorkerInfo;
      if (now - info.lastSeen > STALE_AFTER_MS) stale.push(id);
      else live.push(info);
    } catch {
      stale.push(id);
    }
  }
  if (stale.length > 0) await redis.hdel(K.workers, ...stale).catch(() => undefined);
  return live.sort((a, b) => a.startedAt - b.startedAt);
}
