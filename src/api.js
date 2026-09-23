import express from 'express';
import { safeRouter } from './safe.js';
import { db, now, round8, usd } from './db/index.js';
import config, { canRoute, canBill, canEmail, canRevealKeys, paymentsState, MEASURE_CHOICES } from './config.js';
import { allow, clientIp } from './limits.js';
import crypto from 'node:crypto';
import { startSignUp, checkPassword, startSession, endSession, session, requireUser, cookieFor, clearCookie,
  requestLoginCode, verifyLoginCode, verifyLoginLink, peekLoginLink, changePassword, endOtherSessions,
  requestEmailChange, verifyEmailChange, Refusal, signupCookieFor, clearSignupCookie, signupNonceOf } from './auth.js';
import send, { codeEmail, accountExistsEmail, noticeEmail } from './email.js';
import { issueKey, listKeys, revokeKey, revealKey, revealKeyById } from './keys.js';
import { workloadStats, dailySpend, recentActivity, recentCalls, addActivity, track } from './traffic.js';
import { account, ledger, gateRouting, stripe, topUpAmountOf, allowanceLeft, available, optimizeSpent, spentOnCalls } from './billing.js';
import { notifyPrefs, NOTIFY_KINDS } from './notify.js';
import { routedSavings } from './eval/actual.js';
import { adviceFor } from './eval/advice.js';
import { planFor, forgetPlan, forgetPlanAll } from './eval/plan.js';
import { cadenceOf } from './eval/schedule.js';
import { recipeKind } from './eval/select.js';
import { outcomeSummary, outcomeTotals, tasksFor } from './learn/views.js';
import { nameOfResult, armById } from './learn/arms.js';
import { saveDef } from './learn/outcomes.js';
import { learningView, exploreOf, forgetState, EXPLORE_MODES } from './learn/explore.js';
import { certificate, promote, revert, trafficOf, servingKey, heldBack } from './eval/promote.js';
import { stopMeasuring, closeAbandoned, rest } from './eval/run.js';
import { outcomeOf, cheaperCleared, carriesOf } from './eval/outcome.js';
import { switchStory } from './eval/switch-story.js';
import { enqueue } from './jobs.js';
import { routeOnce } from './proxy.js';
import { forgetWorkspace } from './workspace.js';

export const api = safeRouter();
api.use(express.json({ limit: '2mb' }));
api.use(session);

const DAY = 86400000;
const fail = (res, code, message) => res.status(code).json({ error: message });

/* Accounts -------------------------------------------------------------------- */

const tooMany = (res, message) => fail(res, 429, message);

/* An email sent without waiting for it. Whether an address has an account decides whether a code goes
   out, so waiting for the send made the answer slower for addresses that have one, which told anybody
   timing it who does. A send that fails is logged; the answer never depended on it. */
const sendLater = (message) => { send(message).catch((err) => console.error(`email to ${message.to} failed: ${err?.message || err}`)); };
// where an emailed link lands: a page with a button, because opening a link must never sign anybody in
const linkFor = (token) => `${config.PUBLIC_URL}/signin/link#t=${encodeURIComponent(token)}`;

/* Signing up sends a code to the address, and the account is made usable when the code comes back.
   The answer is the same whether or not the address already has an account. */
api.post('/auth/sign-up', async (req, res) => {
  const ip = clientIp(req);
  if (!await allow('signup_ip', ip, { max: config.LIMIT_SIGNUP_PER_IP_HOUR, windowMs: 3600000 })) {
    return tooMany(res, 'Too many sign-ups from here. Try again in an hour.');
  }
  // this browser's own secret: only a code used from here keeps the password chosen here (see startSignUp)
  const nonce = crypto.randomBytes(24).toString('base64url');
  let out;
  try {
    out = await startSignUp(req.body || {}, { ip, nonce });
  } catch (err) {
    // our own words for a person; anything else is ours to fix and is answered as a failure of ours
    if (err instanceof Refusal) return fail(res, 400, err.message);
    throw err;
  }
  if (!out.ok) return tooMany(res, 'Too many codes asked for this address. Wait an hour, then try again.');
  if (out.send?.kind === 'verify') {
    sendLater({ to: out.email, ...codeEmail({ purpose: 'verify', code: out.send.code, link: linkFor(out.send.token), minutes: out.send.minutes }) });
  } else if (out.send?.kind === 'exists') {
    sendLater({ to: out.email, ...accountExistsEmail({ signInUrl: `${config.PUBLIC_URL}/signin` }) });
  }
  res.setHeader('Set-Cookie', signupCookieFor(nonce));
  return res.json({ ok: true, verify: true, email: out.email, minutes: config.LOGIN_CODE_TTL_MIN, digits: config.LOGIN_CODE_DIGITS });
});

api.post('/auth/sign-in', async (req, res) => {
  const ip = clientIp(req);
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!await allow('signin_ip', ip, { max: config.LIMIT_SIGNIN_PER_IP_15MIN, windowMs: 900000 })
    || !await allow('signin_email', email || '-', { max: 10, windowMs: 900000 })) {
    return tooMany(res, 'Too many tries. Wait a few minutes, or sign in with an emailed code.');
  }
  const u = await checkPassword(email, req.body?.password);
  if (!u) return fail(res, 401, 'That email and password do not match.');
  res.setHeader('Set-Cookie', cookieFor(await startSession(u.id)));
  return res.json({ ok: true });
});

/* Signing in without a password.

   Every answer here is the same whether or not the address has an account, and the limits count
   every address the same way, so neither the words nor the limits say who has one. What differs is
   only whether an email actually goes out. */
api.post('/auth/code/request', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail(res, 400, 'That does not look like an email address.');
  }
  const ip = clientIp(req);
  if (!await allow('code_request_ip', ip, { max: config.LIMIT_CODES_PER_IP_HOUR, windowMs: 3600000 })) {
    return tooMany(res, 'Too many codes asked for from here. Wait an hour, or sign in with your password.');
  }
  const asked = await requestLoginCode(email, { ip });
  if (!asked.ok && asked.reason === 'too_many') {
    return tooMany(res, 'Too many codes asked for. Wait an hour, or sign in with your password.');
  }
  if (asked.send) {
    sendLater({ to: email, ...codeEmail({ purpose: 'sign_in', code: asked.send.code, link: linkFor(asked.send.token), minutes: asked.send.minutes }) });
  }
  return res.json({ ok: true, minutes: config.LOGIN_CODE_TTL_MIN, digits: config.LOGIN_CODE_DIGITS });
});

