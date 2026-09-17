import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import config, { canRoute } from './config.js';
import { db, now } from './db/index.js';
import migrate from './db/migrate.js';
import { handle, startJobs, stopJobs, requeueStale, enqueue } from './jobs.js';
import { fetchModels, saveCatalog } from './openrouter.js';
import { runEvaluation } from './eval/run.js';
import { runTopUp } from './billing.js';
import { revert } from './eval/promote.js';
import api from './api.js';
import v1 from './proxy.js';

migrate();
requeueStale();

/* What the background does ------------------------------------------------------ */

handle('eval_run', async ({ workloadId }) => runEvaluation(workloadId));

handle('catalog_sync', async () => {
  if (!canRoute()) return { snoozeMs: 60 * 60000, note: 'no OPENROUTER_API_KEY' };
  const n = saveCatalog(await fetchModels());
  enqueue('catalog_sync', {}, { runAfter: now() + config.CATALOG_SYNC_HOURS * 3600000, unique: true });
  return { ok: true, models: n };
});

handle('topup', async ({ workspaceId }) => runTopUp(workspaceId));

/** Content ages out; the numbers the charts need do not. */
handle('purge', async () => {
  /* Each workspace chooses its own window in Settings, so this runs per workspace rather
     than against one deployment-wide cutoff. A window of 0 means keep indefinitely, and
     those workspaces are skipped entirely: nothing of theirs is ever blanked. */
  let a = 0;
  let b = 0;
  const spaces = db.prepare('SELECT id, retention_days FROM workspaces').all();
  for (const ws of spaces) {
    if (!ws.retention_days) continue;
    const cutoff = now() - ws.retention_days * 86400000;
    a += db.prepare(
      `UPDATE calls SET request_json = NULL, response_json = NULL, content_purged_at = ?
        WHERE workspace_id = ? AND created_at < ? AND content_purged_at IS NULL`)
      .run(now(), ws.id, cutoff).changes;
    b += db.prepare(
      `UPDATE eval_samples SET ref_a_json = NULL, ref_b_json = NULL, content_purged_at = ?
        WHERE content_purged_at IS NULL AND run_id IN (
          SELECT id FROM eval_runs WHERE workspace_id = ? AND created_at < ?)`)
      .run(now(), ws.id, cutoff).changes;
  }
  enqueue('purge', {}, { runAfter: now() + 6 * 3600000, unique: true });
  return { ok: true, calls: a, samples: b };
});

/** A promoted model is re-tested on fresh calls, and goes back the moment it stops clearing. */
handle('recheck', async () => {
  const due = db.prepare(
    `SELECT * FROM workloads WHERE routed_model IS NOT NULL AND updated_at < ?`)
    .all(now() - config.EVAL_RECHECK_HOURS * 3600000);
  for (const w of due) enqueue('eval_run', { workloadId: w.id }, { unique: true });
  enqueue('recheck', {}, { runAfter: now() + config.EVAL_RECHECK_HOURS * 3600000, unique: true });
  return { ok: true, queued: due.length };
});

export { revert };

/* The app ------------------------------------------------------------------------ */

export const app = express();
app.disable('x-powered-by');

// Stripe needs the raw body, so it is mounted before the global json parser
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const { handleWebhook } = await import('./stripe-webhook.js');
  return handleWebhook(req, res);
});

app.get('/health', (_req, res) => res.json({
  ok: true, routing: canRoute(), models: db.prepare('SELECT COUNT(*) AS n FROM models_catalog').get().n,
}));

// the customer's own traffic, authenticated by their key
app.use('/v1', v1);
// the screens
app.use('/api', api);

// the built single page app, with everything else falling through to it
const dist = path.resolve(process.cwd(), 'web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/(api|v1)\b).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.type('text/plain').send(
    'Understudy is running. The web build is missing: run `npm run build`.'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  enqueue('catalog_sync', {}, { unique: true });
  enqueue('purge', {}, { unique: true });
  enqueue('recheck', {}, { runAfter: now() + 3600000, unique: true });
  startJobs();
  const server = app.listen(config.PORT, () => {
    console.log(`Understudy on http://localhost:${config.PORT}`);
    console.log(`  routing: ${canRoute() ? 'ready' : 'no OPENROUTER_API_KEY, /v1 will answer 503'}`);
  });
  const bye = async () => { await stopJobs(); server.close(() => process.exit(0)); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

export default app;
