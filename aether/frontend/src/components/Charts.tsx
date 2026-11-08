import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtTime } from '../lib/format';
import type { MetricsSample } from '../lib/types';

const AXIS = { stroke: '#475069', fontSize: 11, tickLine: false, axisLine: false } as const;
const TIP = {
  contentStyle: { background: '#10131b', border: '1px solid #2a3042', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#94a3b8' },
  labelFormatter: (v: number) => fmtTime(v),
} as const;

export function ThroughputChart({ data }: { data: MetricsSample[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="gDone" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#818cf8" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#818cf8" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#1f2431" vertical={false} />
        <XAxis dataKey="ts" tickFormatter={(v) => fmtTime(v)} minTickGap={48} {...AXIS} />
        <YAxis allowDecimals={false} {...AXIS} />
        <Tooltip {...TIP} />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
        <Area type="monotone" dataKey="enqueuedRate" name="Enqueued /s" stroke="#818cf8" fill="url(#gIn)" strokeWidth={2} isAnimationActive={false} />
        <Area type="monotone" dataKey="completedRate" name="Completed /s" stroke="#34d399" fill="url(#gDone)" strokeWidth={2} isAnimationActive={false} />
        <Area type="monotone" dataKey="failedRate" name="Failed /s" stroke="#fb7185" fill="none" strokeWidth={2} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function DepthChart({ data }: { data: MetricsSample[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid stroke="#1f2431" vertical={false} />
        <XAxis dataKey="ts" tickFormatter={(v) => fmtTime(v)} minTickGap={48} {...AXIS} />
        <YAxis allowDecimals={false} {...AXIS} />
        <Tooltip {...TIP} />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
        <Line type="stepAfter" dataKey="waiting" name="Waiting" stroke="#94a3b8" dot={false} strokeWidth={2} isAnimationActive={false} />
        <Line type="stepAfter" dataKey="active" name="Active" stroke="#38bdf8" dot={false} strokeWidth={2} isAnimationActive={false} />
        <Line type="stepAfter" dataKey="delayed" name="Delayed" stroke="#a78bfa" dot={false} strokeWidth={2} isAnimationActive={false} />
        <Line type="stepAfter" dataKey="retrying" name="Retrying" stroke="#fbbf24" dot={false} strokeWidth={2} isAnimationActive={false} />
        <Line type="stepAfter" dataKey="failed" name="Dead (DLQ)" stroke="#fb7185" dot={false} strokeWidth={2} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
