import { Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Modal, useToast } from '../components/ui';
import { api } from '../lib/api';
import type { AppInfo, JobType } from '../lib/types';

type When = 'now' | 'delay' | 'runAt' | 'cron';

const CRON_PRESETS = [
  { label: 'Every 10 seconds', value: '*/10 * * * * *' },
  { label: 'Every minute', value: '* * * * *' },
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Daily 09:00', value: '0 9 * * *' },
];

export default function Composer({ jobTypes, info, onClose, onCreated }: { jobTypes: JobType[]; info: AppInfo | null; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [type, setType] = useState(jobTypes[0]?.type ?? 'echo');
  const current = useMemo(() => jobTypes.find((t) => t.type === type), [jobTypes, type]);
  const [payload, setPayload] = useState('{}');
  const [when, setWhen] = useState<When>('now');
  const [delaySec, setDelaySec] = useState(10);
  const [runAt, setRunAt] = useState('');
  const [cron, setCron] = useState('*/10 * * * * *');
  const [tz, setTz] = useState('');
  const [limit, setLimit] = useState('');
  const [scheduleId, setScheduleId] = useState('');
  const [attempts, setAttempts] = useState(info?.defaults.attempts ?? 3);
  const [strategy, setStrategy] = useState<'exponential' | 'fixed'>('exponential');
  const [baseDelay, setBaseDelay] = useState(1000);
  const [maxDelay, setMaxDelay] = useState(60_000);
  const [jitter, setJitter] = useState(true);
  const [hookUrl, setHookUrl] = useState('');
  const [hookSecret, setHookSecret] = useState('');
  const [hookEvents, setHookEvents] = useState<string[]>(['completed', 'failed']);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (current) setPayload(JSON.stringify(current.example, null, 2));
  }, [current]);

  const sinkUrl = `${location.origin}/hooks/sink`;

  const submit = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload || '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    } catch {
      return toast('error', 'Payload must be a valid JSON object');
    }
    const body: Record<string, unknown> = {
      type,
      payload: parsed,
      retry: { attempts, strategy, baseDelayMs: baseDelay, maxDelayMs: Math.max(maxDelay, baseDelay), jitter },
    };
    if (when === 'delay') body.delayMs = Math.round(delaySec * 1000);
    if (when === 'runAt') {
      if (!runAt) return toast('error', 'Pick a date and time');
      body.runAt = new Date(runAt).toISOString();
    }
    if (when === 'cron') {
      body.cron = cron;
      if (tz) body.tz = tz;
      if (limit) body.limit = Number(limit);
      if (scheduleId) body.scheduleId = scheduleId;
    }
    if (hookUrl) body.webhook = { url: hookUrl, events: hookEvents, ...(hookSecret ? { secret: hookSecret } : {}) };

    setBusy(true);
    try {
      if (count > 1 && when !== 'cron') {
        const r = await api<{ accepted: number; rejected: number }>('POST', '/jobs/bulk', { jobs: Array.from({ length: count }, () => body) });
        toast(r.rejected ? 'warn' : 'success', `${r.accepted} jobs queued${r.rejected ? `, ${r.rejected} rejected` : ''}`);
      } else {
        const r = await api<{ kind: string; id: string; next?: string }>('POST', '/jobs', body);
        toast('success', r.kind === 'schedule' ? `Schedule ${r.id} created — next run ${new Date(r.next!).toLocaleTimeString()}` : `Job #${r.id} queued`);
      }
      onCreated();
      onClose();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleEvent = (ev: string) => setHookEvents((p) => (p.includes(ev) ? p.filter((x) => x !== ev) : [...p, ev]));

  return (
    <Modal title="New job" onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="jt">Job type</label>
            <select id="jt" className="input" value={type} onChange={(e) => setType(e.target.value)}>
              {jobTypes.map((t) => (
                <option key={t.type} value={t.type}>{t.type}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">{current?.description}</p>
          </div>
          <div>
            <label className="label" htmlFor="when">When</label>
            <select id="when" className="input" value={when} onChange={(e) => setWhen(e.target.value as When)}>
              <option value="now">Run immediately</option>
              <option value="delay">After a delay</option>
              <option value="runAt">At a specific time</option>
              <option value="cron">Recurring (cron)</option>
            </select>
          </div>
        </div>

        {when === 'delay' && (
          <div>
            <label className="label" htmlFor="delay">Delay (seconds)</label>
            <input id="delay" type="number" min={0} className="input" value={delaySec} onChange={(e) => setDelaySec(Number(e.target.value))} />
          </div>
        )}
        {when === 'runAt' && (
          <div>
            <label className="label" htmlFor="runat">Run at (local time)</label>
            <input id="runat" type="datetime-local" className="input" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
          </div>
        )}
        {when === 'cron' && (
          <div className="space-y-3 rounded-lg border border-ink-700 bg-ink-900/50 p-3">
            <div>
              <label className="label" htmlFor="cron">Cron expression</label>
              <input id="cron" className="input font-mono" value={cron} onChange={(e) => setCron(e.target.value)} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {CRON_PRESETS.map((p) => (
                  <button key={p.value} type="button" onClick={() => setCron(p.value)} className="rounded-full border border-ink-600 px-2 py-0.5 text-xs text-slate-300 hover:bg-ink-700">
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-500">5 fields, or 6 with a leading seconds field.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="tz">Timezone</label>
                <input id="tz" className="input" placeholder="UTC" value={tz} onChange={(e) => setTz(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="lim">Max runs</label>
                <input id="lim" type="number" min={1} className="input" placeholder="unlimited" value={limit} onChange={(e) => setLimit(e.target.value)} />
                <p className="mt-1 text-xs text-slate-500">1 = one-off cron task</p>
              </div>
              <div>
                <label className="label" htmlFor="sid">Schedule ID</label>
                <input id="sid" className="input" placeholder="auto" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)} />
              </div>
            </div>
          </div>
        )}

        <div>
          <label className="label" htmlFor="payload">Payload (JSON)</label>
          <textarea id="payload" rows={6} spellCheck={false} className="input font-mono text-xs" value={payload} onChange={(e) => setPayload(e.target.value)} />
        </div>

        <fieldset className="rounded-lg border border-ink-700 p-3">
          <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-400">Retry strategy</legend>
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label className="label" htmlFor="att">Attempts</label>
              <input id="att" type="number" min={1} max={50} className="input" value={attempts} onChange={(e) => setAttempts(Number(e.target.value))} />
            </div>
            <div>
              <label className="label" htmlFor="strat">Backoff</label>
              <select id="strat" className="input" value={strategy} onChange={(e) => setStrategy(e.target.value as 'exponential' | 'fixed')}>
                <option value="exponential">Exponential</option>
                <option value="fixed">Fixed</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="base">Base (ms)</label>
              <input id="base" type="number" min={100} className="input" value={baseDelay} onChange={(e) => setBaseDelay(Number(e.target.value))} />
            </div>
            <div>
              <label className="label" htmlFor="max">Max (ms)</label>
              <input id="max" type="number" min={100} className="input" value={maxDelay} onChange={(e) => setMaxDelay(Number(e.target.value))} />
            </div>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={jitter} onChange={(e) => setJitter(e.target.checked)} className="accent-indigo-500" />
            Add ±20% jitter to avoid retry stampedes
          </label>
          <p className="mt-2 font-mono text-xs text-slate-500">
            delays: {Array.from({ length: Math.min(attempts - 1, 6) }, (_, i) => {
              const raw = strategy === 'fixed' ? baseDelay : baseDelay * 2 ** i;
              const ms = Math.min(raw, Math.max(maxDelay, baseDelay));
              return ms >= 1000 ? `${+(ms / 1000).toFixed(1)}s` : `${ms}ms`;
            }).join(' → ') || 'none (single attempt)'}
          </p>
        </fieldset>

        <fieldset className="rounded-lg border border-ink-700 p-3">
          <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-400">Webhook callback (optional)</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="label" htmlFor="hurl">URL</label>
              <input id="hurl" className="input font-mono text-xs" placeholder="https://example.com/hooks/aether" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
              {info?.features.webhookSink && (
                <button type="button" className="mt-1 text-xs text-aether-300 hover:underline" onClick={() => setHookUrl(sinkUrl)}>
                  Use built-in test sink ({sinkUrl})
                </button>
              )}
            </div>
            <div>
              <label className="label" htmlFor="hsec">Signing secret</label>
              <input id="hsec" className="input" placeholder="min 8 chars (HMAC-SHA256)" value={hookSecret} onChange={(e) => setHookSecret(e.target.value)} />
            </div>
            <div>
              <span className="label">Fire on</span>
              <div className="flex gap-3 pt-1.5 text-sm text-slate-300">
                {['completed', 'failed', 'retrying'].map((ev) => (
                  <label key={ev} className="flex items-center gap-1.5 capitalize">
                    <input type="checkbox" checked={hookEvents.includes(ev)} onChange={() => toggleEvent(ev)} className="accent-indigo-500" />
                    {ev}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-700 pt-4">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <label htmlFor="count">Copies</label>
            <input id="count" type="number" min={1} max={500} disabled={when === 'cron'} className="input w-20" value={count} onChange={(e) => setCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || (hookUrl !== '' && hookEvents.length === 0)} onClick={submit}>
              <Send size={14} /> {busy ? 'Submitting…' : when === 'cron' ? 'Create schedule' : count > 1 ? `Queue ${count} jobs` : 'Queue job'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
