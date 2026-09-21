import { db, id, now, round8 } from '../db/index.js';
import config, { canRoute } from '../config.js';
import { chat, priceCall, UpstreamError } from '../openrouter.js';
import { addActivity, recordCall } from '../traffic.js';
import { gateEval, chargeEval } from '../billing.js';
import { planFor } from './plan.js';
import { judgePair, judgementsFor } from './judge.js';
import { extract, disagreement, gates, floorFrom, verdictFor, sampleCalls, barIsMeaningful } from './compare.js';
import { promote } from './promote.js';

const DAY = 86400000;

/** Models this workspace is willing to try, cheapest first, never the reference itself. */
/** What a month of this workload would cost on a given model, from its own observed tokens. */
async function monthlyOn(workloadId, modelId) {
  const t = await db.prepare(
    `SELECT COALESCE(SUM(prompt_tokens), 0) AS pin, COALESCE(SUM(completion_tokens), 0) AS pout,
            COUNT(*) AS n, MIN(created_at) AS first
       FROM calls WHERE workload_id = ? AND created_at >= ?`)
    .get(workloadId, now() - 30 * DAY);
  if (!t.n) return null;
  const per = await priceCall(modelId, t.pin, t.pout);
  if (per === null) return null;
  const days = Math.max(1, (now() - t.first) / DAY);
  return round8((per / days) * 30);
}