/* The code from a sign-in email or a sign-up email: either works here. */
api.post('/auth/code/verify', async (req, res) => {
  const ip = clientIp(req);
  if (!await allow('code_verify_ip', ip, { max: config.LIMIT_VERIFY_PER_IP_HOUR, windowMs: 3600000 })) {
    return tooMany(res, 'Too many tries from here. Wait an hour and ask for a new code.');
  }
  const out = await verifyLoginCode(req.body?.email, req.body?.code, { nonce: signupNonceOf(req) });
  if (!out.ok) {
    if (out.reason === 'wrong') {
      return fail(res, 401, out.triesLeft > 0
        ? `That code is not right. ${out.triesLeft} ${out.triesLeft === 1 ? 'try' : 'tries'} left.`
        : 'That code is not right, and it has now been used up. Ask for another.');
    }
    if (out.reason === 'too_many_attempts') return tooMany(res, 'That code has been used up. Ask for another.');
    return fail(res, 401, 'That code has expired. Ask for another.');
  }
  res.setHeader('Set-Cookie', [cookieFor(out.token), clearSignupCookie()]);
  /* A new account's first key is made when its email answers, and handed over here, the one moment it
     can be: without it, a deployment that cannot show keys again left the new customer holding nothing
     but the key's first few characters. */
  return res.json({ ok: true, fresh: !!out.fresh, key: out.key || null, passwordKept: out.passwordKept ?? null });
});

/* The link from the same emails. Links in mail sent before this signed in when opened; they are
   sent to the page that asks first. The token travels after a #, so it never reaches a server log. */
api.get('/auth/link', (req, res) => res.redirect(302, `/signin/link#t=${encodeURIComponent(String(req.query?.token || ''))}`));

/** Whom a link would sign in, so the page can say so before anything is spent. */
api.post('/auth/link/peek', async (req, res) => {
  const ip = clientIp(req);
  if (!await allow('code_verify_ip', ip, { max: config.LIMIT_VERIFY_PER_IP_HOUR, windowMs: 3600000 })) {
    return tooMany(res, 'Too many tries from here. Wait an hour.');
  }
  const out = await peekLoginLink(req.body?.token);
  return res.json(out.ok ? { ok: true, email: out.email, purpose: out.purpose } : { ok: false });
});

api.post('/auth/link', async (req, res) => {
  const ip = clientIp(req);
  if (!await allow('code_verify_ip', ip, { max: config.LIMIT_VERIFY_PER_IP_HOUR, windowMs: 3600000 })) {
    return tooMany(res, 'Too many tries from here. Wait an hour.');
  }
  const out = await verifyLoginLink(req.body?.token, { nonce: signupNonceOf(req) });
  if (!out.ok) return fail(res, 401, 'That link has expired or has already been used. Ask for a new one.');
  res.setHeader('Set-Cookie', [cookieFor(out.token), clearSignupCookie()]);
  return res.json({ ok: true, fresh: !!out.fresh, key: out.key || null, passwordKept: out.passwordKept ?? null });
});

api.post('/auth/sign-out', async (req, res) => {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)us_session=([^;]+)/);
  await endSession(m ? m[1] : null);
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});

/* The contact form, open to anybody.

   What people write goes to the operator's inbox and is never stored here. The address it goes to
   is never shown on a page, and a reply goes straight back to whoever wrote. Limited per internet
   address and per day, because an open form is otherwise a way to send mail through us. */
const TOPICS = ['question', 'sales', 'support', 'privacy', 'security', 'other'];
api.post('/contact', async (req, res) => {
  const b = req.body || {};
  // a field people never see; only scripts fill it in
  if (b.website) return res.json({ ok: true });
  const email = String(b.email || '').trim().toLowerCase();
  const message = String(b.message || '').trim();
  const name = String(b.name || '').trim().slice(0, 120);
  const topic = TOPICS.includes(b.topic) ? b.topic : 'other';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'That does not look like an email address.');
  if (message.length < 10) return fail(res, 400, 'Say a little more, so we can answer properly.');
  if (message.length > 5000) return fail(res, 400, 'That is longer than we can take here. Keep it under 5,000 characters.');
  const ip = clientIp(req);
  if (!await allow('contact_ip', ip, { max: config.LIMIT_CONTACT_PER_IP_HOUR, windowMs: 3600000 })
    || !await allow('contact_all', 'all', { max: config.LIMIT_CONTACT_PER_DAY, windowMs: 86400000 })) {
    return fail(res, 429, 'We have had a lot of messages from here. Try again in an hour.');
  }
  const to = config.CONTACT_TO || config.ALERT_EMAIL;
  if (!to) return fail(res, 503, 'The contact form is not set up on this deployment yet.');
  const who = req.user ? `${req.user.email} (signed in, workspace ${req.workspace?.id ?? 'none'})` : 'not signed in';
  const text = [`Topic: ${topic}`, `From: ${name || '(no name)'} <${email}>`, `Account: ${who}`, '', message].join('\n');
  const sent = await send({ to, subject: `Understudy contact: ${topic}${name ? ` from ${name}` : ''}`, text, replyTo: email });
  if (!sent.ok) return fail(res, 502, 'We could not send that just now. Try again in a minute.');
  return res.json({ ok: true });
});

/* What is working right now, for the status page and for checking a deploy. Nothing here is
   private: it says whether routing, email and payments are switched on, not how. */
api.get('/status', async (_req, res) => {
  const models = (await db.prepare('SELECT COUNT(*) AS n FROM models_catalog').get())?.n ?? 0;
  const synced = await db.prepare(`SELECT source, synced_at FROM fact_sync ORDER BY synced_at DESC`).all();
  const last = (source) => synced.find((r) => r.source === source)?.synced_at ?? null;
  res.json({
    ok: true,
    version: (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || 'local').slice(0, 7),
    routing: canRoute(),
    email: canEmail(),
    payments: paymentsState(),
    models,
    catalogSyncedAt: last('catalog'),
    providersSyncedAt: last('zdr'),
    checkedAt: now(),
  });
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
    payments: paymentsState(),
    // proved by a sign-in code, so the password typed at sign-up was cleared: they choose their own
    needsPassword: !!req.user.pw_cleared,
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
  // what it was quoted before it started, how many of the bar's answers were read from the customer's own calls,
  // what the judge got right on the pairs it was tested with, and which yardstick it measured with
  quote: r.quote_usd ?? null,
  recordedRefs: r.recorded_refs ?? null,
  judgeCheck: parseJson(r.judge_check_json),
  yardstick: r.yardstick ?? 'agreement',
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
  // a strategy rather than one model: what to call it, and how often it sent a call on
  name: nameOfResult(r),
  escalated: r.escalated_pct ?? null,
  costRatio: r.cost_ratio ?? null,
  // where the true gap most likely is, and how many calls a clear would take at this bar
  gapLo: r.gap_lo ?? null,
  gapHi: r.gap_hi ?? null,
  callsNeeded: r.calls_needed ?? null,
  // the second look, on calls it had never seen, when it had one
  confirm: r.confirm_verdict ? {
    verdict: r.confirm_verdict, runs: r.confirm_runs ?? 0, gap: r.confirm_gap ?? null, hi: r.confirm_hi ?? null,
    floor: r.confirm_floor ?? null,
  } : null,
});

