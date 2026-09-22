import { db, id, now, round8 } from '../db/index.js';
import config, { canRoute } from '../config.js';
import { chat, priceCall, UpstreamError } from '../openrouter.js';
import { addActivity, recordCall } from '../traffic.js';
import { gateEval, chargeEval } from '../billing.js';
import { planFor } from './plan.js';
import { judgePair, judgementsFor } from './judge.js';
import { extract, disagreement, gates, floorFrom, verdictFor, sampleCalls, barIsMeaningful } from './compare.js';
import { promote } from './promote.js';
import { OUTCOME_OF, OUTCOME_CASE, cheaperCleared } from './outcome.js';

const DAY = 86400000;

/** Models this workspace is willing to try, cheapest first, never the reference itself. */
/** What a month of this workload would cost on a given model, from its own observed tokens.
 *  The customer's traffic only: our own replays counted here once, and a workload measured a
 *  few times was projected from ten times more calls than it had ever made. */
async function monthlyOn(workloadId, modelId) {
  const t = await db.prepare(
    `SELECT COALESCE(SUM(prompt_tokens), 0) AS pin, COALESCE(SUM(completion_tokens), 0) AS pout,
            COUNT(*) AS n, MIN(created_at) AS first
       FROM calls WHERE workload_id = ? AND created_at >= ? AND source NOT IN ('replay', 'test')`)
    .get(workloadId, now() - 30 * DAY);
  if (!t.n) return null;
  const per = await priceCall(modelId, t.pin, t.pout);
  if (per === null) return null;
  const days = Math.max(1, (now() - t.first) / DAY);
  return round8((per / days) * 30);
}

