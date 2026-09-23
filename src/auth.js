import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, id, now } from './db/index.js';
import { issueKey } from './keys.js';
import config from './config.js';

const DAY = 86400000;
const SESSION_DAYS = 30;

/* Password hashing runs off the request thread. It takes about a tenth of a second by design, and
   done synchronously it stopped the whole server for that long: forty wrong passwords sent at once
   pushed every customer's routed calls from twenty milliseconds to more than a second. */
const scrypt = promisify(crypto.scrypt);
const hash = async (pw, salt) => (await scrypt(String(pw), salt, 64)).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const cleanEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

/** A refusal meant for the person: its words are shown as they are. Anything else is our failure. */
export class Refusal extends Error {}

/* Signing up ---------------------------------------------------------------------

   An account is only usable once its email address has answered. Before this, signing up with
   somebody else's address gave a working key straight away, and when the real owner later signed
   in by emailed code they landed inside the stranger's workspace, with the stranger's password
   still working.

   So signing up only sends a code. The password chosen is kept on the CODE, not on the account, and
   takes effect only when that code comes back: whoever holds the email is whoever chooses the
   password. Signing up again for an address that is still waiting simply sends a new code with the
   new password on it. The answer is the same whether or not the address already has an account, so
   the form cannot be used to find out who does; the owner of an existing account is emailed instead.

   The code alone was not enough. Whoever signed up LAST put their password on the code, so somebody
   who signed up with another person's address, or signed up again inside that person's ten minutes,
   chose the password the real owner then confirmed without knowing. So the browser that signs up is
   given a secret of its own (the nonce, kept in a cookie), and the password chosen there is kept only
   when the code comes back from that same browser. A code that comes back from anywhere else still
   signs its holder in, since holding the email is what proves the account, and asks them to choose a
   password. */
export async function startSignUp({ email, password, name = '' }, { ip = null, nonce = null } = {}) {
  const addr = cleanEmail(email);
  if (!validEmail(addr)) throw new Refusal('That email address does not look right.');
  if (String(password || '').length < 8) throw new Refusal('Use at least 8 characters.');
  if (String(password).length > 200) throw new Refusal('Use at most 200 characters.');
  // hashed whichever way this goes, so how long it takes says nothing about who has an account
  const salt = crypto.randomBytes(16).toString('hex');
  const pw = await hash(password, salt);
  const recent = await codesInLastHour(addr);
  if (recent >= config.LOGIN_CODE_MAX_PER_HOUR) return { ok: false, reason: 'too_many' };

  let user = await db.prepare('SELECT * FROM users WHERE email = ?').get(addr);
  if (user && user.email_verified_at) {
    // somebody already has this address: its owner hears about it, nobody else learns anything
    await logCodeRequest(addr);
    return { ok: true, send: { kind: 'exists' }, email: addr };
  }
  if (!user) {
    try {
      user = await createPendingAccount(addr, String(name || '').trim().slice(0, 80));
    } catch (err) {
      // two sign-ups for one address at the same moment: the second finds the first one's account
      if (err?.code !== '23505') throw err;
      user = await db.prepare('SELECT * FROM users WHERE email = ?').get(addr);
      if (!user) throw err;
      if (user.email_verified_at) {
        await logCodeRequest(addr);
        return { ok: true, send: { kind: 'exists' }, email: addr };
      }
    }
  } else if (name && String(name).trim()) {
    await db.prepare('UPDATE users SET name = ? WHERE id = ? AND email_verified_at IS NULL').run(String(name).trim().slice(0, 80), user.id);
  }
  const code = await issueCode(addr, { purpose: 'verify', ip, pwHash: pw, pwSalt: salt, userId: user.id,
    nonceHash: nonce ? sha(nonce) : null });
  return { ok: true, send: { kind: 'verify', ...code }, email: addr };
}

