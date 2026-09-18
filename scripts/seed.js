/* Puts believable traffic through the real endpoints, so every screen can be seen
   without a provider key. It only ever uses the public API: nothing is written
   straight into the database, so what you see is what a real customer would see. */

import crypto from 'node:crypto';
import { db, now } from '../src/db/index.js';
import config from '../src/config.js';

const BASE = `http://localhost:${config.PORT}`;
const DAY = 86400000;

const key = process.env.SEED_KEY;
if (!key) {
  console.error('Set SEED_KEY to a us_live_ key, then run this again.');
  process.exit(1);
}
// the key decides the workspace, exactly as it does for a real caller
const keyHash = crypto.createHash('sha256').update(key).digest('hex');
const ws = await db.prepare(
  `SELECT w.* FROM workspaces w JOIN api_keys k ON k.workspace_id = w.id WHERE k.key_hash = ?`).get(keyHash);
if (!ws) {
  console.error('That key does not belong to any workspace.');
  process.exit(1);
}

const JOBS = [
  {
    slug: 'summarise-thread', n: 240, model: 'openai/gpt-5.4',
    system: () => 'Summarise this thread for a colleague picking it up cold.',
    body: {},
    answer: (i) => `The customer reported a duplicate charge on order ${70000 + i} and wants it refunded.`,
    tokens: [1450, 120],
  },
  {
    slug: 'translate-product-copy', n: 150, model: 'openai/gpt-5.4',
    system: () => 'Translate this product copy into German, keeping the brand voice.',
    body: {},
    answer: (i) => `Wasserdichte Jacke ${i}, leicht und atmungsaktiv.`,
    tokens: [260, 180],
  },
  {
    slug: 'ticket-priority', n: 320, model: 'openai/gpt-5.4',
    system: () => 'Decide how urgent this ticket is.',
    body: {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'ticket_priority', schema: { properties: { priority: { enum: ['low', 'normal', 'high', 'urgent'] } } } },
      },
    },
    answer: (i) => JSON.stringify({ priority: ['low', 'normal', 'high', 'urgent'][i % 4] }),
    tokens: [210, 10],
  },
  {
    slug: 'contract-terms', n: 190, model: 'openai/gpt-5.4',
    system: (i) => `Pull the key terms out of contract ${5000 + i}.`,
    body: {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'contract_terms', schema: { properties: {
          party: { type: 'string' }, term_months: { type: 'number' },
          notice_days: { type: 'number' }, auto_renew: { type: 'boolean' } } } },
      },
    },
    answer: (i) => JSON.stringify({ party: `Acme ${i}`, term_months: 12 + (i % 24),
      notice_days: [30, 60, 90][i % 3], auto_renew: i % 2 === 0 }),
    tokens: [3100, 90],
  },
  {
    slug: 'flag-listing', n: 210, model: 'openai/gpt-5.4',
    system: () => 'Check this marketplace listing against our policy and flag it if it breaks one.',
    body: {
      tools: [{ type: 'function', function: { name: 'flag_listing',
        description: 'Flag a listing that breaks policy',
        parameters: { type: 'object', properties: {
          reason: { type: 'string' }, severity: { type: 'string' } } } } }],
    },
    answer: (i) => JSON.stringify({ flagged: i % 7 === 0, reason: i % 7 === 0 ? 'counterfeit' : null }),
    tokens: [640, 40],
  },
  {
    slug: 'invoice-extract', n: 420, model: 'openai/gpt-5.4',
    system: (i) => `Extract the line items from invoice ${100000 + i} dated 2026-0${(i % 9) + 1}-14.`,
    body: { response_format: { type: 'json_object' } },
    answer: (i) => JSON.stringify({ number: 100000 + i, total: 120 + (i % 40), lines: (i % 5) + 1 }),
    tokens: [820, 96],
  },
  {
    slug: 'support-reply', n: 260, model: 'openai/gpt-5.4',
    system: () => 'Write a friendly reply to this customer, in our house tone.',
    body: {},
    answer: (i) => `Thanks for getting in touch. ${'We have looked into it. '.repeat(1 + (i % 3))}`,
    tokens: [310, 140],
  },
  {
    slug: 'doc-classify', n: 180, model: 'openai/gpt-5.4',
    system: () => 'Classify this document.',
    body: {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'doc_classify', schema: { properties: { label: { enum: ['invoice', 'order', 'credit-note', 'receipt', 'quote', 'other'] } } } },
      },
    },
    answer: (i) => JSON.stringify({ label: ['invoice', 'order', 'credit-note', 'receipt', 'quote', 'other'][i % 6] }),
    tokens: [180, 12],
  },
];

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
};

const only = (process.env.SEED_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
const jobs = only.length ? JOBS.filter((j) => only.includes(j.slug)) : JOBS;
if (only.length && jobs.length !== only.length) {
  console.error('SEED_ONLY names something that is not a job:', only.join(', '));
  process.exit(1);
}

let sent = 0;
for (const job of jobs) {
  for (let i = 0; i < job.n; i += 200) {
    const batch = [];
    for (let k = i; k < Math.min(job.n, i + 200); k += 1) {
      batch.push({
        request: {
          model: job.model,
          messages: [
            { role: 'system', content: job.system(k) },
            { role: 'user', content: `document body ${k}` },
          ],
          ...job.body,
        },
        response: {
          model: job.model,
          choices: [{ finish_reason: 'stop', message: { content: job.answer(k) } }],
          usage: { prompt_tokens: job.tokens[0], completion_tokens: job.tokens[1] },
        },
        latency_ms: 900 + (k % 700),
      });
    }
    const r = await post('/v1/traces', { traces: batch });
    sent += r.accepted;
  }
  console.log(`  ${job.slug}: ${job.n} calls`);
}

/* The traces all land now, which would leave the daily chart as one spike. Spread them
   over the retention window so the screens show what a month of traffic looks like. */
const calls = only.length ? [] : await db.prepare('SELECT id FROM calls WHERE workspace_id = ? ORDER BY created_at, id').all(ws.id);
const start = now() - 21 * DAY;
await db.tx(async (tx) => {
  const spread = tx.prepare('UPDATE calls SET created_at = ? WHERE id = ?');
  for (const [i, c] of calls.entries()) {
    await spread.run(Math.round(start + (i / calls.length) * 21 * DAY), c.id);
  }
});

console.log(`\n${sent} calls through /v1/traces, spread over 21 days.`);
console.log('Workloads found:');
for (const w of await db.prepare('SELECT slug, shape_kind, status FROM workloads WHERE workspace_id = ?').all(ws.id)) {
  console.log(`  ${w.slug} (${w.shape_kind}) ${w.status}`);
}
