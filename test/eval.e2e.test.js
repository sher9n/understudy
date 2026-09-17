/* The measurement engine, end to end, against a provider we control.

   There is no OpenRouter key on this machine, so the only way to know the engine
   actually works is to stand up a provider that behaves like one and drive the real
   code path through it: sample, replay the reference twice, replay each candidate,
   score, set the bar, pick the cheapest model that cleared, switch. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 4791;
process.env.DB_FILE = `test-eval-${process.pid}.db`;
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.OPENROUTER_BASE = `http://127.0.0.1:${PORT}/api/v1`;
process.env.MODEL_MIN_GAP_MS = '0';
process.env.EVAL_SAMPLE_SIZE = '100';
process.env.EVAL_MIN_RUNS = '100';
process.env.EVAL_MAX_USD_PER_RUN = '100';
process.env.JOBS_ENABLED = 'false';

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { createAccount } = await import('../src/auth.js');
const { workloadFor, recordCall } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { runEvaluation } = await import('../src/eval/run.js');
const { move } = await import('../src/billing.js');

migrate({ quiet: true });

/* How each model behaves. The reference is slightly unstable with itself, which is what
   creates the bar; one candidate is steadier and cheaper, one drifts badly. */
const BEHAVIOUR = {
  'openai/gpt-5.4': (i, call) => ({ total: 100 + i, currency: 'USD', lines: call === 2 && i % 20 === 0 ? 9 : (i % 5) + 1 }),
  'vendor/steady-small': (i) => ({ total: 100 + i, currency: 'USD', lines: (i % 5) + 1 }),
  'vendor/drifty-small': (i) => ({ total: 999, currency: 'EUR', lines: 0 }),
};

let seen = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    const model = payload.model;
    // the marker the request carries tells us which sampled call this is
    const text = payload.messages.find((m) => m.role === 'user')?.content || '';
    const i = Number((text.match(/#(\d+)/) || [])[1] || 0);
    seen += 1;
    const call = (BEHAVIOUR[model] === BEHAVIOUR['openai/gpt-5.4']) ? (seen % 2 === 0 ? 2 : 1) : 1;
    const answer = BEHAVIOUR[model] ? BEHAVIOUR[model](i, call) : { total: 0 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `gen-${seen}`,
      model,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
      usage: { prompt_tokens: 800, completion_tokens: 60, cost: model.includes('steady') ? 0.0002 : 0.002 },
    }));
  });
});

test.before(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  const f = path.resolve(process.cwd(), 'data', process.env.DB_FILE);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(f + suffix); } catch { /* already gone */ }
  }
});

test('a full measurement run sets a bar, scores every candidate, and switches', async () => {
  const { workspace } = createAccount({
    email: `e2e-${process.pid}@understudy.dev`, password: 'correct-horse', name: 'E2E',
  });
  move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });

  saveCatalog([
    { model_id: 'openai/gpt-5.4', name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: 'vendor/steady-small', name: 'steady', context_len: 128000, price_in: 0.2e-6, price_out: 0.6e-6, open_weights: 1, zdr: 1 },
    { model_id: 'vendor/drifty-small', name: 'drifty', context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6, open_weights: 1, zdr: 1 },
  ]);

  // 200 calls of one workload, spread over a fortnight so a monthly cost can be projected
  const DAY = 86400000;
  let workload = null;
  for (let i = 0; i < 200; i += 1) {
    const request = {
      model: 'openai/gpt-5.4',
      messages: [
        { role: 'system', content: `Extract the totals from invoice ${900000 + i}.` },
        { role: 'user', content: `document #${i}` },
      ],
      response_format: { type: 'json_object' },
    };
    workload = workload || workloadFor(workspace.id, request);
    recordCall({
      workspaceId: workspace.id, workloadId: workload.id, source: 'trace',
      requestedModel: 'openai/gpt-5.4', servedModel: 'openai/gpt-5.4', statusCode: 200,
      promptTokens: 800, completionTokens: 60, costUsd: 0.002, chargedUsd: 0.002,
      request, response: { choices: [{ message: { content: '{}' } }] },
    });
  }
  db.prepare('UPDATE calls SET created_at = ? WHERE workload_id = ?')
    .run(now() - 14 * DAY, workload.id);

  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, `the run did not finish: ${JSON.stringify(out)}`);

  // the bar comes from the reference disagreeing with itself, and never drops below 3%
  assert.ok(out.floor >= 3, `bar should be at least the 3% minimum, got ${out.floor}`);

  const run = db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
  assert.equal(run.status, 'done');
  assert.equal(run.sample_size, 100);

  const results = db.prepare('SELECT * FROM eval_results WHERE run_id = ? ORDER BY model_id').all(out.runId);
  assert.equal(results.length, 2, 'both candidates should have been tried');

  const steady = results.find((r) => r.model_id === 'vendor/steady-small');
  const drifty = results.find((r) => r.model_id === 'vendor/drifty-small');

  assert.equal(steady.runs, 100, 'every sampled call should have been replayed');
  assert.equal(steady.verdict, 'cleared', `the steady model should clear, got ${steady.gap_pct}% against ${out.floor}%`);
  assert.equal(drifty.verdict, 'missed', `the drifting model should miss, got ${drifty.gap_pct}%`);
  assert.ok(drifty.gap_pct > steady.gap_pct, 'the drifting model must score worse');
  assert.ok(steady.cost_month_usd < (drifty.cost_month_usd ?? Infinity) * 100, 'a monthly cost should be projected');

  // auto is the default, so the cheapest model that cleared is already serving
  const after = db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
  assert.equal(after.routed_model, 'vendor/steady-small', 'the workload should have switched on its own');
  assert.equal(after.status, 'promoted');

  const promo = db.prepare('SELECT * FROM promotions WHERE workload_id = ?').get(workload.id);
  assert.equal(promo.action, 'promote');
  assert.equal(promo.to_model, 'vendor/steady-small');

  // the replays were paid for out of the balance, the same way real traffic is
  const charged = db.prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS s FROM ledger
                               WHERE workspace_id = ? AND kind = 'eval'`).get(workspace.id).s;
  assert.ok(charged < 0, 'measuring should have been charged');
});
