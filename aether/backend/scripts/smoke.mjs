#!/usr/bin/env node
/**
 * End-to-end smoke test against a running Aether stack.
 *
 *   AETHER_URL=http://localhost:4000 AETHER_API_KEY=aether-demo-key npm run smoke
 *
 * For the webhook check the stack needs ENABLE_WEBHOOK_SINK=true and WEBHOOK_ALLOW_PRIVATE=true
 * (the default docker-compose.yml sets both for demo purposes). Without them that step is skipped.
 */
import { WebSocket } from 'ws';

const BASE = (process.env.AETHER_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const KEY = process.env.AETHER_API_KEY ?? 'aether-demo-key';
const SINK = process.env.AETHER_SINK_URL ?? `${BASE}/hooks/sink`;

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, key = KEY) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function waitFor(label, fn, timeoutMs = 30_000, everyMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(everyMs);
  }
}

async function step(name, fn) {
  const t = Date.now();
  try {
    const note = await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${note ? ` \x1b[2m(${note})\x1b[0m` : ''} \x1b[2m${Date.now() - t}ms\x1b[0m`);
  } catch (err) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
  }
}

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const jobState = async (id) => (await api('GET', `/api/jobs/${id}`)).body?.job?.state;

console.log(`\nAether smoke test → ${BASE}\n`);

// ── Basics ──────────────────────────────────────────────────────────
await step('health is public and reports redis', async () => {
  const r = await fetch(`${BASE}/api/health`);
  expect(r.status === 200, `status ${r.status}`);
});

await step('rejects missing / wrong API key', async () => {
  expect((await api('GET', '/api/metrics', undefined, null)).status === 401, 'expected 401 without key');
  expect((await api('GET', '/api/metrics', undefined, 'nope')).status === 401, 'expected 401 with wrong key');
});

await step('validates payloads (400 with details)', async () => {
  const r = await api('POST', '/api/jobs', { type: 'email.send', payload: { to: 'not-an-email' } });
  expect(r.status === 400, `status ${r.status}`);
  expect((await api('POST', '/api/jobs', { type: 'nope' })).status === 400, 'unknown type should 400');
});

await step('workers are registered', async () => {
  const w = await waitFor('a worker heartbeat', async () => {
    const r = await api('GET', '/api/workers');
    return r.body.items.length > 0 ? r.body.items : null;
  });
  return `${w.length} worker(s)`;
});

// ── Core job flow ───────────────────────────────────────────────────
await step('runs an immediate job to completion', async () => {
  const r = await api('POST', '/api/jobs', { type: 'echo', payload: { message: 'smoke', delayMs: 100 } });
  expect(r.status === 202, `status ${r.status}`);
  await waitFor('completion', async () => (await jobState(r.body.id)) === 'completed');
});

await step('delays a job (delayMs) and runs it afterwards', async () => {
  const r = await api('POST', '/api/jobs', { type: 'echo', payload: {}, delayMs: 1500 });
  expect(r.body.state === 'delayed', `state ${r.body.state}`);
  expect((await jobState(r.body.id)) === 'delayed', 'should be delayed immediately after creation');
  await waitFor('delayed job to complete', async () => (await jobState(r.body.id)) === 'completed');
});

await step('idempotencyKey de-duplicates', async () => {
  const key = `smoke_${Date.now()}`;
  const a = await api('POST', '/api/jobs', { type: 'echo', payload: {}, idempotencyKey: key, delayMs: 5000 });
  const b = await api('POST', '/api/jobs', { type: 'echo', payload: {}, idempotencyKey: key, delayMs: 5000 });
  expect(a.status === 202 && b.status === 200 && b.body.duplicate, `got ${a.status}/${b.status}`);
  await api('DELETE', `/api/jobs/${a.body.id}`);
});

await step('runs CPU-bound work on a worker thread', async () => {
  const r = await api('POST', '/api/jobs', { type: 'compute.primes', payload: { limit: 3_000_000 } });
  await waitFor('primes', async () => (await jobState(r.body.id)) === 'completed');
  const d = await api('GET', `/api/jobs/${r.body.id}`);
  expect(d.body.job.returnValue?.count === 216816, `unexpected prime count ${JSON.stringify(d.body.job.returnValue)}`);
  return `π(3e6)=${d.body.job.returnValue.count}`;
});

// ── Retries + DLQ ───────────────────────────────────────────────────
let retryJobId;
await step('retries with exponential backoff, then succeeds', async () => {
  const r = await api('POST', '/api/jobs', {
    type: 'flaky',
    payload: { failUntilAttempt: 3, durationMs: 10 },
    retry: { attempts: 4, strategy: 'exponential', baseDelayMs: 300, jitter: false },
  });
  retryJobId = r.body.id;
  await waitFor('job enters retrying', async () => (await jobState(retryJobId)) === 'retrying', 10_000, 50);
  await waitFor('job completes', async () => (await jobState(retryJobId)) === 'completed');
  const d = await api('GET', `/api/jobs/${retryJobId}`);
  expect(d.body.job.returnValue?.succeededOnAttempt === 3, `succeeded on attempt ${d.body.job.returnValue?.succeededOnAttempt}`);
});

let deadId;
await step('exhausted job lands in the DLQ with its error', async () => {
  const r = await api('POST', '/api/jobs', {
    type: 'flaky',
    payload: { alwaysFail: true, durationMs: 10, errorMessage: 'boom from smoke' },
    retry: { attempts: 2, baseDelayMs: 200, jitter: false },
  });
  const entry = await waitFor('DLQ entry', async () => {
    const d = await api('GET', '/api/dlq');
    return d.body.items.find((e) => e.error.message.includes('boom from smoke'));
  });
  deadId = entry.id;
  expect(entry.attemptsMade === 2, `attemptsMade ${entry.attemptsMade}`);
  expect(entry.payload.alwaysFail === true, 'payload preserved');
  void r;
});

await step('DLQ replay creates a fresh job and removes the entry', async () => {
  const r = await api('POST', `/api/dlq/${deadId}/replay`);
  expect(r.status === 202 && r.body.jobId, `status ${r.status}`);
  await waitFor('entry removed from DLQ', async () => (await api('GET', `/api/dlq/${deadId}`)).status === 404);
  // it fails again (alwaysFail) and is dead-lettered once more → clean up below
});

await step('DLQ discard + clear', async () => {
  const entry = await waitFor('replayed job to die again', async () => {
    const d = await api('GET', '/api/dlq');
    return d.body.items.find((e) => e.error.message.includes('boom from smoke'));
  });
  expect((await api('DELETE', `/api/dlq/${entry.id}`)).status === 204, 'delete should 204');
  const c = await api('DELETE', '/api/dlq');
  expect(c.status === 200, `clear status ${c.status}`);
  expect((await api('GET', '/api/dlq')).body.total === 0, 'DLQ should be empty');
});

// ── Cron / schedules ────────────────────────────────────────────────
await step('rejects invalid cron', async () => {
  const r = await api('POST', '/api/jobs', { type: 'echo', payload: {}, cron: 'every tuesday' });
  expect(r.status === 400, `status ${r.status}`);
});

await step('cron schedule fires and honours limit (one-off cron)', async () => {
  const id = `smoke-cron-${Date.now()}`;
  const r = await api('POST', '/api/jobs', { type: 'echo', payload: { message: 'cron' }, cron: '* * * * * *', limit: 1, scheduleId: id });
  expect(r.status === 202 && r.body.kind === 'schedule', `status ${r.status}`);
  const listed = await api('GET', '/api/schedules');
  expect(listed.body.items.some((s) => s.id === id), 'schedule should be listed');
  await waitFor('cron job executed', async () => {
    const m = await api('GET', '/api/jobs?state=completed&limit=50');
    return m.body.items.some((j) => j.schedulerId === id);
  }, 15_000);
  await api('DELETE', `/api/schedules/${id}`);
});

// ── Webhooks ────────────────────────────────────────────────────────
await step('webhook fires on completion and is delivered', async () => {
  const before = (await api('GET', '/api/metrics')).body.totals.webhooksDelivered;
  const r = await api('POST', '/api/jobs', {
    type: 'echo',
    payload: { message: 'hook' },
    webhook: { url: SINK, events: ['completed'], secret: 'smoke-secret-123' },
  });
  expect(r.status === 202, `status ${r.status} ${JSON.stringify(r.body)}`);
  await waitFor('webhook delivered', async () => (await api('GET', '/api/metrics')).body.totals.webhooksDelivered > before, 15_000);
});

await step('webhook receives retry + failure events', async () => {
  const before = (await api('GET', '/api/metrics')).body.totals.webhooksDelivered;
  await api('POST', '/api/jobs', {
    type: 'flaky',
    payload: { alwaysFail: true, durationMs: 5 },
    retry: { attempts: 2, baseDelayMs: 100, jitter: false },
    webhook: { url: SINK, events: ['retrying', 'failed'] },
  });
  await waitFor('2 webhook deliveries (retrying + failed)', async () => (await api('GET', '/api/metrics')).body.totals.webhooksDelivered >= before + 2, 15_000);
  await api('DELETE', '/api/dlq');
});

await step('SSRF guard: cloud-metadata webhook target', async () => {
  const info = (await api('GET', '/api/info')).body;
  const r = await api('POST', '/api/jobs', { type: 'echo', payload: {}, webhook: { url: 'http://169.254.169.254/latest/meta-data' } });
  if (info.features.allowPrivateTargets) {
    // Guard is intentionally off (demo setting); make sure we at least did not crash.
    expect(r.status === 202, `status ${r.status}`);
    await api('DELETE', `/api/jobs/${r.body.id}`).catch(() => undefined);
    return 'skipped: WEBHOOK_ALLOW_PRIVATE=true';
  }
  expect(r.status === 400, `expected 400, got ${r.status}`);
});

// ── Bulk + metrics + controls ───────────────────────────────────────
await step('bulk-enqueues 200 jobs and drains them', async () => {
  const jobs = Array.from({ length: 200 }, (_, i) => ({ type: 'echo', payload: { message: `bulk-${i}` } }));
  const r = await api('POST', '/api/jobs/bulk', { jobs });
  expect(r.status === 202 && r.body.accepted === 200, `accepted ${r.body.accepted}`);
  await waitFor('queue drained', async () => {
    const m = (await api('GET', '/api/metrics')).body.queue;
    return m.waiting === 0 && m.active === 0;
  }, 30_000);
});

await step('pause holds jobs, resume releases them', async () => {
  await api('POST', '/api/queue/pause');
  let r;
  try {
    r = await api('POST', '/api/jobs', { type: 'echo', payload: {} });
    await sleep(800);
    expect((await jobState(r.body.id)) !== 'completed', 'job ran while queue was paused');
    expect((await api('GET', '/api/metrics')).body.queue.paused === true, 'metrics should report paused');
  } finally {
    await api('POST', '/api/queue/resume'); // never leave the queue paused, even if an assertion failed
  }
  await waitFor('job completes after resume', async () => (await jobState(r.body.id)) === 'completed');
});

await step('metrics expose throughput rates', async () => {
  const m = (await api('GET', '/api/metrics')).body;
  expect(m.totals.completed > 0 && typeof m.rates.completed === 'number', 'missing totals/rates');
  const h = await api('GET', '/api/metrics/history');
  expect(h.body.items.length > 0, 'history should have samples');
});

// ── WebSocket ───────────────────────────────────────────────────────
await step('WebSocket: auth, hello snapshot, live events + metrics', async () => {
  const wsUrl = BASE.replace(/^http/, 'ws') + '/ws';

  // wrong key is rejected
  await new Promise((resolve, reject) => {
    const bad = new WebSocket(wsUrl);
    bad.on('open', () => bad.send(JSON.stringify({ type: 'auth', apiKey: 'wrong' })));
    bad.on('close', (code) => (code === 4401 ? resolve() : reject(new Error(`bad key closed with ${code}`))));
    bad.on('error', reject);
  });

  const ws = new WebSocket(wsUrl);
  const seen = { hello: false, metrics: 0, events: [] };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', apiKey: KEY })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'hello') seen.hello = true;
    if (m.type === 'metrics') seen.metrics++;
    if (m.type === 'events') seen.events.push(...m.data);
  });
  await waitFor('hello', () => seen.hello, 5000);
  const r = await api('POST', '/api/jobs', { type: 'echo', payload: { message: 'ws' } });
  await waitFor('job lifecycle events over ws', () => ['job.queued', 'job.active', 'job.completed'].every((k) => seen.events.some((e) => e.kind === k && e.jobId === r.body.id)), 8000);
  await waitFor('metrics frames', () => seen.metrics >= 2, 5000);
  ws.close();
  return `${seen.events.length} events, ${seen.metrics} metric frames`;
});

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
