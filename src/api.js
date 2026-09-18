import express from 'express';
import { db, now, round8, usd } from './db/index.js';
import config, { canRoute, canBill } from './config.js';
import { createAccount, checkPassword, startSession, endSession, session, requireUser, cookieFor, clearCookie,
  requestLoginCode, verifyLoginCode, verifyLoginLink } from './auth.js';
import send, { signInEmail } from './email.js';
import { issueKey, listKeys, revokeKey } from './keys.js';
import { workloadStats, dailySpend, recentActivity, addActivity } from './traffic.js';
import { account, ledger, gateRouting } from './billing.js';
import { certificate, promote, revert } from './eval/promote.js';
import { enqueue } from './jobs.js';
import { routeOnce } from './proxy.js';

export const api = express.Router();
api.use(express.json({ limit: '2mb' }));
api.use(session);

const DAY = 86400000;
const fail = (res, code, message) => res.status(code).json({ error: message });

/* Accounts -------------------------------------------------------------------- */

api.post('/auth/sign-up', async (req, res) => {
  try {
    const { user, workspace, key } = await createAccount(req.body || {});
    res.setHeader('Set-Cookie', cookieFor(await startSession(user.id)));
    res.json({ ok: true, workspace: workspace.name, key: key.secret });
  } catch (err) { fail(res, 400, err.message); }
});

api.post('/auth/sign-in', async (req, res) => {
  const u = await checkPassword(req.body?.email, req.body?.password);
  if (!u) return fail(res, 401, 'That email and password do not match.');
  res.setHeader('Set-Cookie', cookieFor(await startSession(u.id)));
  return res.json({ ok: true });
});

/* Signing in without a password.

   Every answer here is the same whether or not the address has an account. An endpoint
   that says "no such user" is a way to find out who has one, and this one is reachable by
   anybody. What differs is only whether an email actually goes out. */
api.post('/auth/code/request', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail(res, 400, 'That does not look like an email address.');
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
  const asked = await requestLoginCode(email, { ip });
  if (!asked.ok && asked.reason === 'too_many') {
    return fail(res, 429, 'Too many codes asked for. Wait an hour, or sign in with your password.');
  }
  if (asked.send) {
    const link = `${config.PUBLIC_URL}/api/auth/link?token=${encodeURIComponent(asked.send.token)}`;
    const mail = signInEmail({ code: asked.send.code, link, minutes: asked.send.minutes });
    await send({ to: email, ...mail });
  }
  return res.json({ ok: true, minutes: config.LOGIN_CODE_TTL_MIN, digits: config.LOGIN_CODE_DIGITS });
});

api.post('/auth/code/verify', async (req, res) => {
  const out = await verifyLoginCode(req.body?.email, req.body?.code);
  if (!out.ok) {
    if (out.reason === 'wrong') {
      return fail(res, 401, out.triesLeft > 0
        ? `That code is not right. ${out.triesLeft} ${out.triesLeft === 1 ? 'try' : 'tries'} left.`
        : 'That code is not right, and it has now been used up. Ask for another.');
    }
    if (out.reason === 'too_many_attempts') {
      return fail(res, 429, 'That code has been used up. Ask for another.');
    }
    return fail(res, 401, 'That code has expired. Ask for another.');
  }
  res.setHeader('Set-Cookie', cookieFor(out.token));
  return res.json({ ok: true });
});

/* The link from the same email. A browser follows it, so this answers with a redirect
   rather than JSON, and lands the person inside the app already signed in. */
api.get('/auth/link', async (req, res) => {
  const out = await verifyLoginLink(req.query?.token);
  if (!out.ok) return res.redirect(302, '/signin?link=expired');
  res.setHeader('Set-Cookie', cookieFor(out.token));
  return res.redirect(302, '/');
});

api.post('/auth/sign-out', async (req, res) => {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)us_session=([^;]+)/);
  await endSession(m ? m[1] : null);
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});

