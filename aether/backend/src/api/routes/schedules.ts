import { Router } from 'express';
import { listSchedules, removeSchedule } from '../../services/schedules';

export const schedulesRouter = Router();

schedulesRouter.get('/schedules', async (_req, res) => {
  res.json({ items: await listSchedules() });
});

schedulesRouter.delete('/schedules/:id', async (req, res) => {
  await removeSchedule(String(req.params.id));
  res.status(204).end();
});
