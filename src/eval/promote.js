import { notify } from '../notify.js';
import { db, id, now } from '../db/index.js';
import { addActivity } from '../traffic.js';
import { OUTCOME_OF, RECENT_CALLS, carriesOf } from './outcome.js';
import { upsertArm, armById, leadModel, specOfResult, setStatus } from '../learn/arms.js';
import { forgetState } from '../learn/memo.js';
import config from '../config.js';

const record = async (workload, row, x = db) =>
  await x.prepare(`INSERT INTO promotions (id, workload_id, action, from_model, to_model, reason, run_id,
              actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id('prm'), workload.id, row.action, row.from_model ?? null, row.to_model ?? null,
         row.reason ?? null, row.run_id ?? null, row.actor_user_id ?? null, now());

/* How long a model switched back for something that can change waits before it can be tried
   again: a provider that was overloaded or slow this week, a price that went up, a provider that
   stopped keeping nothing. A model whose answers stopped matching, or that somebody switched back
   by hand, has said something lasting about itself, and stays out. */
export const WATCH_COOL_OFF_DAYS = 7;

/* Switched back for something that can change, it waits a while, and each time it is switched back
   again it waits twice as long: a strategy that keeps clearing a measurement and then failing live
   would otherwise be switched to and back every week, and the customer's calls would pay for each
   round. After the third it stays out until a person approves it. */
export const LASTING_AFTER = 3;
export async function heldBack(workloadId) {
  const rows = await db.prepare(
    `SELECT from_model, action, created_at FROM promotions WHERE workload_id = ? AND from_model IS NOT NULL
        AND action IN ('revert', 'auto_revert', 'soft_revert') AND created_at >= ?`)
    .all(workloadId, now() - 180 * 86400000);
  const by = new Map();
  for (const r of rows) {
    const m = by.get(r.from_model) || { hard: false, soft: 0, last: 0 };
    if (r.action === 'soft_revert') m.soft += 1; else m.hard = true;
    m.last = Math.max(m.last, Number(r.created_at));
    by.set(r.from_model, m);
  }
  const out = new Set();
  for (const [model, m] of by) {
    const days = WATCH_COOL_OFF_DAYS * 2 ** Math.max(0, m.soft - 1);
    if (m.hard || m.soft >= LASTING_AFTER || now() - m.last < days * 86400000) out.add(model);
  }
  return out;
}

/** A model that was switched back is not promoted automatically again: never, or for a while. */
export async function everReverted(workloadId, modelId) {
  return (await heldBack(workloadId)).has(modelId);
}

/** How a workload's latest calls reach us, and whether switching it would change anything. */
export async function trafficOf(workload) {
  const ws = await db.prepare('SELECT mode FROM workspaces WHERE id = ?').get(workload.workspace_id);
  const r = await db.prepare(
    `SELECT COUNT(*) FILTER (WHERE source = 'routed') AS routed, COUNT(*) FILTER (WHERE source = 'trace') AS copies
       FROM (SELECT source FROM calls WHERE workload_id = ? AND source IN ('routed', 'trace')
              ORDER BY created_at DESC LIMIT ?) x`).get(workload.id, RECENT_CALLS);
  const routed = Number(r?.routed ?? 0);
  const copies = Number(r?.copies ?? 0);
  return { routed, copies, observe: ws?.mode === 'observe', carries: carriesOf({ mode: ws?.mode, routed, copies }) };
}

/* A switch names what it switched to by one key: the model, for a model; "cascade:<model>" for a
   cheap model whose answers are checked and sent on when doubtful; "router:<model>" for one picked
   call by call; "<model>#lighter" for the customer's own model thinking less. It is the name a
   measurement gives the strategy's result, and the name the record of switches keeps. */
export function keyOfSpec(spec, reference) {
  // the customer's own model thinking less, as a part of a strategy or on its own
  const part = (p) => (p.model === reference && p.recipe?.reasoning ? `${p.model}#lighter`
    : p.model === reference && p.recipe?.pinned ? `${p.model}#cheapest` : p.model);
  if (spec.kind === 'cascade') return `cascade:${part(spec.first)}`;
  if (spec.kind === 'router') return `router:${part(spec.cheap)}`;
  return part(spec);
}

