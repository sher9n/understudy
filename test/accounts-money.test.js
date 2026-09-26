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
/* Models for the review's cases. LONG writes the longest answer it can unless asked for less, at a
   cent per thousand tokens, so an answer with no cap costs 45 cents. NOCOST answers without saying
   what it cost. NOLIMIT publishes no longest answer. STREAMY streams, and can be told to break off or
   to go quiet part way. The provider keeps a record of what each answer cost, like OpenRouter's. */
const LONG = 'test/long-writer';
const NOCOST = 'test/no-cost';
const NOLIMIT = 'test/no-limit';
const NOWINDOW = 'test/no-window';
const STREAMY = 'test/streamy';
const NOUSAGE = 'test/no-usage';
const PRICEY = 'test/pricey';
const SLOW = 'test/slow';
const seen = [];
// every provider of a model, as OpenRouter's list of them says, for the models a test sets; others answer 404
const allEndpoints = new Map();
const records = new Map();
let gen = 0;
const provider = http.createServer((req, res) => {
  const listed = req.method === 'GET' && req.url.match(/\/models\/(.+)\/endpoints/);
  if (listed) {
    const list = allEndpoints.get(decodeURIComponent(listed[1]));
    res.writeHead(list ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list ? { data: { id: listed[1], endpoints: list } } : { error: { message: 'no such model' } }));
    return;
  }
  if (req.method === 'GET' && req.url.includes('/generation')) {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    if (!records.has(id)) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { id, total_cost: records.get(id) } }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const p = JSON.parse(body || '{}');
    seen.push(p);
    const id = `gen-${++gen}`;
    if (p.model === PRICEY) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 404, message: 'No endpoints found that satisfy the max price for this request' } }));
      return;
    }
    if (p.model === STREAMY && p.stream) {
      const how = String(p.messages?.at(-1)?.content || '');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const piece = (t) => res.write(`data: ${JSON.stringify({ id, model: p.model, choices: [{ index: 0, delta: { content: t } }] })}\n\n`);
      let n = 0;
      const every = how.includes('slow') ? 120 : 20;
      const tick = setInterval(() => {
        n += 1;
        if (how.includes('break') && n === 4) { clearInterval(tick); records.set(id, 0.0009); res.destroy(); return; }
        if (how.includes('quiet') && n === 3) { clearInterval(tick); records.set(id, 0.0007); return; }
        if (n <= 8) { piece('word '); return; }
        clearInterval(tick);
        res.write(`data: ${JSON.stringify({ id, model: p.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 16, cost: 0.0003 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      }, every);
      return;
    }
    setTimeout(() => {
      let usage = { prompt_tokens: 120, completion_tokens: 2, cost: COST };
      if (p.model === LONG) {
        const out = Math.min(Number(p.max_tokens) || 45000, 45000);
        usage = { prompt_tokens: 50, completion_tokens: out, cost: out * 1e-5 + 50 * 1e-6 };
      } else if (p.model === NOCOST) {
        usage = { prompt_tokens: 100, completion_tokens: 10 };
        records.set(id, 0.0005);
      } else if (p.model === NOUSAGE) {
        usage = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, model: p.model,
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'billing' } }], usage }));
    }, p.model === SLOW ? 600 : 40);
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
const cookiesOf = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || '']);
const named = (r, name) => { const c = cookiesOf(r).find((x) => x.startsWith(`${name}=`) && !x.startsWith(`${name}=;`)); return c ? c.split(';')[0] : null; };
const sessionOf = (r) => named(r, 'us_session');
const signupOf = (r) => named(r, 'us_signup');

test.before(async () => {
  await new Promise((r) => provider.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => { server = app.listen(APP_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: MODEL, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: LONG, name: 'long writer', context_len: 200000, price_in: 1e-6, price_out: 1e-5, open_weights: 0, zdr: 1, max_output: 45000 },
    { model_id: NOCOST, name: 'no cost', context_len: 200000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1, max_output: 8000 },
    { model_id: NOLIMIT, name: 'no limit', context_len: 200000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1 },
    { model_id: NOWINDOW, name: 'no window', context_len: null, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1 },
    { model_id: STREAMY, name: 'streamy', context_len: 200000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1, max_output: 8000 },
    { model_id: NOUSAGE, name: 'no usage', context_len: 200000, price_in: 1e-5, price_out: 2e-5, open_weights: 0, zdr: 1, max_output: 8000 },
    { model_id: PRICEY, name: 'pricey', context_len: 200000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1, max_output: 8000 },
    { model_id: SLOW, name: 'slow', context_len: 400000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1 },
  ]);
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
  assert.equal(sessionOf(r), null, 'no session before the email answers');
  const mine = signupOf(r);
  assert.ok(mine, 'the browser that signed up holds its own secret');
  const ws = await workspaceOf(email);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE workspace_id = ?').get(ws.id)).n, 0);
  // password sign-in does not work yet
  assert.equal((await post('/api/auth/sign-in', { email, password: 'a-good-password' }, { ip: '198.51.100.11' })).status, 401);

  const code = lastCodeFor(email);
  assert.match(code, /^\d{6}$/, 'a six digit code was emailed');
  const v = await post('/api/auth/code/verify', { email, code }, { ip: '198.51.100.10', cookie: mine });
  assert.equal(v.status, 200);
  const vj = await v.clone().json();
  assert.ok(typeof vj.key === 'string' && vj.key.length > 20, 'the first key is handed over when the email answers');
  assert.equal(vj.passwordKept, true, 'the code came back to the browser that chose the password');
  const cookie = sessionOf(v);
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
  s.paymentIntents.list = async () => ({ data: [] });
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

/* What the money and account review found --------------------------------------------------------- */

const call = (key, body) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body),
});
const { trueUp } = await import('../src/trueup.js');

test('many calls with no cap on their answer cannot spend a small balance many times over', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'uncapped@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 0.5, note: 'test credit' });
  // each call, with no max_tokens, writes 45,000 tokens: 45 cents, nearly the whole balance
  const outs = await Promise.all(Array.from({ length: 20 }, (_, i) => call(key.secret, {
    model: LONG, messages: [{ role: 'user', content: `write at length ${i}` }] }).then((r) => r.status)));
  const acct = await billing.account(workspace.id);
  const one = (45000 * 1e-5 + 50 * 1e-6) * (1 + config.ROUTING_FEE_PCT / 100);
  assert.ok(outs.filter((x) => x === 200).length <= 2, `at most the call that ran alone and one after it: ${outs.join(',')}`);
  assert.ok(acct.balance_usd >= -one - 1e-9, `never more than one call's cost below zero: ${acct.balance_usd}`);
  assert.equal((await billing.available(workspace.id)).inFlight, 0, 'every hold was given back');
  const refused = await call(key.secret, { model: LONG, messages: [{ role: 'user', content: 'and one more' }] });
  if (refused.status === 402) assert.match((await refused.json()).error.message, /Add credit/);
});

test('a request is sent as it came but for a price ceiling: the known providers\' own prices, or the list price with a margin', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'nolimit@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  await saveZdrEndpoints([
    { model_id: NOCOST, tag: 'a', provider: 'A', price_in: 1e-6, price_out: 2e-6, context_len: 200000, max_output: 8000 },
  ]);
  seen.length = 0;
  // every provider that keeps nothing is known, with its prices and its longest answer: the call goes exactly as it came
  assert.equal((await call(key.secret, { model: NOCOST, messages: [{ role: 'user', content: 'hello' }] })).status, 200);
  assert.equal(seen.at(-1).max_tokens, undefined, 'no cap added');
  // the dearest known provider's prices, per million: a prompt held at what caching it costs, a quarter more
  assert.deepEqual(seen.at(-1).provider?.max_price, { prompt: 1.25, completion: 2 }, 'a ceiling at the known prices');
  // providers not known one by one: still no cap, and a ceiling at the list price with its margin
  assert.equal((await call(key.secret, { model: NOLIMIT, messages: [{ role: 'user', content: 'hello' }] })).status, 200);
  assert.equal(seen.at(-1).max_tokens, undefined, 'no cap added');
  assert.deepEqual(seen.at(-1).provider?.max_price, { prompt: 2.5, completion: 4 }, 'a ceiling at twice the list price');
  assert.equal((await call(key.secret, { model: NOWINDOW, messages: [{ role: 'user', content: 'hello' }] })).status, 200);
  assert.equal(seen.at(-1).max_tokens, undefined, 'no cap added, even with no window known');
  // a request that names its own cap is sent with it
  assert.equal((await call(key.secret, { model: NOLIMIT, max_tokens: 77, messages: [{ role: 'user', content: 'hello' }] })).status, 200);
  assert.equal(seen.at(-1).max_tokens, 77);
  await saveZdrEndpoints([]);
});

