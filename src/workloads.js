/* Deciding which workload a call belongs to.

   This runs on the proxy's hot path, before the call is forwarded, so it has to be cheap
   and it has to be decidable from the REQUEST ALONE: the answer does not exist yet. It also
   has to be deterministic. A call that lands in a different workload today than it did
   yesterday would quietly change what the bar underneath it was measured against, which is
   worse than being a little too coarse.

   Three steps, cheapest first:

     1. Has this exact request shape been decided before? One indexed lookup. Almost every
        call takes this path, because a running application sends the same shapes over and
        over.
     2. Otherwise, among workloads with the same STRUCTURE, is there one whose instruction
        is close enough? Structure is exact and cheap to index; closeness is a SimHash
        distance over the instruction with the data normalised out. This is the only step
        that looks at more than one row, and it looks at few.
     3. Otherwise this is something new.

   No model is called here, ever. Naming happens later, once, off the request path. */

import crypto from 'node:crypto';
import { db, id, now } from './db/index.js';
import config from './config.js';
import { shapeSignals, hamming, nameFor, slug as slugOf, headHashOf } from './classify.js';

const keyOf = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
const shortModel = (m) => String(m || '').split('/').pop();

/** Follow a merge, so a workload folded into another still resolves to the survivor. */
async function resolve(row) {
  let cur = row;
  for (let i = 0; i < 5 && cur?.merged_into; i += 1) {
    cur = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(cur.merged_into);
  }
  return cur;
}

/* The nearest workload of the same structure, if any is close enough.
 *
 * Compared against every variant a workload has already accepted, not just the one it was
 * created from. One sample is a single point, and a job whose prompt carries a rotating
 * example drifts away from whichever one happened to arrive first, which is how a single
 * job ends up as two workloads. */
async function nearest(workspaceId, sig, maxDistance) {
  const rows = await db.prepare(
    `SELECT s.workload_id, s.simhash FROM workload_signatures s
       JOIN workloads w ON w.id = s.workload_id
      WHERE s.workspace_id = ? AND s.struct_key = ? AND w.merged_into IS NULL
        AND s.simhash IS NOT NULL`).all(workspaceId, sig.structKey);
  let bestId = null;
  let bestAt = Infinity;
  for (const r of rows) {
    const d = hamming(r.simhash, sig.simhash);
    if (d < bestAt) { bestAt = d; bestId = r.workload_id; }
  }
  if (bestAt > maxDistance || !bestId) return null;
  const row = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(bestId);
  return row ? { row, distance: bestAt } : null;
}

/** How wide the net is. It widens once a workspace has more workloads than anybody can read. */
async function maxDistanceFor(workspaceId) {
  const live = (await db.prepare(
    `SELECT COUNT(*) AS n FROM workloads WHERE workspace_id = ? AND state = 'live'
       AND merged_into IS NULL`).get(workspaceId))?.n ?? 0;
  if (live < config.WORKLOAD_MAX_LIVE) return config.WORKLOAD_MATCH_MAX_DISTANCE;
  /* Past the cap, a new shape is far more likely to be a variant we failed to recognise
     than a genuinely new job, so prefer joining something to growing the list. */
  return Math.min(32, config.WORKLOAD_MATCH_MAX_DISTANCE + 8);
}

async function uniqueSlug(workspaceId, base) {
  const taken = db.prepare('SELECT 1 FROM workloads WHERE workspace_id = ? AND slug = ?');
  let slug = base;
  for (let n = 2; await taken.get(workspaceId, slug); n += 1) slug = `${base}-${n}`;
  return slug;
}

/** Remember that this exact shape belongs here, so the next one is a single lookup, and so
 *  later variants have one more point to be close to. */
const remember = (workspaceId, sig, workloadId) => db.prepare(
  `INSERT INTO workload_signatures (workspace_id, fingerprint, workload_id, simhash, struct_key, created_at)
   VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, fingerprint) DO NOTHING`)
  .run(workspaceId, sig.cacheKey, workloadId, sig.simhash, sig.structKey, now());

