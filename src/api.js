import express from 'express';
import { safeRouter } from './safe.js';
import { db, now, round8, usd } from './db/index.js';
import config, { canRoute, canBill, MEASURE_CHOICES } from './config.js';
import { createAccount, checkPassword, startSession, endSession, session, requireUser, cookieFor, clearCookie,
  requestLoginCode, verifyLoginCode, verifyLoginLink } from './auth.js';
import send, { signInEmail } from './email.js';
import { issueKey, listKeys, revokeKey, revealKey } from './keys.js';
import { workloadStats, dailySpend, recentActivity, recentCalls, addActivity } from './traffic.js';
import { account, ledger, gateRouting, stripe } from './billing.js';
import { planFor, forgetPlan } from './eval/plan.js';
import { recipeKind } from './eval/select.js';
import { certificate, promote, revert } from './eval/promote.js';
import { stopMeasuring, closeAbandoned, rest } from './eval/run.js';
import { outcomeOf, cheaperCleared } from './eval/outcome.js';
import { switchStory } from './eval/switch-story.js';
import { enqueue } from './jobs.js';
import { routeOnce } from './proxy.js';

export const api = safeRouter();
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
      `SELECT 1 FROM calls WHERE workspace_id = ? AND source NOT IN ('replay', 'test')
          AND (status_code IS NULL OR status_code < 400) LIMIT 1`)
      .get(req.workspace.id) !== undefined,
    /* And somebody who has not finished the guide belongs there too, even once their traffic
       HAS arrived. The two are different events: a call landing is what makes the last step
       possible, and pressing the button on it is what ends the guide. Ending it on the call
       moved the app out from under somebody who was still reading. */
    onboarded: req.workspace.onboarded_at != null,
  });
});

/* The guide is finished. Said by the person, not inferred from their traffic. */
api.post('/connect/done', requireUser, async (req, res) => {
  if (req.workspace.onboarded_at == null) {
    await db.prepare('UPDATE workspaces SET onboarded_at = ? WHERE id = ?').run(now(), req.workspace.id);
  }
  res.json({ ok: true });
});

api.use(requireUser);

/* What the dashboard and the workloads page are built from ---------------------- */

const shapeLabel = { tool_call: 'tool call', json: 'json', enum: 'enum', free_text: 'free text' };

/* What this call actually asked, in one line. The last user turn is the part that differs
   from one call to the next: the instruction is what they all share, and is already shown
   at the top of the page as the shape. Content is cleared after the retention window, so
   this is often legitimately absent and says so rather than showing an empty cell. */
const CELL = 160;

/** The text of a message, whether it came as a string or as parts. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p?.text === 'string' ? p.text
      : (p?.type ? `[${String(p.type).replace('_', ' ')}]` : ''))).join('\n');
  }
  return '';
}

/** The whole of what was asked: every message in the request, in the order it was sent. */
function askedFull(c) {
  if (c.content_purged_at) return null;
  try {
    const req = JSON.parse(c.request_json || 'null');
    const msgs = Array.isArray(req?.messages) ? req.messages : [];
    if (!msgs.length) return null;
    return msgs.map((m) => {
      const body = contentText(m.content)
        || (m.tool_calls ? JSON.stringify(m.tool_calls, null, 2) : '');
      return `${String(m.role || 'message').toUpperCase()}\n${body}`;
    }).join('\n\n');
  } catch { return null; }
}

/** The whole of what came back. */
function answeredFull(c) {
  if (c.content_purged_at) return null;
  try {
    const res = JSON.parse(c.response_json || 'null');
    if (res?.error?.message) return String(res.error.message);
    const msg = res?.choices?.[0]?.message;
    if (!msg) return null;
    const text = contentText(msg.content);
    if (text.trim()) return text;
    const tools = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!tools.length) return null;
    return tools.map((t) => `CALLED ${t?.function?.name || 'a tool'}\n${t?.function?.arguments ?? ''}`).join('\n\n');
  } catch { return null; }
}

/* One line for the table, plus whether there is more of it than fits. A cell that already
   shows everything has nothing to open, so it is left alone rather than given a hover that
   repeats what is on the screen. */
function cellOf(full) {
  if (!full) return { text: null, more: false };
  const one = String(full).replace(/\s+/g, ' ').trim();
  if (!one) return { text: null, more: false };
  return { text: clip(one, CELL), more: one.length > CELL || /\n/.test(String(full).trim()) };
}

function askedOf(c) {
  const full = askedFull(c);
  if (!full) return { text: null, more: false };
  /* The last thing the customer said is the part that differs from call to call; the
     instruction above it is the same for every call in the workload. */
  try {
    const msgs = JSON.parse(c.request_json).messages || [];
    const last = [...msgs].reverse().find((m) => m.role === 'user') || msgs[msgs.length - 1];
    const one = String(contentText(last?.content)).replace(/\s+/g, ' ').trim();
    const cell = one ? clip(one, CELL) : null;
    return { text: cell, more: !!cell && (one.length > CELL || msgs.length > 1) };
  } catch { return cellOf(full); }
}

