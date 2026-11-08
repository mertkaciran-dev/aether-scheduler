import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { EventLevel } from '../lib/types';

// ── Status badges ─────────────────────────────────────────────────────

const LEVEL_STYLES: Record<EventLevel, string> = {
  info: 'bg-sky-500/10 text-sky-300 ring-sky-500/30',
  success: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
  warn: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
  error: 'bg-rose-500/10 text-rose-300 ring-rose-500/30',
};

const KIND_LABEL: Record<string, { label: string; level: EventLevel }> = {
  'job.queued': { label: 'QUEUED', level: 'info' },
  'job.scheduled': { label: 'SCHEDULED', level: 'info' },
  'job.active': { label: 'ACTIVE', level: 'info' },
  'job.completed': { label: 'COMPLETED', level: 'success' },
  'job.retrying': { label: 'RETRYING', level: 'warn' },
  'job.dead': { label: 'DEAD', level: 'error' },
  'job.stalled': { label: 'STALLED', level: 'warn' },
  'job.replayed': { label: 'REPLAYED', level: 'info' },
  'job.removed': { label: 'REMOVED', level: 'warn' },
  'schedule.created': { label: 'SCHEDULE', level: 'info' },
  'schedule.removed': { label: 'SCHEDULE', level: 'warn' },
  'queue.paused': { label: 'PAUSED', level: 'warn' },
  'queue.resumed': { label: 'RESUMED', level: 'success' },
  'queue.cleaned': { label: 'CLEANED', level: 'warn' },
  'dlq.cleared': { label: 'DLQ', level: 'warn' },
  'webhook.delivered': { label: 'WEBHOOK ✓', level: 'success' },
  'webhook.failed': { label: 'WEBHOOK ✗', level: 'error' },
  'webhook.received': { label: 'SINK', level: 'info' },
  'worker.online': { label: 'WORKER', level: 'success' },
  'worker.offline': { label: 'WORKER', level: 'warn' },
};

export function KindBadge({ kind, level }: { kind: string; level?: EventLevel }) {
  const meta = KIND_LABEL[kind] ?? { label: kind.toUpperCase(), level: level ?? 'info' };
  const lvl = kind === 'webhook.failed' && level ? level : meta.level;
  return (
    <span className={`inline-flex w-[92px] shrink-0 justify-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ring-1 ring-inset ${LEVEL_STYLES[lvl]}`}>
      {meta.label}
    </span>
  );
}

const STATE_STYLES: Record<string, string> = {
  waiting: 'bg-slate-500/10 text-slate-300 ring-slate-500/30',
  active: 'bg-sky-500/10 text-sky-300 ring-sky-500/30',
  delayed: 'bg-violet-500/10 text-violet-300 ring-violet-500/30',
  retrying: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
  completed: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
  failed: 'bg-rose-500/10 text-rose-300 ring-rose-500/30',
  dead: 'bg-rose-500/10 text-rose-300 ring-rose-500/30',
};

export function StateBadge({ state }: { state: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ring-1 ring-inset ${STATE_STYLES[state] ?? STATE_STYLES.waiting}`}>
      {state}
    </span>
  );
}

// ── Toasts ────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  level: EventLevel;
  text: string;
}
const ToastCtx = createContext<(level: EventLevel, text: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((level: EventLevel, text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, level, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === 'error' ? 7000 : 3500);
  }, []);
  const icon = { info: Info, success: CheckCircle2, warn: AlertTriangle, error: XCircle };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,380px)] flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((t) => {
          const Icon = icon[t.level];
          return (
            <div key={t.id} className={`pointer-events-auto flex animate-slide-in items-start gap-2 rounded-lg border bg-ink-800 px-3 py-2.5 text-sm shadow-xl ${t.level === 'error' ? 'border-rose-500/40' : t.level === 'success' ? 'border-emerald-500/40' : 'border-ink-600'}`}>
              <Icon size={16} className={`mt-0.5 shrink-0 ${LEVEL_STYLES[t.level].split(' ')[1]}`} />
              <span className="min-w-0 break-words">{t.text}</span>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`card w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} animate-slide-in bg-ink-850 shadow-2xl`}>
        <div className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button className="rounded p-1 text-slate-400 hover:bg-ink-700 hover:text-white" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center text-slate-500">
      <div className="text-slate-600">{icon}</div>
      <div className="text-sm font-medium text-slate-400">{title}</div>
      {hint && <div className="max-w-sm text-xs">{hint}</div>}
    </div>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-lg border border-ink-700 bg-ink-900 p-3 font-mono text-xs leading-relaxed text-slate-300">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
