import crypto from 'node:crypto';
import { db, id, now } from './db/index.js';
import { issueKey } from './keys.js';
import config from './config.js';

const DAY = 86400000;
const SESSION_DAYS = 30;

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function createAccount({ email, password, name = '' }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new Error('That email address does not look right.');
  if (String(password || '').length < 8) throw new Error('Use at least 8 characters.');
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(clean)) {
    throw new Error('That email already has an account.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: id('usr'), email: clean, name: name.trim(), pw_salt: salt,
    pw_hash: hash(password, salt), created_at: now(),
  };
  const ws = {
    id: id('ws'), owner_user_id: user.id,
    name: name.trim() ? `${name.trim().split(' ')[0]}'s workspace` : 'Understudy',
    mode: 'route', retention_days: config.RETENTION_DAYS, created_at: now(),
  };
  await db.tx(async (tx) => {
    await tx.prepare(`INSERT INTO users (id, email, name, pw_hash, pw_salt, created_at)
                VALUES (@id, @email, @name, @pw_hash, @pw_salt, @created_at)`).run(user);
    await tx.prepare(`INSERT INTO workspaces (id, owner_user_id, name, mode, retention_days, created_at)
                VALUES (@id, @owner_user_id, @name, @mode, @retention_days, @created_at)`).run(ws);
    await tx.prepare(`INSERT INTO billing_accounts (workspace_id, balance_usd, updated_at)
                VALUES (?, 0, ?)`).run(ws.id, now());
  });
  const key = await issueKey(ws.id);
  return { user, workspace: ws, key };
}

export async function checkPassword(email, password) {
  const u = await db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!u) return null;
  const got = Buffer.from(hash(password, u.pw_salt), 'hex');
  const want = Buffer.from(u.pw_hash, 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  return u;
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

/** Reads the session cookie and hangs the user and their workspace off the request. */
export async function session(req, _res, next) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)us_session=([^;]+)/);
  if (m) {
    const row = await db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ?`).get(sha(m[1]), now());
    if (row) {
      req.user = row;
      req.workspace = await db.prepare('SELECT * FROM workspaces WHERE owner_user_id = ?').get(row.id);
    }
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user || !req.workspace) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

const SECURE = config.SECURE_COOKIES ? '; Secure' : '';
export const cookieFor = (value) =>
  `us_session=${value}; Path=/; HttpOnly; SameSite=Lax${SECURE}; Max-Age=${SESSION_DAYS * 86400}`;
export const clearCookie = () => `us_session=; Path=/; HttpOnly; SameSite=Lax${SECURE}; Max-Age=0`;

/* Signing in without a password ---------------------------------------------------

   One row backs both the emailed link and the four-digit code, so spending either spends
   the other. Neither is stored in the clear.

   Two things are deliberate and worth not undoing. Every request answers identically
   whether or not the address has an account, because an endpoint that says "no such user"
   is a way to find out who has one. And the code is compared in constant time, because a
   comparison that returns early leaks, one character at a time, how much of it was right. */

const codeHash = (rowId, code) => sha(`${rowId}:${code}`);

const sameString = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
};

/** Ask for a way in. Returns what to send, or null when there is nothing to send. */
export async function requestLoginCode(email, { ip = null } = {}) {
  const addr = String(email || '').trim().toLowerCase();
  const since = now() - 3600000;
  const recent = (await db.prepare(
    'SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?').get(addr, since))?.n ?? 0;
  if (recent >= config.LOGIN_CODE_MAX_PER_HOUR) return { ok: false, reason: 'too_many' };

  const user = await db.prepare('SELECT id FROM users WHERE email = ?').get(addr);
  if (!user) return { ok: true, send: null };   // answered the same as success, on purpose

  const rowId = id('lgn');
  const digits = config.LOGIN_CODE_DIGITS;
  const code = String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = config.LOGIN_CODE_TTL_MIN * 60000;

  await db.prepare(`INSERT INTO login_codes (id, email, code_hash, link_hash, purpose, attempts,
                      consumed_at, requested_ip, expires_at, created_at)
                    VALUES (?, ?, ?, ?, 'sign_in', 0, NULL, ?, ?, ?)`)
    .run(rowId, addr, codeHash(rowId, code), sha(token), ip, now() + ttl, now());

  return { ok: true, send: { code, token, minutes: config.LOGIN_CODE_TTL_MIN } };
}

/** The newest live row for an address, if there is one. */
const liveCode = (addr) => db.prepare(
  `SELECT * FROM login_codes WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1`).get(addr, now());

async function signInUser(addr) {
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(addr);
  if (!user) return null;
  return { user, token: await startSession(user.id) };
}

/** Type the code in. */
export async function verifyLoginCode(email, code) {
  const addr = String(email || '').trim().toLowerCase();
  const row = await liveCode(addr);
  if (!row) return { ok: false, reason: 'expired' };
  if (row.attempts >= config.LOGIN_CODE_MAX_ATTEMPTS) {
    await db.prepare('UPDATE login_codes SET consumed_at = ? WHERE id = ?').run(now(), row.id);
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (!sameString(row.code_hash, codeHash(row.id, String(code || '').trim()))) {
    await db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = config.LOGIN_CODE_MAX_ATTEMPTS - (row.attempts + 1);
    return { ok: false, reason: 'wrong', triesLeft: Math.max(0, left) };
  }
  await db.prepare('UPDATE login_codes SET consumed_at = ? WHERE id = ?').run(now(), row.id);
  const signed = await signInUser(addr);
  return signed ? { ok: true, ...signed } : { ok: false, reason: 'expired' };
}

/** Or click the link, which spends the same row. */
export async function verifyLoginLink(token) {
  const row = await db.prepare(
    `SELECT * FROM login_codes WHERE link_hash = ? AND consumed_at IS NULL AND expires_at > ?`)
    .get(sha(String(token || '')), now());
  if (!row) return { ok: false, reason: 'expired' };
  await db.prepare('UPDATE login_codes SET consumed_at = ? WHERE id = ?').run(now(), row.id);
  const signed = await signInUser(row.email);
  return signed ? { ok: true, ...signed } : { ok: false, reason: 'expired' };
}