async function createPendingAccount(addr, name) {
  const user = {
    id: id('usr'), email: addr, name,
    // not a usable password: nothing hashes to this, and it is replaced when the email answers
    pw_salt: crypto.randomBytes(16).toString('hex'), pw_hash: crypto.randomBytes(64).toString('hex'),
    created_at: now(),
  };
  const ws = {
    id: id('ws'), owner_user_id: user.id,
    name: name ? `${name.split(' ')[0]}'s workspace` : 'Understudy',
    mode: 'route', retention_days: config.RETENTION_DAYS, created_at: now(),
  };
  await db.tx(async (tx) => {
    await tx.prepare(`INSERT INTO users (id, email, name, pw_hash, pw_salt, created_at)
                VALUES (@id, @email, @name, @pw_hash, @pw_salt, @created_at)`).run(user);
    await tx.prepare(`INSERT INTO workspaces (id, owner_user_id, name, mode, retention_days, created_at)
                VALUES (@id, @owner_user_id, @name, @mode, @retention_days, @created_at)`).run(ws);
    await tx.prepare(`INSERT INTO billing_accounts (workspace_id, balance_usd, auto_topup, updated_at)
                VALUES (?, 0, 0, ?)`).run(ws.id, now());
  });
  return user;
}

/** For tests and scripts that need an account at once: made, verified and given a key in one go. */
export async function createAccount({ email, password, name = '' }) {
  const addr = cleanEmail(email);
  if (!validEmail(addr)) throw new Error('That email address does not look right.');
  if (String(password || '').length < 8) throw new Error('Use at least 8 characters.');
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(addr)) throw new Error('That email already has an account.');
  const user = await createPendingAccount(addr, String(name || '').trim());
  const salt = crypto.randomBytes(16).toString('hex');
  await db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ?, email_verified_at = ? WHERE id = ?')
    .run(salt, await hash(password, salt), now(), user.id);
  const workspace = await db.prepare('SELECT * FROM workspaces WHERE owner_user_id = ?').get(user.id);
  const key = await issueKey(workspace.id);
  return { user: { ...user, email_verified_at: now() }, workspace, key };
}

/** Email and password. Only for accounts whose email has answered. */
export async function checkPassword(email, password) {
  const u = await db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail(email));
  // the same work either way, so how long this takes says nothing about whether the address exists
  const got = Buffer.from(await hash(String(password || ''), u?.pw_salt || 'no-such-account-salt'), 'hex');
  if (!u || !u.email_verified_at) return null;
  const want = Buffer.from(u.pw_hash, 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  return u;
}

/** A new password, given the current one. Every other session ends, so a password somebody else knew stops working everywhere. */
export async function changePassword(user, current, next, { keepSession = null } = {}) {
  if (String(next || '').length < 8) return { ok: false, reason: 'Use at least 8 characters.' };
  if (String(next).length > 200) return { ok: false, reason: 'Use at most 200 characters.' };
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!u) return { ok: false, reason: 'No such account.' };
  // an account whose password was cleared (see verifyLoginCode) can set one without the old one
  if (!u.pw_cleared) {
    const ok = await checkPassword(u.email, current);
    if (!ok) return { ok: false, reason: 'Your current password is not right.' };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  await db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ?, pw_changed_at = ?, pw_cleared = 0 WHERE id = ?')
    .run(salt, await hash(next, salt), now(), u.id);
  await endOtherSessions(u.id, keepSession);
  return { ok: true };
}

export async function startSession(userId) {
  const value = crypto.randomBytes(24).toString('hex');
  await db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(sha(value), userId, now(), now() + SESSION_DAYS * DAY);
  return value;
}

export async function endSession(value) {
  if (value) await db.prepare('DELETE FROM sessions WHERE id = ?').run(sha(value));
}

/** Sign out everywhere else: every session of this person's but the one given. */
export async function endOtherSessions(userId, keepValue = null) {
  return (await db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?')
    .run(userId, keepValue ? sha(keepValue) : '')).changes;
}

