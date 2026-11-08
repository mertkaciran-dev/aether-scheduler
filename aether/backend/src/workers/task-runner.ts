/**
 * Worker-thread entrypoint. CPU-bound work runs here so it never blocks the main
 * thread's event loop (which also owns BullMQ lock renewal and WebSocket delivery).
 */
import { parentPort } from 'node:worker_threads';

type TaskFn = (data: any) => unknown;

/** Sieve of Eratosthenes: number of primes <= limit. */
function primes({ limit }: { limit: number }): { count: number; largest: number } {
  const n = Math.floor(limit);
  if (!Number.isFinite(n) || n < 2) return { count: 0, largest: 0 };
  const composite = new Uint8Array(n + 1);
  let count = 0;
  let largest = 0;
  for (let i = 2; i <= n; i++) {
    if (composite[i] === 0) {
      count++;
      largest = i;
      for (let j = i * i; j <= n; j += i) composite[j] = 1;
    }
  }
  return { count, largest };
}

const tasks: Record<string, TaskFn> = { primes };

if (!parentPort) throw new Error('task-runner must be started as a worker thread');
const port = parentPort;

port.on('message', (msg: { id: number; task: string; data: unknown }) => {
  try {
    const fn = tasks[msg.task];
    if (!fn) throw new Error(`Unknown thread task "${msg.task}"`);
    port.postMessage({ id: msg.id, ok: true, result: fn(msg.data) });
  } catch (err) {
    port.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
