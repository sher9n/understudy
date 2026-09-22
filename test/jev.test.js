/* Jev through OpenRouter: the same System One questions, sent to OpenRouter with our key, only to
   a provider that keeps nothing, and charged at the cost OpenRouter reports. A local stand-in
   for OpenRouter answers, so nothing is sent anywhere and nothing is spent. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const PORT = 4797;
process.env.JOBS_ENABLED = 'false';
process.env.ALERTS_ENABLED = 'false';
process.env.JEV_VIA = 'openrouter';
process.env.OPENROUTER_API_KEY = 'or-test-key';
process.env.OPENROUTER_BASE = `http://127.0.0.1:${PORT}/api/v1`;
process.env.ZDR_ONLY = 'true';
process.env.TYPESAFE_API_KEY = '';

const seen = [];
let reply = { status: 200 };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    if (reply.status !== 200) {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: reply.status, message: 'Insufficient credits. Add more using https://openrouter.ai/credits' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'gen-dec-1', model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe',
      answers: { same: { type: 'noul', noul: 0.93 } },
      usage: { input_tokens: 466, output_tokens: 70, cost: 0.000019572 },
    }));
  });
});

const { ask, jevUsable, jevResting, jevCost } = await import('../src/jev.js');
const { canJev } = await import('../src/config.js');

test.before(async () => { await new Promise((r) => server.listen(PORT, '127.0.0.1', r)); });
test.after(async () => { await new Promise((r) => server.close(r)); });

test('Jev is asked through OpenRouter, only where nothing is kept, and charged what OpenRouter says', async () => {
  assert.equal(canJev(), true, 'an OpenRouter key is all it needs');
  const r = await ask({ request: 'q', answers: { x: 'a', y: 'b' } }, { same: { type: 'noul', instructions: 'Same?' } });
  const sent = seen.at(-1);
  assert.equal(sent.url, '/api/v1/systemone');
  assert.equal(sent.auth, 'Bearer or-test-key');
  assert.equal(sent.body.model, 'jev-latest');
  assert.deepEqual(sent.body.provider, { zdr: true, data_collection: 'deny' });
  assert.equal(r.answers.same.noul, 0.93);
  assert.equal(r.costUsd, 0.000019572, 'the cost OpenRouter reports, not one worked out here');
  assert.equal(r.model, 'typesafe/jev-1.13-20260917');
  assert.equal(r.provider, 'TypeSafe');
  // without a reported cost, the price per input token is the fallback
  assert.ok(Math.abs(jevCost({ input_tokens: 1e6 }) - 0.042) < 1e-12);
});

test('an OpenRouter account out of credit rests Jev, says why, and sends nothing more', async () => {
  reply = { status: 402 };
  await assert.rejects(ask({ x: 1 }, { q: { type: 'noul', instructions: '?' } }), /402/);
  assert.equal(jevUsable(), false);
  assert.match(jevResting(), /OpenRouter account has no credit/);
  const before = seen.length;
  await assert.rejects(ask({ x: 1 }, { q: { type: 'noul', instructions: '?' } }), /resting|credit/);
  assert.equal(seen.length, before, 'nothing is sent while it rests');
});
