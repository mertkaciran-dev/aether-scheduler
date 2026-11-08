import { Activity, CheckCircle2, Clock, Pause, Play, RefreshCw, Server, Skull, Trash2, Webhook } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DepthChart, ThroughputChart } from '../components/Charts';
import { Empty, KindBadge, useToast } from '../components/ui';
import { api } from '../lib/api';
import { fmtNum, fmtTime, fmtUptime } from '../lib/format';
import type { AetherState } from '../lib/useAether';

function Stat({ label, value, sub, icon: Icon, tone, spark }: { label: string; value: number; sub?: string; icon: typeof Activity; tone: string; spark?: boolean }) {
  return (
    <div className="card relative overflow-hidden p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
        <Icon size={16} className={tone} />
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums text-white">{fmtNum(value)}</span>
        {spark && value > 0 && <span className={`h-2 w-2 animate-pulse-dot rounded-full bg-current ${tone}`} />}
      </div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export default function Dashboard({ live, goTo }: { live: AetherState; goTo: (v: string) => void }) {
  const { snapshot: s, history, events } = live;
  const toast = useToast();
  const [filter, setFilter] = useState<'all' | 'job' | 'error'>('all');
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => {
    if (filter === 'error') return events.filter((e) => e.level === 'error' || e.level === 'warn');
    if (filter === 'job') return events.filter((e) => e.kind.startsWith('job.'));
    return events;
  }, [events, filter]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast('success', ok);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!s) return <Empty icon={<RefreshCw className="animate-spin" />} title="Waiting for live data…" />;
  const q = s.queue;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Server size={14} />
          <span>
            {s.workers.length} worker{s.workers.length === 1 ? '' : 's'}
          </span>
          <span className="text-slate-600">·</span>
          <span>{s.workers.reduce((a, w) => a + w.concurrency, 0)} slots</span>
          <span className="text-slate-600">·</span>
          <span>{s.schedules} schedule{s.schedules === 1 ? '' : 's'}</span>
          {q.paused && <span className="ml-2 rounded bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-300">QUEUE PAUSED</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          {q.paused ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api('POST', '/queue/resume'), 'Queue resumed')}>
              <Play size={14} /> Resume
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => run(() => api('POST', '/queue/pause'), 'Queue paused')}>
              <Pause size={14} /> Pause
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => run(() => api('POST', '/queue/clean', { state: 'completed' }), 'Completed jobs cleaned')}>
            <Trash2 size={14} /> Clean completed
          </button>
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => confirm('Remove ALL waiting and delayed jobs? Active jobs are not affected.') && run(() => api('POST', '/queue/drain'), 'Queue drained')}
          >
            <Trash2 size={14} /> Drain
          </button>
        </div>
      </div>

      {/* Metric tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Waiting" value={q.waiting} icon={Clock} tone="text-slate-300" sub={`${s.rates.enqueued}/s in`} />
        <Stat label="Active" value={q.active} icon={Activity} tone="text-sky-400" spark sub="processing now" />
        <Stat label="Completed" value={q.completed} icon={CheckCircle2} tone="text-emerald-400" sub={`${s.rates.completed}/s`} />
        <Stat label="Delayed" value={q.delayed} icon={Clock} tone="text-violet-400" sub="scheduled ahead" />
        <Stat label="Retrying" value={q.retrying} icon={RefreshCw} tone="text-amber-400" sub={`${fmtNum(s.totals.retried)} retries total`} />
        <button className="text-left" onClick={() => goTo('dlq')}>
          <Stat label="Failed (DLQ)" value={q.failed} icon={Skull} tone="text-rose-400" sub="click to inspect" />
        </button>
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-white">Throughput</h3>
          <div className="h-56">{history.length > 1 ? <ThroughputChart data={history} /> : <Empty icon={<Activity />} title="Collecting samples…" />}</div>
        </section>
        <section className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-white">Queue depth</h3>
          <div className="h-56">{history.length > 1 ? <DepthChart data={history} /> : <Empty icon={<Activity />} title="Collecting samples…" />}</div>
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Live event log */}
        <section className="card flex min-h-[26rem] flex-col xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-700 px-4 py-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              Live event stream
              <span className={`h-2 w-2 rounded-full ${live.status === 'live' ? 'animate-pulse-dot bg-emerald-400' : 'bg-amber-400'}`} />
            </h3>
            <div className="flex items-center gap-1 text-xs">
              {(['all', 'job', 'error'] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={`rounded-md px-2 py-1 capitalize ${filter === f ? 'bg-ink-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                  {f === 'error' ? 'Warnings' : f === 'job' ? 'Jobs' : 'All'}
                </button>
              ))}
              <button onClick={live.clearEvents} className="ml-1 rounded-md px-2 py-1 text-slate-400 hover:text-white">
                Clear
              </button>
            </div>
          </div>
          <div className="max-h-[26rem] min-h-0 flex-1 overflow-y-auto font-mono text-xs" aria-live="off">
            {visible.length === 0 ? (
              <Empty icon={<Activity />} title="No events yet" hint="Create a job from the Jobs tab and watch it flow through here." />
            ) : (
              visible.map((e) => (
                <div key={e.id} className="flex flex-wrap items-start gap-x-2 gap-y-0.5 border-b border-ink-800 px-4 py-1.5 hover:bg-ink-800/60">
                  <span className="shrink-0 text-slate-500">{fmtTime(e.ts, true)}</span>
                  <KindBadge kind={e.kind} level={e.level} />
                  {e.jobId && (
                    <span className="shrink-0 text-slate-500">
                      #{e.jobId.length > 12 ? e.jobId.slice(0, 10) + '…' : e.jobId}
                    </span>
                  )}
                  {e.jobType && <span className="shrink-0 text-aether-300">{e.jobType}</span>}
                  <span className="min-w-[12rem] flex-1 break-words text-slate-300">{e.message}</span>
                </div>
              ))
            )}
          </div>
          {live.droppedEvents > 0 && <div className="border-t border-ink-700 px-4 py-1.5 text-[11px] text-amber-300/80">{fmtNum(live.droppedEvents)} events were skipped under load (batched view).</div>}
        </section>

        {/* Workers + webhooks */}
        <div className="space-y-4">
          <section className="card">
            <div className="border-b border-ink-700 px-4 py-3 text-sm font-semibold text-white">Workers</div>
            {s.workers.length === 0 ? (
              <Empty icon={<Server />} title="No workers online" hint="Jobs will queue until a worker connects." />
            ) : (
              <ul className="divide-y divide-ink-800">
                {s.workers.map((w) => (
                  <li key={w.id} className="px-4 py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="truncate font-mono text-xs text-slate-300">{w.id}</span>
                      <span className="text-xs text-slate-500">up {fmtUptime(w.startedAt)}</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700">
                      <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${Math.min(100, (w.active / w.concurrency) * 100)}%` }} />
                    </div>
                    <div className="mt-1.5 flex justify-between text-xs text-slate-500">
                      <span>
                        {w.active}/{w.concurrency} busy
                      </span>
                      <span>
                        {fmtNum(w.processed)} done · {fmtNum(w.failed)} failed
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
              <Webhook size={14} /> Webhook dispatcher
            </h3>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Delivered</dt>
                <dd className="text-xl font-semibold tabular-nums text-emerald-300">{fmtNum(s.totals.webhooksDelivered)}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Gave up</dt>
                <dd className="text-xl font-semibold tabular-nums text-rose-300">{fmtNum(s.totals.webhooksFailed)}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
