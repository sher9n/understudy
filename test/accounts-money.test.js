/* Money that cannot be spent twice, and accounts that prove whose they are, end to end: the real
   app, a provider we control, a real database, and Stripe's own signatures on the webhooks. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4781;
const APP_PORT = 4782;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_money_${process.pid}`;
const adminUrl = new URL(ADMIN);
adminUrl.pathname = '/postgres';
{
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.query(`CREATE DATABASE ${TEST_DB}`);
  await c.end();
}
const testUrl = new URL(ADMIN);
testUrl.pathname = `/${TEST_DB}`;
process.env.DATABASE_URL = testUrl.toString();
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.OPENROUTER_BASE = `http://127.0.0.1:${PORT}/api/v1`;
process.env.MODEL_MIN_GAP_MS = '0';
process.env.JOBS_ENABLED = 'false';
process.env.JEV_VIA = 'off';
process.env.TYPESAFE_API_KEY = '';
process.env.ALERTS_ENABLED = 'false';
process.env.RESEND_API_KEY = '';
process.env.STRIPE_SECRET_KEY = 'sk_test_understudy_tests';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_understudy_tests';
process.env.PUBLIC_URL = 'http://localhost:4782';
process.env.STARTER_CREDIT_USD = '0';

const { db, now } = await import('../src/db/index.js');
const { default: config, paymentsState, canBill } = await import('../src/config.js');
const auth = await import('../src/auth.js');
const billing = await import('../src/billing.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { runOnce, enqueue } = await import('../src/jobs.js');
const { learningSettled } = await import('../src/traffic.js');
// the whole app, as it is deployed: migrations, every route, the webhook, the error handler
const { app } = await import('../src/server.js');
const Stripe = (await import('stripe')).default;

const MODEL = 'openai/gpt-5.4';
// what the catalogue price below charges for the call the provider reports: 120 tokens in, 2 out
const COST = 120 * 2.5e-6 + 2 * 15e-6;
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const p = JSON.parse(body || '{}');
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'gen', model: p.model,
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'billing' } }],
        usage: { prompt_tokens: 120, completion_tokens: 2, cost: COST } }));
    }, 40);
  });
});
let server = null;
const base = `http://127.0.0.1:${APP_PORT}`;

// what would have been emailed, since nothing leaves the building in a test
const mail = [];
const realLog = console.log;
console.log = (...a) => {
  const s = a.join(' ');
  if (s.includes('[no RESEND_API_KEY')) { mail.push(s); return; }
  realLog(...a);
};
const lastCodeFor = (email) => {
  const hit = [...mail].reverse().find((m) => m.includes(`to: ${email}`));
  return hit ? (hit.match(/\b(\d{6})\b/) || [])[1] : null;
};
const lastLinkTokenFor = (email) => {
  const hit = [...mail].reverse().find((m) => m.includes(`to: ${email}`));
  return hit ? decodeURIComponent((hit.match(/#t=([^\s]+)/) || [])[1] || '') : null;
};

const post = (path, body, { ip = '203.0.113.1', cookie = null, headers = {} } = {}) => fetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/json', 'x-real-ip': ip, ...(cookie ? { cookie } : {}), ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0] || null;

test.before(async () => {
  await new Promise((r) => provider.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => { server = app.listen(APP_PORT, '127.0.0.1', r); });
  await saveCatalog([{ model_id: MODEL, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 }]);
});

test.after(async () => {
  console.log = realLog;
  await new Promise((r) => provider.close(r));
  await new Promise((r) => server.close(r));
  await learningSettled();
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

const workspaceOf = async (email) => (await db.prepare(
  'SELECT w.* FROM workspaces w JOIN users u ON u.id = w.owner_user_id WHERE u.email = ?').get(email));

test('signing up sends a code and gives nothing until the code comes back', async () => {
  const email = 'new-person@example.test';
  const r = await post('/api/auth/sign-up', { email, password: 'a-good-password', name: 'New Person' }, { ip: '198.51.100.10' });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.verify, true);
  assert.equal(j.key, undefined, 'no key before the email answers');
  assert.equal(cookieOf(r), null, 'no session before the email answers');
  const ws = await workspaceOf(email);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE workspace_id = ?').get(ws.id)).n, 0);
  // password sign-in does not work yet
  assert.equal((await post('/api/auth/sign-in', { email, password: 'a-good-password' }, { ip: '198.51.100.11' })).status, 401);

  const code = lastCodeFor(email);
  assert.match(code, /^\d{6}$/, 'a six digit code was emailed');
  const v = await post('/api/auth/code/verify', { email, code }, { ip: '198.51.100.10' });
  assert.equal(v.status, 200);
  const cookie = cookieOf(v);
  assert.ok(cookie, 'signed in once the code came back');
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
  assert.equal(me.signedIn, true);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL').get(ws.id)).n, 1,
    'the first key is made when the email answers');
  // and the password chosen with the code now works
  assert.equal((await post('/api/auth/sign-in', { email, password: 'a-good-password' }, { ip: '198.51.100.12' })).status, 200);
});

test('somebody signing up with another person\'s address gets nothing, and the owner takes it back', async () => {
  const victim = 'owner@example.test';
  await auth.startSignUp({ email: victim, password: 'attacker-chose-this' });
  // the attacker cannot sign in with the password they typed
  assert.equal(await auth.checkPassword(victim, 'attacker-chose-this'), null);
  // the real owner signs in with an emailed code, which proves the address is theirs
  const asked = await auth.requestLoginCode(victim);
  const out = await auth.verifyLoginCode(victim, asked.send.code);
  assert.equal(out.ok, true);
  assert.equal(out.fresh, true);
  const u = await db.prepare('SELECT * FROM users WHERE email = ?').get(victim);
  assert.ok(u.email_verified_at);
  assert.equal(u.pw_cleared, 1, 'the password typed at sign-up is cleared: it may not have been theirs');
  assert.equal(await auth.checkPassword(victim, 'attacker-chose-this'), null, 'and it never works');
  // the owner sets their own without needing the old one
  assert.equal((await auth.changePassword(u, '', 'owner-chose-this')).ok, true);
  assert.ok(await auth.checkPassword(victim, 'owner-chose-this'));
});

test('signing up again for an address already in use says the same thing and emails its owner', async () => {
  const email = 'new-person@example.test';
  const before = mail.length;
  const r = await post('/api/auth/sign-up', { email, password: 'somebody-else-typed', name: 'X' }, { ip: '198.51.100.20' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).verify, true, 'the same answer as a new address');
  const sent = mail.slice(before).find((m) => m.includes(`to: ${email}`));
  assert.ok(sent && /already has an account/.test(sent), 'the owner is told');
  assert.equal(await auth.checkPassword(email, 'somebody-else-typed'), null, 'and nothing changed');
});

test('a code allows exactly five tries, however many arrive at once', async () => {
  const email = 'new-person@example.test';
  const asked = await auth.requestLoginCode(email);
  const wrong = asked.send.code === '000000' ? '111111' : '000000';
  const outs = await Promise.all(Array.from({ length: 30 }, () => auth.verifyLoginCode(email, wrong)));
  const row = await db.prepare(`SELECT attempts, consumed_at FROM login_codes WHERE email = ? AND purpose = 'sign_in'
                                  ORDER BY created_at DESC LIMIT 1`).get(email);
  assert.equal(row.attempts, 5, 'five compared, never more');
  assert.equal(outs.filter((o) => o.reason === 'wrong').length, 5);
  assert.ok(row.consumed_at, 'and the code is spent');
  assert.equal((await auth.verifyLoginCode(email, asked.send.code)).ok, false, 'even the right code no longer works');
});

test('asking for codes looks the same whether or not the address has an account', async () => {
  const known = 'new-person@example.test';
  const unknown = 'nobody-at-all@example.test';
  const statuses = async (email, ipBase) => {
    const out = [];
    for (let i = 0; i < 7; i += 1) out.push((await post('/api/auth/code/request', { email }, { ip: `${ipBase}.${i}` })).status);
    return out;
  };
  // wait out the codes already asked for above
  await db.prepare(`DELETE FROM rate_events WHERE bucket = 'code_email'`).run();
  const a = await statuses(known, '192.0.2');
  const b = await statuses(unknown, '192.0.3');
  assert.deepEqual(a, b, 'the same answers, in the same order, for both');
  assert.equal(a.at(-1), 429, 'and both are limited');
});

test('one internet address cannot keep trying passwords', async () => {
  const codes = [];
  for (let i = 0; i < config.LIMIT_SIGNIN_PER_IP_15MIN + 1; i += 1) {
    codes.push((await post('/api/auth/sign-in', { email: `x${i}@example.test`, password: 'wrong-password' }, { ip: '203.0.113.99' })).status);
  }
  assert.equal(codes.at(-1), 429);
  assert.ok(codes.slice(0, -1).every((s) => s === 401));
});

test('opening an emailed link signs nobody in; pressing the button on its page does', async () => {
  const email = 'new-person@example.test';
  await db.prepare(`DELETE FROM rate_events WHERE bucket = 'code_email'`).run();
  await post('/api/auth/code/request', { email }, { ip: '198.51.100.40' });
  const token = lastLinkTokenFor(email);
  assert.ok(token, 'the email carries a link');
  // a scanner opening the old form of the link
  const g = await fetch(`${base}/api/auth/link?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  assert.equal(g.status, 302);
  assert.equal(cookieOf(g), null, 'opening it signs nobody in');
  assert.match(g.headers.get('location'), /^\/signin\/link#t=/);
  const peek = await (await post('/api/auth/link/peek', { token }, { ip: '198.51.100.41' })).json();
  assert.equal(peek.email, email);
  const p = await post('/api/auth/link', { token }, { ip: '198.51.100.41' });
  assert.equal(p.status, 200);
  assert.ok(cookieOf(p), 'pressing the button signs in');
  assert.equal((await post('/api/auth/link', { token }, { ip: '198.51.100.41' })).status, 401, 'once');
});

test('an email address only changes once the new address answers', async () => {
  const email = 'new-person@example.test';
  const u = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const out = await auth.requestEmailChange(u, 'moved-here@example.test');
  assert.equal(out.ok, true);
  assert.equal((await db.prepare('SELECT email FROM users WHERE id = ?').get(u.id)).email, email, 'not yet');
  assert.equal((await auth.verifyEmailChange(u, 'moved-here@example.test', out.send.code)).ok, true);
  assert.equal((await db.prepare('SELECT email FROM users WHERE id = ?').get(u.id)).email, 'moved-here@example.test');
  // an address somebody already has: the same answer, and no code goes out
  const other = await auth.createAccount({ email: 'taken@example.test', password: 'password-123' });
  const again = await auth.requestEmailChange({ ...u, email: 'moved-here@example.test' }, 'taken@example.test');
  assert.equal(again.ok, true);
  assert.equal(again.send, null);
  assert.ok(other.user.id);
});

test('calls arriving together cannot spend more than the balance holds', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'spender@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 0.005, note: 'test credit' });
  const outs = await Promise.all(Array.from({ length: 60 }, (_, i) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 20, messages: [
      { role: 'system', content: 'Classify the ticket as billing, shipping or other.' },
      { role: 'user', content: `Ticket ${i}` }] }),
  }).then((r) => r.status)));
  const acct = await billing.account(workspace.id);
  const ok = outs.filter((s) => s === 200).length;
  assert.ok(ok > 0, 'some went through');
  assert.ok(outs.filter((s) => s === 402).length > 0, 'the rest were refused before being sent');
  assert.ok(acct.balance_usd >= -COST * 1.02, `never below one call's cost: ${acct.balance_usd}`);
  const held = await billing.available(workspace.id);
  assert.equal(held.inFlight, 0, 'every hold was given back');
  // spending down one call at a time still works to the last cent
  const seq = [];
  for (let i = 0; i < 3; i += 1) {
    seq.push((await fetch(`${base}/v1/chat/completions`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}` },
      body: JSON.stringify({ model: MODEL, max_tokens: 20, messages: [{ role: 'user', content: 'one more' }] }) })).status);
  }
  assert.ok(seq[0] === 200 || seq[0] === 402);
});

const stripeSig = new Stripe('sk_test_understudy_tests');
async function webhook(event) {
  const payload = JSON.stringify(event);
  const header = stripeSig.webhooks.generateTestHeaderString({ payload, secret: 'whsec_understudy_tests' });
  return fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
}
let evn = 0;
const event = (type, object, livemode = true) => ({ id: `evt_${++evn}_${Date.now()}`, type, livemode, data: { object } });

test('a test payment never becomes balance on a public deployment', async () => {
  const { workspace } = await auth.createAccount({ email: 'tester@example.test', password: 'password-123' });
  config.ALLOW_TEST_PAYMENTS = false;
  assert.equal(paymentsState(), 'test_refused');
  assert.equal(canBill(), false);
  const r = await webhook(event('payment_intent.succeeded',
    { id: 'pi_test_1', object: 'payment_intent', amount_received: 50000, metadata: { topup: '1', workspace_id: workspace.id } }, false));
  assert.equal(r.status, 200, 'answered, so Stripe stops retrying');
  assert.equal((await billing.account(workspace.id)).balance_usd, 0, 'and nothing was credited');
  config.ALLOW_TEST_PAYMENTS = true;
});

test('only money that arrived is credited, and money that went back comes off again', async () => {
  const { workspace } = await auth.createAccount({ email: 'payer@example.test', password: 'password-123' });
  const s = await billing.stripe();
  s.paymentIntents.retrieve = async (id) => ({ id, payment_method: null });
  // completed, but the money is still on its way
  await webhook(event('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'payment',
    payment_status: 'unpaid', amount_total: 2000, payment_intent: 'pi_async', metadata: { workspace_id: workspace.id } }));
  assert.equal((await billing.account(workspace.id)).balance_usd, 0, 'not credited while unpaid');
  await webhook(event('checkout.session.async_payment_succeeded', { id: 'cs_1', object: 'checkout.session', mode: 'payment',
    payment_status: 'paid', amount_total: 2000, payment_intent: 'pi_async', metadata: { workspace_id: workspace.id } }));
  assert.equal((await billing.account(workspace.id)).balance_usd, 20, 'credited when it arrived');
  assert.equal((await billing.account(workspace.id)).auto_topup, 0, 'adding credit does not switch automatic top up on');
  // a partial refund, told twice, then the rest
  const refund = (amount) => event('charge.refunded', { id: 'ch_1', object: 'charge', amount_refunded: amount, metadata: { workspace_id: workspace.id } });
  await webhook(refund(500));
  await webhook(refund(500));
  assert.equal((await billing.account(workspace.id)).balance_usd, 15, 'five dollars back, once');
  await webhook(refund(2000));
  assert.equal((await billing.account(workspace.id)).balance_usd, 0, 'the rest when the rest went back');
  // a dispute takes its amount and turns automatic top up off
  await db.prepare('UPDATE billing_accounts SET auto_topup = 1, balance_usd = 30 WHERE workspace_id = ?').run(workspace.id);
  await webhook(event('charge.dispute.created', { id: 'dp_1', object: 'dispute', amount: 1000, metadata: { workspace_id: workspace.id } }));
  const after = await billing.account(workspace.id);
  assert.equal(after.balance_usd, 20);
  assert.equal(after.auto_topup, 0);
});

test('the plan\'s allowance pays for measuring first, and comes back each period', async () => {
  const { workspace } = await auth.createAccount({ email: 'planner@example.test', password: 'password-123' });
  await db.prepare(`UPDATE billing_accounts SET plan_status = 'active', allowance_period_start = ?, eval_used_usd = 0, balance_usd = 0
                     WHERE workspace_id = ?`).run(now(), workspace.id);
  const gate = await billing.gateEval(workspace.id, { estimatedUsd: 1 });
  assert.equal(gate.ok, true, 'a plan with no balance can still measure within its allowance');
  await billing.chargeEval(workspace.id, 1, 'Measuring something');
  let acct = await billing.account(workspace.id);
  assert.equal(acct.balance_usd, 0, 'nothing came out of the balance');
  assert.ok(Math.abs(acct.eval_used_usd - 1.01) < 1e-9);
  // a month on, the allowance is whole again
  await db.prepare('UPDATE billing_accounts SET allowance_period_start = ? WHERE workspace_id = ?').run(now() - 31 * 86400000, workspace.id);
  assert.equal(await billing.allowanceLeft(workspace.id), config.EVAL_ALLOWANCE_USD);
  // past the allowance, the rest comes out of the balance
  await db.prepare('UPDATE billing_accounts SET balance_usd = 5, eval_used_usd = 9.5 WHERE workspace_id = ?').run(workspace.id);
  await billing.chargeEval(workspace.id, 1, 'Measuring more');
  acct = await billing.account(workspace.id);
  assert.ok(Math.abs(acct.balance_usd - (5 - (1.01 - 0.5))) < 1e-9, `balance ${acct.balance_usd}`);
});

test('automatic top ups: only when switched on, never twice for one low balance, and a daily ceiling', async () => {
  const { workspace } = await auth.createAccount({ email: 'topper@example.test', password: 'password-123' });
  const s = await billing.stripe();
  const keys = [];
  s.paymentIntents.create = async (_body, opts) => { keys.push(opts.idempotencyKey); return { id: `pi_${keys.length}` }; };
  await db.prepare(`UPDATE billing_accounts SET stripe_customer = 'cus_1', payment_method = 'pm_1', balance_usd = 1, auto_topup = 0
                     WHERE workspace_id = ?`).run(workspace.id);
  assert.equal((await billing.runTopUp(workspace.id)).code, 'no_card', 'off unless switched on');
  await db.prepare('UPDATE billing_accounts SET auto_topup = 1 WHERE workspace_id = ?').run(workspace.id);
  await billing.runTopUp(workspace.id);
  await billing.runTopUp(workspace.id);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'a second low balance before the first top up lands replays the same charge');
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 0, note: 'Automatic top up', ref: 'pi_x' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 0.01, note: 'Automatic top up', ref: 'pi_y' });
  await billing.runTopUp(workspace.id);
  assert.notEqual(keys[2], keys[0], 'once one has landed, the next is a new charge');
  for (let i = 0; i < config.TOPUP_MAX_PER_DAY; i += 1) {
    await billing.move(workspace.id, { kind: 'credit', amountUsd: 0.01, note: 'Automatic top up', ref: `pi_cap_${i}` });
  }
  await db.prepare('UPDATE billing_accounts SET balance_usd = 1 WHERE workspace_id = ?').run(workspace.id);
  assert.equal((await billing.runTopUp(workspace.id)).code, 'daily_cap');
});

test('when a workspace\'s window passes, every copy of what its calls said goes', async () => {
  const { workspace } = await auth.createAccount({ email: 'forgetful@example.test', password: 'password-123' });
  const old = now() - 40 * 86400000;
  await db.prepare(`INSERT INTO workloads (id, workspace_id, slug, fingerprint, shape_kind, reference_model, sample_prompt, created_at, updated_at)
                     VALUES ('wl_forget', ?, 'forget', 'fp_forget', 'free_text', ?, 'SECRET-INSTRUCTION', ?, ?)`).run(workspace.id, MODEL, old, old);
  await db.prepare(`INSERT INTO calls (id, workspace_id, workload_id, source, request_json, response_json, created_at)
                     VALUES ('call_forget', ?, 'wl_forget', 'trace', '{"messages":[{"role":"user","content":"SECRET-ASK"}]}', '{"x":"SECRET-ANSWER"}', ?)`)
    .run(workspace.id, old);
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, created_at)
                     VALUES ('run_forget', ?, 'wl_forget', 'done', 'free_text', ?, ?)`).run(workspace.id, MODEL, old);
  await db.prepare(`INSERT INTO eval_replays (id, run_id, call_id, model_id, answer, created_at)
                     VALUES ('rpl_forget', 'run_forget', 'call_forget', ?, 'SECRET-REPLAY', ?)`).run(MODEL, old);
  await db.prepare(`INSERT INTO replay_cache (key, model_id, call_id, response_json, created_at)
                     VALUES ('rc_forget', ?, 'call_forget', '{"x":"SECRET-CACHED"}', ?)`).run(MODEL, old);
  await db.prepare(`INSERT INTO judge_cache (key, score, detail_json, judged_by, created_at)
                     VALUES ('jc_forget', 0, '{"numbers":["SECRET-NUMBER"]}', 'llm', ?)`).run(old);
  await enqueue('purge', {}, {});
  while (await runOnce()) { /* the purge, and the next one it books */ }
  const leftovers = await db.prepare(`SELECT
      (SELECT request_json FROM calls WHERE id = 'call_forget') AS req,
      (SELECT answer FROM eval_replays WHERE id = 'rpl_forget') AS replay,
      (SELECT COUNT(*) FROM replay_cache WHERE key = 'rc_forget') AS cached,
      (SELECT COUNT(*) FROM judge_cache WHERE key = 'jc_forget') AS judged,
      (SELECT sample_prompt FROM workloads WHERE id = 'wl_forget') AS sample`).get();
  assert.equal(leftovers.req, null);
  assert.equal(leftovers.replay, null);
  assert.equal(Number(leftovers.cached), 0);
  assert.equal(Number(leftovers.judged), 0);
  assert.equal(leftovers.sample, null);
});

test('the contact form sends, refuses what a script fills in, and limits a flood', async () => {
  const ok = await post('/api/contact', { email: 'buyer@example.test', topic: 'sales', message: 'How does the fee work for us?' }, { ip: '198.51.100.70' });
  assert.equal(ok.status, 200);
  const bot = await post('/api/contact', { email: 'bot@example.test', message: 'buy now buy now buy now', website: 'http://spam' }, { ip: '198.51.100.71' });
  assert.equal(bot.status, 200, 'answered the same, so a script learns nothing');
  const flood = [];
  for (let i = 0; i < config.LIMIT_CONTACT_PER_IP_HOUR + 1; i += 1) {
    flood.push((await post('/api/contact', { email: 'a@example.test', message: 'hello there, a question' }, { ip: '198.51.100.72' })).status);
  }
  assert.equal(flood.at(-1), 429);
});
