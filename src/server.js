import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import config, { canRoute } from './config.js';
import { db, now } from './db/index.js';
import migrate from './db/migrate.js';
import { handle, startJobs, stopJobs, requeueStale, enqueue } from './jobs.js';
import { fetchModels, saveCatalog } from './openrouter.js';
import { reportCallFailure, canAlert, flushAllAlerts } from './alerts.js';
import { slug, shapeSignals } from './classify.js';
import { routeOnce } from './proxy.js';
import { runEvaluation } from './eval/run.js';
import { runTopUp } from './billing.js';
import { revert } from './eval/promote.js';
import api from './api.js';
import v1 from './proxy.js';

/* The schema has to exist before anything touches it, and both of these are asynchronous
   now that the database is over a network. Unawaited, the first queue write races the
   migrations: on a database that already has its tables nothing is noticed, and on a fresh
   one, which is every first deploy, the process dies on "relation does not exist". */
await migrate();
await requeueStale();

/* What the background does ------------------------------------------------------ */

handle('eval_run', async ({ workloadId }) => await runEvaluation(workloadId));

handle('catalog_sync', async () => {
  if (!canRoute()) return { snoozeMs: 60 * 60000, note: 'no OPENROUTER_API_KEY' };
  /* This is the earliest thing that breaks when the key is wrong or the credit is gone, and
     it breaks silently: the prices simply stop moving. Worth hearing about on its own. */
  let list;
  try {
    list = await fetchModels();
  } catch (err) {
    reportCallFailure({
      kind: 'model catalogue', status: err?.status ?? 0,
      message: err?.body?.error?.message || err.message,
    });
    throw err;
  }
  const n = await saveCatalog(list);
  await enqueue('catalog_sync', {}, { runAfter: now() + config.CATALOG_SYNC_HOURS * 3600000, unique: true });
  return { ok: true, models: n };
});

handle('topup', async ({ workspaceId }) => await runTopUp(workspaceId));

/* Workloads that existed before calls were grouped by shape.
 *
 * They carry no structure and no instruction signature, so nothing new could ever match
 * them and a customer's screens would empty out on deploy while a parallel set of
 * workloads built up beside them. This recomputes both from a call the workload already
 * holds, which is the same computation a live call goes through, and marks the ones with
 * enough traffic as live so they stay where their owner left them.
 *
 * It only ever touches rows that have no structure yet, so running it twice does nothing. */
handle('backfill_shapes', async () => {
  const rows = await db.prepare(
    `SELECT id, workspace_id FROM workloads WHERE struct_key IS NULL LIMIT 500`).all();
  let done = 0;
  for (const w of rows) {
    const call = await db.prepare(
      `SELECT request_json FROM calls WHERE workload_id = ? AND request_json IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`).get(w.id);
    const seen = (await db.prepare(
      `SELECT COUNT(*) AS n FROM calls WHERE workload_id = ?`).get(w.id))?.n ?? 0;
    let body = null;
    try { body = call?.request_json ? JSON.parse(call.request_json) : null; } catch { body = null; }
    if (!body) {
      /* Nothing left to recompute from, usually because the content aged out. Mark it so
         this does not come back to it, and leave it where it is. */
      await db.prepare(`UPDATE workloads SET struct_key = 'unknown', calls_seen = ?,
                          state = ? WHERE id = ?`)
        .run(seen, seen >= config.WORKLOAD_MIN_CALLS ? 'live' : 'candidate', w.id);
      done += 1;
      continue;
    }
    const sig = shapeSignals(body);
    /* The comparison happens here rather than in SQL on purpose. Two bare parameters in a
       CASE give Postgres nothing to infer a type from, so it compares them as text, and
       '190' >= '20' is false. Every workload whose count began with a 1 stayed hidden. */
    const live = seen >= config.WORKLOAD_MIN_CALLS ? 'live' : 'candidate';
    await db.prepare(`UPDATE workloads SET struct_key = ?, simhash = ?, fingerprint = ?,
                        calls_seen = ?, state = ?, updated_at = ? WHERE id = ?`)
      .run(sig.structKey, sig.simhash, sig.cacheKey, seen, live, now(), w.id);
    await db.prepare(
      `INSERT INTO workload_signatures (workspace_id, fingerprint, workload_id, simhash, struct_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, fingerprint) DO NOTHING`)
      .run(w.workspace_id, sig.cacheKey, w.id, sig.simhash, sig.structKey, now());
    done += 1;
  }
  if (rows.length === 500) await enqueue('backfill_shapes', {}, { unique: true });
  return { ok: true, backfilled: done };
});

/* Give a workload a name a person would recognise.
 *
 * This is the only place a model is involved in classification, and it is not classifying:
 * the grouping is already decided, deterministically and for free. All this does is turn a
 * shape into words. It runs ONCE per workload, off the request path, on the cheapest model
 * the workspace can reach, and if anything about it fails the heuristic name it already has
 * simply stays. A workload is never left without a name because a model was unavailable. */