export async function runEvaluation(workloadId, { trigger = 'manual' } = {}) {
  const workload = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId);
  if (!workload) return { ok: false, reason: 'gone' };
  if (!canRoute()) return { snoozeMs: 15 * 60000, note: 'no OPENROUTER_API_KEY' };

  const reference = workload.reference_model;
  if (!reference) return { ok: false, reason: 'no reference model' };

  /* The same plan the button showed. Working it out twice, in two places, is how a screen
     comes to promise something the run then refuses. */
  const plan = await planFor(workload, { canRoute: canRoute() });
  if (!plan.canRun) {
    await db.prepare(`UPDATE workloads SET status = CASE WHEN status = 'measuring' THEN 'new' ELSE status END,
                updated_at = ? WHERE id = ?`).run(now(), workloadId);
    return { ok: false, reason: plan.reason };
  }

  const pool = await db.prepare(
    `SELECT id, request_json, response_json FROM calls
      WHERE workload_id = ? AND request_json IS NOT NULL AND created_at >= ?
        AND source NOT IN ('replay', 'test')
      ORDER BY created_at DESC LIMIT 600`).all(workloadId, now() - 30 * DAY);

  const samples = sampleCalls(pool, plan.sample);
  const candidates = plan.candidates;
  const estimate = plan.estimateUsd;
  const gate = await gateEval(workload.workspace_id, { estimatedUsd: estimate });
  if (!gate.ok) {
    await addActivity(workload.workspace_id, {
      kind: 'floor', title: `Measuring ${workload.slug} is waiting`, detail: gate.message, workloadId,
    });
    return { snoozeMs: 30 * 60000, note: gate.code };
  }

  /* Every replay this run will make, counted up front, so the screen can say how far along
     it is rather than spinning. Two passes of the sample to set the bar, then one pass per
     model being tried. */
  const judgements = judgementsFor(workload.shape_kind, samples.length, candidates.length);
  const stepsTotal = samples.length * 2 + samples.length * candidates.length + judgements;
  const run = {
    id: id('run'), workspace_id: workload.workspace_id, workload_id: workloadId,
    status: 'running', shape_kind: workload.shape_kind, reference_model: reference,
    sample_size: samples.length, created_at: now(), started_at: now(),
    steps_total: stepsTotal, steps_done: 0, phase: `Setting your bar on ${reference}`,
    trigger: trigger === 'automatic' ? 'automatic' : 'manual',
    models_planned: candidates.length,
  };
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model,
              sample_size, created_at, started_at, steps_total, steps_done, phase, trigger, models_planned)
              VALUES (@id, @workspace_id, @workload_id, @status, @shape_kind, @reference_model,
              @sample_size, @created_at, @started_at, @steps_total, @steps_done, @phase, @trigger,
              @models_planned)`).run(run);

  /* Written as the run goes, not at the end: a screen watching this is the only way somebody
     knows the thing they paid for is happening. */
  let done = 0;
  const step = async (by, phase) => {
    done += by;
    await db.prepare('UPDATE eval_runs SET steps_done = ?, phase = ? WHERE id = ?')
      .run(done, phase, run.id);
  };

  let spend = 0;
  let stoppedShort = null;
  const shape = workload.shape_kind;
  const refPairs = [];

  /* Charge what has run so far, and say whether there is anything left. The gate before a
     run can only work off an estimate, so without this a long run walks past the balance. */
  const settle = async (note) => {
    if (spend <= 0) return true;
    await chargeEval(workload.workspace_id, spend, note);
    await db.prepare('UPDATE eval_runs SET spend_usd = spend_usd + ? WHERE id = ?').run(round8(spend), run.id);
    spend = 0;
    const left = (await db.prepare('SELECT balance_usd FROM billing_accounts WHERE workspace_id = ?')
      .get(workload.workspace_id))?.balance_usd ?? 0;
    return left > 0;
  };

  // the bar first: the reference model against itself, measured fresh
  for (const s of samples) {
    const body = JSON.parse(s.request_json);
    const a = await replay(body, reference, workload, run.id);
    const b = await replay(body, reference, workload, run.id);
    spend += a.cost + b.cost;
    await db.prepare(`INSERT INTO eval_samples (id, run_id, call_id, quartile, ref_a_json, ref_b_json, charged)
                VALUES (?, ?, ?, ?, ?, ?, 0)`)
      .run(id('smp'), run.id, s.id, s.quartile ?? 0,
           a.json ? JSON.stringify(a.json) : null, b.json ? JSON.stringify(b.json) : null);
    refPairs.push({ body, a: extract(a.json, shape), b: extract(b.json, shape) });
    await step(2, `Setting your bar on ${reference}, ${refPairs.length} of ${samples.length} calls`);
  }

  const noiseScores = [];
  for (const p of refPairs) {
    noiseScores.push(await scoreOf(p.a, p.b, shape, askOf(p.body), (c) => { spend += c; }));
    if (judgements) {
      await step(1, `Comparing answers on ${reference}, ${noiseScores.length} of ${refPairs.length}`);
    }
  }
  const noise = mean(noiseScores);
  const floor = floorFrom(noise * 100, {
    multiple: config.EVAL_FLOOR_MULTIPLE, minPct: config.EVAL_FLOOR_MIN_PCT,
  });
  await db.prepare('UPDATE eval_runs SET noise_pct = ?, floor_pct = ? WHERE id = ?')
    .run(round8(noise * 100), round8(floor), run.id);
  await db.prepare('UPDATE workloads SET floor_pct = ?, updated_at = ? WHERE id = ?')
    .run(round8(floor), now(), workloadId);

  /* If the reference model cannot answer its own calls consistently, the bar it produces is
     not a quality standard, it is noise. Certifying against it would let anything through,
     which is the opposite of what this product promises. Stop here and say so. */
  if (!barIsMeaningful(noise * 100, config.EVAL_NOISE_MAX_PCT)) {
    await settle(`Measuring ${workload.slug}, setting the bar`);
    await db.prepare(`UPDATE eval_runs SET status = 'done', finished_at = ?, error = ?, phase = NULL WHERE id = ?`)
      .run(now(), `reference disagreed with itself on ${(noise * 100).toFixed(1)}% of calls`, run.id);
    await db.prepare(`UPDATE workloads SET status = 'no_match', status_note = ?, floor_pct = NULL,
                updated_at = ? WHERE id = ?`)
      .run('We could not measure this workload', now(), workloadId);
    await addActivity(workload.workspace_id, {
      kind: 'floor',
      title: `We could not measure ${workload.slug}`,
      detail: `${reference} gave a different answer to the same call ${(noise * 100).toFixed(0)}% of the time, `
        + 'so there is no steady bar to hold a cheaper model to. Nothing has been switched.',
      workloadId,
    });
    return { ok: true, runId: run.id, floor: null, results: 0, unmeasurable: true };
  }

  if (!await settle(`Measuring ${workload.slug}, setting the bar`)) {
    await db.prepare(`UPDATE eval_runs SET status = 'done', finished_at = ?, error = ?, phase = NULL WHERE id = ?`)
      .run(now(), 'balance ran out after the bar was set', run.id);
    await addActivity(workload.workspace_id, {
      kind: 'floor', title: `Measuring ${workload.slug} stopped early`,
      detail: 'Your balance ran out once the bar was set. Add credit and it picks up where it left off.',
      workloadId,
    });
    return { ok: true, runId: run.id, floor, results: 0, spend: 0, partial: true };
  }

  // then each candidate once, against both reference answers
  const results = [];
  for (const [ci, cand] of candidates.entries()) {
    let runs = 0;
    let failures = 0;
    const pairs = [];
    for (const p of refPairs) {
      const c = await replay(p.body, cand.model_id, workload, run.id);
      spend += c.cost;
      runs += 1;
      const got = extract(c.json, shape);
      if (!got.ok) failures += 1;
      const ask = askOf(p.body);
      const add = (x) => { spend += x; };
      const score = Math.min(
        await scoreOf(got, p.a, shape, ask, add),
        await scoreOf(got, p.b, shape, ask, add),
      );
      pairs.push({ cand: got, ref: p.a.ok ? p.a : p.b, score });
      /* Counted here rather than every five calls, so the bar moves while a slow model is
         answering rather than jumping in blocks. One replay, plus its two comparisons when
         free text has to be judged. */
      await step(1 + (judgements ? 2 : 0),
        `Trying ${cand.model_id}, model ${ci + 1} of ${candidates.length}, ${runs} of ${refPairs.length} calls`);
    }
    const gap = mean(pairs.map((x) => x.score)) * 100;
    const g = gates(pairs, shape);
    const monthly = await monthlyOn(workloadId, cand.model_id);
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
    await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd, verdict,
                gate_structure, gate_accuracy, gate_coverage, gate_complete, failures, created_at)
                VALUES (@id, @run_id, @model_id, @runs, @gap_pct, @cost_month_usd, @verdict,
                @gate_structure, @gate_accuracy, @gate_coverage, @gate_complete, @failures, @created_at)`)
      .run(row);
    results.push(row);
    if (!await settle(`Measuring ${workload.slug} on ${cand.model_id}`)) {
      stoppedShort = cand.model_id;
      break;
    }
  }

  await settle(`Measuring ${workload.slug}`);
  await db.prepare(`UPDATE eval_runs SET status = 'done', finished_at = ?, error = ?, phase = NULL WHERE id = ?`)
    .run(now(), stoppedShort ? `balance ran out after ${stoppedShort}` : null, run.id);

  // the cheapest model that cleared, and what we do about it
  const refMonthly = await monthlyOn(workloadId, reference);
  /* the reference is not a candidate, but every screen compares against what it costs,
     so it is recorded on the run alongside them */
  await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd,
              verdict, gate_structure, gate_accuracy, gate_coverage, gate_complete, failures, created_at)
              VALUES (?, ?, ?, ?, 0, ?, 'reference', 100, 100, 100, 100, 0, ?)
              ON CONFLICT (run_id, model_id) DO UPDATE SET runs = excluded.runs,
                cost_month_usd = excluded.cost_month_usd, created_at = excluded.created_at`)
    .run(id('res'), run.id, reference, samples.length * 2, refMonthly, now());
  const cleared = results.filter((r) => r.verdict === 'cleared' && r.cost_month_usd !== null)
    .filter((r) => refMonthly === null || r.cost_month_usd < refMonthly)
    .sort((a, b) => a.cost_month_usd - b.cost_month_usd);
  const best = cleared[0] || null;

  if (best) {
    const saving = refMonthly === null ? null : round8(refMonthly - best.cost_month_usd);
    await db.prepare(`UPDATE workloads SET status = 'certified', status_note = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), workloadId);
    await addActivity(workload.workspace_id, {
      kind: 'ok',
      title: `${best.model_id} cleared your bar on ${workload.slug}`,
      detail: `${best.gap_pct.toFixed(2)}% against a ${floor.toFixed(2)}% bar`
        + (saving ? `, about $${saving.toFixed(2)} a month less` : ''),
      workloadId,
    });
    if (workload.optimize_mode === 'auto') {
      await promote(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId), best.model_id, {
        runId: run.id, reason: 'cleared your bar', auto: true,
      });
    }
  } else {
    const anyReview = results.some((r) => r.verdict === 'review');
    await db.prepare(`UPDATE workloads SET status = ?, status_note = ?, updated_at = ? WHERE id = ?`)
      .run(anyReview ? 'certified' : 'no_match',
           anyReview ? 'A candidate is close and needs a look' : 'Nothing cleared your bar yet',
           now(), workloadId);
    await addActivity(workload.workspace_id, {
      kind: 'floor', title: `Nothing cleared your bar on ${workload.slug}`,
      detail: `${results.length} models tried against a ${floor.toFixed(2)}% bar`,
      workloadId,
    });
  }
  return { ok: true, runId: run.id, floor, results: results.length, partial: !!stoppedShort };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/* How far apart two answers are, 0 to 1.
 *
 * Structured answers are settled by comparing fields and cost nothing. Free text comes back
 * as null, meaning "identical strings would have been easy, this needs an opinion", and a
 * judge is asked. Without a judge it counts as different, which is the safe direction: a
 * model is never promoted because nobody could tell whether it was any good. */
