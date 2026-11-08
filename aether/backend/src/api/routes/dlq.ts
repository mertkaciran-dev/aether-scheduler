import { Router } from 'express';
import { notFound } from '../../errors';
import { clearDlq, getDlqEntry, listDlq, removeDlq, replayAllDlq, replayDlq } from '../../services/dlq';
import { listDlqQuery } from '../schemas';

export const dlqRouter = Router();

const view = <T extends { webhook?: { url: string; events: string[]; secret?: string; headers?: unknown } }>(e: T) => {
  // Never leak webhook secrets / custom headers through the inspector.
  const { webhook, ...rest } = e;
  return { ...rest, webhook: webhook ? { url: webhook.url, events: webhook.events } : null };
};

dlqRouter.get('/dlq', async (req, res) => {
  const q = listDlqQuery.parse(req.query);
  const { items, total } = await listDlq({ offset: (q.page - 1) * q.limit, limit: q.limit, type: q.type, q: q.q });
  res.json({ page: q.page, limit: q.limit, total, items: items.map(view) });
});

// Static paths are registered before "/dlq/:id" so they are not captured as ids.
dlqRouter.post('/dlq/replay-all', async (_req, res) => {
  res.json(await replayAllDlq());
});

dlqRouter.delete('/dlq', async (_req, res) => {
  res.json({ cleared: await clearDlq() });
});

dlqRouter.get('/dlq/:id', async (req, res) => {
  const entry = await getDlqEntry(String(req.params.id));
  if (!entry) throw notFound('DLQ entry', String(req.params.id));
  res.json(view(entry));
});

dlqRouter.post('/dlq/:id/replay', async (req, res) => {
  const newJobId = await replayDlq(String(req.params.id));
  res.status(202).json({ replayed: true, jobId: newJobId });
});

dlqRouter.delete('/dlq/:id', async (req, res) => {
  await removeDlq(String(req.params.id));
  res.status(204).end();
});