/* What the model answered, in one line, and whether there is more of it. */
const answeredOf = (c) => cellOf(answeredFull(c));

/* One call as a row. */
const callRow = (c) => {
  const asked = askedOf(c);
  const answered = answeredOf(c);
  return ({
  id: c.id,
  at: c.created_at,
  source: c.source,
  model: c.served_model || c.requested_model,
  status: c.status_code,
  promptTokens: c.prompt_tokens,
  completionTokens: c.completion_tokens,
  cost: round8(c.charged_usd || c.cost_usd || 0),
  latencyMs: c.latency_ms,
  asked: asked.text,
  askedMore: asked.more,
  answered: answered.text,
  answeredMore: answered.more,
  purged: !!c.content_purged_at,
  });
};

/* One measurement as a row, so the list and the open one never disagree. */
const runRow = (r) => ({
  id: r.id,
  status: r.status,
  // read from its error when the old process finished it without one, as everywhere else
  outcome: outcomeOf(r),
  trigger: r.trigger,
  sample: r.sample_size,
  models: r.models_planned,
  floor: r.floor_pct,
  noise: r.noise_pct,
  spend: round8(r.spend_usd || 0),
  error: r.error,
  done: r.steps_done ?? null,
  total: r.steps_total ?? null,
  at: r.finished_at || r.started_at || r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  reused: r.reused ?? 0,
  saved: round8(r.saved_usd || 0),
  judge: r.judge ?? null,
});

const parseJson = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };

/* One model's result in a measurement, the same everywhere it is shown. Beyond how often it
   disagreed: how fast it was on these calls, whether its provider refused it, why it was dropped
   if it was, how its answers mostly differed, and how it was asked. */
const resultRow = (r, runs = r.runs) => ({
  model: r.model_id, runs, gap: r.gap_pct, costMonth: r.cost_month_usd, verdict: r.verdict,
  failures: r.failures ?? 0, errors: r.errors ?? 0, stopped: r.stopped ?? null, errorText: r.error_text ?? null,
  difference: r.difference ?? null, reused: r.reused ?? 0,
  latencyP50: r.latency_p50 ?? null, latencyP90: r.latency_p90 ?? null,
  ttftP50: r.ttft_p50 ?? null, ttftP90: r.ttft_p90 ?? null,
  thinking: recipeKind(parseJson(r.recipe_json)),
  thinkingOff: recipeKind(parseJson(r.recipe_json)) === 'off',
  rank: parseJson(r.rank_json),
  gates: { structure: r.gate_structure, accuracy: r.gate_accuracy, coverage: r.gate_coverage, complete: r.gate_complete },
});

/* The customer's own model's speed on a measurement's calls, which every model is held to. */
const refSpeedOf = (run) => ({
  latencyP50: run.ref_latency_p50 ?? null, latencyP90: run.ref_latency_p90 ?? null,
  ttftP50: run.ref_ttft_p50 ?? null, ttftP90: run.ref_ttft_p90 ?? null,
});

/* The columns a measurement row is read with, wherever the page lists or opens one. */
const RUN_COLUMNS = `id, status, outcome, trigger, sample_size, models_planned, floor_pct, noise_pct,
  spend_usd, error, steps_done, steps_total, started_at, finished_at, created_at, reused, saved_usd, judge`;

/* Why a measurement has no models to show, in words somebody can act on. The page puts this
   where the chart would be. It used to leave the section out instead, so opening one of these
   from the history made "How the candidates compare" vanish without a word about why. */
function nothingCompared(r) {
  const ref = r.reference_model || 'your model';
  if (r.status === 'running') {
    return 'This measurement is still running. Each model appears here once it has answered every call.';
  }
  switch (outcomeOf(r)) {
    case 'refused':
      return `${ref} could not answer most of these calls when we replayed them, so there was no bar to hold a `
        + `cheaper model to.${r.ref_error ? ` ${r.ref_error}` : ''} Nothing was tried, and nothing was switched.`;
    case 'unmeasurable':
      return `${ref} gave a different answer to the same call ${Number(r.noise_pct ?? 0).toFixed(1)}% of the `
        + `time when we asked it each of ${r.sample_size} of your calls twice, so there was no steady bar `
        + 'to hold a cheaper model to. No models were tried, and nothing was switched.';
    case 'no_balance':
      return 'Your balance ran out once the bar was set, so no models were tried. Add credit and it can '
        + 'be measured again.';
    case 'stopped':
      return 'This measurement was stopped before any model had answered all of its calls, so there is '
        + 'nothing to compare. You were charged only for the calls it made, and nothing was switched.';
    case 'interrupted':
      return 'This measurement was interrupted before any model had answered all of its calls, so there '
        + 'is nothing to compare. Nothing was switched.';
    default:
      return 'No models were compared in this measurement.';
  }
}

