import crypto from 'node:crypto';
import { db, id, now } from './db/index.js';
import config, { canRevealKeys } from './config.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* A key is stored twice over, for two different jobs.
 *
 * The HASH is what authentication looks up, and it is one way, so the row a request matches
 * never contains anything usable. The CIPHERTEXT is what lets the app show a customer their
 * own key again, which is the one thing they need off the Connect screen.
 *
 * AES-256-GCM, so a tampered ciphertext fails to decrypt rather than returning rubbish, with
 * the key derived from KEY_SECRET in the environment. A copy of the database on its own is
 * not enough to read anybody's key; you would need the environment as well. Without that
 * secret nothing is encrypted and nothing is shown, which is less useful but not less safe. */
const cipherKey = () => crypto.createHash('sha256').update(`understudy:keys:${config.KEY_SECRET}`).digest();

function seal(secret) {
  if (!canRevealKeys()) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cipherKey(), iv);
  const body = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

function open(sealed) {
  if (!sealed || !canRevealKeys()) return null;
  try {
    const [v, iv, tag, body] = String(sealed).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', cipherKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    /* Wrong secret, or the row was tampered with. Either way we do not have the key, and
       saying so is better than showing something that will not authenticate. */
    return null;
  }
}

export async function issueKey(workspaceId, name = 'production') {
  const secret = `us_live_${crypto.randomBytes(16).toString('hex')}`;
  const row = {
    id: id('key'),
    workspace_id: workspaceId,
    name,
    key_hash: sha(secret),
    prefix: secret.slice(0, 12),
    secret_enc: seal(secret),
    created_at: now(),
  };
  await db.prepare(`INSERT INTO api_keys (id, workspace_id, name, key_hash, prefix, secret_enc, created_at)
              VALUES (@id, @workspace_id, @name, @key_hash, @prefix, @secret_enc, @created_at)`).run(row);
  return { ...row, secret };
}

/** This workspace's live key, in full, or null when we genuinely cannot recover it. */
export async function revealKey(workspaceId) {
  const row = await db.prepare(
    `SELECT id, name, prefix, secret_enc FROM api_keys
      WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    .get(workspaceId);
  if (!row) return null;
  return { id: row.id, name: row.name, prefix: row.prefix, secret: open(row.secret_enc) };
}

/** One key of this workspace's, in full when it can be opened; null when there is no such live key. */
export async function revealKeyById(workspaceId, keyId) {
  const row = await db.prepare(
    `SELECT id, name, prefix, secret_enc FROM api_keys WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`)
    .get(keyId, workspaceId);
  if (!row) return null;
  return { id: row.id, name: row.name, prefix: row.prefix, secret: open(row.secret_enc) };
}

/** Resolve a bearer token to its workspace, or null. Stamps last_used_at. */
export async function verifyKey(secret) {
  if (typeof secret !== 'string' || !secret.startsWith('us_live_')) return null;
  const row = await db.prepare(
    `SELECT k.id, k.workspace_id, w.mode
       FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
      WHERE k.key_hash = ? AND k.revoked_at IS NULL`).get(sha(secret));
  if (!row) return null;
  await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return row;
}

export async function listKeys(workspaceId) {
  return await db.prepare(
    `SELECT id, name, prefix, created_at, last_used_at, revoked_at
       FROM api_keys WHERE workspace_id = ? ORDER BY created_at`).all(workspaceId);
}

export async function revokeKey(workspaceId, keyId) {
  return (await db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ?')
    .run(now(), keyId, workspaceId)).changes > 0;
}

/** Pulls the bearer token out of a request, whichever way it was sent. */
export function bearerOf(req) {
  const h = req.get('authorization') || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const k = req.get('x-api-key');
  return k ? k.trim() : null;
}

export { sha };
