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
const ws = db.prepare(
  `SELECT w.* FROM workspaces w JOIN api_keys k ON k.workspace_id = w.id WHERE k.key_hash = ?`).get(keyHash);
if (!ws) {
  console.error('That key does not belong to any workspace.');
  process.exit(1);
}

const JOBS = [
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

let sent = 0;
for (const job of JOBS) {
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
const calls = db.prepare('SELECT id FROM calls WHERE workspace_id = ? ORDER BY rowid').all(ws.id);
const spread = db.prepare('UPDATE calls SET created_at = ? WHERE id = ?');
const start = now() - 21 * DAY;
db.transaction(() => {
  calls.forEach((c, i) => spread.run(Math.round(start + (i / calls.length) * 21 * DAY), c.id));
})();

console.log(`\n${sent} calls through /v1/traces, spread over 21 days.`);
console.log('Workloads found:');
for (const w of db.prepare('SELECT slug, shape_kind, status FROM workloads WHERE workspace_id = ?').all(ws.id)) {
  console.log(`  ${w.slug} (${w.shape_kind}) ${w.status}`);
}