const CALLS_PER_PAGE = 10;
const CALL_COLUMNS = `id, source, requested_model, served_model, status_code, prompt_tokens,
  completion_tokens, charged_usd, cost_usd, latency_ms, created_at, request_json, response_json,
  content_purged_at`;

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
    periods: PERIODS,
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
    activity: await liveFeed(workspaceId, 40),
  };
}

/* What the live feed says about one call.
 *
 * It has to read as an event, in a glance, to somebody who is watching the screen to find
 * out whether their integration works. So it leads with the thing they recognise: the job it
 * was grouped into if we know it yet, and otherwise plainly that a call arrived. */
function callLine(c) {
  const ms = c.latency_ms ? `${c.latency_ms} ms` : null;
  const model = c.served_model || c.requested_model || 'no model named';
  const failed = c.status_code && c.status_code >= 400;
  const job = c.workload || null;

  if (c.source === 'trace') {
    return { kind: 'copy',
      text: job ? `Copy received for ${job}, on ${model}` : `Copy received, on ${model}` };
  }
  if (c.source === 'test') {
    return { kind: failed ? 'bad' : 'test',
      text: failed ? `Test call did not get through, on ${model}` : `Test call went through, on ${model}` };
  }
  if (failed) {
    return { kind: 'bad', text: `A call did not get through, on ${model} (${c.status_code})` };
  }
  const head = job ? `${job} ran on ${model}` : `A call arrived, on ${model}`;
  return { kind: 'call', text: ms ? `${head}, ${ms}` : head };
}

/* An event, with any workload name in it brought up to date. */
function eventText(a) {
  const title = a.workload && /^Found a new workload: /.test(a.title)
    ? `Found a new workload: ${a.workload}`
    : a.title;
  return a.detail ? `${title}, ${a.detail}` : title;
}

/* One feed, from two sources: the calls, which are what somebody watches for, and the events
   worth knowing about between them. Merged and cut once, so the list reads in time order
   rather than as two lists stapled together. */
async function liveFeed(workspaceId, limit) {
  const [calls, events] = await Promise.all([
    recentCalls(workspaceId, limit),
    recentActivity(workspaceId, 12),
  ]);
  const items = [
    ...calls.map((c) => ({ at: c.created_at, ...callLine(c) })),
    ...events.map((a) => ({ at: a.created_at, kind: a.kind,
      /* Rewritten from the workload's CURRENT name, not the one it had when this was
         written. Announcing a workload and then renaming it left the feed disagreeing with
         the list it sits beside, which reads as two different things having happened. */
      text: eventText(a) })),
  ];
  items.sort((a, b) => b.at - a.at);
  return items.slice(0, limit).map((i) => ({ kind: i.kind, title: i.text, created_at: i.at }));
}

/* The window the screens are read over. Only these three, because the number goes straight
   into a date range and an arbitrary one from a query string is an easy way to ask the
   database for a decade of rows. */
export const PERIODS = [7, 30, 90];
const periodFrom = (q) => {
  const n = Number(q);
  return PERIODS.includes(n) ? n : 30;
};

api.get('/overview', async (req, res) =>
  res.json(await overview(req.workspace.id, periodFrom(req.query?.days))));

api.get('/workloads', async (req, res) =>
  res.json(await overview(req.workspace.id, periodFrom(req.query?.days))));