handle('name_workload', async ({ workloadId }) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId);
  if (!w || w.named_at) return { ok: true, skipped: true };
  if (!canRoute()) return { ok: true, skipped: 'no provider' };

  const model = config.WORKLOAD_NAME_MODEL || (await db.prepare(
    `SELECT c.model_id FROM models_catalog c
       LEFT JOIN workspace_models wm ON wm.model_id = c.model_id AND wm.workspace_id = ?
      WHERE COALESCE(wm.enabled, 1) = 1 ORDER BY (c.price_in + c.price_out) ASC LIMIT 1`)
    .get(w.workspace_id))?.model_id;
  if (!model) return { ok: true, skipped: 'no model' };

  const tools = (() => { try { return JSON.parse(w.tool_names || '[]'); } catch { return []; } })();
  const ask = [
    'Name this kind of request in two to four words, as a short kebab-case slug.',
    'Describe the JOB it does, the way an engineer would name the function that sends it.',
    'Answer with the slug only, nothing else.',
    '',
    `Answer shape: ${w.shape_kind}`,
    tools.length ? `Tools offered: ${tools.join(', ')}` : '',
    `Instruction: ${String(w.sample_prompt || '').slice(0, 400)}`,
  ].filter(Boolean).join('\n');

  const out = await routeOnce(w.workspace_id, {
    model,
    messages: [{ role: 'user', content: ask }],
    max_tokens: 24,
  }, { source: 'test', classify: false });
  if (!out.ok) return { ok: true, skipped: out.json?.error?.message || 'call failed' };

  const raw = String(out.json?.choices?.[0]?.message?.content ?? '').trim();
  const named = slug(raw.split(/\s+/)[0] || '');
  /* A model that answers with a sentence, an empty string or something absurd leaves the
     name it already had. Nothing here is allowed to make the list worse. */
  /* We asked for two to four words as a slug, so a single word means the model answered
     with prose, or with a pleasantry, and the heuristic name it already has is better than
     whatever the first word of that happened to be. */
  if (!named || named.length < 3 || named.length > 40 || !named.includes('-')) {
    return { ok: true, skipped: 'unusable answer' };
  }

  const taken = await db.prepare(
    'SELECT 1 FROM workloads WHERE workspace_id = ? AND slug = ? AND id != ?')
    .get(w.workspace_id, named, w.id);
  const finalSlug = taken ? `${named}-${w.id.slice(-4)}` : named;
  await db.prepare('UPDATE workloads SET slug = ?, named_at = ?, name_source = ?, updated_at = ? WHERE id = ?')
    .run(finalSlug, now(), 'model', now(), w.id);
  return { ok: true, was: w.slug, now: finalSlug, model };
});

/** Content ages out; the numbers the charts need do not. */
handle('purge', async () => {
  /* Each workspace chooses its own window in Settings, so this runs per workspace rather
     than against one deployment-wide cutoff. A window of 0 means keep indefinitely, and
     those workspaces are skipped entirely: nothing of theirs is ever blanked. */
  let a = 0;
  let b = 0;
  const spaces = await db.prepare('SELECT id, retention_days FROM workspaces').all();
  for (const ws of spaces) {
    if (!ws.retention_days) continue;
    const cutoff = now() - ws.retention_days * 86400000;
    a += (await db.prepare(
      `UPDATE calls SET request_json = NULL, response_json = NULL, content_purged_at = ?
        WHERE workspace_id = ? AND created_at < ? AND content_purged_at IS NULL`)
      .run(now(), ws.id, cutoff)).changes;
    b += (await db.prepare(
      `UPDATE eval_samples SET ref_a_json = NULL, ref_b_json = NULL, content_purged_at = ?
        WHERE content_purged_at IS NULL AND run_id IN (
          SELECT id FROM eval_runs WHERE workspace_id = ? AND created_at < ?)`)
      .run(now(), ws.id, cutoff)).changes;
  }
  await enqueue('purge', {}, { runAfter: now() + 6 * 3600000, unique: true });
  return { ok: true, calls: a, samples: b };
});

/** A promoted model is re-tested on fresh calls, and goes back the moment it stops clearing. */
handle('recheck', async () => {
  const due = await db.prepare(
    `SELECT * FROM workloads WHERE routed_model IS NOT NULL AND updated_at < ?`)
    .all(now() - config.EVAL_RECHECK_HOURS * 3600000);
  for (const w of due) await enqueue('eval_run', { workloadId: w.id }, { unique: true });
  await enqueue('recheck', {}, { runAfter: now() + config.EVAL_RECHECK_HOURS * 3600000, unique: true });
  return { ok: true, queued: due.length };
});

export { revert };

/* The app ------------------------------------------------------------------------ */

export const app = express();
app.disable('x-powered-by');

// Stripe needs the raw body, so it is mounted before the global json parser
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const { handleWebhook } = await import('./stripe-webhook.js');
  return await handleWebhook(req, res);
});

app.get('/health', async (_req, res) => res.json({
  ok: true, routing: canRoute(), models: (await db.prepare('SELECT COUNT(*) AS n FROM models_catalog').get()).n,
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
  await enqueue('backfill_shapes', {}, { unique: true });
  await enqueue('catalog_sync', {}, { unique: true });
  await enqueue('purge', {}, { unique: true });
  await enqueue('recheck', {}, { runAfter: now() + 3600000, unique: true });
  startJobs();
  const server = app.listen(config.PORT, () => {
    console.log(`Understudy on http://localhost:${config.PORT}`);
    console.log(`  routing: ${canRoute() ? 'ready' : 'no OPENROUTER_API_KEY, /v1 will answer 503'}`);
    console.log(`  alerts:  ${canAlert() ? `a failed call emails ${config.ALERT_EMAIL}`
      : 'nowhere to send (set RESEND_API_KEY and ALERT_EMAIL)'}`);
  });
  const bye = async () => { await stopJobs(); await flushAllAlerts(); server.close(() => process.exit(0)); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

export default app;
