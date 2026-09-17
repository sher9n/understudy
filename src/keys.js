import crypto from 'node:crypto';
import { db, id, now } from './db/index.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The key is shown once. We keep only its hash and enough of it to recognise in a list. */
export function issueKey(workspaceId, name = 'production') {
  const secret = `us_live_${crypto.randomBytes(16).toString('hex')}`;
  const row = {
    id: id('key'),
    workspace_id: workspaceId,
    name,
    key_hash: sha(secret),
    prefix: secret.slice(0, 12),
    created_at: now(),
  };
  db.prepare(`INSERT INTO api_keys (id, workspace_id, name, key_hash, prefix, created_at)
              VALUES (@id, @workspace_id, @name, @key_hash, @prefix, @created_at)`).run(row);
  return { ...row, secret };
}

/** Resolve a bearer token to its workspace, or null. Stamps last_used_at. */
export function verifyKey(secret) {
  if (typeof secret !== 'string' || !secret.startsWith('us_live_')) return null;
  const row = db.prepare(
    `SELECT k.id, k.workspace_id, w.mode
       FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
      WHERE k.key_hash = ? AND k.revoked_at IS NULL`).get(sha(secret));
  if (!row) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return row;
}

export function listKeys(workspaceId) {
  return db.prepare(
    `SELECT id, name, prefix, created_at, last_used_at, revoked_at
       FROM api_keys WHERE workspace_id = ? ORDER BY created_at`).all(workspaceId);
}

export function revokeKey(workspaceId, keyId) {
  return db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ?')
    .run(now(), keyId, workspaceId).changes > 0;
}

/** Pulls the bearer token out of a request, whichever way it was sent. */
export function bearerOf(req) {
  const h = req.get('authorization') || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const k = req.get('x-api-key');
  return k ? k.trim() : null;
}

export { sha };