/** What a workload is served by now, by that key. */
export async function servingKey(workload) {
  if (!workload.routed_model) return workload.reference_model;
  if (workload.routed_arm_id) {
    const arm = await armById(workload.routed_arm_id);
    if (arm?.spec) return keyOfSpec(arm.spec, workload.reference_model);
  }
  /* A switch made before strategies were kept names only a model and how it was asked. The
     customer's own model asked to think less, or pinned to its cheapest provider, is still a
     strategy of its own, and named as one: by the model alone it read as the customer's model,
     which is served by nothing. */
  let recipe = null;
  try { recipe = workload.routed_recipe ? JSON.parse(workload.routed_recipe) : null; } catch { recipe = null; }
  return keyOfSpec({ kind: 'model', model: workload.routed_model, recipe }, workload.reference_model);
}

export async function promote(workload, modelId, { runId = null, reason = 'cleared your bar', actorUserId = null, auto = false, recipe = undefined, spec: given = null, detail = null, rollout = true } = {}) {
  if (auto && await everReverted(workload.id, modelId)) {
    return { ok: false, code: 'previously_reverted' };
  }
  const from = await servingKey(workload);
  if (from === modelId) return { ok: true, already: true };
  /* How it was measured is how it is served: a model that cleared with its thinking switched off
     is sent every live call that way, and a cascade keeps the check and the threshold it cleared
     with. Read from the measurement the switch rests on: the run named, when it measured this,
     otherwise the newest run that did. A model approved from an older measurement than the latest
     was measured in that older one, and serving it any other way would serve something that never
     cleared: one measured with its thinking off, sent live with it on, can spend a short answer
     cap thinking and answer nothing. */
  let spec = given;
  const cols = 'r.model_id, r.recipe_json, r.arm_json, r.cost_ratio, r.verdict, r.gap_pct, r.runs, r.escalated_pct, r.run_id';
  const row = (runId ? await db.prepare(`SELECT ${cols} FROM eval_results r WHERE r.run_id = ? AND r.model_id = ?`)
    .get(runId, modelId) : null) || await db.prepare(
    `SELECT ${cols} FROM eval_results r JOIN eval_runs e ON e.id = r.run_id
      WHERE e.workload_id = ? AND r.model_id = ? ORDER BY e.created_at DESC LIMIT 1`).get(workload.id, modelId);
  if (!spec) spec = row ? specOfResult(row) : { kind: 'model', model: modelId, recipe: null };
  if (recipe !== undefined && spec.kind === 'model') spec = { ...spec, recipe };
  /* What the measurement said about it travels with the switch, its cost against the customer's
     own model above all: learning cannot price or budget an experiment against a switch whose cost
     it does not know. */
  const offline = row ? {
    verdict: row.verdict, gap: row.gap_pct, ratio: row.cost_ratio ?? null, escalatedPct: row.escalated_pct ?? null,
    runs: row.runs, runId: row.run_id, at: now(),
  } : null;
  const arm = await upsertArm(workload, spec, { status: 'serving', originRunId: runId, offline });
  const lead = leadModel(spec);
  /* A switch starts on a share of the calls (see reviewRollout in src/learn/explore.js), and the rest
     stay with what served before it: the strategy it replaces, or the customer's own model.

     "What served before it" is what served in full. A switch made while another is still taking
     over a share at a time keeps that one's control: the strategy on a twentieth of the calls has
     not passed a single stage, and made the control it would have been given nineteen calls in
     twenty straight away, marked as resting, and served on every call by a roll back. A switch back
     to the control itself has nothing to roll out, and serves every call at once. */
  const midRollout = workload.rollout_share !== null && workload.rollout_share !== undefined;
  const control = midRollout ? (workload.rollout_from_arm_id ?? null) : (workload.routed_arm_id ?? null);
  const stages = config.ROLLOUT_ENABLED && rollout && control !== arm.id ? config.ROLLOUT_STAGES : [];
  const staged = stages.length > 0;
  await db.tx(async (tx) => {
    await tx.prepare(`UPDATE workloads SET routed_model = ?, routed_recipe = ?, routed_arm_id = ?, promoted_at = ?, promoted_run_id = ?,
                status = 'promoted', status_note = NULL, updated_at = ?,
                rollout_share = ?, rollout_stage = ?, rollout_started_at = ?, rollout_from_arm_id = ? WHERE id = ?`)
      .run(lead.model, lead.recipe ? JSON.stringify(lead.recipe) : null, arm.id, now(), runId, now(),
        staged ? stages[0] : null, staged ? 0 : null, staged ? now() : null, staged ? control : null, workload.id);
    await record(workload, { action: 'promote', from_model: from, to_model: modelId, reason, run_id: runId, actor_user_id: actorUserId }, tx);
  });
  if (workload.routed_arm_id && workload.routed_arm_id !== arm.id) await setStatus(workload.routed_arm_id, 'resting');
  await setStatus(arm.id, 'serving');
  forgetState(workload.id);
  // said as it is for a workload whose calls arrive as copies: set up, and waiting for them
  const traffic = await trafficOf(workload);
  await addActivity(workload.workspace_id, {
    kind: 'ok',
    title: traffic.carries ? `${workload.slug} now runs on ${arm.label}`
      : `${workload.slug} will run on ${arm.label} once its calls come through Understudy`,
    detail: (detail || (auto
      ? 'Switched on its own, because this workload optimizes automatically.'
      : 'Switched because you approved it.'))
      + (traffic.carries ? '' : ' Its calls reach us as copies, so the switch starts with the first one that comes through Understudy.'),
    workloadId: workload.id,
  });
  // a switch nobody pressed a button for is worth an email; one a person just approved is not
  if (auto) {
    await notify(workload.workspace_id, 'switched', `${workload.id}:${arm.id}:${runId || now()}`, {
      title: `${workload.slug} was switched to ${arm.label}`,
      lines: [
        `${arm.label} gave the same answers as ${workload.reference_model} on your own calls, measured twice, and costs less.`,
        traffic.carries ? 'It starts on a small share of the calls and takes more of them while its live calls hold up.'
          : 'Its calls reach us as copies, so the switch starts with the first call that comes through Understudy.',
        'You can switch it back at any time from the workload page.',
      ],
      path: `/workloads/${workload.id}`, linkText: 'See the switch',
    });
  }
  return { ok: true, from, to: modelId, armId: arm.id, label: arm.label, waiting: !traffic.carries };
}