/* The customer's own model's speed on a measurement's calls, which every model is held to. */
const refSpeedOf = (run) => ({
  latencyP50: run.ref_latency_p50 ?? null, latencyP90: run.ref_latency_p90 ?? null,
  ttftP50: run.ref_ttft_p50 ?? null, ttftP90: run.ref_ttft_p90 ?? null,
});

/* The columns a measurement row is read with, wherever the page lists or opens one. */
const RUN_COLUMNS = `id, status, outcome, trigger, sample_size, models_planned, floor_pct, noise_pct,
  spend_usd, error, steps_done, steps_total, started_at, finished_at, created_at, reused, saved_usd, judge,
  quote_usd, recorded_refs, judge_check_json, yardstick`;

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

/* `carries` says whether any of this workload's latest calls come through us. A switch on one
   that only sends copies is set up and waiting: it changes nothing until calls are routed, so it
   is not called optimized. */
const statusLabel = (w, carries = true) => {
  if (w.routed_model) return carries ? { label: 'Optimized', tone: 'ok' } : { label: 'Waiting for routing', tone: 'wait' };
  if (w.status === 'certified') return { label: 'Ready to optimize', tone: 'go' };
  if (w.status === 'measuring') return { label: 'Measuring', tone: 'wait' };
  if (w.status === 'no_match') return { label: 'Nothing cleared yet', tone: 'q' };
  return { label: 'Not optimized yet', tone: 'q' };
};

/* The dashboard reads itself again every few seconds; how calls turned out over a month moves far more
   slowly than that, so it is worked out at most once a minute per workspace and window. */
const outcomeMemo = new Map();
async function outcomesFor(workspaceId, days, since) {
  const k = `${workspaceId}|${days}`;
  const hit = outcomeMemo.get(k);
  if (hit && Date.now() - hit.at < 60000) return hit.v;
  const v = await outcomeTotals(workspaceId, since);
  outcomeMemo.set(k, { at: Date.now(), v });
  if (outcomeMemo.size > 2000) outcomeMemo.clear();
  return v;
}

/* What a switch is called in the list of workloads, when it is more than one model asked the usual way. */
function shortStrategy(w) {
  if (!w.routed_model || !w.arm_spec) return null;
  let spec = null;
  try { spec = JSON.parse(w.arm_spec); } catch { return null; }
  const s = (m) => String(m || '').split('/').pop();
  if (spec.kind === 'cascade') return `${s(spec.first.model)}, checked`;
  if (spec.kind === 'router') return `${s(spec.cheap.model)}, picked per call`;
  if (spec.kind === 'model' && spec.model === w.reference_model && spec.recipe?.reasoning) return `${s(spec.model)}, thinking less`;
  return null;
}

