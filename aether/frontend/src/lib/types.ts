// Mirrors backend/src/types.ts (the wire format).

export type EventLevel = 'info' | 'success' | 'warn' | 'error';

export interface AetherEvent {
  id: string;
  ts: number;
  kind: string;
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
  queue: { waiting: number; active: number; delayed: number; retrying: number; completed: number; failed: number; paused: boolean };
  totals: {
    enqueued: number;
    completed: number;
    failedAttempts: number;
    retried: number;
    dead: number;
    webhooksDelivered: number;
    webhooksFailed: number;
  };
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

export interface JobType {
  type: string;
  description: string;
  example: Record<string, unknown>;
}

export interface RetryPolicy {
  attempts: number;
  strategy: 'exponential' | 'fixed';
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export interface Job {
  id: string;
  type: string;
  state: string;
  payload: Record<string, unknown>;
  progress: unknown;
  attemptsMade: number;
  maxAttempts: number;
  createdAt: number;
  scheduledFor: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  durationMs: number | null;
  returnValue: unknown;
  failedReason: string | null;
  source: string;
  schedulerId: string | null;
  replayedFrom: string | null;
  webhook: { url: string; events: string[] } | null;
  retry: RetryPolicy | null;
}

export interface Schedule {
  id: string;
  type: string;
  cron: string | null;
  tz: string | null;
  next: number | null;
  limit: number | null;
  iterationCount: number;
  payload: Record<string, unknown>;
  webhook: { url: string; events: string[] } | null;
}

export interface DlqEntry {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  webhook: { url: string; events: string[] } | null;
  meta: { source: string; createdAt: number; replayCount?: number; replayedFrom?: string; retry: RetryPolicy };
  error: { name: string; message: string; stack?: string };
  attemptsMade: number;
  failedAt: number;
  queuedAt: number;
  stacktrace: string[];
}

export interface AppInfo {
  version: string;
  role: string;
  env: string;
  features: { webhookSink: boolean; allowPrivateTargets: boolean; defaultWebhookSigning: boolean };
  defaults: { attempts: number; timeoutMs: number; webhookMaxAttempts: number };
  jobTypes: JobType[];
}