api.get('/me', async (req, res) => {
  if (!req.user) return res.json({ signedIn: false });
  return res.json({
    signedIn: true,
    name: req.user.name || req.user.email.split('@')[0],
    email: req.user.email,
    workspace: req.workspace.name,
    mode: req.workspace.mode,
    canRoute: canRoute(),
    canBill: canBill(),
    // somebody whose traffic has never arrived belongs on Connect, not an empty dashboard
    connected: await db.prepare(
      `SELECT 1 FROM calls WHERE workspace_id = ? AND source NOT IN ('replay', 'test') LIMIT 1`)
      .get(req.workspace.id) !== undefined,
  });
});

api.use(requireUser);

/* What the dashboard and the workloads page are built from ---------------------- */

const shapeLabel = { tool_call: 'tool call', json: 'json', enum: 'enum', free_text: 'free text' };

const statusLabel = (w) => {
  if (w.routed_model) return { label: 'Optimized', tone: 'ok' };
  if (w.status === 'certified') return { label: 'Ready to optimize', tone: 'go' };
  if (w.status === 'measuring') return { label: 'Measuring', tone: 'wait' };
  if (w.status === 'no_match') return { label: 'Nothing cleared yet', tone: 'q' };
  return { label: 'Not optimized yet', tone: 'q' };
};

async function overview(workspaceId, days = 30) {
  const since = now() - days * DAY;
  const rows = await workloadStats(workspaceId, days);
  const spend = await db.prepare(
    `SELECT COALESCE(SUM(charged_usd), 0) AS s, COUNT(*) AS n FROM calls
      WHERE workspace_id = ? AND created_at >= ? AND source NOT IN ('replay', 'test')`).get(workspaceId, since);
  const series = await dailySpend(workspaceId, days);
  const saved = round8(series.reduce((a, d) => a + Math.max(0, d.would - d.paid), 0));
  const priced = (await db.prepare('SELECT COUNT(*) AS n FROM models_catalog').get()).n > 0;
  return {
    days,
    priced,
    spend: round8(spend.s),
    saved,
    calls: spend.n,
    workloads: rows.length,
    optimized: rows.filter((w) => w.routed_model).length,
    ready: rows.filter((w) => !w.routed_model && w.status === 'certified').length,
    measuring: rows.filter((w) => w.status === 'measuring').length,
    series,
    rows: rows.map((w) => ({
      id: w.id, name: w.slug, calls: w.calls,
      shape: shapeLabel[w.shape_kind] || w.shape_kind,
      cost: round8(w.spend),
      model: w.routed_model || w.reference_model || 'not set',
      ...statusLabel(w),
    })),
    activity: await recentActivity(workspaceId, 5),
  };
}

api.get('/overview', async (req, res) => res.json(await overview(req.workspace.id)));

api.get('/workloads', async (req, res) => res.json(await overview(req.workspace.id)));

