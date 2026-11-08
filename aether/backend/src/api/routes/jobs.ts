import { Router } from 'express';
import { listHandlers } from '../../queue/handlers';
import { enqueueJob, enqueueMany, getJobDetail, listJobs, removeJob } from '../../services/jobs';
import { bulkJobsSchema, createJobSchema, listJobsQuery } from '../schemas';

export const jobsRouter = Router();

/** Registered job types with a description and example payload (drives the dashboard composer). */
jobsRouter.get('/job-types', (_req, res) => {
  res.json({ items: listHandlers() });
});

/**
 * Create a job: run now, run after a delay (`delayMs` / `runAt`), or recurring (`cron`).
 * 202 for new work, 200 when an `idempotencyKey` matched an existing job.
 */
jobsRouter.post('/jobs', async (req, res) => {
  const input = createJobSchema.parse(req.body);
  const result = await enqueueJob(input, 'api');
  res.status(result.kind === 'job' && result.duplicate ? 200 : 202).json(result);
});

jobsRouter.post('/jobs/bulk', async (req, res) => {
  const { jobs } = bulkJobsSchema.parse(req.body);
  const results = await enqueueMany(jobs, 'api-bulk');
  const accepted = results.filter((r) => r.ok).length;
  res.status(202).json({ accepted, rejected: results.length - accepted, results });
});

jobsRouter.get('/jobs', async (req, res) => {
  const q = listJobsQuery.parse(req.query);
  const { items, total } = await listJobs(q.state, q.page, q.limit);
  res.json({ state: q.state, page: q.page, limit: q.limit, total, items });
});

jobsRouter.get('/jobs/:id', async (req, res) => {
  res.json(await getJobDetail(String(req.params.id)));
});

jobsRouter.delete('/jobs/:id', async (req, res) => {
  await removeJob(String(req.params.id));
  res.status(204).end();
});
