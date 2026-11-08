import { Activity, CalendarClock, Inbox, KeyRound, ListChecks, LogOut, Plus, Skull, Zap } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ToastProvider, useToast } from './components/ui';
import { api, getStoredKey, setApiKey, setUnauthorizedHandler, storeKey } from './lib/api';
import type { AppInfo } from './lib/types';
import { useAether } from './lib/useAether';
import Composer from './views/Composer';
import Dashboard from './views/Dashboard';
import Dlq from './views/Dlq';
import Jobs from './views/Jobs';
import Schedules from './views/Schedules';

type View = 'dashboard' | 'jobs' | 'schedules' | 'dlq';

function Login({ onLogin, error }: { onLogin: (key: string) => void; error?: string }) {
  const [key, setKey] = useState('');
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        className="card w-full max-w-sm space-y-5 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) onLogin(key.trim());
        }}
      >
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-aether-500/15 p-2 text-aether-400"><Zap size={20} /></div>
          <div>
            <h1 className="text-lg font-semibold text-white">Aether</h1>
            <p className="text-xs text-slate-500">Distributed task scheduler</p>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="key">API key</label>
          <div className="relative">
            <KeyRound size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input id="key" type="password" autoFocus autoComplete="off" className="input pl-9" placeholder="Enter your API key" value={key} onChange={(e) => setKey(e.target.value)} />
          </div>
          {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
        </div>
        <button className="btn btn-primary w-full" type="submit">Connect</button>
        <p className="text-center text-xs text-slate-500">Keys are configured with the <code className="text-slate-400">API_KEYS</code> environment variable.</p>
      </form>
    </div>
  );
}

const NAV: { id: View; label: string; icon: typeof Activity }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: Activity },
  { id: 'jobs', label: 'Jobs', icon: ListChecks },
  { id: 'schedules', label: 'Schedules', icon: CalendarClock },
  { id: 'dlq', label: 'Dead letters', icon: Skull },
];

function Shell({ apiKey, onLogout }: { apiKey: string; onLogout: () => void }) {
  const toast = useToast();
  const live = useAether(apiKey, true);
  const [view, setView] = useState<View>('dashboard');
  const [composer, setComposer] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    api<AppInfo>('GET', '/info').then(setInfo).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (live.status === 'unauthorized') {
      toast('error', 'API key was rejected');
      onLogout();
    }
  }, [live.status, onLogout, toast]);

  const dead = live.snapshot?.queue.failed ?? 0;
  const statusColor = live.status === 'live' ? 'bg-emerald-400' : live.status === 'unauthorized' ? 'bg-rose-400' : 'bg-amber-400 animate-pulse-dot';

  const content: Record<View, ReactNode> = {
    dashboard: <Dashboard live={live} goTo={(v) => setView(v as View)} />,
    jobs: <Jobs refreshKey={refreshKey} />,
    schedules: <Schedules refreshKey={refreshKey} />,
    dlq: <Dlq refreshKey={refreshKey} />,
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-[1500px]">
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-ink-700 p-4 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          <div className="rounded-lg bg-aether-500/15 p-1.5 text-aether-400"><Zap size={18} /></div>
          <span className="text-lg font-semibold tracking-tight text-white">Aether</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setView(id)} className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${view === id ? 'bg-aether-500/15 text-white' : 'text-slate-400 hover:bg-ink-800 hover:text-white'}`}>
              <Icon size={16} />
              {label}
              {id === 'dlq' && dead > 0 && <span className="ml-auto rounded-full bg-rose-500/20 px-1.5 text-[11px] font-semibold text-rose-300">{dead > 99 ? '99+' : dead}</span>}
            </button>
          ))}
        </nav>
        <div className="space-y-2 border-t border-ink-700 pt-3 text-xs text-slate-500">
          <div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${statusColor}`} /> <span className="capitalize">{live.status}</span></div>
          <button onClick={onLogout} className="flex items-center gap-2 hover:text-white"><LogOut size={12} /> Sign out</button>
          {info && <div>v{info.version}</div>}
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-ink-700 bg-ink-950/80 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-aether-500/15 p-1.5 text-aether-400 md:hidden"><Zap size={16} /></div>
            <h1 className="text-base font-semibold text-white">{NAV.find((n) => n.id === view)?.label}</h1>
          </div>
          <button className="btn btn-primary" onClick={() => setComposer(true)}><Plus size={14} /> New job</button>
        </header>

        {/* Tabs (mobile) */}
        <nav className="flex gap-1 overflow-x-auto border-b border-ink-700 px-3 py-2 md:hidden">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setView(id)} className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${view === id ? 'bg-aether-500/15 text-white' : 'text-slate-400'}`}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </nav>

        {live.status !== 'live' && live.status !== 'unauthorized' && (
          <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200 md:px-6">
            <Inbox size={14} /> {live.status === 'connecting' ? 'Connecting to the live stream…' : 'Live stream disconnected — reconnecting…'}
          </div>
        )}

        <main className="p-4 md:p-6">{content[view]}</main>
      </div>

      {composer && <Composer jobTypes={live.jobTypes.length ? live.jobTypes : (info?.jobTypes ?? [])} info={info} onClose={() => setComposer(false)} onCreated={() => setRefreshKey((k) => k + 1)} />}
    </div>
  );
}

export default function App() {
  const [key, setKey] = useState(getStoredKey());
  const [error, setError] = useState<string>();

  const logout = useCallback(() => {
    storeKey('');
    setApiKey('');
    setKey('');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setError('That API key was rejected.');
      logout();
    });
  }, [logout]);

  const login = async (candidate: string) => {
    setError(undefined);
    try {
      await api('GET', '/info', undefined, candidate); // validate before storing
      storeKey(candidate);
      setApiKey(candidate);
      setKey(candidate);
    } catch (e) {
      const status = (e as { status?: number }).status;
      setError(status === 401 ? 'Invalid API key.' : (e as Error).message);
    }
  };

  return <ToastProvider>{key ? <Shell apiKey={key} onLogout={logout} /> : <Login onLogin={login} error={error} />}</ToastProvider>;
}