api.get('/workloads/:id', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  const since = now() - 30 * DAY;
  const t = await db.prepare(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(charged_usd), 0) AS cost FROM calls
      WHERE workload_id = ? AND created_at >= ? AND source NOT IN ('replay', 'test')`).get(w.id, since);
  const cert = await certificate(w.id);
  const best = cert?.results.find((r) => r.verdict === 'cleared' && r.model_id !== w.routed_model);
  const refCost = cert?.referenceCostMonth ?? null;
  return res.json({
    id: w.id, name: w.slug, shape: shapeLabel[w.shape_kind] || w.shape_kind,
    tools: JSON.parse(w.tool_names || '[]'),
    model: w.routed_model || w.reference_model, reference: w.reference_model,
    optimizeMode: w.optimize_mode, floor: w.floor_pct,
    calls: t.calls, cost: round8(t.cost),
    promotedAt: w.promoted_at,
    ...statusLabel(w),
    certificate: cert && {
      rounds: cert.rounds, sampleSize: cert.run.sample_size, floor: cert.run.floor_pct,
      noise: cert.run.noise_pct, reference: cert.run.reference_model,
      finishedAt: cert.run.finished_at,
      referenceCostMonth: refCost,
      results: cert.results.filter((r) => r.verdict !== 'reference').map((r) => ({
        model: r.model_id, runs: r.runs_total, gap: r.gap_pct,
        costMonth: r.cost_month_usd, verdict: r.verdict,
        gates: { structure: r.gate_structure, accuracy: r.gate_accuracy, coverage: r.gate_coverage, complete: r.gate_complete },
      })),
    },
    candidate: best && {
      model: best.model_id, gap: best.gap_pct, costMonth: best.cost_month_usd,
      accuracy: round8(100 - best.gap_pct),
    },
  });
});

api.post('/workloads/:id/mode', async (req, res) => {
  const mode = req.body?.mode === 'ask' ? 'ask' : 'auto';
  const changed = (await db.prepare('UPDATE workloads SET optimize_mode = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(mode, now(), req.params.id, req.workspace.id)).changes;
  if (!changed) return fail(res, 404, 'No such workload.');
  return res.json({ ok: true, mode });
});

api.post('/workloads/:id/promote', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  const cert = await certificate(w.id);
  const pick = req.body?.model
    || cert?.results.find((r) => r.verdict === 'cleared')?.model_id;
  if (!pick) return fail(res, 400, 'Nothing has cleared your bar on this workload yet.');
  return res.json(await promote(w, pick, { runId: cert?.run.id, actorUserId: req.user.id, reason: 'you approved it' }));
});

api.post('/workloads/:id/revert', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  return res.json(await revert(w, { actorUserId: req.user.id }));
});

api.post('/workloads/:id/measure', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  await enqueue('eval_run', { workloadId: w.id }, { unique: true });
  await db.prepare(`UPDATE workloads SET status = 'measuring', updated_at = ? WHERE id = ?`).run(now(), w.id);
  return res.json({ ok: true });
});

/* Models ------------------------------------------------------------------------ */

api.get('/models', async (req, res) => {
  const rows = await db.prepare(
    `SELECT c.*, COALESCE(wm.enabled, 1) AS enabled FROM models_catalog c
       LEFT JOIN workspace_models wm ON wm.model_id = c.model_id AND wm.workspace_id = ?
      ORDER BY (c.price_in + c.price_out)`).all(req.workspace.id);
  const serving = await db.prepare(
    `SELECT slug, COALESCE(routed_model, reference_model) AS m FROM workloads
      WHERE workspace_id = ? AND state = 'live' AND merged_into IS NULL`)
    .all(req.workspace.id);
  const where = new Map();
  for (const s of serving) {
    if (!s.m) continue;
    where.set(s.m, [...(where.get(s.m) || []), s.slug]);
  }
  res.json({
    zdrOnly: config.ZDR_ONLY,
    models: rows.map((m) => ({
      id: m.model_id, name: m.name,
      priceIn: round8(m.price_in * 1e6), priceOut: round8(m.price_out * 1e6),
      openWeights: !!m.open_weights, enabled: !!m.enabled,
      where: where.get(m.model_id) || [],
    })),
  });
});

api.post('/models/:id(*)/enabled', async (req, res) => {
  const enabled = req.body?.enabled ? 1 : 0;
  await db.prepare(`INSERT INTO workspace_models (workspace_id, model_id, enabled, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(workspace_id, model_id) DO UPDATE SET enabled = excluded.enabled,
                updated_at = excluded.updated_at`)
    .run(req.workspace.id, req.params.id, enabled, now());
  res.json({ ok: true, enabled: !!enabled });
});

/* Settings ----------------------------------------------------------------------- */

/* The windows a customer can choose, and what each one means in plain words. 0 is a real
   choice: keep everything, which is what a customer wants when they expect to re-measure a
   model against old traffic later. */
const RETENTION_CHOICES = [
  { days: 30, label: '30 days' },
  { days: 60, label: '60 days' },
  { days: 90, label: '90 days' },
  { days: 0, label: 'Keep indefinitely' },
];


api.get('/settings', async (req, res) => {
  const acct = await account(req.workspace.id);
  res.json({
    name: req.user.name, email: req.user.email,
    mode: req.workspace.mode,
    keys: (await listKeys(req.workspace.id)).filter((k) => !k.revoked_at),
    balance: round8(acct.balance_usd),
    autoTopUp: !!acct.auto_topup,
    topUpAmount: config.TOPUP_AMOUNT_USD,
    topUpThreshold: config.TOPUP_THRESHOLD_USD,
    card: acct.card_last4 ? { brand: acct.card_brand, last4: acct.card_last4 } : null,
    cardNote: acct.topup_failed_note,
    retentionDays: req.workspace.retention_days,
    retentionChoices: RETENTION_CHOICES,
    zdrOnly: config.ZDR_ONLY,
    canBill: canBill(),
    ledger: await ledger(req.workspace.id, 10),
    routing: await gateRouting(req.workspace.id),
  });
});

api.post('/settings/keys', async (req, res) => {
  const k = await issueKey(req.workspace.id, String(req.body?.name || 'production').slice(0, 40));
  await addActivity(req.workspace.id, { kind: 'connect', title: `New key ${k.prefix}`, detail: 'Shown once, right now.' });
  res.json({ ok: true, key: k.secret, prefix: k.prefix });
});

api.delete('/settings/keys/:id', async (req, res) => {
  if (!await revokeKey(req.workspace.id, req.params.id)) return fail(res, 404, 'No such key.');
  return res.json({ ok: true });
});

api.post('/settings/profile', async (req, res) => {
  const name = String(req.body?.name ?? req.user.name).slice(0, 80);
  const email = String(req.body?.email ?? req.user.email).trim().toLowerCase().slice(0, 160);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail(res, 400, 'That does not look like an email address.');
  }
  if (email !== req.user.email) {
    const taken = await db.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
      .get(email, req.user.id);
    if (taken) return fail(res, 409, 'That email address is already in use.');
  }
  await db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, req.user.id);
  return res.json({ ok: true, name, email });
});

api.post('/settings/retention', async (req, res) => {
  const days = Number(req.body?.days);
  if (!RETENTION_CHOICES.some((c) => c.days === days)) {
    return fail(res, 400, 'That is not one of the retention choices.');
  }
  await db.prepare('UPDATE workspaces SET retention_days = ? WHERE id = ?').run(days, req.workspace.id);
  await addActivity(req.workspace.id, {
    kind: 'connect',
    title: days ? `Call content is now kept for ${days} days` : 'Call content is now kept indefinitely',
    detail: days
      ? 'Older request and response bodies are cleared. The figures behind the charts are kept.'
      : 'Nothing is cleared on a schedule any more.',
  });
  return res.json({ ok: true, days });
});

api.post('/settings/auto-topup', async (req, res) => {
  await db.prepare(`UPDATE billing_accounts SET auto_topup = ?, topup_failed_note = NULL, updated_at = ?
               WHERE workspace_id = ?`)
    .run(req.body?.enabled ? 1 : 0, now(), req.workspace.id);
  res.json({ ok: true });
});

/* Connect ------------------------------------------------------------------------ */

api.get('/connect', async (req, res) => {
  const keys = (await listKeys(req.workspace.id)).filter((k) => !k.revoked_at);
  const traffic = await db.prepare(
    `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM calls
      WHERE workspace_id = ? AND source NOT IN ('replay', 'test')`).get(req.workspace.id);
  const workloads = await db.prepare(
    `SELECT w.slug, w.reference_model,
            (SELECT COUNT(*) FROM calls c WHERE c.workload_id = w.id AND c.source NOT IN ('replay', 'test')) AS calls
       FROM workloads w WHERE w.workspace_id = ? AND w.state = 'live' AND w.merged_into IS NULL
       ORDER BY calls DESC LIMIT 5`).all(req.workspace.id);
  /* What the customer is shown, not everything that has ever been grouped. Shapes seen a
     handful of times are real and counted, but a list of them helps nobody. */
  const workloadCount = (await db.prepare(
    `SELECT COUNT(*) AS n FROM workloads WHERE workspace_id = ? AND state = 'live'
       AND merged_into IS NULL`).get(req.workspace.id)).n;
  res.json({
    baseUrl: `${config.PUBLIC_URL}/v1`,
    keyPrefix: keys[0]?.prefix ?? null,
    calls: traffic.n,
    lastCallAt: traffic.last ?? null,
    workloads,
    workloadCount,
    lastTest: await lastTestCall(req.workspace.id),
    canRoute: canRoute(),
  });
});

/** Cut long text where it can be read, and say that it was cut. */
const clip = (t, n) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);

/** The most recent test call, so the panel still says how it went after a reload. */
async function lastTestCall(workspaceId) {
  const row = await db.prepare(
    `SELECT served_model, status_code, latency_ms, charged_usd, created_at
       FROM calls WHERE workspace_id = ? AND source = 'test'
      ORDER BY created_at DESC LIMIT 1`).get(workspaceId);
  if (!row) return null;
  return {
    ok: row.status_code === 200,
    model: row.served_model,
    latencyMs: row.latency_ms,
    costUsd: round8(row.charged_usd),
    at: row.created_at,
  };
}

/* Sends one real call down the routed path and says what came back. It is the same path a
   customer's own call takes, which is the only way a test can prove anything: the same
   gate, the same provider, the same charge. It is recorded as a test rather than as
   traffic, so it never turns into a workload or moves any of their numbers. */
/* The cheapest model this workspace is allowed to reach. A test call should cost as close
   to nothing as possible, and it has to be a model they can actually be served, otherwise
   the test fails for a reason that has nothing to do with their connection. */
async function testModelFor(workspaceId) {
  const row = await db.prepare(
    `SELECT c.model_id FROM models_catalog c
       LEFT JOIN workspace_models wm ON wm.model_id = c.model_id AND wm.workspace_id = ?
      WHERE COALESCE(wm.enabled, 1) = 1
      ORDER BY (c.price_in + c.price_out) ASC LIMIT 1`).get(workspaceId);
  if (row) return row.model_id;
  const own = await db.prepare(
    `SELECT reference_model FROM workloads WHERE workspace_id = ? AND reference_model IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1`).get(workspaceId);
  return own?.reference_model ?? null;
}

api.post('/connect/test', async (req, res) => {
  const model = await testModelFor(req.workspace.id);
  if (!model) {
    return res.json({
      ok: false,
      reason: 'No models are enabled for this workspace yet, so there is nothing to call.',
      at: now(),
    });
  }
  const out = await routeOnce(req.workspace.id, {
    model,
    messages: [
      { role: 'system', content: 'Answer with one word and nothing else.' },
      { role: 'user', content: 'If you can read this, reply: connected' },
    ],
    max_tokens: 12,
  }, { source: 'test', classify: false });

  if (!out.ok) {
    return res.status(200).json({
      ok: false,
      reason: out.json?.error?.message || 'The call did not get through.',
      at: now(),
    });
  }
  await addActivity(req.workspace.id, {
    kind: 'connect',
    title: 'Test call went through',
    detail: `${out.served} answered in ${out.latencyMs} ms.`,
  });
  return res.json({
    ok: true,
    model: out.served,
    latencyMs: out.latencyMs,
    costUsd: round8(out.costUsd),
    reply: clip(String(out.json?.choices?.[0]?.message?.content ?? '').trim(), 60),
    at: now(),
  });
});

export default api;