/** Reads the session cookie and hangs the user and their workspace off the request. */
export async function session(req, _res, next) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)us_session=([^;]+)/);
  if (m) {
    const row = await db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ? AND u.email_verified_at IS NOT NULL`).get(sha(m[1]), now());
    if (row) {
      req.user = row;
      req.sessionValue = m[1];
      req.workspace = await db.prepare('SELECT * FROM workspaces WHERE owner_user_id = ?').get(row.id);
    }
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user || !req.workspace) return res.status(401).json({ error: 'Sign in to continue.', signIn: true });
  next();
}

const SECURE = config.SECURE_COOKIES ? '; Secure' : '';
export const cookieFor = (value) =>
  `us_session=${value}; Path=/; HttpOnly; SameSite=Lax${SECURE}; Max-Age=${SESSION_DAYS * 86400}`;
export const clearCookie = () => `us_session=; Path=/; HttpOnly; SameSite=Lax${SECURE}; Max-Age=0`;

/* The sign-up browser's own secret (see startSignUp). Only the routes that use a code or link read it,
   so it is scoped to them, and it lasts a little longer than a code does. */
export const signupCookieFor = (nonce) =>
  `us_signup=${nonce}; Path=/api/auth; HttpOnly; SameSite=Lax${SECURE}; Max-Age=${(config.LOGIN_CODE_TTL_MIN + 10) * 60}`;
export const clearSignupCookie = () => `us_signup=; Path=/api/auth; HttpOnly; SameSite=Lax${SECURE}; Max-Age=0`;
export const signupNonceOf = (req) => {
  const m = String(req.headers?.cookie || '').match(/(?:^|;\s*)us_signup=([^;]+)/);
  return m ? m[1] : null;
};

/* Codes and links ------------------------------------------------------------------

   Each emailed code is six digits, lives ten minutes, and allows five tries. The tries are counted
   in the same statement that checks them, so a burst of guesses gets exactly five, not the
   twenty-five a read-then-write allowed. Codes are counted per address for EVERY address asked for,
   with or without an account, so the limit itself cannot tell anybody who has one.

   The emailed link is spent by pressing a button on the page it opens, never by opening it: mail
   scanners open links before people do, and a link spent on opening signed the scanner in and
   left the person with a dead code. The link and the code are two ways into the same row. */

const codeHash = (rowId, code) => sha(`${rowId}:${code}`);

const sameString = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
};

/* Codes asked for an address in the last hour. Sign-in and sign-up codes count in one bucket; codes to
   confirm a NEW address count in their own, so another account asking to move to somebody's address
   cannot use up that person's sign-in codes and lock them out. */
async function codesInLastHour(addr, bucket = 'code_email') {
  return Number((await db.prepare(
    `SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND key = ? AND created_at > ?`)
    .get(bucket, addr, now() - 3600000))?.n ?? 0);
}

async function logCodeRequest(addr, bucket = 'code_email') {
  await db.prepare(`INSERT INTO rate_events (bucket, key, created_at) VALUES (?, ?, ?)`).run(bucket, addr, now());
}

async function issueCode(addr, { purpose, ip = null, pwHash = null, pwSalt = null, userId = null, newEmail = null,
  nonceHash = null, decoy = false, bucket = 'code_email' }) {
  await logCodeRequest(addr, bucket);
  const rowId = id('lgn');
  const digits = config.LOGIN_CODE_DIGITS;
  const code = String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = config.LOGIN_CODE_TTL_MIN * 60000;
  // a newer code for the same address and purpose replaces the older ones
  await db.prepare(`UPDATE login_codes SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL`)
    .run(now(), addr, purpose);
  await db.prepare(`INSERT INTO login_codes (id, email, code_hash, link_hash, purpose, attempts,
                      consumed_at, requested_ip, expires_at, created_at, pw_hash, pw_salt, user_id, new_email,
                      signup_nonce_hash, decoy)
                    VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(rowId, addr, codeHash(rowId, code), sha(token), purpose, ip, now() + ttl, now(), pwHash, pwSalt, userId, newEmail,
      nonceHash, decoy ? 1 : 0);
  return { code, token, minutes: config.LOGIN_CODE_TTL_MIN, purpose };
}

