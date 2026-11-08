import { useCallback, useEffect, useRef, useState } from 'react';
import type { AetherEvent, JobType, MetricsSample, MetricsSnapshot } from './types';

export type ConnStatus = 'connecting' | 'live' | 'reconnecting' | 'unauthorized';

export interface AetherState {
  status: ConnStatus;
  snapshot: MetricsSnapshot | null;
  history: MetricsSample[];
  events: AetherEvent[];
  jobTypes: JobType[];
  droppedEvents: number;
  clearEvents: () => void;
}

const MAX_EVENTS = 500;
const MAX_HISTORY = 180;

/**
 * Maintains the live WebSocket connection: authenticates with the API key, hydrates from the
 * `hello` frame, then appends metrics + event frames. Reconnects with capped exponential backoff.
 */
export function useAether(apiKey: string, enabled: boolean): AetherState {
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [history, setHistory] = useState<MetricsSample[]>([]);
  const [events, setEvents] = useState<AetherEvent[]>([]);
  const [jobTypes, setJobTypes] = useState<JobType[]>([]);
  const [droppedEvents, setDropped] = useState(0);
  const attempt = useRef(0);

  useEffect(() => {
    if (!enabled || !apiKey) return;
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let disposed = false;

    const connect = () => {
      setStatus(attempt.current === 0 ? 'connecting' : 'reconnecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);

      ws.onopen = () => ws?.send(JSON.stringify({ type: 'auth', apiKey }));

      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'hello':
            attempt.current = 0;
            setStatus('live');
            setSnapshot(msg.snapshot);
            setHistory(msg.history ?? []);
            setEvents((msg.events ?? []).slice(-MAX_EVENTS).reverse());
            setJobTypes(msg.jobTypes ?? []);
            pingTimer = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 25_000);
            break;
          case 'metrics': {
            const s: MetricsSnapshot = msg.data;
            setSnapshot(s);
            setHistory((h) => {
              const next = [
                ...h,
                {
                  ts: s.ts,
                  waiting: s.queue.waiting,
                  active: s.queue.active,
                  delayed: s.queue.delayed,
                  retrying: s.queue.retrying,
                  failed: s.queue.failed,
                  completedRate: s.rates.completed,
                  failedRate: s.rates.failed,
                  enqueuedRate: s.rates.enqueued,
                },
              ];
              return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
            });
            break;
          }
          case 'events':
            setEvents((prev) => [...(msg.data as AetherEvent[]).slice().reverse(), ...prev].slice(0, MAX_EVENTS));
            if (msg.dropped) setDropped((d) => d + msg.dropped);
            break;
        }
      };

      ws.onclose = (ev) => {
        if (pingTimer) clearInterval(pingTimer);
        if (disposed) return;
        if (ev.code === 4401) return setStatus('unauthorized');
        attempt.current++;
        setStatus('reconnecting');
        timer = setTimeout(connect, Math.min(500 * 2 ** attempt.current, 10_000));
      };
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (pingTimer) clearInterval(pingTimer);
      ws?.close();
    };
  }, [apiKey, enabled]);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setDropped(0);
  }, []);

  return { status, snapshot, history, events, jobTypes, droppedEvents, clearEvents };
}