api.get('/workloads/:id', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  const since = now() - 30 * DAY;
  const t = await db.prepare(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(charged_usd), 0) AS cost FROM calls
      WHERE workload_id = ? AND created_at >= ? AND source NOT IN ('replay', 'test')`).get(w.id, since);
  /* A measurement nothing is running any more is closed before the page is told what is
     running, so a deploy in the middle of one cannot leave a bar here that never moves. */
  await closeAbandoned(w.id);
  const plan = await planFor(w, { canRoute: canRoute(), memo: true });
  const running = await db.prepare(
    `SELECT id, steps_total, steps_done, phase, spend_usd, started_at, models_planned, sample_size,
            stop_requested_at, heartbeat_at
       FROM eval_runs WHERE workload_id = ? AND status = 'running'
      ORDER BY created_at DESC LIMIT 1`).get(w.id);
  /* A measurement asked for and not started yet is a job waiting its turn, which can be a few
     seconds or, when the balance is short, much longer. The page shows it as one, with its Stop
     button, rather than hiding the panel at its first check and leaving a run to start a moment
     later with nobody watching it. A job claimed more than a minute ago with no run behind it
     was abandoned, and is not shown as waiting. */
  const waiting = running ? null : await db.prepare(
    `SELECT id, run_after FROM jobs WHERE kind = 'eval_run'
        AND (status = 'queued' OR (status = 'claimed' AND claimed_at > ?))
        AND (payload::jsonb ->> 'workloadId') = ?
      ORDER BY run_after LIMIT 1`).get(now() - 60000, w.id);
  const last = await db.prepare(
    `SELECT ${RUN_COLUMNS} FROM eval_runs WHERE workload_id = ? AND status != 'running'
      ORDER BY created_at DESC LIMIT 1`).get(w.id);
  const runCount = (await db.prepare('SELECT COUNT(*) AS n FROM eval_runs WHERE workload_id = ?').get(w.id)).n;
  const measure = {
    canRun: plan.canRun && !running && !waiting,
    reason: running ? 'A measurement is running now.'
      : waiting ? 'A measurement is waiting to start.' : plan.reason,
    pool: plan.pool,
    sample: plan.sample,
    models: Math.min(plan.models, plan.order.length),
    modelsWanted: plan.models,
    estimateUsd: plan.estimateUsd,
    picked: plan.order.slice(0, plan.models).map((r) => r.model),
    /* How the models were chosen, for the page to explain: what ruled each group out, in what
       order the rest will be tried and why, what Jev and the leaderboard said, how old each fact
       is, and the speed every model is held to. Nothing when no choice was made, because the
       workload has too few calls yet or nothing to measure against: a panel built from an empty
       plan read "Out of the 0 models switched on" on every new workload. */
    selection: !plan.funnel.length ? null : {
      want: plan.models,
      funnel: plan.funnel,
      ruledOut: Object.values(plan.excluded.reduce((a, e) => {
        a[e.step] = a[e.step] || { step: e.step, count: 0, examples: [] };
        a[e.step].count += 1;
        if (a[e.step].examples.length < 5) a[e.step].examples.push({ model: e.model, reason: e.reason });
        return a;
      }, {})).sort((x, y) => y.count - x.count),
      order: plan.order.slice(0, plan.models + 5).map((r) => ({
        model: r.model, savingShare: r.savingShare, chance: r.chance,
        parts: (r.parts || []).map((x) => ({ source: x.source, p: x.p, note: x.note })),
        family: r.family, thinking: recipeKind(r.recipe), thinkingOff: recipeKind(r.recipe) === 'off',
        speedChance: r.speedChance ?? null, answerChance: r.answerChance ?? null,
        speedMeasured: r.speedMeasured ?? null, busy: !!r.busy, mustThink: !!r.mustThink,
      })),
      queued: plan.order.length,
      beyond: plan.waiting,
      judge: plan.judge,
      jevResting: plan.jevResting,
      pendingJev: plan.pendingJev,
      difficulty: plan.difficulty,
      cachedBar: plan.cachedBar,
      factsAt: plan.factsAt,
      speed: plan.speed ? { pref: plan.speed.pref, auto: !!plan.speed.auto, factor: plan.speed.factor, metric: plan.speed.metric } : null,
      streamed: !!plan.profile?.streamed,
      outCap: plan.profile?.outCap ?? null,
      refThinks: plan.refThinks ?? null,
      reasoningSet: !!plan.profile?.reasoningSet,
    },
    runs: runCount,
    last: last ? runRow(last) : null,
    running: running ? {
      id: running.id,
      total: running.steps_total,
      done: running.steps_done,
      phase: running.phase,
      spend: round8(running.spend_usd || 0),
      startedAt: running.started_at,
      models: running.models_planned,
      sample: running.sample_size,
      // asked to stop and not there yet: the call in flight is finishing first
      stopping: !!running.stop_requested_at,
      /* when it was last heard from, and how long silence may last before it counts as having
         nothing running it, so a stop waiting on a run whose process has gone can say so */
      heartbeatAt: running.heartbeat_at ?? running.started_at,
      // as a duration, worked out here: the browser's clock is not the server's
      quietMs: Math.max(0, now() - (running.heartbeat_at ?? running.started_at ?? now())),
      staleMin: config.EVAL_STALE_MIN,
    } : waiting ? {
      queued: true, startsAt: waiting.run_after, total: 0, done: 0, spend: 0, phase: null,
    } : null,
  };

  /* A workload only says "Measuring" while something is measuring it. The status is stored,
     so a run that ended without clearing it, or a restart in the middle of one, would leave
     the word on the screen for ever. Correcting it here rather than only in a migration
     means it can never get stuck again, whatever ends a run. It goes back to what the last
     measurement that found anything found, the same rule a stop uses, rather than guessing
     "ready to optimize" from whether a bar was ever set. */
  /* "Ready to optimize" and "Nothing cleared yet" are read again too. The code before this set
     the first from whether a bar had ever been set, so some say it with no candidate behind
     them; and a run the old process finished during a deploy could set the second over a
     candidate an earlier measurement found. */
  if (((w.status === 'measuring' && !running && !waiting) || w.status === 'certified' || w.status === 'no_match')
    && await rest(w.id)) {
    Object.assign(w, await db.prepare('SELECT status, status_note FROM workloads WHERE id = ?').get(w.id));
  }

  const cert = await certificate(w.id);
  /* A candidate is what the run itself would switch to: cleared, priced, and cheaper a month.
     Any cleared model used to be offered, so one that cleared but cost more showed "-25% lower",
     "You keep -$2.50" and, in auto mode, "switches on its own", which it never would. */
  const best = cert ? cheaperCleared(cert.results).find((r) => r.model_id !== w.routed_model) : null;
  const refCost = cert?.referenceCostMonth ?? null;
  const compared = cert ? cert.results.filter((r) => r.verdict !== 'reference') : [];
  /* The newest measurement that compared any model. It can be older than the one shown, and
     the page offers it when the one shown has nothing to compare, so a measurement that could
     not set a bar never hides the comparison that came before it. */
  const lastComparison = await db.prepare(
    `SELECT r.id, COALESCE(r.finished_at, r.started_at, r.created_at) AS at,
            (SELECT COUNT(*) FROM eval_results e WHERE e.run_id = r.id AND e.verdict <> 'reference') AS models
       FROM eval_runs r WHERE r.workload_id = ? AND r.status <> 'running'
        AND EXISTS (SELECT 1 FROM eval_results e WHERE e.run_id = r.id AND e.verdict <> 'reference')
      ORDER BY r.created_at DESC LIMIT 1`).get(w.id);
  return res.json({
    id: w.id, name: w.slug, shape: shapeLabel[w.shape_kind] || w.shape_kind,
    tools: JSON.parse(w.tool_names || '[]'),
    model: w.routed_model || w.reference_model, reference: w.reference_model,
    optimizeMode: w.optimize_mode, floor: w.floor_pct,
    speedPref: w.speed_pref || null,
    calls: t.calls, cost: round8(t.cost),
    promotedAt: w.promoted_at,
    /* What a measurement would do, and whether it can. The button reads this rather than
       finding out the hard way after somebody presses it. */
    measure,
    ...statusLabel(w),
    certificate: cert && {
      runId: cert.run.id, outcome: outcomeOf(cert.run),
      rounds: cert.rounds, sampleSize: cert.run.sample_size, floor: cert.run.floor_pct,
      noise: cert.run.noise_pct, reference: cert.run.reference_model,
      finishedAt: cert.run.finished_at,
      referenceCostMonth: refCost,
      refSpeed: refSpeedOf(cert.run),
      judge: cert.run.judge ?? null,
      reused: cert.run.reused ?? 0,
      saved: round8(cert.run.saved_usd || 0),
      plan: parseJson(cert.run.plan_json),
      // this measurement's calls, like the reference row beside them and the note above them
      results: compared.map((r) => resultRow(r)),
      nothing: compared.length ? null : nothingCompared(cert.run),
    },
    lastComparison: lastComparison
      ? { runId: lastComparison.id, at: lastComparison.at, models: lastComparison.models }
      : null,
    /* For a workload we moved to a cheaper model: from what, to what, why, what it saves and
       what that comes to over time. Read from the switch's own record, never from whichever
       measurement is newest, which may not have tried the model serving it at all. */
    switched: w.routed_model ? await switchStory(w) : null,
    candidate: best && {
      model: best.model_id, gap: best.gap_pct, costMonth: best.cost_month_usd,
      accuracy: round8(100 - best.gap_pct),
    },
  });
});

/* The calls in a workload, a page at a time, optionally narrowed by a search.
 *
 * Paged on the server because a workload can hold tens of thousands of calls and the only
 * useful number to send the browser is the twenty-five it is about to draw. The search looks
 * at what people actually wrote and what came back, and at the model, and NOT at the JSON
 * around them: matching the raw request would make "content" or "role" match every call
 * there is, since those words are in the structure of every one. */
api.get('/workloads/:id/calls', async (req, res) => {
  const w = await db.prepare('SELECT id FROM workloads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');

  const q = String(req.query.q || '').trim().slice(0, 200);
  // a percent or an underscore typed into the box means itself, not a wildcard
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const where = `workload_id = ? AND source NOT IN ('replay', 'test')`
    + (q ? ` AND (
        served_model ILIKE ? OR requested_model ILIKE ?
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(request_json::jsonb -> 'messages') = 'array'
                  THEN request_json::jsonb -> 'messages' ELSE '[]'::jsonb END) m
           WHERE m ->> 'content' ILIKE ?)
        OR (response_json::jsonb #>> '{choices,0,message,content}') ILIKE ?)` : '');
  const args = q ? [w.id, like, like, like, like] : [w.id];

  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE ${where}`).get(...args)).n;
  const pages = Math.max(1, Math.ceil(total / CALLS_PER_PAGE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const rows = await db.prepare(
    `SELECT ${CALL_COLUMNS} FROM calls WHERE ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, CALLS_PER_PAGE, (page - 1) * CALLS_PER_PAGE);

  return res.json({ total, page, pages, per: CALLS_PER_PAGE, q, rows: rows.map(callRow) });
});

