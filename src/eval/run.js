import { db, id, now, round8 } from '../db/index.js';
import config, { canRoute } from '../config.js';
import { chat, priceCall, UpstreamError } from '../openrouter.js';
import { addActivity, recordCall } from '../traffic.js';
import { gateEval, chargeEval } from '../billing.js';
import { extract, disagreement, gates, floorFrom, verdictFor, sampleCalls } from './compare.js';
import { promote } from './promote.js';

const DAY = 86400000;

/** Models this workspace is willing to try, cheapest first, never the reference itself. */
export function candidatesFor(workspaceId, referenceModel) {
  return db.prepare(
    `SELECT c.model_id, c.price_in, c.price_out
       FROM models_catalog c
       LEFT JOIN workspace_models wm ON wm.model_id = c.model_id AND wm.workspace_id = ?
      WHERE COALESCE(wm.enabled, 1) = 1 AND c.model_id != ?
      ORDER BY (c.price_in + c.price_out)`).all(workspaceId, referenceModel).slice(0, 6);
}

/** What a month of this workload would cost on a given model, from its own observed tokens. */
function monthlyOn(workloadId, modelId) {
  const t = db.prepare(
    `SELECT COALESCE(SUM(prompt_tokens), 0) AS pin, COALESCE(SUM(completion_tokens), 0) AS pout,
            COUNT(*) AS n, MIN(created_at) AS first
       FROM calls WHERE workload_id = ? AND created_at >= ?`)
    .get(workloadId, now() - 30 * DAY);
  if (!t.n) return null;
  const per = priceCall(modelId, t.pin, t.pout);
  if (per === null) return null;
  const days = Math.max(1, (now() - t.first) / DAY);
  return round8((per / days) * 30);
}

