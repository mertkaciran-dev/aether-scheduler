import { CalendarClock, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Empty, useToast } from '../components/ui';
import { api } from '../lib/api';
import { fmtRelative } from '../lib/format';
import type { Schedule } from '../lib/types';

export default function Schedules({ refreshKey }: { refreshKey: number }) {
  const toast = useToast();
  const [items, setItems] = useState<Schedule[] | null>(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Schedule[] }>('GET', '/schedules')).items);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      void load();
      tick((n) => n + 1);
    }, 3000);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  const remove = async (id: string) => {
    if (!confirm(`Delete schedule "${id}"? Already-queued runs are not cancelled.`)) return;
    try {
      await api('DELETE', `/schedules/${encodeURIComponent(id)}`);
      toast('success', `Schedule ${id} deleted`);
      void load();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  return (
    <div className="card overflow-x-auto">
      {!items || items.length === 0 ? (
        <Empty icon={<CalendarClock size={28} />} title="No schedules" hint="Create a job with “Recurring (cron)” to see it here. Set Max runs to 1 for a one-off cron task." />
      ) : (
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-ink-700 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Schedule</th>
              <th className="px-4 py-2.5 font-medium">Type</th>
              <th className="px-4 py-2.5 font-medium">Cron</th>
              <th className="px-4 py-2.5 font-medium">Next run</th>
              <th className="px-4 py-2.5 font-medium">Runs</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} className="border-b border-ink-800 hover:bg-ink-800/60">
                <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{s.id}</td>
                <td className="px-4 py-2.5 text-aether-300">{s.type}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-300">
                  {s.cron}
                  {s.tz && <span className="ml-1 text-slate-500">({s.tz})</span>}
                </td>
                <td className="px-4 py-2.5 text-slate-400">{fmtRelative(s.next)}</td>
                <td className="px-4 py-2.5 tabular-nums text-slate-400">
                  {s.iterationCount}
                  {s.limit ? ` / ${s.limit}` : ''}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button className="btn btn-danger" onClick={() => remove(s.id)} aria-label={`Delete schedule ${s.id}`}>
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