async function overview(workspaceId, days = 30) {
  const since = now() - days * DAY;
  const rows = await workloadStats(workspaceId, days);
  const spend = await db.prepare(
    `SELECT COALESCE(SUM(charged_usd), 0) AS s, COUNT(*) AS n FROM calls
      WHERE workspace_id = ? AND created_at >= ? AND source NOT IN ('replay', 'test')`).get(workspaceId, since);
  /* What the customer is actually ahead by: what their routed calls would have cost on their own
     models, less what they paid us for them, less what measuring and background answers cost. Each
     part is given, so a screen can say where the figure comes from; it used to count only the days
     that saved something, and to price their own model with our fee on it. */
  const actual = await routedSavings({ workspaceId, days, at: now() });
  const series = actual.series;
  const optimizing = await optimizeSpent(workspaceId, days);
  const saved = round8(actual.saved - optimizing);
  const priced = (await db.prepare('SELECT COUNT(*) AS n FROM models_catalog').get()).n > 0;
  return {
    days,
    periods: PERIODS,
    priced,
    spend: round8(spend.s),
    saved,
    savings: {
      // on the calls themselves: their own models' cost against what they paid us, fee included
      onCalls: actual.saved, paid: actual.paid, would: actual.would,
      // what optimizing cost over the same days: measurements and background answers, fee included
      optimizing,
      net: saved,
      // how many routed calls a cheaper strategy answered
      switchedCalls: actual.switched, routedCalls: actual.calls,
    },
    calls: spend.n,
    workloads: rows.length,
    // switched, and some calls come through us to be switched; a switch on copies alone is waiting
    optimized: rows.filter((w) => w.routed_model && carriesOf({ mode: w.ws_mode, routed: w.recent_routed })).length,
    waiting: rows.filter((w) => w.routed_model && !carriesOf({ mode: w.ws_mode, routed: w.recent_routed })).length,
    ready: rows.filter((w) => !w.routed_model && w.status === 'certified').length,
    measuring: rows.filter((w) => w.status === 'measuring').length,
    series,
    // how calls turned out over the window, in the same four groups each workload page shows
    outcomes: await outcomesFor(workspaceId, days, since),
    rows: rows.map((w) => ({
      id: w.id, name: w.slug, calls: w.calls,
      shape: shapeLabel[w.shape_kind] || w.shape_kind,
      cost: round8(w.spend),
      // a strategy by its short name: a cascade is its cheap model, checked; the customer's model thinking less says so
      model: shortStrategy(w) || w.routed_model || w.reference_model || 'not set',
      ...statusLabel(w, carriesOf({ mode: w.ws_mode, routed: w.recent_routed, copies: w.recent_copies })),
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
  /* Why a call ran where it did, when that is not what serves it: the check sent it on to the
     customer's own model, the router picked that model, or it was one of the few calls an experiment
     answers. Without it, a switched workload's feed showed its old model now and then, which read as
     the switch failing. */
  let by = null;
  try { by = c.check_json ? JSON.parse(c.check_json).by : null; } catch { by = null; }
  const why = Number(c.explored) === 1 ? ', an experiment'
    : Number(c.escalated) !== 1 ? ''
      : by === 'router' ? ', picked for the harder calls'
        : by === 'unavailable' || by === 'check failed' ? ', sent on because the check could not answer'
          : by === 'first failed' ? ', sent on because the cheaper model failed'
            : ', sent on by the check';
  const head = job ? `${job} ran on ${model}${why}` : `A call arrived, on ${model}`;
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
  // whether its calls come through us, so the page offers a switch or a recommendation
  const traffic = await trafficOf(w);
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
    /* What a measurement is worth: what it is expected to find a month, what the switch already saves
       and protects, and the most one may spend on this workload. A measurement nobody asks for runs
       only when it would pay for itself within EVAL_PAYBACK_MONTHS. */
    worth: plan.worth ? { ...plan.worth, paybackMonths: config.EVAL_PAYBACK_MONTHS } : null,
    ceilingUsd: plan.ceilingUsd ?? null,
    optimizeBudget: plan.optimizeBudget ?? null,
    // how many of the bar's answers can be read from the customer's own calls rather than bought
    recordedShare: plan.recordedShare ?? 0,
    // how often the workspace measures by itself, zero for only when asked, and when this one is next looked at
    everyDays: await cadenceOf(w.workspace_id),
    nextAt: w.recheck_after ? Number(w.recheck_after) : null,
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
        model: r.model, key: r.key ?? null, label: r.label ?? null, savingShare: r.savingShare, chance: r.chance,
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
  // what serves it now, by the name its measurement row carries: a cascade's is its own, not its cheap model's
  const servingAs = w.routed_model ? await servingKey(w) : null;
  const best = cert ? cheaperCleared(cert.results).find((r) => r.model_id !== servingAs) : null;
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
    servingKey: servingAs,
    optimizeMode: w.optimize_mode, floor: w.floor_pct,
    // savings the customer can make in their own code, with what each would save (src/eval/advice.js)
    advice: await adviceFor(w),
    speedPref: w.speed_pref || null,
    calls: t.calls, cost: round8(t.cost),
    promotedAt: w.promoted_at,
    /* What a measurement would do, and whether it can. The button reads this rather than
       finding out the hard way after somebody presses it. */
    measure,
    ...statusLabel(w, traffic.carries),
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
      // held to the same answer as the customer's own model, or to one at least as good
      yardstick: cert.run.yardstick ?? 'agreement',
      // how many of the bar's answers were the customer's own, read rather than bought
      recordedRefs: cert.run.recorded_refs ?? null,
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
      name: nameOfResult(best), escalated: best.escalated_pct ?? null,
      // the second look on calls it had never seen, when it had one: a candidate it did not confirm waits for a person
      confirm: best.confirm_verdict ? { verdict: best.confirm_verdict, runs: best.confirm_runs ?? 0, gap: best.confirm_gap ?? null,
        hi: best.confirm_hi ?? null, floor: best.confirm_floor ?? null } : null,
      // switched back from before, so switching never picks it again by itself; a person still can
      heldBack: (await heldBack(w.id)).has(best.model_id),
    },
    /* A switch still taking over: the share of calls it answers now, the steps it passes through, and
       what it has to show at this one before it takes the next. */
    rollout: w.rollout_share === null || w.rollout_share === undefined ? null : {
      share: Number(w.rollout_share), stage: Number(w.rollout_stage ?? 0), stages: config.ROLLOUT_STAGES,
      startedAt: Number(w.rollout_started_at ?? w.promoted_at ?? 0), stageHours: config.ROLLOUT_STAGE_HOURS,
      minCalls: config.ROLLOUT_MIN_CALLS, from: w.rollout_from_arm_id ? (await armById(w.rollout_from_arm_id))?.label ?? null : null,
    },
    traffic: { routed: traffic.routed, copies: traffic.copies, carries: traffic.carries, observe: traffic.observe },
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

  /* A search reads the text of every stored call, on the same database the live calls use. One
     account running a dozen of them at once used to slow every other customer's calls to seconds.
     So a search gets three seconds, a workspace runs two at a time, and the count stops at a
     thousand: past that nobody pages through, they search for something narrower. */
  if (q) {
    const running = searching.get(req.workspace.id) || 0;
    if (running >= 2) return fail(res, 429, 'Two searches are already running. Wait for them to finish.');
    searching.set(req.workspace.id, running + 1);
  }
  try {
    const out = await db.tx(async (tx) => {
      if (q) await tx.exec(`SET LOCAL statement_timeout = ${SEARCH_TIMEOUT_MS}`);
      const counted = Number((await tx.prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM calls WHERE ${where} LIMIT ${COUNT_CAP + 1}) x`).get(...args)).n);
      const total = Math.min(counted, COUNT_CAP);
      const pages = Math.max(1, Math.ceil(total / CALLS_PER_PAGE));
      const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
      const rows = await tx.prepare(
        `SELECT ${CALL_COLUMNS} FROM calls WHERE ${where}
          ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...args, CALLS_PER_PAGE, (page - 1) * CALLS_PER_PAGE);
      return { total, more: counted > COUNT_CAP, page, pages, per: CALLS_PER_PAGE, q, rows: rows.map(callRow) };
    });
    return res.json(out);
  } catch (err) {
    // 57014 is Postgres cancelling a statement that ran past its time
    if (err?.code === '57014') {
      return res.json({ total: 0, page: 1, pages: 1, per: CALLS_PER_PAGE, q, rows: [], timedOut: true,
        message: 'That search took too long. Try fewer words, or more particular ones.' });
    }
    throw err;
  } finally {
    if (q) {
      const n = (searching.get(req.workspace.id) || 1) - 1;
      if (n > 0) searching.set(req.workspace.id, n); else searching.delete(req.workspace.id);
    }
  }
});
const searching = new Map();
const SEARCH_TIMEOUT_MS = 3000;
const COUNT_CAP = 1000;

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

/* How this workload is switched: on its own, only once somebody approves, or never (measured, and a
   person can still approve by hand). Anything else is refused rather than read as "on its own": the
   page offering two choices used to turn a "never" workload into an automatic one with one click. */
api.post('/workloads/:id/mode', async (req, res) => {
  const mode = String(req.body?.mode || '');
  if (!['auto', 'ask', 'off'].includes(mode)) return fail(res, 400, 'Choose auto, ask or off.');
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
  /* The model named, or the one the measurement itself would switch to: cleared, priced, cheaper once
     our fee is added, and confirmed by the second look before one that was not. The first model that
     cleared, whatever it cost, used to be taken. */
  const pick = req.body?.model || (cert ? cheaperCleared(cert.results)[0]?.model_id : null);
  if (!pick) return fail(res, 400, 'Nothing has cleared your bar on this workload yet.');
  // a person may take all of the calls at once; otherwise it starts on a share and grows
  return res.json(await promote(w, pick, { runId: cert?.run.id, actorUserId: req.user.id, reason: 'you approved it',
    rollout: req.body?.rollout !== false }));
});

/* A switch still taking over a share at a time, given every call now, because a person says so. */
api.post('/workloads/:id/rollout/finish', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  if (w.rollout_share === null || w.rollout_share === undefined) return res.json({ ok: true, already: true });
  await db.prepare(`UPDATE workloads SET rollout_share = NULL, rollout_stage = NULL, rollout_started_at = NULL,
      rollout_from_arm_id = NULL, updated_at = ? WHERE id = ?`).run(now(), w.id);
  forgetState(w.id);
  await addActivity(req.workspace.id, {
    kind: 'ok', title: `${w.slug} now answers all of its calls on the new strategy`,
    detail: 'You gave it every call at once rather than a share at a time.', workloadId: w.id,
  });
  return res.json({ ok: true });
});

api.post('/workloads/:id/revert', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  return res.json(await revert(w, { actorUserId: req.user.id }));
});