async function scoreOf(a, b, shape, request, charge) {
  const d = disagreement(a, b, shape);
  if (d !== null) return d;
  const { score, cost } = await judgePair(request, a.value ?? '', b.value ?? '');
  if (cost && charge) charge(cost);
  return score;
}

/* What the call asked, for the judge to weigh both answers against. */
function askOf(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  return msgs.map((m) => {
    const c = typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content) ? m.content.map((x) => x?.text || '').join(' ') : '');
    return `${m.role}: ${c}`;
  }).join('\n').slice(0, 4000);
}

async function replay(body, model, workload, runId) {
  try {
    const { json, latencyMs } = await chat({ ...body, stream: false }, model);
    const cost = Number(json?.usage?.cost ?? 0);
    await recordCall({
      workspaceId: workload.workspace_id, workloadId: workload.id, source: 'replay',
      requestedModel: workload.reference_model, servedModel: model, statusCode: 200,
      promptTokens: json?.usage?.prompt_tokens ?? 0, completionTokens: json?.usage?.completion_tokens ?? 0,
      costUsd: cost, chargedUsd: 0, latencyMs,
    });
    return { json, cost };
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 0;
    await recordCall({
      workspaceId: workload.workspace_id, workloadId: workload.id, source: 'replay',
      requestedModel: workload.reference_model, servedModel: model, statusCode: status,
    });
    return { json: null, cost: 0 };
  }
}