export async function runEvaluation(workloadId) {
  const workload = db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId);
  if (!workload) return { ok: false, reason: 'gone' };
  if (!canRoute()) return { snoozeMs: 15 * 60000, note: 'no OPENROUTER_API_KEY' };

  const reference = workload.reference_model;
  if (!reference) return { ok: false, reason: 'no reference model' };

  const pool = db.prepare(
    `SELECT id, request_json, response_json FROM calls
      WHERE workload_id = ? AND request_json IS NOT NULL AND created_at >= ?
      ORDER BY created_at DESC LIMIT 600`).all(workloadId, now() - 30 * DAY);
  if (pool.length < config.EVAL_MIN_RUNS) {
    return { ok: false, reason: `only ${pool.length} calls, ${config.EVAL_MIN_RUNS} needed` };
  }

  const samples = sampleCalls(pool, config.EVAL_SAMPLE_SIZE);
  const candidates = candidatesFor(workload.workspace_id, reference);
  const estimate = estimateCost(workloadId, reference, candidates);
  if (estimate > config.EVAL_MAX_USD_PER_RUN) {
    return { ok: false, reason: `estimated $${estimate.toFixed(2)} over the $${config.EVAL_MAX_USD_PER_RUN} cap` };
  }
  const gate = gateEval(workload.workspace_id, { estimatedUsd: estimate });
  if (!gate.ok) {
    addActivity(workload.workspace_id, {
      kind: 'floor', title: `Measuring ${workload.slug} is waiting`, detail: gate.message, workloadId,
    });
    return { snoozeMs: 30 * 60000, note: gate.code };
  }

  const run = {
    id: id('run'), workspace_id: workload.workspace_id, workload_id: workloadId,
    status: 'running', shape_kind: workload.shape_kind, reference_model: reference,
    sample_size: samples.length, created_at: now(), started_at: now(),
  };
  db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model,
              sample_size, created_at, started_at)
              VALUES (@id, @workspace_id, @workload_id, @status, @shape_kind, @reference_model,
              @sample_size, @created_at, @started_at)`).run(run);

  let spend = 0;
  let stoppedShort = null;
  const shape = workload.shape_kind;
  const refPairs = [];

  /* Charge what has run so far, and say whether there is anything left. The gate before a
     run can only work off an estimate, so without this a long run walks past the balance. */
  const settle = (note) => {
    if (spend <= 0) return true;
    chargeEval(workload.workspace_id, spend, note);
    db.prepare('UPDATE eval_runs SET spend_usd = spend_usd + ? WHERE id = ?').run(round8(spend), run.id);
    spend = 0;
    const left = db.prepare('SELECT balance_usd FROM billing_accounts WHERE workspace_id = ?')
      .get(workload.workspace_id)?.balance_usd ?? 0;
    return left > 0;
  };

  // the bar first: the reference model against itself, measured fresh
  for (const s of samples) {
    const body = JSON.parse(s.request_json);
    const a = await replay(body, reference, workload, run.id);
    const b = await replay(body, reference, workload, run.id);
    spend += a.cost + b.cost;
    db.prepare(`INSERT INTO eval_samples (id, run_id, call_id, quartile, ref_a_json, ref_b_json, charged)
                VALUES (?, ?, ?, ?, ?, ?, 0)`)
      .run(id('smp'), run.id, s.id, s.quartile ?? 0,
           a.json ? JSON.stringify(a.json) : null, b.json ? JSON.stringify(b.json) : null);
    refPairs.push({ body, a: extract(a.json, shape), b: extract(b.json, shape) });
  }

  const noise = mean(refPairs.map((p) => scoreOf(p.a, p.b, shape)));
  const floor = floorFrom(noise * 100, {
    multiple: config.EVAL_FLOOR_MULTIPLE, minPct: config.EVAL_FLOOR_MIN_PCT,
  });
  db.prepare('UPDATE eval_runs SET noise_pct = ?, floor_pct = ? WHERE id = ?')
    .run(round8(noise * 100), round8(floor), run.id);
  db.prepare('UPDATE workloads SET floor_pct = ?, updated_at = ? WHERE id = ?')
    .run(round8(floor), now(), workloadId);

  if (!settle(`Measuring ${workload.slug}, setting the bar`)) {
    db.prepare(`UPDATE eval_runs SET status = 'done', finished_at = ?, error = ? WHERE id = ?`)
      .run(now(), 'balance ran out after the bar was set', run.id);
    addActivity(workload.workspace_id, {
      kind: 'floor', title: `Measuring ${workload.slug} stopped early`,
      detail: 'Your balance ran out once the bar was set. Add credit and it picks up where it left off.',
      workloadId,
    });
    return { ok: true, runId: run.id, floor, results: 0, spend: 0, partial: true };
  }

  // then each candidate once, against both reference answers
  const results = [];
  for (const cand of candidates) {
    let runs = 0;
    let failures = 0;
    const pairs = [];
    for (const p of refPairs) {
      const c = await replay(p.body, cand.model_id, workload, run.id);
      spend += c.cost;
      runs += 1;
      const got = extract(c.json, shape);
      if (!got.ok) failures += 1;
      const score = Math.min(scoreOf(got, p.a, shape), scoreOf(got, p.b, shape));
      pairs.push({ cand: got, ref: p.a.ok ? p.a : p.b, score });
    }
    const gap = mean(pairs.map((x) => x.score)) * 100;
    const g = gates(pairs, shape);
    const monthly = monthlyOn(workloadId, cand.model_id);
    const verdict = verdictFor(gap, floor, runs, {
      minRuns: Math.min(config.EVAL_MIN_RUNS, samples.length),
      reviewBand: config.EVAL_REVIEW_BAND,
    });
    const row = {
      id: id('res'), run_id: run.id, model_id: cand.model_id, runs,
      gap_pct: round8(gap), cost_month_usd: monthly, verdict,
      gate_structure: Math.round(g.structure * 100), gate_accuracy: Math.round(g.accuracy * 100),
      gate_coverage: Math.round(g.coverage * 100), gate_complete: Math.round(g.complete * 100),
      failures, created_at: now(),
    };
    db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd, verdict,
                gate_structure, gate_accuracy, gate_coverage, gate_complete, failures, created_at)
                VALUES (@id, @run_id, @model_id, @runs, @gap_pct, @cost_month_usd, @verdict,
                @gate_structure, @gate_accuracy, @gate_coverage, @gate_complete, @failures, @created_at)`)
      .run(row);
    results.push(row);
    if (!settle(`Measuring ${workload.slug} on ${cand.model_id}`)) {
      stoppedShort = cand.model_id;
      break;
    }
  }

  settle(`Measuring ${workload.slug}`);
  db.prepare(`UPDATE eval_runs SET status = 'done', finished_at = ?, error = ? WHERE id = ?`)
    .run(now(), stoppedShort ? `balance ran out after ${stoppedShort}` : null, run.id);

  // the cheapest model that cleared, and what we do about it
  const refMonthly = monthlyOn(workloadId, reference);
  /* the reference is not a candidate, but every screen compares against what it costs,
     so it is recorded on the run alongside them */
  db.prepare(`INSERT OR REPLACE INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd,
              verdict, gate_structure, gate_accuracy, gate_coverage, gate_complete, failures, created_at)
              VALUES (?, ?, ?, ?, 0, ?, 'reference', 100, 100, 100, 100, 0, ?)`)
    .run(id('res'), run.id, reference, samples.length * 2, refMonthly, now());
  const cleared = results.filter((r) => r.verdict === 'cleared' && r.cost_month_usd !== null)
    .filter((r) => refMonthly === null || r.cost_month_usd < refMonthly)
    .sort((a, b) => a.cost_month_usd - b.cost_month_usd);
  const best = cleared[0] || null;

  if (best) {
    const saving = refMonthly === null ? null : round8(refMonthly - best.cost_month_usd);
    db.prepare(`UPDATE workloads SET status = 'certified', status_note = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), workloadId);
    addActivity(workload.workspace_id, {
      kind: 'ok',
      title: `${best.model_id} cleared your bar on ${workload.slug}`,
      detail: `${best.gap_pct.toFixed(2)}% against a ${floor.toFixed(2)}% bar`
        + (saving ? `, about $${saving.toFixed(2)} a month less` : ''),
      workloadId,
    });
    if (workload.optimize_mode === 'auto') {
      promote(db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId), best.model_id, {
        runId: run.id, reason: 'cleared your bar', auto: true,
      });
    }
  } else {
    const anyReview = results.some((r) => r.verdict === 'review');
    db.prepare(`UPDATE workloads SET status = ?, status_note = ?, updated_at = ? WHERE id = ?`)
      .run(anyReview ? 'certified' : 'no_match',
           anyReview ? 'A candidate is close and needs a look' : 'Nothing cleared your bar yet',
           now(), workloadId);
    addActivity(workload.workspace_id, {
      kind: 'floor', title: `Nothing cleared your bar on ${workload.slug}`,
      detail: `${results.length} models tried against a ${floor.toFixed(2)}% bar`,
      workloadId,
    });
  }
  return { ok: true, runId: run.id, floor, results: results.length, partial: !!stoppedShort };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** free text with no judge available falls back to "different", which is the safe direction. */
const scoreOf = (a, b, shape) => {
  const d = disagreement(a, b, shape);
  return d === null ? 1 : d;
};

async function replay(body, model, workload, runId) {
  try {
    const { json, latencyMs } = await chat({ ...body, stream: false }, model);
    const cost = Number(json?.usage?.cost ?? 0);
    recordCall({
      workspaceId: workload.workspace_id, workloadId: workload.id, source: 'replay',
      requestedModel: workload.reference_model, servedModel: model, statusCode: 200,
      promptTokens: json?.usage?.prompt_tokens ?? 0, completionTokens: json?.usage?.completion_tokens ?? 0,
      costUsd: cost, chargedUsd: 0, latencyMs,
    });
    return { json, cost };
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 0;
    recordCall({
      workspaceId: workload.workspace_id, workloadId: workload.id, source: 'replay',
      requestedModel: workload.reference_model, servedModel: model, statusCode: status,
    });
    return { json: null, cost: 0 };
  }
}

function estimateCost(workloadId, reference, candidates) {
  const t = db.prepare(
    `SELECT COALESCE(AVG(prompt_tokens), 0) AS pin, COALESCE(AVG(completion_tokens), 0) AS pout
       FROM calls WHERE workload_id = ?`).get(workloadId);
  const n = config.EVAL_SAMPLE_SIZE;
  const refPer = priceCall(reference, t.pin, t.pout) ?? 0;
  let total = refPer * n * 2;
  for (const c of candidates) total += (priceCall(c.model_id, t.pin, t.pout) ?? 0) * n;
  return round8(total);
}