/* How a workload's calls turned out: read from the traffic that followed them and from what the
   customer reported, with the definition of "worked" they can change. */
api.get('/workloads/:id/outcomes', async (req, res) => {
  const w = await db.prepare('SELECT id FROM workloads WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  return res.json({
    ...(await outcomeSummary(w.id, 30)),
    // what the page shows as the way to report outcomes
    endpoint: `${config.PUBLIC_URL}/v1/outcomes`,
    callIdHeader: 'x-understudy-call-id',
    refHeader: 'x-understudy-ref',
  });
});

api.post('/workloads/:id/outcomes/def', async (req, res) => {
  const w = await db.prepare('SELECT id FROM workloads WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  const b = req.body || {};
  if (b.events !== undefined && !Array.isArray(b.events)) return fail(res, 400, 'events has to be a list.');
  if ((b.events || []).length > 100) return fail(res, 400, 'At most 100 events can be given a meaning.');
  const bad = (b.events || []).find((e) => !e || typeof e !== 'object' || typeof e.event !== 'string' || !e.event.trim()
    || e.event.length > 80 || !['worked', 'failed'].includes(e.means));
  if (bad !== undefined) return fail(res, 400, 'Each event needs a name of up to 80 characters and a meaning: worked or failed.');
  if (b.signals !== undefined && (typeof b.signals !== 'object' || b.signals === null)) return fail(res, 400, 'signals has to be an object.');
  /* Saved at once; the calls it touches are read again behind the answer, since on a busy workload
     that is every call with a signal in three months, far longer than anybody should wait on Save. */
  const def = await saveDef(w.id, b, { reread: false });
  track(def.reread, `reading ${w.id} again under its new meaning of worked`);
  return res.json({ ok: true, def: { events: def.events, signals: def.signals, windowDays: def.windowDays }, rereading: true });
});

/** The multi-step tasks this workload's calls were part of. */
api.get('/workloads/:id/tasks', async (req, res) => {
  const w = await db.prepare('SELECT id FROM workloads WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  return res.json(await tasksFor(w.id));
});

/** What live calls are teaching about this workload's strategies, and how much it may experiment. */
api.get('/workloads/:id/learning', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  return res.json(await learningView(w));
});

/* How much a workload may experiment: off, in the background only, or on a small share of its
   calls, and the most a day's experiments may add to the bill. */
api.post('/workloads/:id/explore', async (req, res) => {
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspace.id);
  if (!w) return fail(res, 404, 'No such workload.');
  const b = req.body || {};
  let mode = w.explore_mode;
  if (b.mode !== undefined) {
    if (b.mode !== 'auto' && !EXPLORE_MODES.includes(b.mode)) return fail(res, 400, 'That is not one of the choices.');
    mode = b.mode === 'auto' ? null : b.mode;
  }
  let budget = w.explore_budget_usd;
  if (b.budgetUsd !== undefined) {
    // a number of dollars or null for the default; nothing else, so an empty box never saves as $0
    if (b.budgetUsd !== null && (typeof b.budgetUsd !== 'number' || !Number.isFinite(b.budgetUsd) || b.budgetUsd < 0 || b.budgetUsd > 1000)) {
      return fail(res, 400, 'The budget has to be between $0 and $1,000 a day.');
    }
    if (b.budgetUsd !== null && b.budgetUsd > 0 && b.budgetUsd < 0.01) return fail(res, 400, 'The smallest budget is one cent a day, or $0 to stop experiments.');
    budget = b.budgetUsd === null ? null : Math.round(b.budgetUsd * 100) / 100;
  }
  await db.prepare('UPDATE workloads SET explore_mode = ?, explore_budget_usd = ?, updated_at = ? WHERE id = ?')
    .run(mode, budget, now(), w.id);
  forgetState(w.id);
  const saved = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(w.id);
  return res.json({ ok: true, explore: exploreOf(saved) });
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
  /* How many providers that keep nothing serve each model, once that list has been read at least once;
     before then nothing is known, and the page says "not reported" rather than "none". */
  const zdrKnown = !!(await db.prepare(`SELECT 1 FROM fact_sync WHERE source = 'zdr'`).get());
  res.json({
    zdrOnly: req.workspace.zdr_required !== 0,
    models: rows.map((m) => ({
      id: m.model_id, name: m.name,
      priceIn: round8(m.price_in * 1e6), priceOut: round8(m.price_out * 1e6),
      openWeights: !!m.open_weights, enabled: !!m.enabled,
      where: where.get(m.model_id) || [],
      zdr: zdrKnown ? Number(m.zdr || 0) : null,
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
  const free = await available(req.workspace.id);
  const planActive = acct.plan_status === 'active';
  res.json({
    name: req.user.name, email: req.user.email,
    // signed in with a code after the password was cleared: a new one is set without the old
    needsPassword: !!req.user.pw_cleared,
    mode: req.workspace.mode,
    keys: (await listKeys(req.workspace.id)).filter((k) => !k.revoked_at),
    balance: round8(acct.balance_usd),
    // set aside for calls in flight right now, and what is free to spend
    held: round8(free.held),
    free: round8(free.free),
    autoTopUp: !!acct.auto_topup,
    topUpAmount: topUpAmountOf(acct),
    topUpThreshold: config.TOPUP_THRESHOLD_USD,
    topUpMaxPerDay: config.TOPUP_MAX_PER_DAY,
    topUpMin: config.TOPUP_MIN_USD,
    topUpMax: config.TOPUP_MAX_USD,
    payments: paymentsState(),
    plan: planActive ? {
      allowanceTotal: config.EVAL_ALLOWANCE_USD,
      allowanceLeft: await allowanceLeft(req.workspace.id),
      periodStart: (await account(req.workspace.id)).allowance_period_start,
    } : null,
    /* Both, not just the digits. The brand and last four are only there to be READ; the
       thing that can actually be charged is the payment method, and anything that clears
       that while leaving the digits behind leaves a card on screen that does not exist. */
    card: (acct.payment_method && acct.card_last4)
      ? { brand: acct.card_brand, last4: acct.card_last4, forTopUps: Number(acct.card_for_topups || 0) === 1 } : null,
    // whether this deployment keeps keys in a form it can show again (KEY_SECRET is set)
    canRevealKeys: canRevealKeys(),
    passwordMin: 8,
    cardNote: acct.topup_failed_note,
    retentionDays: req.workspace.retention_days,
    evalModels: req.workspace.eval_models ?? config.EVAL_MODELS_DEFAULT,
    evalModelsMax: config.EVAL_MODELS_MAX,
    measureEveryDays: req.workspace.measure_every_days ?? config.MEASURE_EVERY_DAYS,
    measureChoices: MEASURE_OPTIONS,
    retentionChoices: RETENTION_CHOICES,
    zdrOnly: req.workspace.zdr_required !== 0,
    zdrForced: config.ZDR_FORCED,
    // how a new workload is switched: ask first, on its own, or not at all
    defaultOptimizeMode: req.workspace.default_optimize_mode || config.DEFAULT_OPTIMIZE_MODE,
    // whether this workspace's results (never content) may help other workspaces choose models
    shareStats: Number(req.workspace.share_stats || 0) === 1,
    // the most optimizing may spend over thirty days, and what it has
    optimizeBudget: req.workspace.optimize_budget_usd ?? null,
    optimizeSpent: await optimizeSpent(req.workspace.id),
    // marking long instructions for caching where that pays
    cacheHints: Number(req.workspace.cache_hints ?? 1) !== 0,
    cacheHintsAvailable: config.CACHE_HINTS,
    // the most calls may cost through us in a day and a month, and what they have
    limits: await (async () => {
      const spent = await spentOnCalls(req.workspace.id);
      return { dailyUsd: req.workspace.daily_limit_usd ?? null, monthlyUsd: req.workspace.monthly_limit_usd ?? null,
        spentToday: spent.day, spentMonth: spent.month };
    })(),
    // which emails the workspace gets
    notify: notifyPrefs(req.workspace),
    notifyKinds: NOTIFY_KINDS,
    canBill: canBill(),
    ledger: await ledger(req.workspace.id, 10),
    routing: await gateRouting(req.workspace.id),
  });
});

/* Whether this workspace's calls only go to providers that keep nothing. Turning it off is a real
   choice with a real cost, so it is said in the activity feed in words, and it never reaches
   providers that train on what they are sent. */
api.post('/settings/zdr', async (req, res) => {
  if (config.ZDR_FORCED) return fail(res, 400, 'Zero data retention is required for every workspace on this deployment.');
  const required = req.body?.required !== false;
  await db.prepare('UPDATE workspaces SET zdr_required = ? WHERE id = ?').run(required ? 1 : 0, req.workspace.id);
  forgetWorkspace(req.workspace.id);
  await addActivity(req.workspace.id, {
    kind: 'connect',
    title: required ? 'Only providers that keep nothing' : 'Providers that keep data briefly are allowed',
    detail: required
      ? 'Every call goes only to providers that keep nothing of what they are sent.'
      : 'Calls may go to providers that keep what they are sent for a while (usually for abuse checks), '
        + 'never to ones that train on it. More models can be used, and measured.',
  });
  return res.json({ ok: true, required });
});

/* How a new workload is switched. Workloads that exist keep what they have unless asked to follow. */
api.post('/settings/default-mode', async (req, res) => {
  const mode = String(req.body?.mode || '');
  if (!['ask', 'auto', 'off'].includes(mode)) return fail(res, 400, 'Choose ask, auto or off.');
  await db.prepare('UPDATE workspaces SET default_optimize_mode = ? WHERE id = ?').run(mode, req.workspace.id);
  let moved = 0;
  if (req.body?.applyToExisting === true) {
    moved = (await db.prepare(`UPDATE workloads SET optimize_mode = ?, updated_at = ? WHERE workspace_id = ? AND merged_into IS NULL`)
      .run(mode, now(), req.workspace.id)).changes;
  }
  const words = { ask: 'ask you before switching', auto: 'switch on their own once a model clears twice', off: 'never be switched' };
  await addActivity(req.workspace.id, {
    kind: 'connect', title: `New workloads will ${words[mode]}`,
    detail: moved ? `And the ${moved} workloads you have now do the same.` : 'Workloads you have now keep their own setting.',
  });
  return res.json({ ok: true, mode, moved });
});

/* Whether this workspace's measurement results may help other workspaces choose which models to try.
   Only which model cleared which kind of workload is ever shared, never a call, an answer or a name. */
api.post('/settings/share-stats', async (req, res) => {
  const on = req.body?.enabled === true;
  await db.prepare('UPDATE workspaces SET share_stats = ? WHERE id = ?').run(on ? 1 : 0, req.workspace.id);
  return res.json({ ok: true, enabled: on });
});

/* The most optimizing (measurements and background answers) may spend over thirty days. Null is no
   ceiling beyond what each measurement is worth. */
api.post('/settings/optimize-budget', async (req, res) => {
  const raw = req.body?.amountUsd;
  const amount = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 100000)) {
    return fail(res, 400, 'The budget is a number of dollars between 0 and 100,000, or nothing for no budget.');
  }
  await db.prepare('UPDATE workspaces SET optimize_budget_usd = ? WHERE id = ?').run(amount, req.workspace.id);
  forgetPlanAll();
  return res.json({ ok: true, amountUsd: amount });
});

/* Whether long instructions may be marked for caching, on models that only cache what is marked. */
api.post('/settings/cache-hints', async (req, res) => {
  const on = req.body?.enabled !== false;
  await db.prepare('UPDATE workspaces SET cache_hints = ? WHERE id = ?').run(on ? 1 : 0, req.workspace.id);
  forgetWorkspace(req.workspace.id);
  return res.json({ ok: true, enabled: on });
});

/* The most calls may cost through us in a day and in a month, days and months told in IST. */
api.post('/settings/limits', async (req, res) => {
  const read = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const daily = read(req.body?.dailyUsd);
  const monthly = read(req.body?.monthlyUsd);
  for (const v of [daily, monthly]) {
    if (v !== null && (!Number.isFinite(v) || v <= 0 || v > 1000000)) {
      return fail(res, 400, 'A limit is a number of dollars above 0, or nothing for no limit.');
    }
  }
  if (daily !== null && monthly !== null && daily > monthly) return fail(res, 400, 'The daily limit cannot be above the monthly one.');
  await db.prepare('UPDATE workspaces SET daily_limit_usd = ?, monthly_limit_usd = ? WHERE id = ?').run(daily, monthly, req.workspace.id);
  forgetWorkspace(req.workspace.id);
  return res.json({ ok: true, dailyUsd: daily, monthlyUsd: monthly });
});

/* Which emails the workspace gets. */
api.post('/settings/notify', async (req, res) => {
  const given = req.body?.kinds && typeof req.body.kinds === 'object' ? req.body.kinds : {};
  const prefs = notifyPrefs(req.workspace);
  for (const k of Object.keys(NOTIFY_KINDS)) if (typeof given[k] === 'boolean') prefs[k] = given[k];
  await db.prepare('UPDATE workspaces SET notify_json = ? WHERE id = ?').run(JSON.stringify(prefs), req.workspace.id);
  return res.json({ ok: true, notify: prefs });
});

/* The ledger further back than Settings shows at first, twenty lines at a time. */
api.get('/settings/ledger', async (req, res) => {
  const before = Number(req.query?.before);
  const beforeId = typeof req.query?.beforeId === 'string' ? req.query.beforeId.slice(0, 60) : null;
  const rows = await ledger(req.workspace.id, 20, { before: Number.isFinite(before) && before > 0 ? before : null, beforeId });
  return res.json({ rows, more: rows.length === 20 });
});

/* Keys have names, so somebody with several can tell which one a service uses before revoking it. */
const keyName = (raw, fallback) => {
  const n = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return n || fallback;
};

api.post('/settings/keys', async (req, res) => {
  const count = (await listKeys(req.workspace.id)).filter((k) => !k.revoked_at).length;
  const k = await issueKey(req.workspace.id, keyName(req.body?.name, `Key ${count + 1}`));
  await addActivity(req.workspace.id, {
    kind: 'connect', title: `New key "${k.name}" (${k.prefix}…)`,
    detail: canRevealKeys() ? 'Its full value is on Connect and in Settings.' : 'Copy it now: this deployment cannot show it again.',
  });
  res.json({ ok: true, key: k.secret, prefix: k.prefix, id: k.id, name: k.name });
});

api.post('/settings/keys/:id/name', async (req, res) => {
  const name = keyName(req.body?.name, null);
  if (!name) return fail(res, 400, 'Give the key a name.');
  const done = (await db.prepare('UPDATE api_keys SET name = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL')
    .run(name, req.params.id, req.workspace.id)).changes;
  if (!done) return fail(res, 404, 'No such key.');
  return res.json({ ok: true, name });
});

/* Revealing one key in full, when somebody asks to see it. Keys are shown masked until then. */
api.get('/settings/keys/:id/reveal', async (req, res) => {
  if (!canRevealKeys()) {
    return fail(res, 410, 'This deployment does not keep keys in a form it can show again, so a key can only be copied when it is made. Make a new one to get a key you can copy.');
  }
  const k = await revealKeyById(req.workspace.id, req.params.id);
  if (!k) return fail(res, 404, 'No such key.');
  if (!k.secret) return fail(res, 410, 'This key was made before keys could be shown again. Replace it to get one you can copy.');
  return res.json({ ok: true, key: k.secret });
});

api.delete('/settings/keys/:id', async (req, res) => {
  if (!await revokeKey(req.workspace.id, req.params.id)) return fail(res, 404, 'No such key.');
  return res.json({ ok: true });
});

/* A name changes at once. An email address changes only once the new address answers a code, so
   nobody can move an account to an address that is not theirs, and a typo cannot lock anybody out.

   Moving the address that signs in also needs the current password. A session alone used to be
   enough, so anybody holding a stolen session could move the account to their own address, and the
   owner could then sign in neither by password nor by code. The old address is told once it moves,
   and every other session ends. Asking is limited per account and per address a request came from,
   because each ask sends an email from us to an address of the asker's choosing. */
api.post('/settings/profile', async (req, res) => {
  const name = String(req.body?.name ?? req.user.name).replace(/\s+/g, ' ').trim().slice(0, 80);
  await db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  const email = String(req.body?.email ?? req.user.email).trim().toLowerCase().slice(0, 160);
  if (email === req.user.email) return res.json({ ok: true, name, email });
  if (req.user.pw_cleared) return fail(res, 400, 'Choose a password first, under Password below, then change your email.');
  const ip = clientIp(req);
  if (!await allow('email_change_user', req.user.id, { max: 5, windowMs: 3600000 })
    || !await allow('code_request_ip', ip, { max: config.LIMIT_CODES_PER_IP_HOUR, windowMs: 3600000 })) {
    return tooMany(res, 'Too many changes asked for. Wait an hour, then try again.');
  }
  // a wrong password is a 400, not a 401: the app reads 401 as a session that has ended
  if (!await checkPassword(req.user.email, req.body?.password)) return fail(res, 400, 'Your current password is not right.');
  const asked = await requestEmailChange(req.user, email, { ip });
  if (!asked.ok) return fail(res, 400, asked.reason);
  if (asked.send) sendLater({ to: asked.email, ...codeEmail({ purpose: 'change_email', code: asked.send.code, minutes: asked.send.minutes }) });
  // the same answer whether or not the address is free, so this cannot be used to find out who has an account
  return res.json({ ok: true, name, email: req.user.email, pendingEmail: asked.email, minutes: config.LOGIN_CODE_TTL_MIN });
});

api.post('/settings/email/verify', async (req, res) => {
  const ip = clientIp(req);
  if (!await allow('code_verify_ip', ip, { max: config.LIMIT_VERIFY_PER_IP_HOUR, windowMs: 3600000 })) {
    return fail(res, 429, 'Too many tries from here. Wait an hour.');
  }
  const before = req.user.email;
  const out = await verifyEmailChange(req.user, req.body?.email, req.body?.code);
  if (!out.ok) {
    // 400 either way: the app reads a 401 as a session that has ended
    return fail(res, 400, out.reason === 'wrong'
      ? `That code is not right. ${out.triesLeft} ${out.triesLeft === 1 ? 'try' : 'tries'} left.`
      : 'That code has expired or the address is no longer free. Ask for another.');
  }
  const ended = await endOtherSessions(req.user.id, req.sessionValue);
  await addActivity(req.workspace.id, { kind: 'connect', title: 'Your email address changed',
    detail: `It is ${out.email} now.${ended ? ' Every other session was signed out.' : ''}` });
  sendLater({ to: before, ...noticeEmail({
    title: 'Your Understudy email address was changed',
    lines: [
      `The address that signs in to your Understudy account is now ${out.email}. This one no longer signs in.`,
      'It was changed by somebody signed in to the account who knew its password, and every other session was signed out.',
      'If that was not you, tell us straight away through the contact page.',
    ],
    link: `${config.PUBLIC_URL}/contact?topic=security`, linkText: 'Contact us',
  }) });
  return res.json({ ok: true, email: out.email });
});

/* A new password. Every other session ends, so anybody who knew the old one is signed out everywhere. */
api.post('/settings/password', async (req, res) => {
  // each try is a deliberately slow hash, and a session must not be a way to guess the password
  if (!await allow('password_change_user', req.user.id, { max: 10, windowMs: 900000 })) {
    return tooMany(res, 'Too many tries. Wait a quarter of an hour, then try again.');
  }
  const out = await changePassword(req.user, req.body?.current, req.body?.next, { keepSession: req.sessionValue });
  if (!out.ok) return fail(res, 400, out.reason);
  return res.json({ ok: true });
});

api.post('/settings/sign-out-others', async (req, res) => {
  const n = await endOtherSessions(req.user.id, req.sessionValue);
  return res.json({ ok: true, ended: n });
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
  if (!s || !canBill()) {
    return res.status(503).json({ error: paymentsState() === 'test_refused'
      ? 'Payments are not switched on yet on this deployment, so credit cannot be added. Sending us copies needs no credit.'
      : 'Payments are not set up on this deployment yet.' });
  }
  const asked = Number(req.body?.amountUsd);
  const amount = Math.min(config.TOPUP_MAX_USD,
    Math.max(config.TOPUP_MIN_USD, Number.isFinite(asked) ? asked : config.TOPUP_AMOUNT_USD));
  // automatic top up only when the customer asked for it here, with the words that ask for it
  const autoTopUp = req.body?.autoTopUp === true;

  const acct = await account(req.workspace.id);
  const topUpAmount = topUpAmountOf(acct);
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
      ...(autoTopUp ? { setup_future_usage: 'off_session' } : {}),
      metadata: { workspace_id: req.workspace.id },
    },
    ...(autoTopUp ? {
      custom_text: {
        submit: {
          message: `We will save this card and charge it $${topUpAmount.toFixed(2)} `
            + `automatically whenever your balance falls below $${config.TOPUP_THRESHOLD_USD.toFixed(2)}, `
            + `at most ${config.TOPUP_MAX_PER_DAY} times a day, so your calls do not stop. You can turn that off in Settings at any time.`,
        },
      },
    } : {}),
    // the session travels back, so the page asks us what was paid rather than reading it from the address
    success_url: `${config.PUBLIC_URL}/settings?credit=paid&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.PUBLIC_URL}/settings?credit=cancelled`,
    metadata: { workspace_id: req.workspace.id, auto_topup: autoTopUp ? '1' : '0' },
  }, {
    /* A double click, or a retried request, should land on the same payment page rather than
       opening a second one. Scoped to the minute so choosing the same amount again later is
       still a new top up. */
    idempotencyKey: `checkout:${req.workspace.id}:${dollars}:${autoTopUp ? 'auto' : 'once'}:${Math.floor(Date.now() / 60000)}`,
  });
  res.json({ url: session.url });
});