/** Ask for a way in. Returns what to send, or nothing to send when the address has no account. */
export async function requestLoginCode(email, { ip = null } = {}) {
  const addr = cleanEmail(email);
  if (await codesInLastHour(addr) >= config.LOGIN_CODE_MAX_PER_HOUR) return { ok: false, reason: 'too_many' };
  const user = await db.prepare('SELECT id FROM users WHERE email = ?').get(addr);
  /* No account: a code is still made, and never sent, so that trying a code for this address answers
     "not right, so many tries left" exactly as it would for an address with an account. Without it the
     answer was "expired", which told anybody who asked which addresses have accounts. */
  if (!user) {
    await issueCode(addr, { purpose: 'sign_in', ip, decoy: true });
    return { ok: true, send: null };
  }
  return { ok: true, send: await issueCode(addr, { purpose: 'sign_in', ip, userId: user.id }) };
}

/** A code to confirm a new email address, sent to that address. */
export async function requestEmailChange(user, newEmail, { ip = null } = {}) {
  const addr = cleanEmail(newEmail);
  if (!validEmail(addr)) return { ok: false, reason: 'That does not look like an email address.' };
  if (addr === user.email) return { ok: false, reason: 'That is already your email address.' };
  if (await codesInLastHour(addr, 'code_change') >= config.LOGIN_CODE_MAX_PER_HOUR) return { ok: false, reason: 'Too many codes asked for. Wait an hour.' };
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(addr)) {
    /* The same answer as success; the address already in use simply never gets a code. A decoy is kept
       for it, so trying a code answers as it would for a free address. */
    await issueCode(addr, { purpose: 'change_email', ip, userId: user.id, newEmail: addr, decoy: true, bucket: 'code_change' });
    return { ok: true, send: null, email: addr };
  }
  return { ok: true, email: addr, send: await issueCode(addr, { purpose: 'change_email', ip, userId: user.id, newEmail: addr, bucket: 'code_change' }) };
}

/** The newest live row for an address and purpose, if there is one. */
/* The newest live code of each kind for an address. A sign-up code and a sign-in code can both be
   live: somebody asking for a sign-in code while a sign-up waited used to leave only the newest one
   working, so the person who signed up found their own code refused, and the sign-in code they used
   instead cleared the password they had chosen. */
const liveCodes = (addr, purposes) => db.prepare(
  `SELECT DISTINCT ON (purpose) * FROM login_codes WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
      AND purpose = ANY(?) ORDER BY purpose, created_at DESC`).all(addr, now(), purposes);

/* What a code or link that came back means, once it is known to be right: the account is the
   holder's from now on. A sign-up code sets the password chosen with it. A sign-in code for an
   account that never answered its email clears the password somebody else may have chosen and
   ends every other session, because answering the email is what proves whose the account is. */
async function redeem(row, { nonce = null } = {}) {
  /* Spent in the same statement that checks it was still unspent. Marked spent without looking, one
     link pressed twice at once signed in twice and made two live API keys. */
  const spent = await db.prepare(
    'UPDATE login_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL RETURNING id').run(now(), row.id);
  if (!spent.rows.length) return { ok: false, reason: 'expired' };
  // a code nobody was ever sent opens nothing, even guessed
  if (Number(row.decoy)) return { ok: false, reason: 'expired' };
  if (row.purpose === 'change_email') {
    const taken = await db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(row.new_email, row.user_id);
    if (taken) return { ok: false, reason: 'expired' };
    await db.prepare('UPDATE users SET email = ? WHERE id = ?').run(row.new_email, row.user_id);
    return { ok: true, changedEmail: row.new_email };
  }
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(row.email);
  if (!user) return { ok: false, reason: 'expired' };
  let fresh = false;
  let passwordKept = null;
  if (!user.email_verified_at) {
    fresh = true;
    // the password chosen at sign-up, only for a code that came back to the browser that chose it
    const fromSigner = row.purpose === 'verify' && row.pw_hash && row.signup_nonce_hash && nonce
      && sameString(row.signup_nonce_hash, sha(String(nonce)));
    passwordKept = !!fromSigner;
    if (fromSigner) {
      await db.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, email_verified_at = ?, pw_changed_at = ? WHERE id = ?')
        .run(row.pw_hash, row.pw_salt, now(), now(), user.id);
    } else {
      // proved by a sign-in code: whatever password was typed at sign-up was not necessarily theirs
      await db.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, email_verified_at = ?, pw_cleared = 1 WHERE id = ?')
        .run(crypto.randomBytes(64).toString('hex'), crypto.randomBytes(16).toString('hex'), now(), user.id);
    }
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  }
  /* A new account gets its first key when its email answers, never before; and only a workspace that
     never had a key gets one this way, so revoking every key and then signing in by code does not
     quietly bring one back. */
  const ws = await db.prepare('SELECT id FROM workspaces WHERE owner_user_id = ?').get(user.id);
  let key = null;
  if (ws && !await db.prepare('SELECT 1 FROM api_keys WHERE workspace_id = ?').get(ws.id)) {
    key = (await issueKey(ws.id)).secret;
  }
  return { ok: true, user, token: await startSession(user.id), fresh, key, passwordKept };
}