/** Back to the customer's own model, from the next call onwards. */
export async function revert(workload, { reason = 'you asked for it', actorUserId = null, auto = false, soft = false } = {}) {
  if (!workload.routed_model) return { ok: true, already: true };
  const from = await servingKey(workload);
  /* Only the strategy this was decided about. The row can be read a while before it is written,
     and a switch made in between, by a person or by a measurement finishing, must not be undone
     on the strength of evidence about the one before it. */
  let moved = false;
  await db.tx(async (tx) => {
    const r = await tx.prepare(`UPDATE workloads SET routed_model = NULL, routed_recipe = NULL, routed_arm_id = NULL, promoted_at = NULL,
                promoted_run_id = NULL, status = 'certified', updated_at = ?,
                rollout_share = NULL, rollout_stage = NULL, rollout_started_at = NULL, rollout_from_arm_id = NULL
              WHERE id = ? AND routed_model = ? AND routed_arm_id IS NOT DISTINCT FROM ?`)
      .run(now(), workload.id, workload.routed_model, workload.routed_arm_id ?? null);
    if (!r.changes) { moved = true; return; }
    await record(workload, {
      action: soft ? 'soft_revert' : auto ? 'auto_revert' : 'revert', from_model: from,
      to_model: workload.reference_model, reason, actor_user_id: actorUserId,
    }, tx);
  });
  if (moved) return { ok: false, code: 'moved' };
  if (workload.routed_arm_id) await setStatus(workload.routed_arm_id, soft ? 'resting' : 'retired');
  forgetState(workload.id);
  await addActivity(workload.workspace_id, {
    kind: 'revert',
    title: `${workload.slug} is back on ${workload.reference_model}`,
    detail: reason,
    workloadId: workload.id,
  });
  if (auto || soft) {
    await notify(workload.workspace_id, 'reverted', `${workload.id}:${from}:${now()}`, {
      title: `${workload.slug} is back on ${workload.reference_model}`,
      lines: [reason, 'Nothing needs doing: its calls are answered by your own model again from the next one on.'],
      path: `/workloads/${workload.id}`, linkText: 'See why',
    });
  }
  return { ok: true, from, to: workload.reference_model };
}