/* The whole of ONE field of one call, for reading a cell the table had to cut short.
 *
 * One field, not the whole call: a request and its answer together can run to tens of
 * thousands of characters, and somebody who rested the pointer on what was asked wants what
 * was asked. Fetched when they ask for it rather than sent with the page, because
 * twenty-five whole calls would be most of a megabyte that nobody reads. */
const FIELD_MAX = 20000;

api.get('/workloads/:id/calls/:callId/text', async (req, res) => {
  const which = req.query.field === 'answered' ? 'answered' : 'asked';
  const c = await db.prepare(
    `SELECT ${CALL_COLUMNS} FROM calls
      WHERE id = ? AND workload_id = ? AND workspace_id = ?`)
    .get(req.params.callId, req.params.id, req.workspace.id);
  if (!c) return fail(res, 404, 'No such call.');

  const whole = which === 'answered' ? answeredFull(c) : askedFull(c);
  const text = whole === null ? null : String(whole).slice(0, FIELD_MAX);
  return res.json({
    field: which,
    text,
    truncated: whole !== null && String(whole).length > FIELD_MAX,
    purged: !!c.content_purged_at,
    at: c.created_at,
    model: c.served_model || c.requested_model,
    status: c.status_code,
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

/* How much slower than the customer's own model a switched-to model may be on this workload.
   "auto" follows the traffic: streamed answers keep the same speed, others may be a little slower. */
const SPEED_PREFS = ['auto', 'same', 'slower_ok', 'any'];
api.post('/workloads/:id/speed', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  const pref = String(req.body?.pref || '');
  if (!SPEED_PREFS.includes(pref)) return fail(res, 400, 'That is not one of the choices.');
  await db.prepare('UPDATE workloads SET speed_pref = ?, updated_at = ? WHERE id = ?')
    .run(pref === 'auto' ? null : pref, now(), w.id);
  forgetPlan(w.id);
  return res.json({ ok: true, pref });
});

/* Start a measurement, or say why it cannot start.
 *
 * It used to mark the workload "Measuring" and queue a job that quietly declined a moment
 * later, so a workload with too few calls sat saying "Measuring" for ever and nobody was
 * ever told why. The same plan the button was shown decides here. */
api.post('/workloads/:id/measure', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');

  /* A run a restart left behind still says "running", and without this it would answer every
     press of the button with "already running" for ever. */
  await closeAbandoned(w.id);
  /* Running, or waiting its turn. A job that is only waiting has a payload of its own, so the
     queue's own check does not see a scheduled one when somebody presses the button, and a
     page left open could start a second measurement beside the first. */
  const running = await db.prepare(
    `SELECT id FROM eval_runs WHERE workload_id = ? AND status = 'running'
     UNION ALL
     SELECT id FROM jobs WHERE kind = 'eval_run' AND (payload::jsonb ->> 'workloadId') = ?
        AND (status = 'queued' OR (status = 'claimed' AND claimed_at > ?))
     LIMIT 1`).get(w.id, w.id, now() - 60000);
  if (running) return res.json({ ok: true, already: true });

  const plan = await planFor(w, { canRoute: canRoute() });
  if (!plan.canRun) return fail(res, 400, plan.reason);

  await enqueue('eval_run', { workloadId: w.id, trigger: 'manual' }, { unique: true });
  await db.prepare(`UPDATE workloads SET status = 'measuring', updated_at = ? WHERE id = ?`).run(now(), w.id);
  return res.json({ ok: true, sample: plan.sample, models: plan.candidates.length, estimateUsd: plan.estimateUsd });
});

/* Stop measuring. What already ran is kept and charged like any other call, and nothing is
   switched on the strength of a measurement that did not finish. A measurement still waiting
   in the queue is simply taken out of it. */
api.post('/workloads/:id/measure/stop', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  return res.json(await stopMeasuring(w, { actorUserId: req.user.id }));
});

/* Every measurement this workload has had, newest first. The results of each one are already
   kept; nothing ever showed them, so a switch made in October could not be looked up in
   November. */
api.get('/workloads/:id/runs', async (req, res) => {
  const w = await db.prepare('SELECT id FROM workloads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  const runs = await db.prepare(
    `SELECT ${RUN_COLUMNS} FROM eval_runs WHERE workload_id = ? ORDER BY created_at DESC LIMIT 30`).all(w.id);
  return res.json({ runs: runs.map(runRow) });
});

/* One measurement, with what every model scored in it. */
api.get('/workloads/:id/runs/:runId', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ? AND workload_id = ?')
    .get(req.params.runId, w.id);
  if (!run) return fail(res, 404, 'No such measurement.');
  const rows = await db.prepare(
    `SELECT * FROM eval_results WHERE run_id = ? ORDER BY cost_month_usd NULLS LAST`).all(run.id);
  const ref = rows.find((r) => r.verdict === 'reference');
  const compared = rows.filter((r) => r.verdict !== 'reference');
  return res.json({
    ...runRow(run),
    reference: run.reference_model,
    referenceCostMonth: ref?.cost_month_usd ?? null,
    refSpeed: refSpeedOf(run),
    plan: parseJson(run.plan_json),
    results: compared.map((r) => resultRow(r)),
    nothing: compared.length ? null : nothingCompared(run),
  });
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
    /* Both, not just the digits. The brand and last four are only there to be READ; the
       thing that can actually be charged is the payment method, and anything that clears
       that while leaving the digits behind leaves a card on screen that does not exist. */
    card: (acct.payment_method && acct.card_last4)
      ? { brand: acct.card_brand, last4: acct.card_last4 } : null,
    cardNote: acct.topup_failed_note,
    retentionDays: req.workspace.retention_days,
    evalModels: req.workspace.eval_models ?? config.EVAL_MODELS_DEFAULT,
    evalModelsMax: config.EVAL_MODELS_MAX,
    measureEveryDays: req.workspace.measure_every_days ?? config.MEASURE_EVERY_DAYS,
    measureChoices: MEASURE_OPTIONS,
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

/* How many models a measurement tries. More is a better picture of where quality falls off,
   and costs proportionally more, which is why there is a ceiling everyone shares. */
api.post('/settings/models-tested', async (req, res) => {
  const n = Math.round(Number(req.body?.count));
  if (!Number.isFinite(n) || n < 1 || n > config.EVAL_MODELS_MAX) {
    return fail(res, 400, `Pick between 1 and ${config.EVAL_MODELS_MAX} models.`);
  }
  await db.prepare('UPDATE workspaces SET eval_models = ? WHERE id = ?').run(n, req.workspace.id);
  return res.json({ ok: true, count: n });
});

/* How often measuring happens by itself. Zero is "only when I ask", and it is a real choice
   rather than an off switch: everything else still works, nothing is spent unasked.

   The cadences themselves are config's, and the screen draws whatever this sends. The screen
   used to keep its own copy of the list, which is how the default came to be a cadence it did
   not offer, and a workspace that never chose saw nothing selected at all. */
const measureLabel = (days) => (days === 0 ? 'Only when I ask' : days === 1 ? 'Every day' : `Every ${days} days`);
const MEASURE_OPTIONS = MEASURE_CHOICES.map((days) => ({ days, label: measureLabel(days) }));

api.post('/settings/measure-every', async (req, res) => {
  const days = Math.round(Number(req.body?.days));
  if (!MEASURE_CHOICES.includes(days)) return fail(res, 400, 'That is not one of the choices.');
  await db.prepare('UPDATE workspaces SET measure_every_days = ? WHERE id = ?').run(days, req.workspace.id);
  await addActivity(req.workspace.id, {
    kind: 'connect',
    title: days ? `Measuring every ${days} ${days === 1 ? 'day' : 'days'}` : 'Measuring only when you ask',
    detail: days
      ? 'Each workload is measured again on that cadence, and you are charged for the calls it replays.'
      : 'Nothing is measured, and nothing is spent, until you press Measure now on a workload.',
  });
  return res.json({ ok: true, days });
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

/* Adding credit.
 *
 * One hosted Checkout does both halves at once: it takes this top up, and it saves the card
 * so the automatic one can be charged later without the customer present. Stripe asks for
 * the consent to that in words WE supply, which is why custom_text is not optional here: an
 * off-session charge the customer never agreed to is a dispute waiting to happen. */
api.post('/billing/checkout', async (req, res) => {
  const s = await stripe();
  if (!s) {
    return res.status(503).json({ error: 'Payments are not set up on this deployment yet.' });
  }
  const asked = Number(req.body?.amountUsd);
  const amount = Math.min(config.TOPUP_MAX_USD,
    Math.max(config.TOPUP_MIN_USD, Number.isFinite(asked) ? asked : config.TOPUP_AMOUNT_USD));

  const acct = await account(req.workspace.id);
  let customer = acct.stripe_customer;
  if (!customer) {
    const made = await s.customers.create({
      email: req.user.email,
      name: req.user.name || undefined,
      metadata: { workspace_id: req.workspace.id },
    }, { idempotencyKey: `customer:${req.workspace.id}` });
    customer = made.id;
    await db.prepare('UPDATE billing_accounts SET stripe_customer = ?, updated_at = ? WHERE workspace_id = ?')
      .run(customer, now(), req.workspace.id);
  }

  const dollars = amount.toFixed(2);
  const session = await s.checkout.sessions.create({
    mode: 'payment',
    customer,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(amount * 100),
        product_data: {
          name: 'Understudy credit',
          description: 'Spent on the model calls we route for you, at cost plus '
            + `${config.ROUTING_FEE_PCT}%. Unused credit stays on your balance.`,
        },
      },
    }],
    payment_intent_data: {
      setup_future_usage: 'off_session',
      metadata: { workspace_id: req.workspace.id },
    },
    custom_text: {
      submit: {
        message: `We will save this card and charge it $${config.TOPUP_AMOUNT_USD.toFixed(2)} `
          + `automatically whenever your balance falls below $${config.TOPUP_THRESHOLD_USD.toFixed(2)}, `
          + 'so your calls do not stop. You can turn that off in Settings at any time.',
      },
    },
    success_url: `${config.PUBLIC_URL}/settings?credit=${dollars}`,
    cancel_url: `${config.PUBLIC_URL}/settings?credit=cancelled`,
    metadata: { workspace_id: req.workspace.id },
  }, {
    /* A double click, or a retried request, should land on the same payment page rather than
       opening a second one. Scoped to the minute so choosing the same amount again later is
       still a new top up. */
    idempotencyKey: `checkout:${req.workspace.id}:${dollars}:${Math.floor(Date.now() / 60000)}`,
  });
  res.json({ url: session.url });
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
  /* Only calls that actually worked. A call we turned away for an empty balance is recorded
     so the customer can see it arrived, but counting it here would tell the guide the job is
     done when nothing has been measured. */
  const traffic = await db.prepare(
    `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM calls
      WHERE workspace_id = ? AND source NOT IN ('replay', 'test')
        AND (status_code IS NULL OR status_code < 400)`).get(req.workspace.id);
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
  /* Shapes we have recognised but not yet shown, because they have not been seen often
     enough to be worth a row. Without this the first hour of a customer's traffic reads as
     "no workloads found", which looks like nothing is working when in fact it is. */
  const candidates = (await db.prepare(
    `SELECT COUNT(*) AS n FROM workloads WHERE workspace_id = ? AND state = 'candidate'
       AND merged_into IS NULL`).get(req.workspace.id)).n;
  /* The customer's own key, in full. It is the one thing they need off this screen, and
     showing eight characters of it beside a Copy button hands over something that cannot
     authenticate. Keys made before they were kept encrypted come back as null here, and the
     screen offers to replace them, because those really are unrecoverable. */
  const live = await revealKey(req.workspace.id);
  /* Calls that reached us and were turned away for an empty balance. This matters most on
     the very first run: the customer's wiring is CORRECT, and without this the guide would
     sit on "waiting for your first call" while their calls arrived and bounced, which reads
     as "your integration is broken" when the truth is "your wallet is empty". */
  const refused = (await db.prepare(
    `SELECT COUNT(*) AS n FROM calls WHERE workspace_id = ? AND status_code = 402`)
    .get(req.workspace.id)).n;
  const acct = await account(req.workspace.id);
  res.json({
    baseUrl: `${config.PUBLIC_URL}/v1`,
    key: live?.secret ?? null,
    balance: round8(acct.balance_usd),
    refused,
    /* Routed calls need credit; copies never do. Saying so only when it is actually in the
       way keeps it out of the face of somebody who is on the copies path. */
    needsCredit: refused > 0 && acct.balance_usd <= 0,
    keyPrefix: live?.prefix ?? keys[0]?.prefix ?? null,
    calls: traffic.n,
    lastCallAt: traffic.last ?? null,
    workloads,
    workloadCount,
    candidates,
    minCalls: config.WORKLOAD_MIN_CALLS,
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

/* Replace the key.
 *
 * Only a hash of a key is ever stored, so a key that has been lost cannot be shown again;
 * it can only be replaced. That is the whole reason this exists. The new one is returned in
 * full, once, right here, and everything still using the old one stops working, which the
 * screen says before it is pressed rather than after. */
api.post('/connect/regenerate-key', async (req, res) => {
  const live = (await listKeys(req.workspace.id)).filter((k) => !k.revoked_at);
  const fresh = await issueKey(req.workspace.id, 'production');
  for (const old of live) await revokeKey(req.workspace.id, old.id);
  await addActivity(req.workspace.id, {
    kind: 'connect',
    title: `New key ${fresh.prefix}`,
    detail: live.length
      ? `${live.length} older ${live.length === 1 ? 'key' : 'keys'} stopped working.`
      : 'Nothing was using a key before this one.',
  });
  return res.json({ ok: true, key: fresh.secret, prefix: fresh.prefix, replaced: live.length });
});

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
      WHERE COALESCE(wm.enabled, 1) = 1 AND c.price_in > 0 AND c.price_out > 0
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