test('an answer that reports no usage at all is charged for its prompt as well as its answer', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'nousage@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  const prompt = 'word '.repeat(3000);
  const r = await call(key.secret, { model: NOUSAGE, max_tokens: 50, messages: [{ role: 'user', content: prompt }] });
  assert.equal(r.status, 200);
  const charged = -Number((await db.prepare(`SELECT SUM(amount_usd) AS s FROM ledger WHERE workspace_id = ? AND kind = 'call'`).get(workspace.id)).s);
  const promptOnly = billing.promptTokensOf({ messages: [{ role: 'user', content: prompt }] }) * 1e-5;
  assert.ok(charged >= promptOnly, `the prompt is in the estimate: charged ${charged}, prompt alone ${promptOnly}`);
  const row = await db.prepare('SELECT cost_estimated FROM calls WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1').get(workspace.id);
  assert.equal(Number(row.cost_estimated), 1, 'an estimate, to be corrected from the provider\'s record');
});

test('no provider within a call\'s ceiling is a moment\'s wait, and the model\'s prices are read again', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'pricemoved@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  await db.prepare(`INSERT INTO model_endpoints_all_sync (model_id, synced_at, ok) VALUES (?, ?, 1)
      ON CONFLICT (model_id) DO UPDATE SET synced_at = excluded.synced_at`).run(PRICEY, Date.now());
  await enqueue('model_health', {}, { runAfter: Date.now() + 3600000, unique: true });
  const r = await call(key.secret, { model: PRICEY, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 503, 'not a 404, which from a chat endpoint reads as a wrong address');
  const j = await r.json();
  assert.equal(j.error.type, 'not_ready');
  assert.match(j.error.message, /Send it again in a moment/);
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(await db.prepare('SELECT 1 FROM model_endpoints_all_sync WHERE model_id = ?').get(PRICEY), undefined, 'its providers are read again');
  const health = await db.prepare(`SELECT run_after FROM jobs WHERE kind = 'model_health' AND status = 'queued'`).get();
  assert.ok(Number(health.run_after) <= Date.now(), 'and the providers that keep nothing now, not in an hour');
  assert.equal((await billing.available(workspace.id)).inFlight, 0, 'the hold was given back');
  assert.equal((await billing.account(workspace.id)).balance_usd, 5, 'and nothing was charged');
});

test('a customer\'s own max_price that rules out every provider is said as theirs, and nothing is read again', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'theirceiling@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  await db.prepare(`INSERT INTO model_endpoints_all_sync (model_id, synced_at, ok) VALUES (?, ?, 1)
      ON CONFLICT (model_id) DO UPDATE SET synced_at = excluded.synced_at`).run(PRICEY, Date.now());
  const r = await call(key.secret, { model: PRICEY, max_tokens: 5, provider: { max_price: { completion: 0.0001 } },
    messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 400, 'sending it again cannot help, so it is not a 503');
  const j = await r.json();
  assert.equal(j.error.type, 'max_price_too_low');
  assert.match(j.error.message, /max_price your request sets/);
  assert.ok(await db.prepare('SELECT 1 FROM model_endpoints_all_sync WHERE model_id = ?').get(PRICEY), 'the prices are not read again on its account');
});

test('a prompt is counted a token a byte, and what parts carry inline is left out by where it sits, not by how it starts', async () => {
  const long = 'x'.repeat(40000);
  // text that starts "data:" is text, in a message or in a text part
  assert.ok((await billing.callShape({ messages: [{ role: 'user', content: `data:${long}` }] })).pin >= 40000);
  assert.ok((await billing.callShape({ messages: [{ role: 'user', content: [{ type: 'text', text: `data: ${long}` }] }] })).pin >= 40000);
  // characters a rule of thumb undercounts are counted at their bytes at least: two tokens for three digits was short
  const digits = await billing.callShape({ messages: [{ role: 'user', content: '7'.repeat(30000) }] });
  assert.ok(digits.pin >= 30000, `digits: ${digits.pin}`);
  const emoji = await billing.callShape({ messages: [{ role: 'user', content: '\u{1F9EA}'.repeat(1000) }] });
  assert.ok(emoji.pin >= 4000, `emoji, four bytes each: ${emoji.pin}`);
  // the whole request is counted: a response_format schema is billed as prompt
  const schema = await billing.callShape({ messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object', description: 'y'.repeat(50000) } } } });
  assert.ok(schema.pin >= 50000, `a schema: ${schema.pin}`);
  // a predicted output's unused tokens are billed as answer tokens, so they are held as such
  const predicted = await billing.callShape({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }],
    prediction: { type: 'content', content: 'z'.repeat(20000) } });
  assert.equal(predicted.predicted, 20000);
  assert.ok((await billing.callBound(NOCOST, predicted, { zdr: true })).parts.outTokens >= 20010);
  // a picture's data is not text: it is a picture
  const pic = await billing.callShape({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(100000)}` } }] }] });
  assert.ok(pic.pin < 1000, `the picture's bytes are not read as text: ${pic.pin}`);
  assert.equal(pic.images, 1);
  assert.ok(pic.extraIn >= config.HOLD_IMAGE_TOKENS);
  // video sent inline is counted by its bytes
  const video = await billing.callShape({ messages: [{ role: 'user', content: [
    { type: 'video_url', video_url: { url: `data:video/mp4;base64,${'A'.repeat(40000)}` } }] }] });
  assert.ok(video.extraIn >= 30000, `video: ${video.extraIn}`);
  assert.ok(video.pin < 1000);
  // a PDF given as file.url is counted by its pages, as one given as file_data is
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i += 1) doc.addPage([60, 60]);
  const pdf = `data:application/pdf;base64,${Buffer.from(await doc.save()).toString('base64')}`;
  const viaUrl = await billing.callShape({ messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'a.pdf', url: pdf } }] }] });
  assert.ok(viaUrl.extraUsd >= 5 * 0.0025 - 1e-12, `five pages: ${viaUrl.extraUsd}`);
  // and a file carrying inline data beside an address is refused, since the address could be read instead
  const { workspace, key } = await auth.createAccount({ email: 'twofields@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  const both = await call(key.secret, { model: NOCOST, messages: [{ role: 'user', content: [
    { type: 'file', file: { filename: 'a.pdf', file_data: pdf, url: 'https://example.test/a.pdf' } }] }] });
  assert.equal(both.status, 400);
  assert.match((await both.json()).error.message, /address/);
});

test('a request\'s ceiling covers the fallbacks it names, and its hold is read at that ceiling', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'fallceiling@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 20, note: 'test credit' });
  seen.length = 0;
  // SLOW is cheap with a long window; LONG, the fallback it names, is dear
  const body = { model: SLOW, models: [LONG], messages: [{ role: 'user', content: 'hi' }] };
  const going = call(key.secret, body);
  let held = null;
  for (let i = 0; i < 100 && held === null; i += 1) {
    const h = await db.prepare(`SELECT amount_usd FROM balance_holds WHERE workspace_id = ? AND purpose = 'call'`).get(workspace.id);
    if (h) held = Number(h.amount_usd); else await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal((await going).status, 200);
  // LONG's list price, twice over as its providers are not known one by one: $1e-5 out is $20 a million
  assert.ok(seen.at(-1).provider.max_price.completion >= 20, `the fallback's price is let through: ${JSON.stringify(seen.at(-1).provider.max_price)}`);
  // so SLOW's longest answer, at LONG's prices, is what the call can cost, and what it set aside
  const shape = await billing.callShape(body);
  const own = await billing.callBound(SLOW, shape, { zdr: true });
  const fall = await billing.callBound(LONG, shape, { zdr: true });
  const ceiling = billing.mergeCeilings([own.ceiling, fall.ceiling]);
  const want = billing.withFee(Math.max(billing.boundAt(own.parts, ceiling), billing.boundAt(fall.parts, ceiling)));
  assert.ok(held !== null, 'a hold was taken');
  assert.ok(Math.abs(held - want) < want * 1e-3, `held ${held} against ${want}`);
  assert.ok(held > billing.withFee(Math.max(own.usd, fall.usd)) * 1.5, 'far more than either model at its own prices');
  assert.equal((await billing.available(workspace.id)).inFlight, 0, 'and given back');
});

test('an alert about a failure of ours says what failed, not that calls failed', async () => {
  const { composeAlert } = await import('../src/alerts.js');
  const window = (count) => ({ count, openedAt: Date.now() - 12 * 60000, worstStatus: 0,
    samples: [{ at: '12:00', model: 'stripe', status: 0, message: 'gave up after 5 tries' }] });
  const many = composeAlert('automatic top up', window(3));
  assert.match(many.subject, /3 failures \(automatic top up\)/);
  assert.match(many.text, /^An automatic top up failed, 3 times in the last 12 minutes\./);
  assert.doesNotMatch(many.text, /calls failed/);
  const one = composeAlert('model catalogue', window(1));
  assert.match(one.subject, /the model list from OpenRouter looked wrong/, 'OpenRouter keeps its capitals');
  const calls = composeAlert('routed call', window(4));
  assert.match(calls.text, /^4 calls failed in the last 12 minutes\./);
});