/* A switch in progress whose calls did worse than what served before it goes back to that: the
   strategy it replaced, served in full straight away, or the customer's own model. It is recorded as
   a switch back of the new strategy, so it waits before it can be tried again (see heldBack). */
export async function rollBack(workload, reason) {
  const fromArm = workload.rollout_from_arm_id ? await armById(workload.rollout_from_arm_id) : null;
  if (!fromArm?.spec) return await revert(workload, { auto: true, soft: true, reason });
  const newKey = await servingKey(workload);
  const oldKey = keyOfSpec(fromArm.spec, workload.reference_model);
  const lead = leadModel(fromArm.spec);
  let moved = false;
  await db.tx(async (tx) => {
    const r = await tx.prepare(`UPDATE workloads SET routed_model = ?, routed_recipe = ?, routed_arm_id = ?, updated_at = ?,
                rollout_share = NULL, rollout_stage = NULL, rollout_started_at = NULL, rollout_from_arm_id = NULL
              WHERE id = ? AND routed_arm_id IS NOT DISTINCT FROM ?`)
      .run(lead.model, lead.recipe ? JSON.stringify(lead.recipe) : null, fromArm.id, now(), workload.id, workload.routed_arm_id ?? null);
    if (!r.changes) { moved = true; return; }
    await record(workload, { action: 'soft_revert', from_model: newKey, to_model: oldKey, reason }, tx);
  });
  if (moved) return { ok: false, code: 'moved' };
  if (workload.routed_arm_id) await setStatus(workload.routed_arm_id, 'resting');
  await setStatus(fromArm.id, 'serving');
  forgetState(workload.id);
  await addActivity(workload.workspace_id, { kind: 'revert', title: `${workload.slug} is back on ${fromArm.label}`, detail: reason, workloadId: workload.id });
  await notify(workload.workspace_id, 'reverted', `${workload.id}:${newKey}:${now()}`, {
    title: `${workload.slug} is back on ${fromArm.label}`,
    lines: [reason, 'Nothing needs doing: its calls are answered the way they were before the switch.'],
    path: `/workloads/${workload.id}`, linkText: 'See why',
  });
  return { ok: true, from: newKey, to: oldKey };
}

/** The certificate a switch was made on: the run, its bar, and every model tried. */
export async function certificate(workloadId, runId = null) {
  /* The newest finished measurement that found something: it compared models, or it found the
     bar could not be set. One that ran out of balance before trying anything says nothing about
     any model, so it does not replace what the last real measurement found; it is still in the
     history for anybody who opens it. A row with no outcome is read from its error, the way
     the backfill reads it. */
  const run = runId
    ? await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(runId)
    : await db.prepare(`SELECT * FROM eval_runs WHERE workload_id = ? AND status = 'done'
                   AND ${OUTCOME_OF()} IN ('compared', 'unmeasurable', 'refused')
                   ORDER BY created_at DESC LIMIT 1`).get(workloadId);
  if (!run) return null;
  const results = await db.prepare(
    `SELECT * FROM eval_results WHERE run_id = ? ORDER BY cost_month_usd IS NULL, cost_month_usd`)
    .all(run.id);
  const runsTotal = await db.prepare(
    `SELECT model_id, SUM(runs) AS runs FROM eval_results
      WHERE run_id IN (SELECT id FROM eval_runs WHERE workload_id = ?) GROUP BY model_id`)
    .all(workloadId);
  const totals = new Map(runsTotal.map((r) => [r.model_id, r.runs]));
  const refCost = (await db.prepare(
    `SELECT cost_month_usd FROM eval_results WHERE run_id = ? AND model_id = ?`)
    .get(run.id, run.reference_model))?.cost_month_usd ?? null;
  return {
    run,
    referenceCostMonth: refCost,
    rounds: (await db.prepare(`SELECT COUNT(*) AS n FROM eval_runs WHERE workload_id = ? AND status = 'done'`)
      .get(workloadId)).n,
    results: results.map((r) => ({ ...r, runs_total: totals.get(r.model_id) ?? r.runs })),
  };
}