export async function runEvaluation(workloadId, { trigger = 'manual', jobId = null } = {}) {
  const workload = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId);
  if (!workload) return { ok: false, reason: 'gone' };
  if (!canRoute()) return { snoozeMs: 15 * 60000, note: 'no OPENROUTER_API_KEY' };

  const reference = workload.reference_model;
  if (!reference) return { ok: false, reason: 'no reference model' };

  /* The same plan the button showed. Working it out twice, in two places, is how a screen
     comes to promise something the run then refuses. */
  const plan = await planFor(workload, { canRoute: canRoute() });
  if (!plan.canRun) {
    /* Back to what its last measurement found, not to "new": a workload that has been measured
       before still has that result, and forgetting it here would put "Not optimized yet" over a
       page that shows a candidate. */
    if (workload.status === 'measuring') await rest(workloadId);
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
    models_planned: candidates.length, heartbeat_at: now(), job_id: jobId,
  };
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model,
              sample_size, created_at, started_at, steps_total, steps_done, phase, trigger, models_planned,
              heartbeat_at, job_id)
              VALUES (@id, @workspace_id, @workload_id, @status, @shape_kind, @reference_model,
              @sample_size, @created_at, @started_at, @steps_total, @steps_done, @phase, @trigger,
              @models_planned, @heartbeat_at, @job_id)`).run(run);
  /* Whatever started it, a workload being measured says so from the moment the run exists. A
     scheduled run used to leave the page saying whatever it said before, and only the button
     ever set this. */
  await db.prepare(`UPDATE workloads SET status = 'measuring', updated_at = ? WHERE id = ?`).run(now(), workloadId);

  /* Written as the run goes, not at the end: a screen watching this is the only way somebody
     knows the thing they paid for is happening.

     A step answers true when the run should end there: somebody asked it to stop, or its row
     was closed from outside because it looked abandoned. */
  let done = 0;
  /* calls that have come back since the last step, so a stop between the two replays of a pair
     still counts the one that ran and was paid for */
  let pending = 0;
  const ended = (row) => !row || row.status !== 'running' || !!row.stop_requested_at;
  const step = async (by, phase) => {
    done += by;
    pending = 0;
    const r = await db.prepare(`UPDATE eval_runs SET steps_done = ?, phase = ?, heartbeat_at = ?
                  WHERE id = ? RETURNING status, stop_requested_at`).run(done, phase, now(), run.id);
    return ended(r.rows[0]);
  };

  /* Asked before every call goes out: the heartbeat, and whether to send the call at all.
     Checking only between steps let a stop through with a call still to send, because one
     step can be two replays, or a replay and two judgements. Checked here, nothing more is sent
     once somebody presses Stop; and since the heartbeat is written just before each call, a
     run waiting on one slow call is never mistaken for an abandoned one. */
  const halted = async () => {
    const r = await db.prepare(`UPDATE eval_runs SET heartbeat_at = ? WHERE id = ?
                  RETURNING status, stop_requested_at`).run(now(), run.id);
    return ended(r.rows[0]);
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

  /* Stopped part way. Everything that ran is charged, every model that answered all of its
     calls keeps its result, and nothing is switched: a stopped run is never a certificate,
     because only a finished one is. If the row was already closed from outside, the charge
     still lands here, where the spend is, and the stop is not announced twice. */
  const endStopped = async () => {
    await settle(`Measuring ${workload.slug}, stopped`);
    done += pending;
    pending = 0;
    const closed = await db.prepare(`UPDATE eval_runs SET status = 'stopped', outcome = 'stopped',
                  finished_at = ?, phase = NULL, steps_done = ? WHERE id = ? AND status = 'running' RETURNING id`)
      .run(now(), done, run.id);
    await db.prepare('UPDATE eval_runs SET phase = NULL WHERE id = ?').run(run.id);
    if (!closed.rows.length) return { ok: true, runId: run.id, stopped: true };
    await rest(workloadId);
    await addActivity(workload.workspace_id, {
      kind: 'floor',
      title: `Measuring ${workload.slug} stopped`,
      detail: `Stopped at ${done} of ${stepsTotal} model calls, as you asked. You were charged only for `
        + 'the calls it made, and nothing was switched.',
      workloadId,
    });
    return { ok: true, runId: run.id, stopped: true };
  };

  /* A stop that arrived while this was being picked up. Its job was cancelled after it was
     claimed and before this run existed, so there was no run to ask; it ends here, before a
     single call is sent. */
  if (jobId && (await db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId))?.status === 'cancelled') {
    return await endStopped();
  }

  // the bar first: the reference model against itself, measured fresh
  for (const s of samples) {
    const body = JSON.parse(s.request_json);
    if (await halted()) return await endStopped();
    const a = await replay(body, reference, workload, run.id);
    spend += a.cost;
    pending += 1;
    if (await halted()) return await endStopped();
    const b = await replay(body, reference, workload, run.id);
    spend += b.cost;
    pending += 1;
    await db.prepare(`INSERT INTO eval_samples (id, run_id, call_id, quartile, ref_a_json, ref_b_json, charged)
                VALUES (?, ?, ?, ?, ?, ?, 0)`)
      .run(id('smp'), run.id, s.id, s.quartile ?? 0,
           a.json ? JSON.stringify(a.json) : null, b.json ? JSON.stringify(b.json) : null);
    refPairs.push({ body, a: extract(a.json, shape), b: extract(b.json, shape) });
    if (await step(2, `Setting your bar on ${reference}, ${refPairs.length} of ${samples.length} calls`)) {
      return await endStopped();
    }
  }

  const noiseScores = [];
  for (const p of refPairs) {
    // free text asks a judge, and a judgement is a call like any other
    if (judgements && await halted()) return await endStopped();
    noiseScores.push(await scoreOf(p.a, p.b, shape, askOf(p.body), (c) => { spend += c; }));
    if (judgements) pending += 1;
    if (judgements
      && await step(1, `Comparing answers on ${reference}, ${noiseScores.length} of ${refPairs.length}`)) {
      return await endStopped();
    }
  }
  const noise = mean(noiseScores);
  const floor = floorFrom(noise * 100, {
    multiple: config.EVAL_FLOOR_MULTIPLE, minPct: config.EVAL_FLOOR_MIN_PCT,
  });
  await db.prepare('UPDATE eval_runs SET noise_pct = ?, floor_pct = ? WHERE id = ?')
    .run(round8(noise * 100), round8(floor), run.id);

  /* The run's ending is written only while it is still running and nobody has asked it to stop.
     A stop can arrive after the last step, while the last charge is being settled; unguarded,
     the run then wrote "done" and switched the model, while the page, told it was stopping,
     said nothing had been switched. Answers false when the stop won, and the run ends stopped. */
  const finish = async (outcome, error) => (await db.prepare(
    `UPDATE eval_runs SET status = 'done', outcome = ?, finished_at = ?, error = ?, phase = NULL
      WHERE id = ? AND status = 'running' AND stop_requested_at IS NULL RETURNING id`)
    .run(outcome, now(), error, run.id)).rows.length > 0;

  /* If the reference model cannot answer its own calls consistently, the bar it produces is
     not a quality standard, it is noise. Certifying against it would let anything through,
     which is the opposite of what this product promises. Stop here and say so. */
  if (!barIsMeaningful(noise * 100, config.EVAL_NOISE_MAX_PCT)) {
    await settle(`Measuring ${workload.slug}, setting the bar`);
    if (!await finish('unmeasurable', `reference disagreed with itself on ${(noise * 100).toFixed(1)}% of calls`)) {
      return await endStopped();
    }
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

  /* A bar worth holding models to, so from here it is the workload's bar. It used to be written
     before the check above, so a run stopped at that moment left a bar nobody could clear. */
  await db.prepare('UPDATE workloads SET floor_pct = ?, updated_at = ? WHERE id = ?')
    .run(round8(floor), now(), workloadId);

  if (!await settle(`Measuring ${workload.slug}, setting the bar`)) {
    if (!await finish('no_balance', 'balance ran out after the bar was set')) return await endStopped();
    await rest(workloadId);
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
      if (await halted()) return await endStopped();
      const c = await replay(p.body, cand.model_id, workload, run.id);
      spend += c.cost;
      pending += 1;
      runs += 1;
      const got = extract(c.json, shape);
      if (!got.ok) failures += 1;
      const ask = askOf(p.body);
      const add = (x) => { spend += x; };
      // each comparison of free text is a judgement, and a judgement is a call
      if (judgements && await halted()) return await endStopped();
      const againstA = await scoreOf(got, p.a, shape, ask, add);
      if (judgements) pending += 1;
      if (judgements && await halted()) return await endStopped();
      const againstB = await scoreOf(got, p.b, shape, ask, add);
      if (judgements) pending += 1;
      const score = Math.min(againstA, againstB);
      pairs.push({ cand: got, ref: p.a.ok ? p.a : p.b, score });
      /* Counted here rather than every five calls, so the bar moves while a slow model is
         answering rather than jumping in blocks. One replay, plus its two comparisons when
         free text has to be judged. */
      /* A model stopped part way through its calls is left out rather than judged on what
         it managed, the same rule a verdict already has for too few runs. */
      if (await step(1 + (judgements ? 2 : 0),
        `Trying ${cand.model_id}, model ${ci + 1} of ${candidates.length}, ${runs} of ${refPairs.length} calls`)) {
        return await endStopped();
      }
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
  // a stop that arrived during that last settle wins: stopped, and nothing switched
  if (!await finish('compared', stoppedShort ? `balance ran out after ${stoppedShort}` : null)) {
    return await endStopped();
  }

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

/* Whether anything is still running a measurement.
 *
 * A live run writes a heartbeat just before every call it sends, so one that has gone quiet
 * for longer than the slowest single call could take has nothing running it: the process that
 * was went away, usually in a deploy or a restart.
 *
 * A run started by the code before this has no heartbeat at all, and during a deploy the old
 * process may still be running it while this one boots. Such a run is only judged once this
 * process has been up longer than the same window, by which time the old one is certainly
 * gone; judged earlier, a run still being worked on could be closed from under it. */
export function isAbandoned(run, at = now()) {
  const stale = config.EVAL_STALE_MIN * 60000;
  if (run.heartbeat_at == null) {
    return process.uptime() * 1000 > stale && at - (run.started_at ?? run.created_at) > stale;
  }
  return at - run.heartbeat_at > stale;
}

/* Every finished run says what it found. The migration filled this in for runs before it, but
   during a deploy the old process can still finish one afterwards, without the word; read as
   "compared", a run that ran out of balance would then stand in for the last real measurement.
   Run at boot and hourly, and it only ever touches rows that have no outcome yet. */
export async function settleOutcomes() {
  return (await db.prepare(`UPDATE eval_runs SET outcome = ${OUTCOME_CASE()}
    WHERE outcome IS NULL AND status IN ('done', 'failed', 'stopped')`).run()).changes;
}

/* What a workload's status should say while nothing is measuring it: what the last measurement
 * that found anything found. A run that ended without finding anything, because it was
 * stopped, interrupted or ran out of balance, changes nothing, so stopping a measurement can
 * never make a workload forget a candidate an earlier one found. The same reading the end of a
 * finished run makes. */
export async function restingStatus(workloadId) {
  const w = await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(workloadId);
  const routed = w?.routed_model ?? null;
  if (routed) return { status: 'promoted', note: null, routed };
  const last = await db.prepare(
    `SELECT id, ${OUTCOME_OF()} AS outcome FROM eval_runs WHERE workload_id = ?
        AND status = 'done' AND ${OUTCOME_OF()} IN ('compared', 'unmeasurable')
      ORDER BY created_at DESC LIMIT 1`).get(workloadId);
  if (!last) return { status: 'new', note: null, routed };
  if (last.outcome === 'unmeasurable') return { status: 'no_match', note: 'We could not measure this workload', routed };
  const results = await db.prepare(
    `SELECT verdict, cost_month_usd FROM eval_results WHERE run_id = ?`).all(last.id);
  // the run's own rule, so a status read again always says what the run said at its end
  if (cheaperCleared(results).length) return { status: 'certified', note: null, routed };
  if (results.some((r) => r.verdict === 'review')) {
    return { status: 'certified', note: 'A candidate is close and needs a look', routed };
  }
  return { status: 'no_match', note: 'Nothing cleared your bar yet', routed };
}

/* Put a workload back to its resting status, unless it is about to be measured anyway: another
   run of it is going, or one is waiting in the queue. A claimed job does not count, because the
   one asking is usually that very job, and an abandoned run's job stays claimed for ever. */
export async function rest(workloadId) {
  const readAt = now();
  const { status, note, routed } = await restingStatus(workloadId);
  /* The check and the write are one statement, and the write only lands if nothing it was read
     from has moved since: no run is going or waiting, none has finished since the reading, and
     the model serving it is the one it was read with. As separate steps, a run starting in
     between had its "Measuring" overwritten, and one finishing in between, or a switch, had its
     ending replaced by the older reading. */
  const r = await db.prepare(
    `UPDATE workloads SET status = ?, status_note = ?, updated_at = ?
      WHERE id = ? AND routed_model IS NOT DISTINCT FROM ?
        AND NOT EXISTS (SELECT 1 FROM eval_runs WHERE workload_id = ?
                          AND (status = 'running' OR COALESCE(finished_at, 0) > ?))
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE kind = 'eval_run' AND status = 'queued'
                          AND (payload::jsonb ->> 'workloadId') = ?)`)
    .run(status, note, now(), workloadId, routed, workloadId, readAt, workloadId);
  return r.changes > 0;
}

/* Close a run that nothing is running any more: stopped when somebody asked for that, and
   interrupted otherwise. Nothing is switched and nothing more is charged. What it spent up to
   its last settle is already on the ledger; the calls after that were never charged, which
   leaves that difference with us rather than with the customer. */
async function closeRun(run, how) {
  const closed = await db.prepare(
    `UPDATE eval_runs SET status = ?, outcome = ?, finished_at = ?, phase = NULL,
            error = COALESCE(error, ?) WHERE id = ? AND status = 'running' RETURNING id`)
    .run(how === 'stopped' ? 'stopped' : 'failed', how, now(),
         how === 'stopped' ? null : 'interrupted', run.id);
  if (!closed.rows.length) return false;
  /* and let go of the job that started it. Left claimed, the job still counted as open, so
     Measure now was answered with it and started nothing, and a later boot revived it and ran
     a measurement nobody had asked for then. */
  if (run.job_id) {
    /* Unless another run holds it now. A restart puts a dead run's job back in the queue, and a
       new run takes it under the same id; releasing it from under that run would leave its
       ending unwritten and its retry skipped. */
    await db.prepare(`UPDATE jobs SET status = 'failed', error = ? WHERE id = ? AND status = 'claimed'
                AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.job_id = jobs.id AND r.status = 'running')`)
      .run(how === 'stopped' ? 'stopped by you' : 'interrupted', run.job_id);
  }
  await rest(run.workload_id);
  const slug = (await db.prepare('SELECT slug FROM workloads WHERE id = ?').get(run.workload_id))?.slug
    ?? 'a workload';
  await addActivity(run.workspace_id, {
    kind: 'floor',
    title: how === 'stopped' ? `Measuring ${slug} stopped` : `Measuring ${slug} was interrupted`,
    detail: how === 'stopped'
      ? `Stopped at ${run.steps_done} of ${run.steps_total} model calls, as you asked. You were charged only `
        + 'for the calls it made, and nothing was switched.'
      : 'It stopped moving part way through, usually because the service restarted. Nothing was '
        + 'switched, and it can be measured again.',
    workloadId: run.workload_id,
  });
  return true;
}

/** Close every measurement nothing is running any more, for one workload or for all of them. */
export async function closeAbandoned(workloadId = null) {
  const rows = workloadId
    ? await db.prepare(`SELECT * FROM eval_runs WHERE workload_id = ? AND status = 'running'`).all(workloadId)
    : await db.prepare(`SELECT * FROM eval_runs WHERE status = 'running'`).all();
  let closed = 0;
  for (const r of rows) {
    if (isAbandoned(r) && await closeRun(r, r.stop_requested_at ? 'stopped' : 'interrupted')) closed += 1;
  }
  /* A job can be left claimed with no run at all: its process died between picking it up and
     starting. Claimed for longer than any run goes quiet, with no running run of its own, it is
     let go too, for the same reason a closed run's job is. */
  const since = now() - config.EVAL_STALE_MIN * 60000;
  await db.prepare(
    `UPDATE jobs SET status = 'failed', error = 'interrupted: nothing was running it'
      WHERE kind = 'eval_run' AND status = 'claimed' AND claimed_at < ?
        ${workloadId ? `AND (payload::jsonb ->> 'workloadId') = ?` : ''}
        AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.job_id = jobs.id AND r.status = 'running')`)
    .run(...(workloadId ? [since, workloadId] : [since]));
  return closed;
}

/* Stop measuring a workload, whatever state that is in.
 *
 * One waiting in the queue is taken out of it. One running is asked to stop, and does at its
 * next step, once the call in flight has come back and been counted, which is usually a matter
 * of seconds. One that nothing is running any more is closed here and now, because nothing else
 * ever would: it would sit on the page as a bar that never moves and keep Measure now from
 * starting another. Its job leaves the queue as well, or the next restart would put it back and
 * start measuring again, which is the one thing somebody pressing Stop has said they do not
 * want. Answers with what happened: stopping, stopped, cancelled, or idle for nothing at all. */
export async function stopMeasuring(workload, { actorUserId = null } = {}) {
  /* Only the jobs no run belongs to yet: waiting in the queue, or picked up a moment ago and not
     started. Those really are stopped before they start. A job whose run exists is that run's,
     and the run is stopped through its own row below; cancelling it too made a stop in a run's
     last moments, after it had finished and while it was tidying up, answer "stopped before it
     started, so nothing was spent" about a measurement that had spent money and may have been
     switching a model. */
  const cancelled = (await db.prepare(
    `UPDATE jobs SET status = 'cancelled', error = 'stopped by you'
      WHERE kind = 'eval_run' AND status IN ('queued', 'claimed')
        AND (payload::jsonb ->> 'workloadId') = ?
        AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.job_id = jobs.id)`).run(workload.id)).changes;
  /* Every run of it, not only the newest: one asked for and one on schedule can be running at
     once, and stopping the workload means stopping both. */
  const runs = await db.prepare(
    `SELECT * FROM eval_runs WHERE workload_id = ? AND status = 'running'`).all(workload.id);
  if (!runs.length) {
    await rest(workload.id);
    /* Nothing running. A measurement that was waiting and has been taken out of the queue was
       stopped before it started, whatever finished earlier. Only with nothing cancelled does a
       run that finished a moment ago mean the stop came too late. */
    if (cancelled) return { ok: true, state: 'cancelled' };
    const recent = await db.prepare(
      `SELECT status FROM eval_runs WHERE workload_id = ? AND finished_at > ?
        ORDER BY created_at DESC LIMIT 1`).get(workload.id, now() - 60000);
    if (recent?.status === 'done') return { ok: true, state: 'finished' };
    return { ok: true, state: 'idle' };
  }
  let live = 0;
  for (const run of runs) {
    await db.prepare(`UPDATE eval_runs SET stop_requested_at = COALESCE(stop_requested_at, ?),
                stopped_by = COALESCE(stopped_by, ?) WHERE id = ?`).run(now(), actorUserId, run.id);
    if (!(isAbandoned(run) && await closeRun(run, 'stopped'))) live += 1;
  }
  return { ok: true, state: live ? 'stopping' : 'stopped' };
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