/** Count the call, and promote the workload onto the screens once it has earned a row.
 *
 *  One statement, so calls arriving together each add one: read, added to and written back, twenty
 *  at once counted as a handful, and the workload that should have become live on its twentieth call
 *  could miss its moment. Exactly one call sees it become live, so it is announced once. */
async function count(workload) {
  const r = await db.prepare(
    `UPDATE workloads SET calls_seen = COALESCE(calls_seen, 0) + 1,
            state = CASE WHEN state = 'candidate' AND COALESCE(calls_seen, 0) + 1 >= ?::int THEN 'live' ELSE state END,
            updated_at = ?
      WHERE id = ? RETURNING calls_seen, state`)
    .run(config.WORKLOAD_MIN_CALLS, now(), workload.id);
  const after = r.rows[0] || { calls_seen: (workload.calls_seen ?? 0) + 1, state: workload.state };
  const becameLive = after.state === 'live' && Number(after.calls_seen) === config.WORKLOAD_MIN_CALLS
    && workload.state !== 'live';
  return { ...workload, calls_seen: Number(after.calls_seen), state: after.state, becameLive };
}

/* A workload made for the first time: its row, or the one a call arriving at the same moment made. */
async function create(workspaceId, sig, body, { fingerprint, slugBase, extra = {} }) {
  const slug = await uniqueSlug(workspaceId, slugBase);
  const row = {
    id: id('wl'), workspace_id: workspaceId, slug, fingerprint,
    struct_key: sig.structKey, simhash: sig.simhash,
    shape_kind: sig.shapeKind, reference_model: body?.model || null, routed_model: null,
    optimize_mode: await defaultModeFor(workspaceId), status: 'new', status_note: null, floor_pct: null,
    promoted_at: null, promoted_run_id: null,
    sample_prompt: sig.template.slice(0, 400), tool_names: JSON.stringify(sig.toolNames),
    calls_seen: 0, state: 'candidate', merged_into: null,
    named_at: null, name_source: sig.toolNames.length ? 'tool' : (sig.schemaTitle ? 'schema' : 'words'),
    sibling_of: null, head_key: null, named_by_customer: 0,
    created_at: now(), updated_at: now(), ...extra,
  };
  const made = await db.prepare(`INSERT INTO workloads
      (id, workspace_id, slug, fingerprint, struct_key, simhash, shape_kind, reference_model,
       routed_model, optimize_mode, status, status_note, floor_pct, promoted_at, promoted_run_id,
       sample_prompt, tool_names, calls_seen, state, merged_into, named_at, name_source,
       sibling_of, head_key, named_by_customer, created_at, updated_at)
      VALUES (@id, @workspace_id, @slug, @fingerprint, @struct_key, @simhash, @shape_kind,
       @reference_model, @routed_model, @optimize_mode, @status, @status_note, @floor_pct,
       @promoted_at, @promoted_run_id, @sample_prompt, @tool_names, @calls_seen, @state,
       @merged_into, @named_at, @name_source, @sibling_of, @head_key, @named_by_customer, @created_at, @updated_at)
      ON CONFLICT (workspace_id, fingerprint) DO NOTHING RETURNING id`).run(row);
  if (made.rows.length) return row;
  const winner = await db.prepare('SELECT * FROM workloads WHERE workspace_id = ? AND fingerprint = ?')
    .get(workspaceId, fingerprint);
  return winner ? await resolve(winner) : row;
}

/* How a new workload in this workspace is switched: what the workspace chose for new workloads, and
   "ask first" when it has not chosen, so nothing is switched before somebody has seen it clear. */
async function defaultModeFor(workspaceId) {
  const ws = await db.prepare('SELECT default_optimize_mode FROM workspaces WHERE id = ?').get(workspaceId);
  const m = ws?.default_optimize_mode;
  return m === 'auto' || m === 'ask' || m === 'off' ? m : config.DEFAULT_OPTIMIZE_MODE;
}