/* Watching a switch after it is made.
 *
 * A measurement is a sample; live traffic is the real thing. After a switch, the switched-to
 * model's live calls are compared with the customer's own model's calls from the fortnight
 * before it. A model whose provider starts failing calls, or that answers slower than the
 * workload's speed setting allows, is switched back, and the activity feed says why in numbers.
 * Quality is re-checked by measuring again on the workspace's schedule; this is the part a
 * measurement cannot see, which is how the model behaves under the customer's own load.
 *
 * Both checks need real evidence, because a switch back costs the customer the saving. Failures
 * are read over the last day, since that is what the watch is for, and only count when there are
 * enough of them that chance would explain them less than one time in a hundred at the rate
 * the customer's own model failed at before (never taken as lower than one in a hundred). A
 * switch back by the watch keeps the model out for a week rather than for good: an overloaded
 * provider recovers, and the next measurement can find the model again once it has. */
const DAY = 86400000;
const providerFailed = (s) => s === 0 || s === 404 || s === 408 || s === 429 || s >= 500;
const pct = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null;
};

/** The chance of k or more failures in n calls when each fails with chance p. */
export function tailAtLeast(k, n, p) {
  if (k <= 0 || p >= 1) return 1;
  if (k > n || p <= 0) return 0;
  let term = (1 - p) ** n; // P(X = 0)
  let below = 0;
  for (let i = 0; i < k; i += 1) {
    below += term;
    term = (term * (n - i) * p) / ((i + 1) * (1 - p));
  }
  return Math.max(0, 1 - below);
}

/** Whether k failed calls out of n, against a failure rate of `before`, is enough to act on. */
export function failingClearly(k, n, before) {
  const rate = n ? k / n : 0;
  const base = Math.max(before, 0.01);
  return k >= 5 && rate > 0.05 && rate > 2 * before && tailAtLeast(k, n, base) < 0.01;
}

/* Every model a serving strategy can send a call to, besides the customer's own. */
function modelsServing(workload, spec) {
  if (!spec) return [workload.routed_model].filter(Boolean);
  if (spec.kind === 'cascade') return [spec.first?.model].filter(Boolean);
  if (spec.kind === 'router') return [spec.cheap?.model].filter(Boolean);
  return [spec.model].filter(Boolean);
}

/* What serves a workload has to still be something we can send calls to. A model that left the
   catalogue, or lost the last provider that keeps nothing while the workspace requires one, fails
   every call it is given, and a quiet workload never makes enough failures for the live watch to
   notice. Checked every hour, and switched back softly: it can be measured again once it returns. */
export async function watchCatalogue() {
  const { zdrFor } = await import('../workspace.js');
  const rows = await db.prepare('SELECT * FROM workloads WHERE routed_model IS NOT NULL').all();
  let reverted = 0;
  for (const w of rows) {
    let spec = null;
    if (w.routed_arm_id) {
      const arm = await db.prepare('SELECT spec_json FROM arms WHERE id = ?').get(w.routed_arm_id);
      try { spec = arm?.spec_json ? JSON.parse(arm.spec_json) : null; } catch { spec = null; }
    }
    const zdr = await zdrFor(w.workspace_id);
    let why = null;
    for (const m of modelsServing(w, spec)) {
      if (m === w.reference_model) continue;
      const row = await db.prepare('SELECT zdr FROM models_catalog WHERE model_id = ?').get(m);
      if (!row) { why = `${m} is no longer offered by the provider`; break; }
      if (zdr && Number(row.zdr) === 0) { why = `no provider that keeps nothing serves ${m} any more`; break; }
    }
    if (!why) continue;
    const r = await revert(w, { auto: true, soft: true, reason: `${why}. Switched back to ${w.reference_model}, and it can be measured again once that changes.` });
    if (r.ok) reverted += 1;
  }
  return reverted;
}

