/** Shared domain types. The frontend mirrors these in frontend/src/lib/types.ts. */

export type WebhookEvent = 'completed' | 'failed' | 'retrying';

export interface WebhookConfig {
  url: string;
  events: WebhookEvent[];
  /** HMAC-SHA256 signing secret. Never returned by the API. */
  secret?: string;
  /** Extra static headers (e.g. a bearer token for the receiver). Never returned by the API. */
  headers?: Record<string, string>;
}

export interface RetryPolicy {
  attempts: number;
  strategy: 'exponential' | 'fixed';
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

/** What is stored as BullMQ job data. */
export interface JobEnvelope {
  type: string;
  payload: Record<string, unknown>;
  webhook?: WebhookConfig;
  meta: {
    source: string;
    createdAt: number;
    retry: RetryPolicy;
    timeoutMs?: number;
    schedulerId?: string;
    replayedFrom?: string;
    replayCount?: number;
  };
}

export type EventKind =
  | 'job.queued'
  | 'job.scheduled'
  | 'job.active'
  | 'job.completed'
  | 'job.retrying'
  | 'job.dead'
  | 'job.stalled'
  | 'job.replayed'
  | 'job.removed'
  | 'schedule.created'
  | 'schedule.removed'
  | 'queue.paused'
  | 'queue.resumed'
  | 'queue.cleaned'
  | 'dlq.cleared'
  | 'webhook.delivered'
  | 'webhook.failed'
  | 'webhook.received'
  | 'worker.online'
  | 'worker.offline';

export type EventLevel = 'info' | 'success' | 'warn' | 'error';

export interface AetherEvent {
  id: string;
  ts: number;
  kind: EventKind;
  level: EventLevel;
  message: string;
  jobId?: string;
  jobType?: string;
  data?: Record<string, unknown>;
}

export interface WorkerInfo {
  id: string;
  host: string;
  pid: number;
  concurrency: number;
  active: number;
  processed: number;
  failed: number;
  startedAt: number;
  lastSeen: number;
  version: string;
}

export interface MetricsSnapshot {
  ts: number;
  queue: {
    waiting: number;
    active: number;
    /** Scheduled-in-the-future jobs, excluding those waiting on a retry backoff. */
    delayed: number;
    retrying: number;
    /** Lifetime completed count. */
    completed: number;
    /** Current dead-letter queue size. */
    failed: number;
    paused: boolean;
  };
  totals: {
    enqueued: number;
    completed: number;
    failedAttempts: number;
    retried: number;
    dead: number;
    webhooksDelivered: number;
    webhooksFailed: number;
  };
  /** Per-second rates derived from lifetime counter deltas. */
  rates: { enqueued: number; completed: number; failed: number };
  schedules: number;
  workers: WorkerInfo[];
}

export interface MetricsSample {
  ts: number;
  waiting: number;
  active: number;
  delayed: number;
  retrying: number;
  failed: number;
  completedRate: number;
  failedRate: number;
  enqueuedRate: number;
}

export interface DlqEntry {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  webhook?: WebhookConfig;
  meta: JobEnvelope['meta'];
  opts: { attempts: number; priority?: number; backoff?: unknown };
  error: { name: string; message: string; stack?: string };
  attemptsMade: number;
  failedAt: number;
  queuedAt: number;
  stacktrace: string[];
}