/* A workload by the key it was made under, made on first sight. */
async function keyed(workspaceId, sig, body, key, slugBase, extra) {
  const hit = await db.prepare('SELECT * FROM workloads WHERE workspace_id = ? AND fingerprint = ?').get(workspaceId, key);
  if (hit) return await resolve(hit);
  return await create(workspaceId, sig, body, { fingerprint: key, slugBase, extra });
}

/* Several jobs behind one shared instruction. While a workload is young, the instruction each call
   opens its user turn with is counted; at a few points along the way, when two or more openings each
   carry at least a fifth of its calls (and at least ten) and together most of them, every one but the
   commonest becomes a workload of its own from the next call on. A chat, whose user turns open
   differently every time, never splits; nor does a workload somebody named. */
const HEAD_TRACK_CALLS = 300;
const HEAD_CHECKS = new Set([60, 150, 300]);
async function byHead(workspaceId, sig, body, w) {
  if (!sig.userHead || w.named_by_customer || w.head_key) return w;
  const hh = headHashOf(sig.userHead);
  let split = [];
  try { split = w.split_heads ? JSON.parse(w.split_heads) : []; } catch { split = []; }
  if (split.includes(hh)) {
    const words = sig.userHead.split(' ').slice(0, 3).join('-');
    return await keyed(workspaceId, sig, body, keyOf(w.id, 'head', hh), `${w.slug}-${slugOf(words)}`,
      { head_key: hh, sibling_of: null });
  }
  const seen = Number(w.calls_seen || 0) + 1;
  if (seen > HEAD_TRACK_CALLS) return w;
  await db.prepare(`INSERT INTO workload_heads (workload_id, head_hash, head_text, calls, created_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (workload_id, head_hash) DO UPDATE SET calls = workload_heads.calls + 1`)
    .run(w.id, hh, sig.userHead.slice(0, 200), now());
  if (HEAD_CHECKS.has(seen)) await maybeSplit(w);
  return w;
}