test('a daily limit counts calls in flight, so a burst cannot run far past it', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'limited@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 10, note: 'test credit' });
  await db.prepare('UPDATE workspaces SET daily_limit_usd = 0.05 WHERE id = ?').run(workspace.id);
  // each call costs about a cent, and forty arrive at once
  const outs = await Promise.all(Array.from({ length: 40 }, (_, i) => call(key.secret, {
    model: LONG, max_tokens: 1000, messages: [{ role: 'user', content: `burst ${i}` }] }).then((r) => r.status)));
  const spent = await billing.spentOnCalls(workspace.id);
  const oneCall = (1000 * 1e-5 + 50 * 1e-6) * (1 + config.ROUTING_FEE_PCT / 100);
  assert.ok(outs.includes(402), 'the rest were refused');
  const day = Number((await db.prepare(`SELECT -SUM(amount_usd) AS s FROM ledger WHERE workspace_id = ? AND kind = 'call'`).get(workspace.id)).s);
  assert.ok(day <= 0.05 + oneCall + 1e-9, `at most one call past the limit: spent ${day}, reading ${spent.day}`);
});

test('an answer that states no cost is charged from its tokens, then corrected to the provider\'s record', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'nocost@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  const r = await call(key.secret, { model: NOCOST, messages: [{ role: 'user', content: 'price me' }] });
  assert.equal(r.status, 200);
  const callId = r.headers.get('x-understudy-call-id');
  let row = await db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  assert.equal(row.cost_estimated, 1);
  assert.ok(Math.abs(row.cost_usd - (100 * 1e-6 + 10 * 2e-6)) < 1e-12, `charged from its tokens: ${row.cost_usd}`);
  assert.ok(row.charged_usd > 0, 'never free');
  const job = await db.prepare(`SELECT * FROM jobs WHERE kind = 'true_up' AND payload LIKE ?`).get(`%${callId}%`);
  assert.ok(job, 'a correction is booked');
  const before = (await billing.account(workspace.id)).balance_usd;
  await trueUp({ callId });
  row = await db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  assert.equal(row.cost_estimated, 0);
  assert.ok(Math.abs(row.cost_usd - 0.0005) < 1e-12, 'corrected to what the provider recorded');
  const after = (await billing.account(workspace.id)).balance_usd;
  assert.ok(Math.abs((before - after) - (0.0005 - 0.00012) * (1 + config.ROUTING_FEE_PCT / 100)) < 1e-9, 'the difference, with the fee, and only that');
  await trueUp({ callId });
  assert.equal((await billing.account(workspace.id)).balance_usd, after, 'correcting twice changes nothing');
});

test('a stream that breaks off part way is charged for what it wrote, and corrected', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'broken@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  const r = await call(key.secret, { model: STREAMY, stream: true, messages: [{ role: 'user', content: 'break please' }] });
  assert.equal(r.status, 200);
  await r.text().catch(() => '');
  const callId = r.headers.get('x-understudy-call-id');
  let row = null;
  for (let i = 0; i < 50 && !row; i += 1) {
    row = await db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
    if (!row) await new Promise((x) => setTimeout(x, 20));
  }
  assert.ok(row, 'the call is recorded');
  assert.equal(row.status_code, 502);
  assert.ok(row.charged_usd > 0, 'what it wrote is charged');
  assert.equal(row.cost_estimated, 1);
  assert.equal((await billing.available(workspace.id)).inFlight, 0, 'and its hold is gone');
  await trueUp({ callId });
  row = await db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  assert.ok(Math.abs(row.cost_usd - 0.0009) < 1e-12, 'corrected to the provider\'s record');
});

test('a streamed answer may take longer than the time allowed to start, as long as it keeps coming', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'slowstream@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  const was = { start: config.UPSTREAM_TIMEOUT_MS, idle: config.UPSTREAM_IDLE_MS };
  config.UPSTREAM_TIMEOUT_MS = 400;
  config.UPSTREAM_IDLE_MS = 400;
  try {
    // about a second in all, never quiet for long
    const ok = await call(key.secret, { model: STREAMY, stream: true, messages: [{ role: 'user', content: 'slow please' }] });
    const text = await ok.text();
    assert.match(text, /\[DONE\]/, 'the whole answer arrived');
    // a stream that goes quiet is ended, and charged for what it wrote
    const quiet = await call(key.secret, { model: STREAMY, stream: true, messages: [{ role: 'user', content: 'quiet please' }] });
    await quiet.text().catch(() => '');
    const id = quiet.headers.get('x-understudy-call-id');
    let row = null;
    for (let i = 0; i < 100 && !row; i += 1) {
      row = await db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
      if (!row) await new Promise((x) => setTimeout(x, 20));
    }
    assert.equal(row?.status_code, 502);
    assert.ok(row.charged_usd > 0);
  } finally {
    config.UPSTREAM_TIMEOUT_MS = was.start;
    config.UPSTREAM_IDLE_MS = was.idle;
  }
});

test('a sign-up code used from another browser signs in, and asks for a password instead of keeping the one typed', async () => {
  const email = 'elsewhere@example.test';
  const r = await post('/api/auth/sign-up', { email, password: 'typed-at-sign-up', name: 'E' }, { ip: '198.51.100.60' });
  assert.equal(r.status, 200);
  const v = await post('/api/auth/code/verify', { email, code: lastCodeFor(email) }, { ip: '198.51.100.61' });
  assert.equal(v.status, 200);
  const j = await v.json();
  assert.equal(j.fresh, true);
  assert.equal(j.passwordKept, false);
  assert.ok(j.key, 'the first key is still handed over');
  const u = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  assert.equal(u.pw_cleared, 1);
  assert.equal(await auth.checkPassword(email, 'typed-at-sign-up'), null);
});

test('signing up again inside the owner\'s ten minutes cannot choose the owner\'s password', async () => {
  const email = 'owner-two@example.test';
  const own = await post('/api/auth/sign-up', { email, password: 'owner-typed-this' }, { ip: '198.51.100.62' });
  const ownSecret = signupOf(own);
  await post('/api/auth/sign-up', { email, password: 'attacker-typed-this' }, { ip: '198.51.100.63' });
  // the newest code, made by the attacker's sign-up, is the one in the owner's inbox
  const v = await post('/api/auth/code/verify', { email, code: lastCodeFor(email) }, { ip: '198.51.100.62', cookie: ownSecret });
  assert.equal(v.status, 200);
  assert.equal((await v.json()).passwordKept, false, 'this code\'s password was not chosen by this browser');
  assert.equal(await auth.checkPassword(email, 'attacker-typed-this'), null, 'the attacker\'s password never works');
});

test('a link pressed twice at once signs in once and makes one key', async () => {
  const email = 'twice@example.test';
  const out = await auth.startSignUp({ email, password: 'password-123' });
  const both = await Promise.all([auth.verifyLoginLink(out.send.token), auth.verifyLoginLink(out.send.token)]);
  assert.equal(both.filter((o) => o.ok).length, 1);
  const ws = await workspaceOf(email);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE workspace_id = ?').get(ws.id)).n), 1);
});

test('trying a code answers the same way whether or not the address has an account', async () => {
  await auth.createAccount({ email: 'has-account@example.test', password: 'password-123' });
  await post('/api/auth/code/request', { email: 'has-account@example.test' }, { ip: '198.51.100.70' });
  await post('/api/auth/code/request', { email: 'no-account-here@example.test' }, { ip: '198.51.100.71' });
  const a = await post('/api/auth/code/verify', { email: 'has-account@example.test', code: 'nonono' }, { ip: '198.51.100.72' });
  const b = await post('/api/auth/code/verify', { email: 'no-account-here@example.test', code: 'nonono' }, { ip: '198.51.100.73' });
  assert.equal(a.status, b.status);
  assert.deepEqual(await a.json(), await b.json());
});

test('changing the email needs the password, a code only its own account can use, and tells the old address', async () => {
  const { user } = await auth.createAccount({ email: 'mover@example.test', password: 'mover-password' });
  const mine = `us_session=${await auth.startSession(user.id)}`;
  const other = `us_session=${await auth.startSession(user.id)}`;
  const to = 'mover-new@example.test';
  assert.equal((await post('/api/settings/profile', { email: to }, { cookie: mine, ip: '198.51.100.80' })).status, 400, 'no password, no change');
  assert.equal((await post('/api/settings/profile', { email: to, password: 'not-it' }, { cookie: mine, ip: '198.51.100.80' })).status, 400);
  const asked = await post('/api/settings/profile', { email: to, password: 'mover-password' }, { cookie: mine, ip: '198.51.100.80' });
  assert.equal(asked.status, 200);
  const code = lastCodeFor(to);
  const { user: nosy } = await auth.createAccount({ email: 'nosy@example.test', password: 'password-123' });
  assert.equal((await auth.verifyEmailChange(nosy, to, code)).ok, false, 'another account cannot spend it');
  const before = mail.length;
  const v = await post('/api/settings/email/verify', { email: to, code }, { cookie: mine, ip: '198.51.100.80' });
  assert.equal(v.status, 200);
  assert.ok(mail.slice(before).some((m) => m.includes('to: mover@example.test') && /was changed/.test(m)), 'the old address is told');
  assert.equal((await (await fetch(`${base}/api/me`, { headers: { cookie: other } })).json()).signedIn, false, 'other sessions end');
  assert.equal((await (await fetch(`${base}/api/me`, { headers: { cookie: mine } })).json()).signedIn, true, 'this one stays');
  // a wrong code while signed in is a 400, never read as a session that ended
  assert.equal((await post('/api/settings/email/verify', { email: 'x@example.test', code: '000000' }, { cookie: mine, ip: '198.51.100.81' })).status, 400);
});

