export const fmtNum = (n: number) => n.toLocaleString('en-US');

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function fmtTime(ts: number, withMs = false): string {
  const d = new Date(ts);
  const base = d.toLocaleTimeString('en-GB', { hour12: false });
  return withMs ? `${base}.${String(d.getMilliseconds()).padStart(3, '0')}` : base;
}

export function fmtRelative(ts: number | null, now = Date.now()): string {
  if (ts == null) return '—';
  const diff = ts - now;
  const abs = Math.abs(diff);
  const s = Math.round(abs / 1000);
  const text = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export function fmtUptime(ts: number): string {
  return fmtDuration(Date.now() - ts).replace(/\.\d/, '');
}
