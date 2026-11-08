import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { verifyApiKey } from '../api/auth';
import { config } from '../config';
import { recentEvents } from '../events/bus';
import { logger } from '../logger';
import { listHandlers } from '../queue/handlers';
import type { MetricsSampler } from '../services/metrics';
import type { AetherEvent, MetricsSnapshot } from '../types';

interface Client {
  ws: WebSocket;
  authed: boolean;
  alive: boolean;
}

const FLUSH_MS = 100;
const MAX_EVENTS_PER_FLUSH = 200;
const MAX_PENDING = 5000;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

/**
 * Real-time channel at /ws.
 *
 * Protocol (JSON text frames):
 *   client → {type:"auth", apiKey}                       must be the first frame (within WS_AUTH_TIMEOUT_MS)
 *   server → {type:"hello", snapshot, history, events, jobTypes, version}
 *   server → {type:"metrics", data: MetricsSnapshot}     every METRICS_INTERVAL_MS
 *   server → {type:"events", data: AetherEvent[], dropped}   batched every 100ms
 *   client → {type:"ping"}  /  server → {type:"pong"}
 *
 * Events are micro-batched so a burst of thousands of job transitions per second becomes ~10
 * frames per second, and clients with a backed-up socket are skipped rather than buffered forever.
 */
export class RealtimeServer {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private pending: AetherEvent[] = [];
  private dropped = 0;
  private flushTimer?: NodeJS.Timeout;
  private readonly pingTimer: NodeJS.Timeout;

  constructor(
    server: http.Server,
    private readonly sampler: MetricsSampler,
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.wss.on('error', (err) => logger.error({ err: err.message }, 'websocket server error'));

    this.pingTimer = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }, 30_000);
    this.pingTimer.unref();
  }

  get clientCount(): number {
    return [...this.clients].filter((c) => c.authed).length;
  }

  pushEvent(event: AetherEvent): void {
    if (this.clientCount === 0) return;
    if (this.pending.length >= MAX_PENDING) {
      this.pending.shift();
      this.dropped++;
    }
    this.pending.push(event);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  broadcastMetrics(snapshot: MetricsSnapshot): void {
    this.broadcast(JSON.stringify({ type: 'metrics', data: snapshot }));
  }

  async close(): Promise<void> {
    clearInterval(this.pingTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const c of this.clients) c.ws.close(1001, 'server shutting down');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private flush(): void {
    this.flushTimer = undefined;
    const batch = this.pending.splice(0);
    const dropped = this.dropped + Math.max(0, batch.length - MAX_EVENTS_PER_FLUSH);
    this.dropped = 0;
    if (batch.length === 0) return;
    this.broadcast(JSON.stringify({ type: 'events', data: batch.slice(-MAX_EVENTS_PER_FLUSH), dropped }));
  }

  private broadcast(frame: string): void {
    for (const c of this.clients) {
      if (!c.authed || c.ws.readyState !== WebSocket.OPEN) continue;
      if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) continue; // slow consumer: skip instead of buffering unboundedly
      c.ws.send(frame);
    }
  }

  private onConnection(ws: WebSocket): void {
    if (this.clients.size >= config.wsMaxClients) {
      ws.close(1013, 'too many connections');
      return;
    }
    const client: Client = { ws, authed: false, alive: true };
    this.clients.add(client);

    const authTimer = setTimeout(() => {
      if (!client.authed) ws.close(4001, 'authentication timeout');
    }, config.wsAuthTimeoutMs);

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(client);
    });
    ws.on('error', () => ws.terminate());

    ws.on('message', async (raw) => {
      let msg: { type?: string; apiKey?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return ws.close(1003, 'invalid JSON');
      }

      if (!client.authed) {
        if (msg.type === 'auth' && verifyApiKey(msg.apiKey)) {
          client.authed = true;
          clearTimeout(authTimer);
          try {
            const [snapshot, events] = await Promise.all([this.sampler.snapshotNow(), recentEvents(150)]);
            ws.send(
              JSON.stringify({
                type: 'hello',
                version: config.version,
                snapshot,
                history: this.sampler.history(),
                events,
                jobTypes: listHandlers(),
              }),
            );
          } catch (err) {
            logger.error({ err: (err as Error).message }, 'failed to build ws hello');
            ws.close(1011, 'server error');
          }
        } else {
          ws.close(4401, 'unauthorized');
        }
        return;
      }

      if (msg.type === 'ping') ws.send('{"type":"pong"}');
    });
  }
}
