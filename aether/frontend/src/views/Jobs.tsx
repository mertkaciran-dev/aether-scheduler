import { Inbox, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Empty, JsonBlock, Modal, StateBadge, useToast } from '../components/ui';
import { api } from '../lib/api';
import { fmtDuration, fmtRelative, fmtTime } from '../lib/format';
import type { Job } from '../lib/types';

const STATES = ['waiting', 'active', 'delayed', 'retrying', 'completed'] as const;
type State = (typeof STATES)[number];
const LIMIT = 25;

export default function Jobs({ refreshKey }: { refreshKey: number }) {
  const toast = useToast();
  const [state, setState] = useState<State>('waiting');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Job[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<{ job: Job; logs: string[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api('GET', `/jobs?state=${state}&page=${page}&limit=${LIMIT}`));
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [state, page, toast]);

  useEffect(() => {
    void load();
    // Poll lightly so the list follows the live queue without a manual refresh.
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  const open = async (id: string) => {
    try {
      setDetail(await api('GET', `/jobs/${encodeURIComponent(id)}`));
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const remove = async (id: string) => {
    try {
      await api('DELETE', `/jobs/${encodeURIComponent(id)}`);
      toast('success', `Job #${id} removed`);
      setDetail(null);
      void load();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / LIMIT));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg border border-ink-700 bg-ink-850 p-1">
          {STATES.map((s) => (
            <button
              key={s}
              onClick={() => {
                setState(s);
                setPage(1);
              }}
              className={`rounded-md px-3 py-1.5 text-sm capitalize ${state === s ? 'bg-aether-500 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {s}
            </button>
          ))}
        </div>
        <button className="btn" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="card overflow-x-auto">
        {!data || data.items.length === 0 ? (
          <Empty icon={<Inbox size={28} />} title={`No ${state} jobs`} hint="Use “New job” to enqueue one." />
        ) : (
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-ink-700 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">ID</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">State</th>
                <th className="px-4 py-2.5 font-medium">Attempts</th>
                <th className="px-4 py-2.5 font-medium">{state === 'delayed' || state === 'retrying' ? 'Runs' : 'Created'}</th>
                <th className="px-4 py-2.5 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((j) => (
                <tr key={j.id} onClick={() => open(j.id)} className="cursor-pointer border-b border-ink-800 hover:bg-ink-800/60">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-400">#{j.id.length > 14 ? j.id.slice(0, 12) + '…' : j.id}</td>
                  <td className="px-4 py-2.5 text-aether-300">{j.type}</td>
                  <td className="px-4 py-2.5"><StateBadge state={j.state} /></td>
                  <td className="px-4 py-2.5 tabular-nums text-slate-300">{j.attemptsMade}/{j.maxAttempts}</td>
                  <td className="px-4 py-2.5 text-slate-400">{j.scheduledFor && (state === 'delayed' || state === 'retrying') ? fmtRelative(j.scheduledFor) : fmtRelative(j.createdAt)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-slate-400">{fmtDuration(j.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.total > LIMIT && (
          <div className="flex items-center justify-between border-t border-ink-700 px-4 py-2.5 text-sm text-slate-400">
            <span>{data.total.toLocaleString()} jobs</span>
            <div className="flex items-center gap-2">
              <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
              <span>{page} / {pages}</span>
              <button className="btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        )}
      </div>

      {detail && (
        <Modal title={`Job #${detail.job.id}`} onClose={() => setDetail(null)} wide>
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <StateBadge state={detail.job.state} />
              <span className="text-aether-300">{detail.job.type}</span>
              <span className="text-slate-500">via {detail.job.source}</span>
              {detail.job.schedulerId && <span className="text-slate-500">schedule {detail.job.schedulerId}</span>}
              {detail.job.replayedFrom && <span className="text-slate-500">replay of #{detail.job.replayedFrom}</span>}
            </div>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Attempts', `${detail.job.attemptsMade}/${detail.job.maxAttempts}`],
                ['Created', fmtTime(detail.job.createdAt)],
                ['Started', detail.job.processedOn ? fmtTime(detail.job.processedOn) : '—'],
                ['Duration', fmtDuration(detail.job.durationMs)],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-slate-500">{k}</dt>
                  <dd className="text-slate-200">{v}</dd>
                </div>
              ))}
            </dl>
            {detail.job.failedReason && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-rose-200">{detail.job.failedReason}</div>}
            <div><div className="label">Payload</div><JsonBlock value={detail.job.payload} /></div>
            {detail.job.returnValue != null && <div><div className="label">Result</div><JsonBlock value={detail.job.returnValue} /></div>}
            {detail.job.retry && <div><div className="label">Retry policy</div><JsonBlock value={detail.job.retry} /></div>}
            {detail.job.webhook && <div><div className="label">Webhook</div><JsonBlock value={detail.job.webhook} /></div>}
            {detail.logs.length > 0 && <div><div className="label">Logs</div><JsonBlock value={detail.logs} /></div>}
            {detail.job.state !== 'active' && detail.job.state !== 'dead' && (
              <div className="flex justify-end border-t border-ink-700 pt-3">
                <button className="btn btn-danger" onClick={() => remove(detail.job.id)}><Trash2 size={14} /> Remove job</button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
