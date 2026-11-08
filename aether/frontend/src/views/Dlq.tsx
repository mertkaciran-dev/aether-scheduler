import { PartyPopper, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Empty, JsonBlock, Modal, useToast } from '../components/ui';
import { api } from '../lib/api';
import { fmtRelative } from '../lib/format';
import type { DlqEntry } from '../lib/types';

const LIMIT = 25;

export default function Dlq({ refreshKey }: { refreshKey: number }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: DlqEntry[]; total: number } | null>(null);
  const [selected, setSelected] = useState<DlqEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(LIMIT), ...(q ? { q } : {}) });
      setData(await api('GET', `/dlq?${qs}`));
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }, [page, q, toast]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast('success', ok);
      setSelected(null);
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const replay = (id: string) => act(() => api('POST', `/dlq/${encodeURIComponent(id)}/replay`), `Job #${id} replayed with a fresh retry budget`);
  const discard = (id: string) => act(() => api('DELETE', `/dlq/${encodeURIComponent(id)}`), `Job #${id} discarded`);
  const replayAll = () =>
    confirm(`Replay ${data?.total} dead job(s)?`) &&
    act(async () => {
      const r = await api<{ replayed: number; failed: number }>('POST', '/dlq/replay-all');
      if (r.failed) throw new Error(`${r.replayed} replayed, ${r.failed} failed`);
    }, 'All dead jobs replayed');
  const clearAll = () => confirm(`Permanently discard all ${data?.total} dead job(s)? This cannot be undone.`) && act(() => api('DELETE', '/dlq'), 'Dead-letter queue cleared');

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / LIMIT));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative w-full sm:w-80">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            className="input pl-9"
            placeholder="Search error message or job id…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            aria-label="Search dead jobs"
          />
        </div>
        <div className="flex gap-2">
          <button className="btn" disabled={busy || !data?.total} onClick={replayAll}><RotateCcw size={14} /> Replay all</button>
          <button className="btn btn-danger" disabled={busy || !data?.total} onClick={clearAll}><Trash2 size={14} /> Clear all</button>
        </div>
      </div>

      <div className="card overflow-x-auto">
        {!data || data.items.length === 0 ? (
          <Empty icon={<PartyPopper size={28} />} title={q ? 'No matches' : 'Dead-letter queue is empty'} hint={q ? undefined : 'Jobs that exhaust all their retries land here for inspection and replay.'} />
        ) : (
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-ink-700 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">ID</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Error</th>
                <th className="px-4 py-2.5 font-medium">Attempts</th>
                <th className="px-4 py-2.5 font-medium">Died</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id} onClick={() => setSelected(e)} className="cursor-pointer border-b border-ink-800 hover:bg-ink-800/60">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-400">#{e.id.length > 14 ? e.id.slice(0, 12) + '…' : e.id}</td>
                  <td className="px-4 py-2.5 text-aether-300">{e.type}</td>
                  <td className="max-w-xs truncate px-4 py-2.5 text-rose-300" title={e.error.message}>{e.error.message}</td>
                  <td className="px-4 py-2.5 tabular-nums text-slate-300">{e.attemptsMade}</td>
                  <td className="px-4 py-2.5 text-slate-400">{fmtRelative(e.failedAt)}</td>
                  <td className="px-4 py-2.5 text-right" onClick={(ev) => ev.stopPropagation()}>
                    <div className="flex justify-end gap-1.5">
                      <button className="btn" disabled={busy} onClick={() => replay(e.id)} aria-label={`Replay ${e.id}`}><RotateCcw size={14} /></button>
                      <button className="btn btn-danger" disabled={busy} onClick={() => discard(e.id)} aria-label={`Discard ${e.id}`}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.total > LIMIT && (
          <div className="flex items-center justify-between border-t border-ink-700 px-4 py-2.5 text-sm text-slate-400">
            <span>{data.total.toLocaleString()} dead jobs</span>
            <div className="flex items-center gap-2">
              <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
              <span>{page} / {pages}</span>
              <button className="btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        )}
      </div>

      {selected && (
        <Modal title={`Dead job #${selected.id}`} onClose={() => setSelected(null)} wide>
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-400">
              <span className="text-aether-300">{selected.type}</span>
              <span>{selected.attemptsMade} attempts</span>
              <span>died {fmtRelative(selected.failedAt)}</span>
              <span>via {selected.meta.source}</span>
              {!!selected.meta.replayCount && <span>replayed {selected.meta.replayCount}×</span>}
            </div>
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3">
              <div className="font-mono text-xs text-rose-300">{selected.error.name}</div>
              <div className="mt-1 text-rose-100">{selected.error.message}</div>
            </div>
            <div><div className="label">Payload</div><JsonBlock value={selected.payload} /></div>
            <div><div className="label">Retry policy</div><JsonBlock value={selected.meta.retry} /></div>
            {selected.webhook && <div><div className="label">Webhook</div><JsonBlock value={selected.webhook} /></div>}
            {selected.stacktrace.length > 0 && <div><div className="label">Stack traces (per attempt)</div><JsonBlock value={selected.stacktrace} /></div>}
            <div className="flex justify-end gap-2 border-t border-ink-700 pt-3">
              <button className="btn btn-danger" disabled={busy} onClick={() => discard(selected.id)}><Trash2 size={14} /> Discard</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => replay(selected.id)}><RotateCcw size={14} /> Replay</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
