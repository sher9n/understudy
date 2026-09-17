import crypto from 'node:crypto';
import { db, id, now } from './db/index.js';
import { issueKey } from './keys.js';
import config from './config.js';

const DAY = 86400000;
const SESSION_DAYS = 30;

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createAccount({ email, password, name = '' }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new Error('That email address does not look right.');
  if (String(password || '').length < 8) throw new Error('Use at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(clean)) {
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
  db.transaction(() => {
    db.prepare(`INSERT INTO users (id, email, name, pw_hash, pw_salt, created_at)
                VALUES (@id, @email, @name, @pw_hash, @pw_salt, @created_at)`).run(user);
    db.prepare(`INSERT INTO workspaces (id, owner_user_id, name, mode, retention_days, created_at)
                VALUES (@id, @owner_user_id, @name, @mode, @retention_days, @created_at)`).run(ws);
    db.prepare(`INSERT INTO billing_accounts (workspace_id, balance_usd, updated_at)
                VALUES (?, 0, ?)`).run(ws.id, now());
  })();
  const key = issueKey(ws.id);
  return { user, workspace: ws, key };
}

export function checkPassword(email, password) {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!u) return null;
  const got = Buffer.from(hash(password, u.pw_salt), 'hex');
  const want = Buffer.from(u.pw_hash, 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  return u;
}

export function startSession(userId) {
  const value = crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(sha(value), userId, now(), now() + SESSION_DAYS * DAY);
  return value;
}

export function endSession(value) {
  if (value) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha(value));
}

/** Reads the session cookie and hangs the user and their workspace off the request. */
export function session(req, _res, next) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)us_session=([^;]+)/);
  if (m) {
    const row = db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ?`).get(sha(m[1]), now());
    if (row) {
      req.user = row;
      req.workspace = db.prepare('SELECT * FROM workspaces WHERE owner_user_id = ?').get(row.id);
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