/* What a payment page that sent somebody back actually took, asked of Stripe: the amount, whether it
   was paid, and whether it is on the balance yet. Only this workspace's own sessions are answered. */
api.get('/billing/checkout/:id', async (req, res) => {
  const s = await stripe();
  if (!s) return fail(res, 503, 'Payments are not set up here.');
  const sid = String(req.params.id || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) return fail(res, 404, 'No such payment.');
  let session;
  try { session = await s.checkout.sessions.retrieve(sid); } catch { return fail(res, 404, 'No such payment.'); }
  if (session?.metadata?.workspace_id !== req.workspace.id) return fail(res, 404, 'No such payment.');
  const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  const credited = intent ? !!(await db.prepare('SELECT 1 FROM ledger WHERE workspace_id = ? AND ref = ?').get(req.workspace.id, intent)) : false;
  return res.json({ amount: (session.amount_total ?? 0) / 100, paid: session.payment_status === 'paid', credited });
});

/* Automatic top up: on only with a card saved, off at any time, and for an amount the customer picks. */
api.post('/settings/auto-topup', async (req, res) => {
  const acct = await account(req.workspace.id);
  const b = req.body || {};
  if (b.amountUsd !== undefined) {
    const a = Number(b.amountUsd);
    if (!Number.isFinite(a) || a < config.TOPUP_MIN_USD || a > config.TOPUP_MAX_USD) {
      return fail(res, 400, `Pick an amount between $${config.TOPUP_MIN_USD} and $${config.TOPUP_MAX_USD}.`);
    }
    await db.prepare('UPDATE billing_accounts SET topup_amount_usd = ?, updated_at = ? WHERE workspace_id = ?')
      .run(Math.round(a * 100) / 100, now(), req.workspace.id);
  }
  if (b.enabled !== undefined) {
    // only a card saved for top ups, at a checkout that said so, is ever charged without its owner there
    if (b.enabled && (!acct.payment_method || Number(acct.card_for_topups || 0) !== 1)) {
      return fail(res, 400, 'Add credit with a card first, and tick the box to top up automatically there, so the card is saved for top ups.');
    }
    await db.prepare(`UPDATE billing_accounts SET auto_topup = ?, topup_failed_note = NULL, updated_at = ?
                 WHERE workspace_id = ?`).run(b.enabled ? 1 : 0, now(), req.workspace.id);
  }
  const after = await account(req.workspace.id);
  res.json({ ok: true, enabled: !!after.auto_topup, amountUsd: topUpAmountOf(after) });
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
  /* The last calls we turned away, with the reason each was given, so a mistake in the wiring (a model
     name we do not know, a body that is not JSON, a limit reached) is seen and fixed here rather than
     found in the customer's own logs. At most one a minute is kept (see recordRefusal). */
  const turnedAway = (await db.prepare(
    `SELECT created_at, status_code, requested_model, response_json FROM calls
      WHERE workspace_id = ? AND source = 'routed' AND status_code >= 400 ORDER BY created_at DESC LIMIT 5`)
    .all(req.workspace.id)).map((r) => {
    let why = null;
    try { const j = JSON.parse(r.response_json || 'null'); why = j?.error?.message ?? (typeof j?.error === 'string' ? j.error : null); } catch { why = null; }
    return { at: r.created_at, status: r.status_code, model: r.requested_model, why: why ? String(why).slice(0, 300) : null };
  });
  res.json({
    baseUrl: `${config.PUBLIC_URL}/v1`,
    // how new workloads are switched, chosen once while connecting and changeable in Settings
    defaultMode: req.workspace.default_optimize_mode || config.DEFAULT_OPTIMIZE_MODE,
    turnedAway,
    key: live?.secret ?? null,
    // which key that is, by name, so replacing it replaces that one and says so
    keyId: live?.id ?? null,
    keyName: live?.name ?? null,
    // what the workspace chose about what is kept, for the promise the page makes
    zdrOnly: req.workspace.zdr_required !== 0,
    retentionDays: req.workspace.retention_days ?? null,
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
/* Replacing ONE key: the one named, or the one Connect shows. It used to revoke every key in the
   workspace, including ones made separately in Settings for other services, while the screen
   warned only about "your current key". Other keys keep working. */
api.post('/connect/regenerate-key', async (req, res) => {
  const live = (await listKeys(req.workspace.id)).filter((k) => !k.revoked_at);
  const target = req.body?.keyId ? live.find((k) => k.id === req.body.keyId) : live[live.length - 1];
  if (req.body?.keyId && !target) return fail(res, 404, 'No such key.');
  const fresh = await issueKey(req.workspace.id, target?.name || 'Key 1');
  if (target) await revokeKey(req.workspace.id, target.id);
  await addActivity(req.workspace.id, {
    kind: 'connect',
    title: `New key "${fresh.name}" (${fresh.prefix}…)`,
    detail: target
      ? `It replaces ${target.prefix}…, which stopped working. ${live.length - 1 > 0 ? `Your ${live.length - 1} other ${live.length - 1 === 1 ? 'key keeps' : 'keys keep'} working.` : ''}`.trim()
      : 'Nothing was using a key before this one.',
  });
  return res.json({ ok: true, key: fresh.secret, prefix: fresh.prefix, id: fresh.id, replaced: target ? 1 : 0, replacedId: target?.id ?? null });
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