/** Type the code in. Five tries a code, counted in the same step that checks them. */
export async function verifyLoginCode(email, code, { purposes = ['sign_in', 'verify'], nonce = null, userId = null } = {}) {
  const addr = cleanEmail(email);
  let rows = await liveCodes(addr, purposes);
  // a code to confirm a new address is only ever the account's that asked for it
  if (userId) rows = rows.filter((r) => r.user_id === userId);
  if (!rows.length) return { ok: false, reason: 'expired' };
  /* The code typed is compared with each live code, and each counts the try, so no code allows more
     than its five: guessing gains nothing from two codes being live, beyond the second code itself. */
  const typed = String(code || '').trim();
  let left = 0;
  let counted = false;
  for (const row of rows) {
    const tried = await db.prepare(
      `UPDATE login_codes SET attempts = attempts + 1
        WHERE id = ? AND consumed_at IS NULL AND attempts < ? RETURNING attempts`).run(row.id, config.LOGIN_CODE_MAX_ATTEMPTS);
    if (!tried.rows.length) {
      await db.prepare('UPDATE login_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now(), row.id);
      continue;
    }
    counted = true;
    if (sameString(row.code_hash, codeHash(row.id, typed))) return redeem(row, { nonce });
    const mine = config.LOGIN_CODE_MAX_ATTEMPTS - tried.rows[0].attempts;
    if (mine <= 0) await db.prepare('UPDATE login_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now(), row.id);
    left = Math.max(left, mine);
  }
  if (!counted) return { ok: false, reason: 'too_many_attempts' };
  return { ok: false, reason: 'wrong', triesLeft: Math.max(0, left) };
}

/** Confirm a new email address with the code sent to it. */
export async function verifyEmailChange(user, email, code) {
  const out = await verifyLoginCode(email, code, { purposes: ['change_email'], userId: user.id });
  if (!out.ok) return out;
  return out.changedEmail ? { ok: true, email: out.changedEmail } : { ok: false, reason: 'expired' };
}

/** What an emailed link would do, without spending it: who it signs in, for the page to ask. */
export async function peekLoginLink(token) {
  const row = await db.prepare(
    `SELECT email, purpose FROM login_codes WHERE link_hash = ? AND consumed_at IS NULL AND expires_at > ?`)
    .get(sha(String(token || '')), now());
  return row ? { ok: true, email: row.email, purpose: row.purpose } : { ok: false };
}

/** Spend the link, when the person presses the button on the page it opened. */
export async function verifyLoginLink(token, { nonce = null } = {}) {
  const row = await db.prepare(
    `SELECT * FROM login_codes WHERE link_hash = ? AND consumed_at IS NULL AND expires_at > ?`)
    .get(sha(String(token || '')), now());
  if (!row || row.purpose === 'change_email') return { ok: false, reason: 'expired' };
  return redeem(row, { nonce });
}