// a call the serving strategy failed and the customer's own model answered instead, for a reason of the strategy's
const fellBack = (c) => /"by":"fell back"/.test(String(c.check_json || ''));

export async function watchLive({ minCalls = 20, speedFactor = null } = {}) {
  const { default: config } = await import('../config.js');
  const { profileOf, speedRule } = await import('./profile.js');
  const rows = await db.prepare(
    'SELECT * FROM workloads WHERE routed_model IS NOT NULL AND promoted_at IS NOT NULL').all();
  let reverted = 0;
  for (const w of rows) {
    /* The last day for a busy workload, up to a week for a quiet one: the 500 newest calls since the
       switch, so a workload with a few calls a day still gathers enough to be judged. */
    const since = Math.max(w.promoted_at, now() - 7 * DAY);
    // the calls the switched-to strategy served: all of a cascade's, the ones it sent on included
    const after = w.routed_arm_id
      ? await db.prepare(
        `SELECT status_code, latency_ms, ttft_ms, check_json FROM calls WHERE workload_id = ? AND source = 'routed' AND arm_id = ?
            AND created_at >= ? ORDER BY created_at DESC LIMIT 500`).all(w.id, w.routed_arm_id, since)
      : await db.prepare(
        `SELECT status_code, latency_ms, ttft_ms, check_json FROM calls WHERE workload_id = ? AND source = 'routed' AND served_model = ?
            AND created_at >= ? ORDER BY created_at DESC LIMIT 500`).all(w.id, w.routed_model, since);
    if (after.length < minCalls) continue;
    const before = await db.prepare(
      `SELECT status_code, latency_ms, ttft_ms FROM calls WHERE workload_id = ? AND source = 'routed' AND served_model = ?
          AND created_at < ? AND created_at >= ? ORDER BY created_at DESC LIMIT 500`)
      .all(w.id, w.reference_model, w.promoted_at, w.promoted_at - 14 * DAY);
    const failed = (xs) => xs.filter((c) => providerFailed(c.status_code ?? 200) || fellBack(c)).length;
    const errAfter = after.length ? failed(after) / after.length : 0;
    const errBefore = before.length ? failed(before) / before.length : 0;
    if (failingClearly(failed(after), after.length, errBefore)) {
      const r = await revert(w, {
        auto: true,
        soft: true,
        reason: `${Math.round(errAfter * 100)}% of its recent live calls failed (${failed(after)} of `
          + `${after.length}), against ${Math.round(errBefore * 100)}% on ${w.reference_model} before the switch. `
          + `Switched back, and it can be tried again in ${WATCH_COOL_OFF_DAYS} days.`,
      });
      if (r.ok) reverted += 1;
      continue;
    }
    /* The workload's own speed rule, the one its measurements hold models to: streamed calls
       are timed to the first word, everything else to the whole answer. */
    const rule = speedRule(w, await profileOf(w), config);
    const factor = speedFactor ?? rule.factor;
    if (!factor) continue;
    const field = rule.metric === 'ttft' ? 'ttft_ms' : 'latency_ms';
    const ok = (xs) => xs.filter((c) => (c.status_code ?? 200) < 400 && c[field] > 0).map((c) => c[field]);
    const a = ok(after);
    const b = ok(before);
    if (a.length < minCalls || b.length < minCalls) continue;
    const a50 = pct(a, 0.5);
    const b50 = pct(b, 0.5);
    if (a50 && b50 && a50 > factor * b50 + config.SPEED_SLACK_MS) {
      const what = rule.metric === 'ttft' ? 'started answering in' : 'took';
      const r = await revert(w, {
        auto: true,
        soft: true,
        reason: `its typical live answer ${what} ${(a50 / 1000).toFixed(1)} s over the last day, against `
          + `${(b50 / 1000).toFixed(1)} s on ${w.reference_model} before the switch, more than your speed setting allows. `
          + `Switched back, and it can be tried again in ${WATCH_COOL_OFF_DAYS} days.`,
      });
      if (r.ok) reverted += 1;
    }
  }
  return reverted;
}
