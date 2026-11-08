# Aether ⚡

**A distributed, event-driven task scheduler and queue-monitoring dashboard for high-throughput background jobs.**

Aether runs on **Node.js (TypeScript / Express)**, **BullMQ + Redis**, and **WebSockets**, with a **React (Vite) + Tailwind + Lucide** dashboard. It schedules delayed and cron jobs, retries failures with exponential backoff, parks exhausted jobs in a dead-letter queue (DLQ) you can inspect and replay, and calls your webhooks when jobs finish, fail, or retry. Everything shows up live in the dashboard.

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Job lifecycle, retries and the DLQ](#job-lifecycle-retries-and-the-dlq)
- [REST API](#rest-api)
- [Webhooks](#webhooks)
- [WebSocket protocol](#websocket-protocol)
- [Configuration](#configuration)
- [Built-in job types / adding your own](#job-types)
- [Scaling and operations](#scaling-and-operations)
- [Security model](#security-model)
- [Development and testing](#development-and-testing)
- [Project layout](#project-layout)

---

## Quick start

```bash
docker compose up --build
```

Open **http://localhost:8080** and sign in with the API key `aether-demo-key`. Click **New job**, or run the load generator from the API section below.

Before exposing it anywhere, copy `.env.example` to `.env` and set a real `AETHER_API_KEY`. Also set `ENABLE_WEBHOOK_SINK=false` and `WEBHOOK_ALLOW_PRIVATE=false`. The compose file defaults both to `true` so webhooks can be tried against the built-in test sink on a first run.

| Service    | Image               | Purpose                                                            |
| ---------- | ------------------- | ------------------------------------------------------------------ |
| `redis`    | `redis:7-alpine`    | Queue storage, DLQ, counters, pub/sub. AOF persistence is enabled. |
| `backend`  | `./backend`         | REST API, WebSocket server, job workers, webhook dispatcher.       |
| `frontend` | `./frontend` (nginx)| Serves the SPA and reverse-proxies `/api`, `/ws`, `/hooks`.        |

Without Docker (Node 20+ and a local Redis):

```bash
cd backend  && npm install && REDIS_URL=redis://localhost:6379 npm run dev   # :4000
cd frontend && npm install && npm run dev                                    # :5173, proxies to :4000
```

---

## Architecture

```
                       ┌──────────────── Browser (React SPA) ────────────────┐
                       │  REST (X-API-Key)             WebSocket /ws         │
                       └──────────┬──────────────────────────▲───────────────┘
                                  │ via nginx                │ metrics + batched events
┌─────────────────────────────────▼──────────────────────────┴───────────────────────┐
│ Aether process  (ROLE = all | api | worker)                                        │
│                                                                                    │
│  API role                                       Worker role                        │
│  ┌──────────────┐  ┌────────────────────┐       ┌───────────────────────────────┐  │
│  │ Express      │  │ RealtimeServer     │       │ BullMQ Worker (concurrency N) │  │
│  │ auth · zod   │  │ ws · micro-batching│       │  └ processor → job handlers   │  │
│  │ rate limit   │  │ backpressure       │       │       └ ThreadPool (CPU tasks)│  │
│  └──────┬───────┘  └─────────▲──────────┘       │ Webhook Worker (own queue)    │  │
│         │ enqueue            │ subscribe        └───────┬───────────────────────┘  │
│  MetricsSampler ─────────────┘                          │ events, DLQ writes       │
└─────────┼───────────────────────────────────────────────┼──────────────────────────┘
          │                                               │
┌─────────▼───────────────────────────────────────────────▼──────────────────────────┐
│ Redis                                                                              │
│  BullMQ keys (wait · delayed · active · schedulers)   aether:dlq:*  aether:stats   │
│  aether:events (pub/sub + capped history)             aether:workers (heartbeats)  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### Design decisions

- **Redis is the only shared state.** API and worker processes share nothing in memory. Any number of workers on any number of machines feed the same dashboard.
- **Event bus on Redis pub/sub.** Every state change is published once. Each API process subscribes and fans the events out to its own WebSocket clients, so a worker on host B shows up live in a dashboard served by host A. A capped Redis list keeps recent history so a freshly opened dashboard has context.
- **Event-driven bookkeeping.** Retry counts, DLQ writes and webhook triggers are driven from BullMQ worker events, which fire after the state transition is committed. This keeps handler code free of infrastructure concerns.
- **Worker threads for CPU-bound work.** Heavy synchronous code (see `compute.primes`) runs in a `worker_threads` pool. This keeps the main thread free to renew BullMQ locks and serve WebSockets. Runaway tasks are killed by terminating their thread, and the pool respawns a replacement.
- **Micro-batched WebSocket delivery.** Thousands of job transitions per second collapse into about 10 frames per second. Clients with a backed-up socket are skipped instead of buffered, and the UI shows a counter when events were dropped.
- **Separate webhook queue.** Deliveries get independent retries with exponential backoff, so a slow receiver can never delay job processing.

---

## Job lifecycle, retries and the DLQ

```
 POST /api/jobs ─► waiting ─► active ─┬─► completed ──► (webhook: job.completed)
                      ▲   delayed     │
                      │      ▲        └─► failed attempt
              (delayMs / runAt / cron)        │
                                    attempts left? ── yes ─► retrying (delayed by backoff) ─► active …
                                              │                 (webhook: job.retrying)
                                              no
                                              ▼
                                   Dead-letter queue ──► replay (new job, fresh attempts)
                                   (webhook: job.failed)   or discard
```

**Scheduling** (mutually exclusive):

| Field                     | Behaviour                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------- |
| *(none)*                  | Run immediately.                                                                        |
| `delayMs`                 | Run after N milliseconds (max 30 days).                                                 |
| `runAt`                   | Run at an ISO-8601 timestamp (with offset).                                             |
| `cron` (+ `tz`, `limit`)  | Recurring. 5 fields, or 6 with a leading seconds field. `limit: 1` makes a one-off cron task. |

Cron schedules are idempotent upserts. Re-posting the same `scheduleId` updates the schedule instead of duplicating it.

**Retry policy** (per job, `retry` object):

| Field         | Default       | Meaning                                              |
| ------------- | ------------- | ---------------------------------------------------- |
| `attempts`    | `3`           | Total tries, including the first (1–50).             |
| `strategy`    | `exponential` | `exponential` (`base × 2^(n-1)`) or `fixed`.         |
| `baseDelayMs` | `1000`        | First retry delay.                                   |
| `maxDelayMs`  | `300000`      | Hard cap on any delay.                               |
| `jitter`      | `true`        | Multiplies the delay by a random 0.8–1.2 so simultaneous failures don't retry in lock-step. |

With `base=400ms`, no jitter, 5 attempts, the observed delays between attempts are 400ms → 800ms → 1.6s → 3.2s, then the job is dead-lettered. Jobs that throw `UnrecoverableError`, such as an unknown job type or a blocked network target, skip retries and go straight to the DLQ.

**Dead-letter queue.** When a job exhausts its attempts, a full snapshot is stored: payload, retry policy, error and stack traces per attempt. From the dashboard (or API) you can inspect it, **replay** it, or **discard** it. A replay creates a *new* job with a fresh attempt budget and removes the DLQ entry. The order is add-then-delete, so a crash in between can duplicate a job but never lose one. The DLQ is capped at `DLQ_MAX_SIZE` entries, and the oldest are evicted first.

**Delivery semantics.** BullMQ gives at-least-once execution. If a worker dies mid-job, the job's lock expires, the job is returned to the queue (`job.stalled` event), and it runs again. **Make handlers idempotent**, and use `idempotencyKey` to de-duplicate *submissions*.

---

## REST API

Base path `/api`. All endpoints except `/api/health` require an API key sent as either header:

```
X-API-Key: <key>
Authorization: Bearer <key>
```

Errors share one shape, `{ "error": { "code", "message", "details?" } }`, with codes `unauthorized` (401), `validation_error` / `bad_request` / `invalid_json` (400), `not_found` (404), `conflict` (409), `payload_too_large` (413), `rate_limited` (429), `internal_error` (500).

### Jobs

#### `POST /api/jobs` — create a job or schedule

```jsonc
{
  "type": "email.send",                       // required — see GET /api/job-types
  "payload": { "to": "ada@example.com" },     // validated against the job type's schema

  // when (optional, mutually exclusive)
  "delayMs": 30000,
  "runAt": "2026-12-01T09:00:00+03:00",
  "cron": "*/5 * * * *", "tz": "Europe/Istanbul", "limit": 10, "scheduleId": "welcome-emails",

  "priority": 1,                              // 1 = highest
  "timeoutMs": 30000,                         // per-attempt timeout (default DEFAULT_TIMEOUT_MS)
  "idempotencyKey": "order-8841-confirmation",// de-duplicates one-off jobs

  "retry": { "attempts": 5, "strategy": "exponential", "baseDelayMs": 1000, "maxDelayMs": 60000, "jitter": true },
  "webhook": {
    "url": "https://example.com/hooks/aether",
    "events": ["completed", "failed", "retrying"],
    "secret": "at-least-8-chars",             // optional HMAC signing secret
    "headers": { "Authorization": "Bearer receiver-token" }
  }
}
```

| Response | Body                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| `202`    | `{ "kind":"job", "id":"42", "type":"echo", "state":"waiting"\|"delayed", "scheduledFor":null\|ISO, "duplicate":false }` |
| `202`    | Cron: `{ "kind":"schedule", "id":"welcome-emails", "cron":"…", "tz":null, "limit":null, "next":"ISO" }` |
| `200`    | Same as the first body with `"duplicate": true` when `idempotencyKey` matched an existing job. |
| `400`    | Validation failure, bad cron, unknown type, or unsafe webhook URL.                |

```bash
curl -X POST http://localhost:8080/api/jobs \
  -H "X-API-Key: aether-demo-key" -H "Content-Type: application/json" \
  -d '{"type":"flaky","payload":{"failUntilAttempt":3},"retry":{"attempts":4,"baseDelayMs":500}}'
```

#### Other job endpoints

| Method & path             | Description                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/jobs/bulk`     | `{ "jobs": [ …up to 500 create-job bodies ] }` → `202 { accepted, rejected, results[] }` (per-item success or error). |
| `GET /api/jobs`           | Query `state` = `waiting` \| `active` \| `delayed` \| `retrying` \| `completed`, `page`, `limit` (≤200). → `{ state, page, limit, total, items[] }` |
| `GET /api/jobs/:id`       | `{ job, logs[] }`. Falls back to the DLQ for dead jobs (`state: "dead"`).                |
| `DELETE /api/jobs/:id`    | `204`. `409` if the job is currently being processed.                                    |
| `GET /api/job-types`      | Registered handlers with description and example payload.                                |

### Schedules

| Method & path                | Description                                                                |
| ---------------------------- | -------------------------------------------------------------------------- |
| `GET /api/schedules`         | `{ items: [{ id, type, cron, tz, next, limit, iterationCount, payload, webhook }] }` |
| `DELETE /api/schedules/:id`  | `204`. Already-queued runs are not cancelled.                              |

### Dead-letter queue

| Method & path                | Description                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/dlq`               | Query `page`, `limit`, `type`, `q` (matches error message or id). → `{ total, items[] }` with payload, error, attempts, stack traces. |
| `GET /api/dlq/:id`           | One entry.                                                                            |
| `POST /api/dlq/:id/replay`   | `202 { replayed: true, jobId }`. Fresh attempt budget.                                |
| `POST /api/dlq/replay-all`   | `{ replayed, failed }`. Replays up to 1000 entries.                                   |
| `DELETE /api/dlq/:id`        | `204` discard one.                                                                    |
| `DELETE /api/dlq`            | `{ cleared }` discard everything.                                                     |

### Queue, metrics and system

| Method & path                | Description                                                                 |
| ---------------------------- | --------------------------------------------------------------------------- |
| `POST /api/queue/pause`      | Stop taking new jobs. In-flight jobs finish.                                |
| `POST /api/queue/resume`     |                                                                             |
| `POST /api/queue/clean`      | `{ "state": "completed"\|"delayed"\|"waiting", "graceMs": 0 }` → `{ removed }` |
| `POST /api/queue/drain`      | Remove all waiting and delayed jobs (active jobs untouched).                |
| `GET /api/metrics`           | Snapshot: `queue` (waiting, active, delayed, retrying, completed, failed=DLQ size, paused), lifetime `totals`, per-second `rates`, `schedules`, `workers[]`. |
| `GET /api/metrics/history`   | Last ~180 samples (one per `METRICS_INTERVAL_MS`) used by the charts.       |
| `GET /api/workers`           | Live workers (heartbeat within 3 × `WORKER_HEARTBEAT_MS`).                  |
| `GET /api/events?limit=100`  | Recent event log, oldest first.                                             |
| `GET /api/info`              | Version, role, feature flags, defaults, job types.                          |
| `POST /api/webhooks/test`    | `{ url, secret? }` → sends a signed `webhook.test` through the real dispatcher. |
| `GET /api/health`            | **Unauthenticated.** `{ status, redisMs, role, version, uptime }`, `503` if Redis is down. |

Metric semantics: `delayed` counts jobs scheduled for the future and excludes ones waiting on a retry backoff, which are reported as `retrying`. `completed` is a lifetime counter and `failed` is the current DLQ size.

---

## Webhooks

Configure a webhook on any job (`webhook` object). Aether calls it from a dedicated queue with exponential backoff, up to `WEBHOOK_MAX_ATTEMPTS` tries. Any 2xx response counts as success. Redirects are not followed.

**Request:** `POST`, `Content-Type: application/json`

| Header                 | Value                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| `X-Aether-Event`       | `job.completed` \| `job.failed` \| `job.retrying` \| `webhook.test` |
| `X-Aether-Delivery`    | Unique delivery id (use it to de-duplicate).                       |
| `X-Aether-Timestamp`   | Unix seconds when the delivery was signed.                         |
| `X-Aether-Signature`   | `sha256=<hex>`, present when a `secret` is set (per job or `WEBHOOK_SIGNING_SECRET`). |

**Body examples**

```jsonc
// job.completed
{ "event": "job.completed", "deliveryId": "…", "timestamp": "2026-11-08T10:00:00.000Z",
  "job": { "id": "42", "type": "email.send", "attempts": 2, "durationMs": 183,
           "queuedAt": "…", "finishedAt": "…" },
  "result": { "messageId": "<…@aether.local>", "accepted": ["ada@example.com"] } }

// job.retrying
{ "event": "job.retrying", …, "job": { "id": "42", "type": "…", "attempts": 1, "maxAttempts": 5, "queuedAt": "…" },
  "error": { "name": "Error", "message": "SMTP 451…" }, "nextRetryInMs": 2000 }

// job.failed  (retries exhausted, job is in the DLQ)
{ "event": "job.failed", …, "job": { … }, "error": { "name": "Error", "message": "…" } }
```

**Verifying signatures.** The signature is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`. Verify it against the **raw** body bytes and reject old timestamps:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, rawBody, headers) {
  const ts = headers['x-aether-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;          // replay window
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const given = headers['x-aether-signature'] ?? '';
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

**Testing locally.** With `ENABLE_WEBHOOK_SINK=true`, `POST /hooks/sink` accepts any JSON and reports it in the live event stream. The job composer has a one-click "Use built-in test sink" link.

---

## WebSocket protocol

Endpoint `/ws` (JSON text frames). Authenticate within `WS_AUTH_TIMEOUT_MS`, or the server closes the socket with code `4001`. A bad key closes with `4401`.

| Direction        | Frame                                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| client → server  | `{ "type": "auth", "apiKey": "…" }` (must be the first frame)                    |
| server → client  | `{ "type": "hello", snapshot, history, events, jobTypes, version }`              |
| server → client  | `{ "type": "metrics", "data": MetricsSnapshot }` every `METRICS_INTERVAL_MS`     |
| server → client  | `{ "type": "events", "data": AetherEvent[], "dropped": n }` batched every 100 ms |
| client ↔ server  | `{ "type": "ping" }` ↔ `{ "type": "pong" }`                                      |

Event kinds: `job.queued|scheduled|active|completed|retrying|dead|stalled|replayed|removed`, `schedule.created|removed`, `queue.paused|resumed|cleaned`, `dlq.cleared`, `webhook.delivered|failed|received`, `worker.online|offline`. Each event carries `level` (`info|success|warn|error`), which drives the colour-coded badges.

The browser client (`frontend/src/lib/useAether.ts`) reconnects with capped exponential backoff.

---

## Configuration

All configuration is via environment variables. Invalid values fail fast at startup.

### Core

| Variable          | Default                  | Description                                                              |
| ----------------- | ------------------------ | ------------------------------------------------------------------------ |
| `ROLE`            | `all`                    | `all`, `api` (HTTP + WS only) or `worker` (processing only).             |
| `PORT` / `HOST`   | `4000` / `0.0.0.0`       | Listen address (API role).                                               |
| `REDIS_URL`       | `redis://127.0.0.1:6379` | Redis connection string (`rediss://` for TLS).                           |
| `QUEUE_PREFIX`    | `aether`                 | Redis key prefix, so several environments can share one Redis.           |
| `API_KEYS`        | *(demo key)*             | Comma-separated valid keys. **If unset, `aether-demo-key` is accepted and a warning is logged.** |
| `LOG_LEVEL`       | `info`                   | `fatal` … `trace` (pino JSON logs).                                      |
| `NODE_ENV`        | `development`            |                                                                          |

### Queue and workers

| Variable                   | Default      | Description                                                    |
| -------------------------- | ------------ | -------------------------------------------------------------- |
| `WORKER_CONCURRENCY`       | `10`         | Jobs processed in parallel per process.                        |
| `THREAD_POOL_SIZE`         | `min(4,CPUs)`| Worker threads for CPU-bound handlers.                         |
| `DEFAULT_ATTEMPTS`         | `3`          | Attempts when a job doesn't specify `retry.attempts`.          |
| `DEFAULT_TIMEOUT_MS`       | `30000`      | Per-attempt timeout when the job doesn't specify `timeoutMs`.  |
| `KEEP_COMPLETED_COUNT`     | `1000`       | Completed jobs retained in Redis (count cap).                  |
| `KEEP_COMPLETED_AGE_SEC`   | `86400`      | Completed jobs retained (age cap).                             |
| `DLQ_MAX_SIZE`             | `10000`      | Oldest DLQ entries are evicted beyond this.                    |
| `WORKER_HEARTBEAT_MS`      | `5000`       | Worker liveness reporting interval.                            |
| `SHUTDOWN_TIMEOUT_MS`      | `15000`      | Max time to drain in-flight jobs on SIGTERM before forcing exit. |

### Real-time and API

| Variable               | Default                                  | Description                                          |
| ---------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `METRICS_INTERVAL_MS`  | `1000`                                   | Metrics sampling / push cadence.                     |
| `EVENT_LOG_SIZE`       | `500`                                    | Recent events kept in Redis for new dashboards.      |
| `WS_MAX_CLIENTS`       | `200`                                    | Max concurrent dashboard sockets per API process.    |
| `WS_AUTH_TIMEOUT_MS`   | `5000`                                   | Time allowed to send the `auth` frame.               |
| `RATE_LIMIT_PER_MIN`   | `600`                                    | Per-IP request limit on `/api`.                      |
| `CORS_ORIGINS`         | *(none)*                                 | Comma-separated origins. Unneeded behind the bundled nginx (same origin). |
| `TRUST_PROXY`          | `loopback,linklocal,uniquelocal`         | Express `trust proxy` (so rate limiting sees real client IPs). |

### Webhooks

| Variable                  | Default | Description                                                                      |
| ------------------------- | ------- | -------------------------------------------------------------------------------- |
| `WEBHOOK_TIMEOUT_MS`      | `10000` | Per-delivery timeout.                                                            |
| `WEBHOOK_MAX_ATTEMPTS`    | `5`     | Delivery attempts (exponential backoff, 2 s base).                               |
| `WEBHOOK_SIGNING_SECRET`  | *(none)*| Default HMAC secret for webhooks that don't set their own.                       |
| `WEBHOOK_ALLOW_PRIVATE`   | `false` | Allow webhooks and `http.request` jobs to reach private / loopback / link-local addresses. **Keep `false` on any shared or internet-facing deployment.** |
| `ENABLE_WEBHOOK_SINK`     | `false` | Expose the unauthenticated `POST /hooks/sink` test receiver.                     |

### Docker Compose (`.env`)

`AETHER_API_KEY`, `AETHER_PORT` (default `8080`), `WORKER_CONCURRENCY`, `THREAD_POOL_SIZE`, `LOG_LEVEL`, `ENABLE_WEBHOOK_SINK`, `WEBHOOK_ALLOW_PRIVATE`. See `.env.example`.

---

## Job types

Handlers live in `backend/src/queue/handlers/index.ts`. Each declares a zod payload schema, which is enforced **at enqueue time** so bad jobs get a `400` instead of burning retries.

| Type              | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `echo`            | Returns its message after an optional delay. Useful for smoke tests.          |
| `http.request`    | Calls a URL through the SSRF-guarded client. Non-2xx fails the attempt.       |
| `email.send`      | Simulated email with a configurable `failRate`.                               |
| `report.generate` | Simulated multi-stage build that reports progress and logs.                   |
| `compute.primes`  | CPU-bound prime counting on a **worker thread**.                              |
| `flaky`           | Chaos job: `failUntilAttempt`, `failRate`, `alwaysFail`. For demoing retries and the DLQ. |

**Add your own:**

```ts
// backend/src/queue/handlers/index.ts
const resizeImage: JobHandler<{ url: string; width: number }> = {
  type: 'image.resize',
  description: 'Resizes an image',
  schema: z.object({ url: z.string().url(), width: z.number().int().min(1).max(8000) }),
  example: { url: 'https://example.com/a.png', width: 640 },
  async run(payload, ctx) {
    ctx.signal;                       // aborted on timeout — pass it to fetch()/sleep()
    await ctx.progress(50);           // shows up on the job
    return { ok: true };              // stored as the job result (capped at 16 KB)
  },
};
export const handlers = [/* … */ resizeImage];
```

For CPU-heavy work, add a function to `backend/src/workers/task-runner.ts` and call `getPool().run('name', data, { signal: ctx.signal })`.

---

## Scaling and operations

- **Scale workers independently.** Run API replicas with `ROLE=api` and worker replicas with `ROLE=worker`, all pointing at the same Redis. In Compose: add a second service from the same image with `ROLE: worker`, then `docker compose up --scale worker=4`.
- **Graceful shutdown.** On `SIGTERM` the process stops taking jobs, waits for in-flight jobs (up to `SHUTDOWN_TIMEOUT_MS`), flushes webhooks and closes connections. Compose sets `stop_grace_period: 20s`, and `tini` is PID 1 so signals are forwarded.
- **Crash safety.** A killed worker's jobs are detected as stalled and re-queued, which means at-least-once execution (see above).
- **Persistence.** Compose runs Redis with AOF (`appendfsync everysec`) and `noeviction`, so a full Redis returns errors instead of silently dropping jobs. Size `maxmemory` accordingly.
- **Health.** `GET /api/health` is wired into the container `HEALTHCHECK`.
- **Logs.** Structured JSON (pino), with API keys redacted.
- **Redis keys.** BullMQ owns `<prefix>:jobs:*` and `<prefix>:webhooks:*`. Aether adds `<prefix>:stats`, `:retrying`, `:dlq:index`, `:dlq:entry:<id>`, `:workers`, `:events:log` and the `:events` pub/sub channel.

---

## Security model

- **API keys** are compared as SHA-256 digests in constant time. Keys are never logged. There is no per-key scoping, so every key is full-access.
- **The WebSocket requires an `auth` frame**, not a URL parameter, so keys don't end up in access logs.
- **The dashboard stores the API key in `localStorage`.** Serve it over HTTPS and treat the dashboard as an operator tool.
- **SSRF protection** for webhooks and `http.request`: only `http(s)`, no URL credentials, no redirects, response size caps and timeouts. Private, loopback, link-local (including cloud metadata `169.254.169.254`) and CGNAT ranges are blocked. The check runs on IP literals **and on every DNS answer at connect time**, which defeats DNS rebinding. Policy violations fail permanently without retrying. Set `WEBHOOK_ALLOW_PRIVATE=true` only for trusted, internal-only deployments.
- **Webhook secrets and custom headers are never returned by any endpoint.** Webhook URLs are shown with their query string masked.
- **Input limits:** 1 MB JSON bodies, 500 jobs per bulk call, payload schemas per job type, rate limiting, and a `WS_MAX_CLIENTS` cap.
- **TLS:** terminate TLS in front of nginx (a load balancer or Caddy/Traefik). The bundled nginx listens on plain HTTP.

---

## Development and testing

```bash
cd backend
npm run typecheck && npm test        # 42 unit tests: backoff, SSRF guard, DNS rebinding, thread pool
npm run build

# End-to-end smoke test against a running stack (21 checks: auth, validation, delays, idempotency,
# threads, retries + backoff, DLQ replay/clear, cron, webhooks, bulk, pause/resume, WebSocket):
AETHER_URL=http://localhost:8080 AETHER_API_KEY=aether-demo-key npm run smoke
```

The smoke test's webhook steps need `ENABLE_WEBHOOK_SINK=true` and `WEBHOOK_ALLOW_PRIVATE=true`, which the default Compose file sets. The SSRF step only asserts a rejection when `WEBHOOK_ALLOW_PRIVATE=false`.

---

## Project layout

```
aether/
├── docker-compose.yml        redis + backend + frontend, single command
├── .env.example
├── backend/
│   ├── Dockerfile            multi-stage, non-root, tini, healthcheck
│   ├── scripts/smoke.mjs     end-to-end test
│   └── src/
│       ├── index.ts          bootstrap, roles, graceful shutdown
│       ├── config.ts         validated env configuration
│       ├── api/              Express app, auth, zod schemas, routes/{jobs,schedules,dlq,system}
│       ├── ws/server.ts      WebSocket server (auth, batching, backpressure)
│       ├── events/bus.ts     Redis pub/sub event bus + history
│       ├── queue/            queues, worker (event wiring), processor, backoff, handlers/
│       ├── workers/          worker_threads pool + task runner
│       └── services/         jobs, schedules, dlq, webhooks, metrics, safeRequest, cron, queueControl
└── frontend/
    ├── Dockerfile · nginx.conf
    └── src/
        ├── App.tsx           shell, API-key gate, navigation
        ├── lib/              api client, useAether (WebSocket hook), types, formatters
        ├── components/       charts, badges, toasts, modals
        └── views/            Dashboard, Jobs, Composer, Schedules, Dlq
```

## License

MIT