async function maybeSplit(w) {
  const heads = await db.prepare('SELECT head_hash, calls FROM workload_heads WHERE workload_id = ? ORDER BY calls DESC')
    .all(w.id);
  const total = heads.reduce((a, h) => a + Number(h.calls), 0);
  const big = heads.filter((h) => Number(h.calls) >= Math.max(10, 0.2 * total));
  const covered = big.reduce((a, h) => a + Number(h.calls), 0);
  if (big.length < 2 || covered < 0.6 * total) return false;
  const others = big.slice(1).map((h) => h.head_hash);
  await db.prepare('UPDATE workloads SET split_heads = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(others), now(), w.id);
  return true;
}

/* One workload per model the customer names. The same prompt sent to two models is two jobs as far as
   a measurement goes: each is held to its own model's answers, and a switch made for one would move the
   other's calls too. The model a prompt was first seen with keeps its workload; each other model gets
   a sibling beside it. */
async function byModel(workspaceId, sig, body, w) {
  const model = body?.model || null;
  if (!model || !w.reference_model || w.reference_model === model) return w;
  const rootId = w.sibling_of || w.id;
  const root = rootId === w.id ? w : (await db.prepare('SELECT * FROM workloads WHERE id = ?').get(rootId)) || w;
  if (root.reference_model === model) return root;
  return await keyed(workspaceId, sig, body, keyOf(rootId, 'model', model), `${root.slug}-${slugOf(shortModel(model))}`,
    { sibling_of: rootId, head_key: root.head_key ?? null, named_at: root.named_at ? now() : null,
      named_by_customer: root.named_by_customer ? 1 : 0, name_source: root.name_source });
}

/**
 * The workload for one request, creating it if this is a shape we have not seen.
 * Returns the workload row, with `becameLive` set on the call that promoted it.
 *
 * `name` is the workload the call says it belongs to (x-understudy-workload), which wins over any
 * matching: a customer who names their jobs knows which calls are the same.
 */
export async function matchWorkload(workspaceId, body, { name = null } = {}) {
  const sig = shapeSignals(body);
  let w = null;
  if (name) {
    w = await keyed(workspaceId, sig, body, keyOf('named', name.toLowerCase(), sig.shapeKind), slugOf(name) || 'workload',
      { named_by_customer: 1, named_at: now(), name_source: 'customer' });
  } else {
    w = await matchShape(workspaceId, sig, body);
    w = await byHead(workspaceId, sig, body, w);
  }
  w = await byModel(workspaceId, sig, body, w);
  return await count(w);
}

/* The three steps, for a call nobody named. */
async function matchShape(workspaceId, sig, body) {
  // 1. decided before
  const known = await db.prepare(
    `SELECT w.* FROM workload_signatures s JOIN workloads w ON w.id = s.workload_id
      WHERE s.workspace_id = ? AND s.fingerprint = ?`).get(workspaceId, sig.cacheKey);
  if (known) {
    const row = await resolve(known);
    if (row) return row;
  }

  // 2. near enough to something we already have
  const near = await nearest(workspaceId, sig, await maxDistanceFor(workspaceId));
  if (near) {
    await remember(workspaceId, sig, near.row.id);
    return near.row;
  }

  // 3. genuinely new
  const slug = await uniqueSlug(workspaceId, nameFor(sig));
  const row = {
    /* The workload's own identity is the structure plus the instruction, not the older
       fingerprint: that one is the same for every call with no system prompt, and the
       table's unique index would refuse the second job to arrive. */
    id: id('wl'), workspace_id: workspaceId, slug, fingerprint: sig.cacheKey,
    struct_key: sig.structKey, simhash: sig.simhash,
    shape_kind: sig.shapeKind, reference_model: body?.model || null, routed_model: null,
    optimize_mode: await defaultModeFor(workspaceId), status: 'new', status_note: null, floor_pct: null,
    promoted_at: null, promoted_run_id: null,
    sample_prompt: sig.template.slice(0, 400), tool_names: JSON.stringify(sig.toolNames),
    calls_seen: 0, state: 'candidate', merged_into: null,
    named_at: null, name_source: sig.toolNames.length ? 'tool' : (sig.schemaTitle ? 'schema' : 'words'),
    created_at: now(), updated_at: now(),
  };
  /* Calls of a brand new shape usually arrive together: an app starting up sends its first burst at
     once. Every one of them finds nothing and tries to make the workload, and only one can. The
     others used to fail on the unique index and answer the customer with a 500; now they find the
     one that was made and join it. */
  const made = await db.prepare(`INSERT INTO workloads
      (id, workspace_id, slug, fingerprint, struct_key, simhash, shape_kind, reference_model,
       routed_model, optimize_mode, status, status_note, floor_pct, promoted_at, promoted_run_id,
       sample_prompt, tool_names, calls_seen, state, merged_into, named_at, name_source,
       created_at, updated_at)
      VALUES (@id, @workspace_id, @slug, @fingerprint, @struct_key, @simhash, @shape_kind,
       @reference_model, @routed_model, @optimize_mode, @status, @status_note, @floor_pct,
       @promoted_at, @promoted_run_id, @sample_prompt, @tool_names, @calls_seen, @state,
       @merged_into, @named_at, @name_source, @created_at, @updated_at)
      ON CONFLICT (workspace_id, fingerprint) DO NOTHING RETURNING id`).run(row);
  if (!made.rows.length) {
    const winner = await db.prepare('SELECT * FROM workloads WHERE workspace_id = ? AND fingerprint = ?')
      .get(workspaceId, sig.cacheKey);
    const target = winner ? await resolve(winner) : null;
    if (target) {
      await remember(workspaceId, sig, target.id);
      return target;
    }
  }
  await remember(workspaceId, sig, row.id);
  return row;
}

export default matchWorkload;