test('only a card saved for top ups is ever charged automatically', async () => {
  const { workspace, user } = await auth.createAccount({ email: 'carder@example.test', password: 'password-123' });
  const s = await billing.stripe();
  s.paymentMethods.retrieve = async (id) => ({ id, card: { brand: 'visa', last4: '4242' } });
  const paid = (id, pm, auto) => {
    s.paymentIntents.retrieve = async (x) => ({ id: x, payment_method: pm });
    return webhook(event('checkout.session.completed', { id, object: 'checkout.session', mode: 'payment', payment_status: 'paid',
      amount_total: 1000, payment_intent: `pi_${id}`, customer: 'cus_card', metadata: { workspace_id: workspace.id, auto_topup: auto } }));
  };
  await paid('cs_once', 'pm_once', '0');
  let acct = await billing.account(workspace.id);
  assert.equal(acct.balance_usd, 10);
  assert.equal(acct.payment_method, null, 'a one-off payment keeps no card');
  const sess = `us_session=${await auth.startSession(user.id)}`;
  assert.equal((await post('/api/settings/auto-topup', { enabled: true }, { cookie: sess })).status, 400);
  await paid('cs_auto', 'pm_auto', '1');
  acct = await billing.account(workspace.id);
  assert.equal(acct.payment_method, 'pm_auto');
  assert.equal(acct.card_for_topups, 1);
  assert.equal(acct.auto_topup, 1);
  await paid('cs_once_again', 'pm_other', '0');
  assert.equal((await billing.account(workspace.id)).payment_method, 'pm_auto', 'a later one-off payment leaves the top up card alone');
});

