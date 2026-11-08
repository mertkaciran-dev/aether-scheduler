import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from '../config';

interface Task {
  id: number;
  task: string;
  data: unknown;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer?: NodeJS.Timeout;
  abortCleanup?: () => void;
  failure?: Error;
}

interface Slot {
  worker: Worker;
  current?: Task;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Small worker_threads pool. Threads are spawned lazily up to `size`. A task that times out or is
 * aborted while running has its thread terminated (the only reliable way to stop CPU-bound JS)
 * and the pool transparently spawns a replacement for the next task.
 */
export class ThreadPool {
  private slots: Slot[] = [];
  private pending: Task[] = [];
  private nextId = 1;
  private closed = false;
  private readonly script: string;
  private readonly execArgv: string[];

  constructor(private readonly size: number) {
    const ext = path.extname(__filename); // '.ts' under tsx, '.js' when compiled
    this.script = path.join(__dirname, `task-runner${ext}`);
    this.execArgv = ext === '.ts' ? ['--import', 'tsx'] : [];
  }

  get stats(): { threads: number; busy: number; queued: number } {
    return {
      threads: this.slots.length,
      busy: this.slots.filter((s) => s.current).length,
      queued: this.pending.length,
    };
  }

  run<T = unknown>(task: string, data: unknown, opts: RunOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new Error('Thread pool is closed'));
      if (opts.signal?.aborted) return reject(toError(opts.signal.reason));

      const t: Task = { id: this.nextId++, task, data, resolve, reject };

      const onAbort = () => this.fail(t, toError(opts.signal?.reason));
      if (opts.signal) {
        opts.signal.addEventListener('abort', onAbort, { once: true });
        t.abortCleanup = () => opts.signal?.removeEventListener('abort', onAbort);
      }
      if (opts.timeoutMs) {
        t.timer = setTimeout(
          () => this.fail(t, new Error(`Thread task "${task}" timed out after ${opts.timeoutMs}ms`)),
          opts.timeoutMs,
        );
      }

      this.pending.push(t);
      this.pump();
    });
  }

  async destroy(): Promise<void> {
    this.closed = true;
    for (const t of this.pending.splice(0)) this.settle(t, () => t.reject(new Error('Thread pool is closed')));
    await Promise.allSettled(this.slots.splice(0).map((s) => s.worker.terminate()));
  }

  private pump(): void {
    while (this.pending.length > 0) {
      let slot = this.slots.find((s) => !s.current);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) return;
      const task = this.pending.shift()!;
      slot.current = task;
      slot.worker.postMessage({ id: task.id, task: task.task, data: task.data });
    }
  }

  private spawn(): Slot {
    const worker = new Worker(this.script, { execArgv: this.execArgv });
    const slot: Slot = { worker };

    worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const t = slot.current;
      if (!t || t.id !== msg.id) return;
      slot.current = undefined;
      this.settle(t, () => (msg.ok ? t.resolve(msg.result) : t.reject(new Error(msg.error ?? 'Thread task failed'))));
      this.pump();
    });

    const onGone = (err?: Error) => {
      const t = slot.current;
      slot.current = undefined;
      const i = this.slots.indexOf(slot);
      if (i >= 0) this.slots.splice(i, 1);
      if (t) this.settle(t, () => t.reject(t.failure ?? err ?? new Error('Worker thread exited unexpectedly')));
      if (!this.closed) this.pump();
    };
    worker.on('error', onGone);
    worker.on('exit', () => onGone());

    this.slots.push(slot);
    return slot;
  }

  /** Fail a task: dequeue it if waiting, or terminate its thread if running. */
  private fail(t: Task, error: Error): void {
    const qi = this.pending.indexOf(t);
    if (qi >= 0) {
      this.pending.splice(qi, 1);
      this.settle(t, () => t.reject(error));
      return;
    }
    const slot = this.slots.find((s) => s.current === t);
    if (slot) {
      t.failure = error;
      void slot.worker.terminate(); // 'exit' handler rejects the task and removes the slot
    }
  }

  private settle(t: Task, fn: () => void): void {
    if (t.timer) clearTimeout(t.timer);
    t.abortCleanup?.();
    fn();
  }
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'Aborted');
}

let pool: ThreadPool | undefined;

export function getPool(): ThreadPool {
  if (!pool) pool = new ThreadPool(config.threadPoolSize);
  return pool;
}

export async function destroyPool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.destroy();
  }
}
