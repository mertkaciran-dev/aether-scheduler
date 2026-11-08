import { notFound } from '../errors';
import { publishEvent } from '../events/bus';
import { getJobsQueue } from '../queue/queues';
import type { JobEnvelope } from '../types';
import { publicWebhook } from './jobs';

export interface ScheduleDto {
  id: string;
  type: string;
  cron: string | null;
  everyMs: number | null;
  tz: string | null;
  next: number | null;
  limit: number | null;
  iterationCount: number;
  payload: Record<string, unknown>;
  webhook: { url: string; events: string[] } | null;
}

export async function listSchedules(): Promise<ScheduleDto[]> {
  const schedulers = await getJobsQueue().getJobSchedulers(0, 199, true);
  return schedulers.map((s) => {
    const data = s.template?.data as JobEnvelope | undefined;
    return {
      id: String(s.id ?? s.key),
      type: data?.type ?? s.name,
      cron: s.pattern ?? null,
      everyMs: s.every ?? null,
      tz: s.tz ?? null,
      next: s.next ?? null,
      limit: s.limit ?? null,
      iterationCount: s.iterationCount ?? 0,
      payload: data?.payload ?? {},
      webhook: publicWebhook(data?.webhook),
    };
  });
}

export async function removeSchedule(id: string): Promise<void> {
  const removed = await getJobsQueue().removeJobScheduler(id);
  if (!removed) throw notFound('Schedule', id);
  publishEvent({ kind: 'schedule.removed', level: 'warn', message: `schedule ${id} removed`, data: { scheduleId: id } });
}