test('two partial refunds arriving together take exactly what was refunded', async () => {
  const { workspace } = await auth.createAccount({ email: 'refunds@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 20, note: 'test credit', ref: 'pi_refunds' });
  const refund = (amount) => event('charge.refunded', { id: 'ch_together', object: 'charge', amount_refunded: amount, metadata: { workspace_id: workspace.id } });
  await Promise.all([webhook(refund(500)), webhook(refund(1000))]);
  assert.equal((await billing.account(workspace.id)).balance_usd, 10);
});

test('a dispute the bank decides for us gives its credit back, once', async () => {
  const { workspace } = await auth.createAccount({ email: 'disputed@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 30, note: 'test credit', ref: 'pi_disputed' });
  await webhook(event('charge.dispute.created', { id: 'dp_won', object: 'dispute', amount: 1000, metadata: { workspace_id: workspace.id } }));
  assert.equal((await billing.account(workspace.id)).balance_usd, 20);
  await webhook(event('charge.dispute.closed', { id: 'dp_won', object: 'dispute', amount: 1000, status: 'won', metadata: { workspace_id: workspace.id } }));
  await webhook(event('charge.dispute.funds_reinstated', { id: 'dp_won', object: 'dispute', amount: 1000, metadata: { workspace_id: workspace.id } }));
  assert.equal((await billing.account(workspace.id)).balance_usd, 30);
  // one lost keeps what it took
  await webhook(event('charge.dispute.created', { id: 'dp_lost', object: 'dispute', amount: 500, metadata: { workspace_id: workspace.id } }));
  await webhook(event('charge.dispute.closed', { id: 'dp_lost', object: 'dispute', amount: 500, status: 'lost', metadata: { workspace_id: workspace.id } }));
  assert.equal((await billing.account(workspace.id)).balance_usd, 25);
});

test('a top up that fails for a reason other than the card stays on and is tried again', async () => {
  const { workspace } = await auth.createAccount({ email: 'blip@example.test', password: 'password-123' });
  const s = await billing.stripe();
  s.paymentIntents.list = async () => ({ data: [] });
  await db.prepare(`UPDATE billing_accounts SET stripe_customer = 'cus_b', payment_method = 'pm_b', card_for_topups = 1,
                     balance_usd = 1, auto_topup = 1 WHERE workspace_id = ?`).run(workspace.id);
  s.paymentIntents.create = async () => { const e = new Error('connection reset'); e.type = 'StripeConnectionError'; throw e; };
  await assert.rejects(billing.runTopUp(workspace.id), /connection reset/);
  assert.equal((await billing.account(workspace.id)).auto_topup, 1, 'still on, and the job tries again');
  s.paymentIntents.create = async () => { const e = new Error('Your card was declined.'); e.type = 'StripeCardError'; e.code = 'card_declined'; e.raw = { decline_code: 'insufficient_funds' }; throw e; };
  const before = mail.length;
  const out = await billing.runTopUp(workspace.id);
  assert.equal(out.ok, false);
  const acct = await billing.account(workspace.id);
  assert.equal(acct.auto_topup, 0, 'a declined card switches it off');
  assert.equal(acct.topup_failed_note, 'insufficient_funds');
  assert.ok(mail.slice(before).some((m) => m.includes('to: blip@example.test')), 'and the owner is emailed');
});

test('two top ups booked at the same moment are one job', async () => {
  const { workspace } = await auth.createAccount({ email: 'onejob@example.test', password: 'password-123' });
  const ids = await Promise.all(Array.from({ length: 8 }, () => enqueue('topup', { workspaceId: workspace.id }, { unique: true })));
  assert.equal(new Set(ids).size, 1);
  assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'topup' AND payload LIKE ?`).get(`%${workspace.id}%`)).n), 1);
});

/* The second review of the money fixes ------------------------------------------------------------- */

const { streamCollect, saveZdrEndpoints } = await import('../src/openrouter.js');

test('only models the catalogue knows are routed, fallbacks included, and a variant is priced as its model', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'catalogue@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  const unknown = await call(key.secret, { model: 'nobody/never-heard-of', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.type, 'model_not_found');
  const auto = await call(key.secret, { model: 'openrouter/auto', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(auto.status, 400);
  assert.match((await auto.json()).error.message, /picks a different model for every call/);
  const fallbackUnknown = await call(key.secret, { model: NOCOST, models: ['nobody/else'], messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(fallbackUnknown.status, 400, 'a fallback we cannot price is refused too');
  const variant = await call(key.secret, { model: `${NOCOST}:nitro`, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(variant.status, 200, 'a variant is its model');
});

test('a fallback list, web search, pictures by address and price tiers all count in what a call sets aside', async () => {
  const shape = await billing.callShape({ messages: [{ role: 'user', content: 'x' }] });
  const plain = await billing.callBound(NOCOST, shape, { zdr: true });
  const web = await billing.callBound(NOCOST, await billing.callShape({ plugins: [{ id: 'web' }], messages: [{ role: 'user', content: 'x' }] }), { zdr: true });
  assert.ok(web.usd >= plain.usd + config.HOLD_WEB_SEARCH_USD - 1e-12, 'web search is allowed for');
  const pics = await billing.callBound(NOCOST, await billing.callShape({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] }] }), { zdr: true });
  assert.ok(pics.usd > plain.usd, 'a picture by address is allowed for');
  // a dearer tier for long prompts, and a dearer hour: the bound takes the dearest
  await saveCatalog([
    { model_id: MODEL, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: LONG, name: 'long writer', context_len: 200000, price_in: 1e-6, price_out: 1e-5, open_weights: 0, zdr: 1, max_output: 45000 },
    { model_id: NOCOST, name: 'no cost', context_len: 200000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1, max_output: 8000 },
    { model_id: NOLIMIT, name: 'no limit', context_len: 200000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1 },
    { model_id: NOWINDOW, name: 'no window', context_len: null, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1 },
    { model_id: STREAMY, name: 'streamy', context_len: 200000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1, max_output: 8000 },
    { model_id: 'test/tiered', name: 'tiered', context_len: 200000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1, max_output: 1000,
      overrides_json: JSON.stringify([{ min_prompt_tokens: 100000, prompt: '0.000004', completion: '0.00001' },
        { utc_days: ['monday'], utc_start: '0900', utc_end: '1200', prompt: '0.000003', completion: '0.00003' }]) },
  ]);
  const tiered = await billing.callBound('test/tiered', { pin: 10, cap: null, n: 1 }, { zdr: false });
  // the dearest completion price is the hour's, 3e-5, over the longest answer, 1000, with the margin of 2
  assert.ok(tiered.usd >= 1000 * 3e-5 * 2, `the dearest tier: ${tiered.usd}`);
  // a fallback list reaches the dearer model, so a small balance cannot cover it while another call is in flight
  const { workspace, key } = await auth.createAccount({ email: 'fallbacks@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 0.2, note: 'test credit' });
  const outs = await Promise.all([0, 1].map((i) => call(key.secret, { model: NOCOST, models: [LONG],
    messages: [{ role: 'user', content: `fall back ${i}` }] }).then((r) => r.status)));
  assert.ok(outs.includes(402), `the fallback's cost was set aside: ${outs.join(',')}`);
});

test('a provider that publishes no longest answer means the call is held for the whole window, and never capped', async () => {
  await saveZdrEndpoints([
    { model_id: NOCOST, tag: 'a', provider: 'A', price_in: 1e-6, price_out: 2e-6, context_len: 200000, max_output: 8000 },
    { model_id: NOCOST, tag: 'b', provider: 'B', price_in: 1e-6, price_out: 2e-6, context_len: 200000, max_output: null },
  ]);
  const open = await billing.callBound(NOCOST, { pin: 10, cap: null, n: 1 }, { zdr: true });
  assert.equal(open.each, 200000, 'one provider could write to the end of the window');
  assert.equal(open.known, true);
  const want = { prompt: 1.25e-6, completion: 2e-6, request: 0, image: 0, search: 0 };
  for (const k of Object.keys(want)) assert.ok(Math.abs(open.ceiling[k] - want[k]) < 1e-15, `the known providers' own ${k} price: ${open.ceiling[k]}`);
  // every provider publishes its longest answer: the longest of them is the bound
  await saveZdrEndpoints([
    { model_id: NOCOST, tag: 'a', provider: 'A', price_in: 1e-6, price_out: 2e-6, context_len: 200000, max_output: 8000 },
    { model_id: NOCOST, tag: 'b', provider: 'B', price_in: 1e-6, price_out: 3e-6, context_len: 200000, max_output: 6000 },
  ]);
  const closed = await billing.callBound(NOCOST, { pin: 10, cap: null, n: 1 }, { zdr: true });
  assert.equal(closed.each, 8000);
  assert.ok(Math.abs(closed.usd - (10 * 1e-6 * 1.25 + 8000 * 3e-6)) < 1e-12, `the dearest provider, no margin: ${closed.usd}`);
  await saveZdrEndpoints([]);
});

test('a file given by its address, or a plugin we cannot price, is refused with a way round', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'files@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  const byUrl = await call(key.secret, { model: NOCOST, messages: [{ role: 'user', content: [
    { type: 'file', file: { filename: 'a.pdf', file_data: 'https://example.test/a.pdf' } }] }] });
  assert.equal(byUrl.status, 400);
  assert.match((await byUrl.json()).error.message, /inline/);
  const plugin = await call(key.secret, { model: NOCOST, plugins: [{ id: 'something-new' }], messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(plugin.status, 400);
  const web = await call(key.secret, { model: NOCOST, plugins: [{ id: 'web' }], messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(web.status, 200, 'web search is priced, so it goes through');
});

test('a replay\'s time limit starts when it is sent, not while it waits its turn', async () => {
  const was = { gap: config.MODEL_MIN_GAP_MS, start: config.UPSTREAM_TIMEOUT_MS };
  config.MODEL_MIN_GAP_MS = 300;
  config.UPSTREAM_TIMEOUT_MS = 700;
  try {
    const outs = await Promise.allSettled([0, 1, 2, 3, 4].map((i) => streamCollect(
      { messages: [{ role: 'user', content: `replay ${i}` }] }, STREAMY, { retries: 0, pace: true })));
    assert.deepEqual(outs.map((o) => o.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
      outs.map((o) => o.reason?.message).join(' / '));
  } finally {
    config.MODEL_MIN_GAP_MS = was.gap;
    config.UPSTREAM_TIMEOUT_MS = was.start;
  }
});

test('a bank inquiry takes nothing; a dispute takes its money when it is withdrawn and gives it back when won', async () => {
  const { workspace } = await auth.createAccount({ email: 'inquiry@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 30, note: 'test credit', ref: 'pi_inquiry' });
  await webhook(event('charge.dispute.created', { id: 'dp_inq', object: 'dispute', amount: 1000, status: 'warning_needs_response', metadata: { workspace_id: workspace.id } }));
  assert.equal((await billing.account(workspace.id)).balance_usd, 30, 'an inquiry takes nothing');
  await webhook(event('charge.dispute.closed', { id: 'dp_inq', object: 'dispute', amount: 1000, status: 'warning_closed', metadata: { workspace_id: workspace.id } }));
  assert.equal((await billing.account(workspace.id)).balance_usd, 30, 'and closing it gives nothing extra');
  // an inquiry that became a chargeback: the money comes off when it is withdrawn
  await webhook(event('charge.dispute.created', { id: 'dp_esc', object: 'dispute', amount: 500, status: 'warning_needs_response', metadata: { workspace_id: workspace.id } }));
  await webhook(event('charge.dispute.funds_withdrawn', { id: 'dp_esc', object: 'dispute', amount: 500, status: 'needs_response', metadata: { workspace_id: workspace.id } }));
  assert.equal((await billing.account(workspace.id)).balance_usd, 25);
  await webhook(event('charge.dispute.closed', { id: 'dp_esc', object: 'dispute', amount: 500, status: 'won', metadata: { workspace_id: workspace.id } }));
  assert.equal((await billing.account(workspace.id)).balance_usd, 30);
});

test('a declined top up is told once, and a problem of ours never blames the customer\'s card', async () => {
  const { workspace } = await auth.createAccount({ email: 'toldonce@example.test', password: 'password-123' });
  const s = await billing.stripe();
  s.paymentIntents.list = async () => ({ data: [] });
  const arm = () => db.prepare(`UPDATE billing_accounts SET stripe_customer = 'cus_t', payment_method = 'pm_t', card_for_topups = 1,
                     balance_usd = 1, auto_topup = 1, topup_failed_note = NULL WHERE workspace_id = ?`).run(workspace.id);
  await arm();
  // our own key refused: the customer is told nothing, top up stays on, and the job tries again
  s.paymentIntents.create = async () => { const e = new Error('Invalid API Key provided'); e.type = 'StripeAuthenticationError'; e.statusCode = 401; throw e; };
  let before = mail.filter((m) => m.includes('to: toldonce@example.test')).length;
  await assert.rejects(billing.runTopUp(workspace.id), /Invalid API Key/);
  assert.equal((await billing.account(workspace.id)).auto_topup, 1);
  assert.equal(mail.filter((m) => m.includes('to: toldonce@example.test')).length, before, 'the owner is not told their card failed');
  // a decline, then Stripe's own word about the same payment: one email, one activity row
  s.paymentIntents.create = async () => { const e = new Error('Your card was declined.'); e.type = 'StripeCardError'; e.code = 'card_declined';
    e.raw = { decline_code: 'insufficient_funds', payment_intent: { id: 'pi_declined_once' } }; throw e; };
  before = mail.filter((m) => m.includes('to: toldonce@example.test')).length;
  await billing.runTopUp(workspace.id);
  await webhook(event('payment_intent.payment_failed', { id: 'pi_declined_once', object: 'payment_intent', metadata: { topup: '1', workspace_id: workspace.id },
    last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' } }));
  assert.equal(mail.filter((m) => m.includes('to: toldonce@example.test')).length - before, 1, 'told once');
  const rows = Number((await db.prepare(`SELECT COUNT(*) AS n FROM activity WHERE workspace_id = ? AND title = 'A top up was declined'`).get(workspace.id)).n);
  assert.equal(rows, 1);
});

test('a top up tried again after an error does not charge twice for one low balance', async () => {
  const { workspace } = await auth.createAccount({ email: 'twicecharge@example.test', password: 'password-123' });
  const s = await billing.stripe();
  await db.prepare(`UPDATE billing_accounts SET stripe_customer = 'cus_2', payment_method = 'pm_2', card_for_topups = 1,
                     balance_usd = 1, auto_topup = 1 WHERE workspace_id = ?`).run(workspace.id);
  let made = 0;
  const keys = [];
  s.paymentIntents.create = async (_b, opts) => { made += 1; keys.push(opts.idempotencyKey); return { id: `pi_made_${made}` }; };
  // Stripe says a top up is already under way from the try that timed out
  s.paymentIntents.list = async () => ({ data: [{ id: 'pi_earlier', status: 'processing', metadata: { topup: '1', workspace_id: workspace.id } }] });
  const out = await billing.runTopUp(workspace.id, { attempt: 1 });
  assert.equal(out.already, true);
  assert.equal(made, 0, 'no second charge');
  s.paymentIntents.list = async () => ({ data: [] });
  await billing.runTopUp(workspace.id, { attempt: 2 });
  assert.equal(made, 1);
  assert.match(keys[0], /:2$/, 'a fresh key for the new try');
});

test('a sign-up code still works when a sign-in code was asked for meanwhile, and keeps the password', async () => {
  const email = 'meanwhile@example.test';
  const r = await post('/api/auth/sign-up', { email, password: 'chosen-at-sign-up' }, { ip: '198.51.100.90' });
  const mine = signupOf(r);
  const code = lastCodeFor(email);
  await post('/api/auth/code/request', { email }, { ip: '198.51.100.91' });
  const v = await post('/api/auth/code/verify', { email, code }, { ip: '198.51.100.90', cookie: mine });
  assert.equal(v.status, 200);
  assert.equal((await v.json()).passwordKept, true);
  assert.ok(await auth.checkPassword(email, 'chosen-at-sign-up'));
});

test('revoking every key and signing in by code does not bring a key back', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'nokeys@example.test', password: 'password-123' });
  const keys = await import('../src/keys.js');
  await keys.revokeKey(workspace.id, key.id);
  const asked = await auth.requestLoginCode('nokeys@example.test');
  const out = await auth.verifyLoginCode('nokeys@example.test', asked.send.code);
  assert.equal(out.ok, true);
  assert.equal(out.key, null);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL').get(workspace.id)).n), 0);
});

test('spending limits read running totals that every charge moves', async () => {
  const { workspace } = await auth.createAccount({ email: 'totals@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 10, note: 'test credit' });
  await billing.chargeCall(workspace.id, 0.5, 'a call');
  await billing.chargeCall(workspace.id, 0.25, 'another');
  const spent = await billing.spentOnCalls(workspace.id);
  const fee = 1 + config.ROUTING_FEE_PCT / 100;
  assert.ok(Math.abs(spent.day - 0.75 * fee) < 1e-9, `day ${spent.day}`);
  assert.ok(Math.abs(spent.month - 0.75 * fee) < 1e-9);
  // a correction that gives money back lowers them
  await billing.move(workspace.id, { kind: 'call', amountUsd: 0.1, note: 'given back' });
  assert.ok(Math.abs((await billing.spentOnCalls(workspace.id)).day - (0.75 * fee - 0.1)) < 1e-9);
});

/* The third review of the money fixes ------------------------------------------------------------ */

test('tools the provider runs itself, and videos by address, are refused; free plugins and free variants are said plainly', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'servertools@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  for (const tool of [{ type: 'openrouter:web_search' }, { type: 'web_search' }, { type: 'openrouter:advisor', model: 'openai/gpt-5.5-pro' }]) {
    const r = await call(key.secret, { model: NOCOST, tools: [tool], messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 400, JSON.stringify(tool));
    assert.match((await r.json()).error.message, /runs on the provider's side/);
  }
  const fn = await call(key.secret, { model: NOCOST, tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(fn.status, 200, 'a function the customer runs is ordinary');
  const video = await call(key.secret, { model: NOCOST, messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://example.test/v.mp4' } }] }] });
  assert.equal(video.status, 400);
  for (const plugin of [{ id: 'response-healing' }, { id: 'context-compression', enabled: false }, { id: 'anything', enabled: false }]) {
    const r = await call(key.secret, { model: NOCOST, plugins: [plugin], messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200, JSON.stringify(plugin));
  }
  const free = await call(key.secret, { model: 'liquid/lfm-2.5-2.6b:free', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(free.status, 400);
  assert.match((await free.json()).error.message, /free variant/);
  // even where the paid model is one we route: a free variant is a different offer, never routed or charged for
  const freeOfOurs = await call(key.secret, { model: `${NOCOST}:free`, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(freeOfOurs.status, 400);
  assert.match((await freeOfOurs.json()).error.message, /free variant/);
});

test('a fallback named without its maker is sent under the name it was priced as', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'barefallback@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  seen.length = 0;
  const r = await call(key.secret, { model: NOCOST, models: ['long-writer'], max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(seen.at(-1).models, [LONG]);
});

/* Every request and every copy names the model it is for (the owner's rule, 26 Sep 2026): that model is its workload's
   own, what cheaper ones are tested against. One that names none is refused before it is grouped, and leaves no workload
   behind; it used to be answered by the model of whatever workload its words looked most like. */
test('a call that names no model is refused, whatever workload its words look like, and leaves no workload behind', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'nomodel@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  const system = 'Tag the courier note as late, lost or delivered, one word.';
  // copies of the job, naming the model the customer's own calls went to, make its workload
  for (let i = 0; i < 3; i += 1) {
    const t = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}` },
      body: JSON.stringify({ request: { model: MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: `note ${i}` }] },
        response: { model: MODEL, choices: [{ message: { role: 'assistant', content: 'late' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } } }) });
    assert.equal((await t.json()).accepted, 1, 'a copy that names its model is taken');
  }
  const workloads = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM workloads WHERE workspace_id = ?').get(workspace.id)).n);
  const before = await workloads();
  // the same job with no model named: refused, even though its workload has a model it could have been sent to
  for (const body of [
    { messages: [{ role: 'system', content: system }, { role: 'user', content: 'note 9' }] },
    { model: '', messages: [{ role: 'system', content: system }, { role: 'user', content: 'note 10' }] },
    { model: 7, messages: [{ role: 'system', content: system }, { role: 'user', content: 'note 11' }] },
    // and a job never seen before, which used to leave an empty workload behind when it was refused
    { messages: [{ role: 'system', content: 'Summarise the parcel history in one line.' }, { role: 'user', content: 'parcel 5' }] },
  ]) {
    const r = await call(key.secret, body);
    assert.equal(r.status, 400, `refused: ${JSON.stringify(body.model)}`);
    const err = (await r.json()).error;
    assert.equal(err.type, 'invalid_request_error');
    assert.match(err.message, /Name the model this request is for in "model"/);
  }
  assert.equal(await workloads(), before, 'no workload was made or changed by a call that named no model');
});

test('a copy that names no model is not taken, says why, and leaves no workload behind; the others in the same batch are taken', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'nomodel-copies@example.test', password: 'password-123' });
  const system = 'Sort the return reason into damaged, wrong item or changed mind.';
  const copy = (i, model) => ({ request: { ...(model === undefined ? {} : { model }), messages: [{ role: 'system', content: system }, { role: 'user', content: `return ${i}` }] },
    response: { model: MODEL, choices: [{ message: { role: 'assistant', content: 'damaged' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } } });
  const t = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}` },
    body: JSON.stringify({ traces: [copy(1), copy(2, MODEL), copy(3, '  ')] }) });
  assert.equal(t.status, 200);
  const out = await t.json();
  assert.deepEqual([out.accepted, out.rejected], [1, 2], JSON.stringify(out));
  assert.equal(out.reasons.length, 2);
  assert.match(out.reasons[0], /^copy 1: Name the model this request is for in "request\.model"/);
  assert.match(out.reasons[1], /^copy 3: /);
  const made = await db.prepare('SELECT reference_model FROM workloads WHERE workspace_id = ?').all(workspace.id);
  assert.deepEqual(made.map((w) => w.reference_model), [MODEL], 'one workload, the one the copy that named its model made');
});

test('with zero retention off, a call is bounded by every provider OpenRouter lists, or by the list price with a ceiling when the list cannot be read', async () => {
  await saveCatalog([
    { model_id: MODEL, name: 'gpt-5.4', context_len: 400000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1, max_output: 128000,
      overrides_json: JSON.stringify([{ min_prompt_tokens: 272000, prompt: '0.000005', completion: '0.0000225' }]) },
    { model_id: LONG, name: 'long writer', context_len: 200000, price_in: 1e-6, price_out: 1e-5, open_weights: 0, zdr: 1, max_output: 45000 },
    { model_id: NOCOST, name: 'no cost', context_len: 200000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1, max_output: 8000 },
    { model_id: NOLIMIT, name: 'no limit', context_len: 200000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1 },
    { model_id: NOWINDOW, name: 'no window', context_len: null, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1 },
    { model_id: STREAMY, name: 'streamy', context_len: 200000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1, max_output: 8000 },
    { model_id: 'test/pictures', name: 'pictures', context_len: 100000, price_in: 1e-6, price_out: 2e-6, open_weights: 0, zdr: 1, max_output: 4000,
      pricing_json: JSON.stringify({ prompt: '0.000001', completion: '0.000002', image_output: '0.00012', request: '0.01' }) },
  ]);
  // every provider of the model, one dearer than the list price, each publishing its longest answer
  allEndpoints.set(MODEL, [
    { tag: 'a', provider_name: 'A', context_length: 400000, max_completion_tokens: 128000, pricing: { prompt: '0.0000025', completion: '0.000015' } },
    { tag: 'b', provider_name: 'B', context_length: 400000, max_completion_tokens: 64000, pricing: { prompt: '0.000003', completion: '0.00002' } },
  ]);
  await db.prepare('DELETE FROM model_endpoints_all_sync').run();
  const known = await billing.callBound(MODEL, { pin: 20, cap: null, n: 1 }, { zdr: false });
  assert.equal(known.each, 128000, 'the longest answer any provider writes');
  assert.equal(known.known, true);
  assert.ok(Math.abs(known.ceiling.completion - 2e-5) < 1e-15, 'the ceiling is the dearest provider\'s price, no margin');
  assert.ok(Math.abs(known.usd - (20 * 3e-6 * 1.25 + 128000 * 2e-5)) < 1e-9, `the dearest provider, no margin: ${known.usd}`);
  // the list is kept: a second call does not ask again
  const asked = await db.prepare('SELECT COUNT(*) AS n FROM model_endpoints_all WHERE model_id = ?').get(MODEL);
  assert.equal(Number(asked.n), 2);
  // OpenRouter's list cannot be read: the list price with its margin, a ceiling that makes the margin hold, the whole window
  allEndpoints.delete(MODEL);
  await db.prepare('DELETE FROM model_endpoints_all_sync').run();
  const short = await billing.callBound(MODEL, { pin: 20, cap: null, n: 1 }, { zdr: false });
  assert.equal(short.each, 400000, 'no provider is known to stop sooner than the window');
  assert.equal(short.known, false);
  assert.ok(Math.abs(short.ceiling.completion - 15e-6 * 2) < 1e-12, 'and a price ceiling that makes the margin a bound');
  const long = await billing.callBound(MODEL, { pin: 300000, cap: 100, n: 1 }, { zdr: false });
  assert.ok(Math.abs(long.ceiling.completion - 22.5e-6 * 2) < 1e-12, 'a prompt long enough for the tier is priced at it');
  // pictures written, and a fee per request, are priced as such
  const pic = await billing.callBound('test/pictures', { pin: 10, cap: 4000, n: 1, outputs: ['image'] }, { zdr: false });
  assert.ok(pic.usd >= 4000 * 0.00012 * 2 + 0.01 * 2 - 1e-9, `pictures: ${pic.usd}`);
  // and the request tells OpenRouter the ceiling
  const { buildUpstream } = await import('../src/openrouter.js');
  const up = buildUpstream({ messages: [], provider: { max_price: { prompt: 0.5 } } }, MODEL, null, { zdr: false, priceCaps: { [MODEL]: short.ceiling } });
  assert.equal(up.provider.max_price.prompt, 0.5, 'a lower ceiling the customer set is kept');
  assert.ok(up.provider.max_price.completion >= 30 && up.provider.max_price.completion < 30.001, `per million: ${up.provider.max_price.completion}`);
  // end to end, for a workspace that allows providers keeping data: the request goes exactly as it came
  const { workspace, key } = await auth.createAccount({ email: 'retention@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 20, note: 'test credit' });
  await db.prepare('UPDATE workspaces SET zdr_required = 0 WHERE id = ?').run(workspace.id);
  allEndpoints.set(NOCOST, [
    { tag: 'a', provider_name: 'A', context_length: 200000, max_completion_tokens: 8000, pricing: { prompt: '0.000001', completion: '0.000002' } },
  ]);
  seen.length = 0;
  assert.equal((await call(key.secret, { model: NOCOST, messages: [{ role: 'user', content: 'hello' }] })).status, 200);
  const sent = seen.find((p) => p.model === NOCOST);
  assert.equal(sent.max_tokens, undefined, 'no cap added');
  assert.deepEqual(sent.provider?.max_price, { prompt: 1.25, completion: 2 }, 'a ceiling at the prices OpenRouter listed');
  allEndpoints.clear();
});

test('a PDF sent inline is counted by its pages, however small each page is', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 300; i += 1) doc.addPage([50, 50]);
  const bytes = await doc.save({ useObjectStreams: true });
  const data = `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`;
  const shape = await billing.callShape({ messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'a.pdf', file_data: data } }] }] });
  assert.ok(shape.extraUsd >= 300 * 0.0025 - 1e-9, `three hundred pages allowed for: ${shape.extraUsd} from ${bytes.length} bytes`);
});

test('a second top up job asks Stripe first, even on its first try, so one low balance is charged once', async () => {
  const { workspace } = await auth.createAccount({ email: 'secondjob@example.test', password: 'password-123' });
  const s = await billing.stripe();
  await db.prepare(`UPDATE billing_accounts SET stripe_customer = 'cus_3', payment_method = 'pm_3', card_for_topups = 1,
                     balance_usd = 1, auto_topup = 1 WHERE workspace_id = ?`).run(workspace.id);
  let made = 0;
  s.paymentIntents.create = async () => { made += 1; return { id: `pi_second_${made}` }; };
  s.paymentIntents.list = async () => ({ data: [{ id: 'pi_first_job', status: 'succeeded', metadata: { topup: '1', workspace_id: workspace.id } }] });
  const out = await billing.runTopUp(workspace.id, { attempt: 0 });
  assert.equal(out.already, true);
  assert.equal(made, 0);
});

test('declines Stripe says to retry are retried, and giving up keeps top up on, tells the owner once and books the next try', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'retrydecline@example.test', password: 'password-123' });
  const s = await billing.stripe();
  s.paymentIntents.list = async () => ({ data: [] });
  await db.prepare(`UPDATE billing_accounts SET stripe_customer = 'cus_4', payment_method = 'pm_4', card_for_topups = 1,
                     balance_usd = 1, auto_topup = 1, topup_failed_note = NULL WHERE workspace_id = ?`).run(workspace.id);
  s.paymentIntents.create = async () => { const e = new Error('Try again later'); e.type = 'StripeCardError'; e.code = 'card_declined';
    e.raw = { decline_code: 'try_again_later' }; throw e; };
  await assert.rejects(billing.runTopUp(workspace.id));
  assert.equal((await billing.account(workspace.id)).auto_topup, 1, 'still on: this decline is worth another try');
  // Stripe's own word about the same decline leaves it on too
  await webhook(event('payment_intent.payment_failed', { id: 'pi_retry_later', object: 'payment_intent', metadata: { topup: '1', workspace_id: workspace.id },
    last_payment_error: { code: 'card_declined', decline_code: 'try_again_later' } }));
  assert.equal((await billing.account(workspace.id)).auto_topup, 1, 'the webhook does not switch it off for a decline to retry');
  const before = mail.filter((m) => m.includes('to: retrydecline@example.test')).length;
  assert.equal(await billing.giveUpTopUp(workspace.id, new Error('Stripe down')), true);
  assert.equal(await billing.giveUpTopUp(workspace.id, new Error('Stripe down')), false, 'a second give up says nothing more');
  assert.equal((await billing.account(workspace.id)).auto_topup, 1, 'nothing is wrong with the card, so top up stays on');
  assert.equal(mail.filter((m) => m.includes('to: retrydecline@example.test')).length - before, 1, 'told once');
  const rows = Number((await db.prepare(`SELECT COUNT(*) AS n FROM activity WHERE workspace_id = ? AND title = 'An automatic top up is taking longer'`).get(workspace.id)).n);
  assert.equal(rows, 1, 'one line on the activity feed');
  // the next try is booked with no call charged: by the hourly sweep, and by a call turned away for balance
  const payload = JSON.stringify({ workspaceId: workspace.id });
  const queued = async () => Number((await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'topup' AND payload = ? AND status = 'queued'`).get(payload)).n);
  await db.prepare(`DELETE FROM jobs WHERE kind = 'topup' AND payload = ?`).run(payload);
  assert.ok(await billing.sweepTopUps() >= 1);
  assert.equal(await queued(), 1, 'the sweep booked it');
  await db.prepare(`DELETE FROM jobs WHERE kind = 'topup' AND payload = ?`).run(payload);
  await db.prepare('UPDATE billing_accounts SET balance_usd = 0 WHERE workspace_id = ?').run(workspace.id);
  assert.equal((await call(key.secret, { model: NOCOST, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })).status, 402);
  for (let i = 0; i < 50 && (await queued()) === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await queued(), 1, 'the call turned away booked it');
  // a new low balance, after a credit landed, is told again
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 1, note: 'test credit', ref: 'pi_new_episode' });
  assert.equal(await billing.giveUpTopUp(workspace.id, new Error('Stripe down')), true, 'a new low balance is a new telling');
});

test('the limit totals never move a day backwards, and are read again from the ledger', async () => {
  const { workspace } = await auth.createAccount({ email: 'backwards@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 10, note: 'test credit' });
  await db.prepare('UPDATE workspaces SET daily_limit_usd = 5 WHERE id = ?').run(workspace.id);
  await billing.chargeCall(workspace.id, 0.5, 'today');
  // a later day already on the row (a charge after midnight got there first): an older charge leaves it alone
  const acct = await db.prepare('SELECT call_day_start FROM billing_accounts WHERE workspace_id = ?').get(workspace.id);
  await db.prepare('UPDATE billing_accounts SET call_day_start = ?, call_day_usd = 0.2 WHERE workspace_id = ?').run(Number(acct.call_day_start) + 86400000, workspace.id);
  await billing.chargeCall(workspace.id, 0.25, 'yesterday, late');
  const row = await db.prepare('SELECT call_day_start, call_day_usd FROM billing_accounts WHERE workspace_id = ?').get(workspace.id);
  assert.equal(Number(row.call_day_start), Number(acct.call_day_start) + 86400000, 'the later day stays');
  assert.equal(Number(row.call_day_usd), 0.2, 'and its total is untouched');
  // reading the ledger again sets today's total from what today's charges were
  await db.prepare('UPDATE billing_accounts SET call_day_start = ?, call_day_usd = 0 WHERE workspace_id = ?').run(Number(acct.call_day_start), workspace.id);
  assert.ok(await billing.reconcileLimitTotals() >= 1);
  const fee = 1 + config.ROUTING_FEE_PCT / 100;
  assert.ok(Math.abs((await billing.spentOnCalls(workspace.id)).day - 0.75 * fee) < 1e-9);
  // a row already on a later day (another process's clock, a charge just after midnight) is left as it is
  await db.prepare('UPDATE billing_accounts SET call_day_start = ?, call_day_usd = 0.33 WHERE workspace_id = ?').run(Number(acct.call_day_start) + 86400000, workspace.id);
  await billing.reconcileLimitTotals();
  const later = await db.prepare('SELECT call_day_start, call_day_usd FROM billing_accounts WHERE workspace_id = ?').get(workspace.id);
  assert.equal(Number(later.call_day_start), Number(acct.call_day_start) + 86400000, 'the later day stays');
  assert.equal(Number(later.call_day_usd), 0.33, 'and so does its total');
});

test('switching automatic top up on with the balance already low books a top up at once', async () => {
  const { workspace, user } = await auth.createAccount({ email: 'switchon@example.test', password: 'password-123' });
  await db.prepare(`UPDATE billing_accounts SET stripe_customer = 'cus_on', payment_method = 'pm_on', card_for_topups = 1,
                     balance_usd = 0.5, auto_topup = 0 WHERE workspace_id = ?`).run(workspace.id);
  const sess = `us_session=${await auth.startSession(user.id)}`;
  const r = await post('/api/settings/auto-topup', { enabled: true }, { cookie: sess });
  assert.equal(r.status, 200);
  const booked = Number((await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'topup' AND payload = ? AND status = 'queued'`)
    .get(JSON.stringify({ workspaceId: workspace.id }))).n);
  assert.equal(booked, 1, 'booked now, not after a call is charged');
});

test('the check before a top up ignores payments already credited, and reads every page Stripe has', async () => {
  const { workspace } = await auth.createAccount({ email: 'precheck@example.test', password: 'password-123' });
  const s = await billing.stripe();
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 10, note: 'test credit', ref: 'pi_landed' });
  await db.prepare(`UPDATE billing_accounts SET stripe_customer = 'cus_5', payment_method = 'pm_5', card_for_topups = 1,
                     balance_usd = 1, auto_topup = 1 WHERE workspace_id = ?`).run(workspace.id);
  let made = 0;
  const keys = [];
  s.paymentIntents.create = async (_b, opts) => { made += 1; keys.push(opts.idempotencyKey); return { id: `pi_pc_${made}` }; };
  // a top up that already landed, in the same second as this one's window opened: it does not stand in for this one
  s.paymentIntents.list = async () => ({ data: [{ id: 'pi_landed', status: 'succeeded', metadata: { topup: '1', workspace_id: workspace.id } }], has_more: false });
  const out = await billing.runTopUp(workspace.id, { attempt: 0, jobId: 'job_a' });
  assert.notEqual(out.already, true);
  assert.equal(made, 1, 'charged');
  // one still under way, on the second page of what Stripe has, is found
  const pages = [];
  s.paymentIntents.list = async (q) => {
    pages.push(q.starting_after ?? null);
    return q.starting_after
      ? { data: [{ id: 'pi_going', status: 'processing', metadata: { topup: '1', workspace_id: workspace.id } }], has_more: false }
      : { data: Array.from({ length: 100 }, (_, i) => ({ id: `pi_other_${i}`, status: 'succeeded', metadata: {} })), has_more: true };
  };
  const again = await billing.runTopUp(workspace.id, { attempt: 0, jobId: 'job_b' });
  assert.equal(again.already, true);
  assert.equal(made, 1, 'no second charge');
  assert.deepEqual(pages, [null, 'pi_other_99']);
  // a later job for the same low balance sends Stripe a label of its own, so it never gets an earlier job's answer back
  s.paymentIntents.list = async () => ({ data: [], has_more: false });
  await billing.runTopUp(workspace.id, { attempt: 0, jobId: 'job_c' });
  assert.equal(made, 2);
  assert.notEqual(keys[0], keys[1], `one label per job: ${keys.join(' / ')}`);
});

test('a refund switches automatic top up off, so the card is not charged straight back', async () => {
  const { workspace } = await auth.createAccount({ email: 'refundoff@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 20, note: 'test credit', ref: 'pi_refundoff' });
  await db.prepare(`UPDATE billing_accounts SET stripe_customer = 'cus_r', payment_method = 'pm_r', card_for_topups = 1, auto_topup = 1
                     WHERE workspace_id = ?`).run(workspace.id);
  await webhook(event('charge.refunded', { id: 'ch_refundoff', object: 'charge', amount_refunded: 1700, metadata: { workspace_id: workspace.id } }));
  const acct = await billing.account(workspace.id);
  assert.equal(acct.balance_usd, 3);
  assert.equal(acct.auto_topup, 0, 'off');
  const payload = JSON.stringify({ workspaceId: workspace.id });
  await billing.sweepTopUps();
  assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'topup' AND payload = ?`).get(payload)).n), 0, 'and nothing books a charge');
  const said = await db.prepare(`SELECT detail FROM activity WHERE workspace_id = ? AND title LIKE '%came off your balance' ORDER BY created_at DESC LIMIT 1`).get(workspace.id);
  assert.match(said.detail, /Automatic top up is off/);
});

test('a PDF that cannot be counted in time is refused, and files are counted a few at a time', async () => {
  const { workspace, key } = await auth.createAccount({ email: 'slowpdf@example.test', password: 'password-123' });
  await billing.move(workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
  const { pdfCounting } = await import('../src/pdf-pages.js');
  // a page tree that points twice at the same node at every level: a trillion ways down to one page
  const dag = (depth, salt) => {
    const objs = ['1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'];
    for (let i = 0; i < depth; i += 1) objs.push(`${2 + i} 0 obj\n<< /Type /Pages /Kids [${3 + i} 0 R ${3 + i} 0 R] /Count 2 >>\nendobj\n`);
    objs.push(`${2 + depth} 0 obj\n<< /Type /Page /Parent ${1 + depth} 0 R /MediaBox [0 0 10 10] >>\nendobj\n`);
    const text = `%PDF-1.4\n%${salt}\n${objs.join('')}trailer\n<< /Root 1 0 R /Size ${3 + depth} >>\n%%EOF\n`;
    return `data:application/pdf;base64,${Buffer.from(text).toString('base64')}`;
  };
  const asFile = (data) => ({ model: NOCOST, max_tokens: 5, messages: [{ role: 'user', content: [
    { type: 'text', text: 'read this' }, { type: 'file', file: { filename: 'a.pdf', file_data: data } }] }] });
  const was = config.PDF_COUNT_MS;
  config.PDF_COUNT_MS = 400;
  try {
    const slow = await call(key.secret, asFile(dag(40, 'one')));
    assert.equal(slow.status, 400);
    assert.match((await slow.json()).error.message, /could not be counted \(took too long to count\)/);
    // this workspace sends two at once and another workspace one: each workspace has one counted at a time,
    // so the other's is counted straight away and this one's second waits behind its own first
    const other = await auth.createAccount({ email: 'slowpdf-other@example.test', password: 'password-123' });
    await billing.move(other.workspace.id, { kind: 'credit', amountUsd: 5, note: 'test credit' });
    const three = Promise.all([
      call(key.secret, asFile(dag(40, 'a'))), call(key.secret, asFile(dag(40, 'b'))), call(other.key.secret, asFile(dag(40, 'c'))),
    ].map((p) => p.then((r) => r.status)));
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(pdfCounting(), { active: 2, waiting: 0, held: 1 }, 'two counters busy, one file waiting behind its own workspace');
    assert.deepEqual(await three, [400, 400, 400]);
    assert.deepEqual(pdfCounting(), { active: 0, waiting: 0, held: 0 }, 'every counter given back');
    // three files that could not be counted in ten minutes: the next is refused at once, unread
    const started = Date.now();
    const rested = await call(key.secret, asFile(dag(40, 'd')));
    assert.equal(rested.status, 503);
    assert.match((await rested.json()).error.message, /could not be counted in the last ten minutes/);
    assert.ok(Date.now() - started < 300, 'without being parsed');
    // the other workspace is not held to it, and an ordinary PDF still goes through
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const fine = await call(other.key.secret, asFile(`data:application/pdf;base64,${Buffer.from(await doc.save()).toString('base64')}`));
    assert.equal(fine.status, 200);
  } finally {
    config.PDF_COUNT_MS = was;
  }
});

test('a model\'s own searches are held only when the call asks for search, or the model always searches', async () => {
  await db.prepare(`INSERT INTO models_catalog (model_id, name, context_len, price_in, price_out, open_weights, zdr, synced_at, pricing_json, max_output)
      VALUES (?, 'searchy', 200000, 0.000003, 0.000015, 0, 1, ?, ?, 8000), (?, 'sonar', 200000, 0.000001, 0.000001, 0, 1, ?, ?, 8000)`)
    .run('test/searchy', Date.now(), JSON.stringify({ prompt: '0.000003', completion: '0.000015', web_search: '0.01' }),
      'perplexity/sonar-test', Date.now(), JSON.stringify({ prompt: '0.000001', completion: '0.000001', web_search: '0.005' }));
  try {
    const plain = await billing.callShape({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    const quiet = await billing.callBound('test/searchy', plain, { zdr: true });
    assert.equal(quiet.parts.searches, 0, 'not asked, so no searches held');
    assert.ok(quiet.usd < 0.01, `a short call holds a cent at most: ${quiet.usd}`);
    const asked = await billing.callShape({ max_tokens: 10, web_search_options: {}, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal((await billing.callBound('test/searchy', asked, { zdr: true })).parts.searches, config.HOLD_SEARCHES_PER_CALL);
    const always = await billing.callBound('perplexity/sonar-test', plain, { zdr: true });
    assert.equal(always.parts.searches, config.HOLD_SEARCHES_PER_CALL, 'a model that always searches is held for it');
  } finally {
    await db.prepare('DELETE FROM models_catalog WHERE model_id = ANY(?::text[])').run(['test/searchy', 'perplexity/sonar-test']);
  }
});
