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

import { db, id, now } from './db/index.js';
import config from './config.js';
import { shapeSignals, hamming, nameFor } from './classify.js';

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

/** Count the call, and promote the workload onto the screens once it has earned a row. */
async function count(workload) {
  const seen = (workload.calls_seen ?? 0) + 1;
  const becomesLive = workload.state === 'candidate' && seen >= config.WORKLOAD_MIN_CALLS;
  await db.prepare(
    `UPDATE workloads SET calls_seen = ?, state = ?, updated_at = ? WHERE id = ?`)
    .run(seen, becomesLive ? 'live' : workload.state, now(), workload.id);
  return { ...workload, calls_seen: seen, state: becomesLive ? 'live' : workload.state, becameLive: becomesLive };
}

/**
 * The workload for one request, creating it if this is a shape we have not seen.
 * Returns the workload row, with `becameLive` set on the call that promoted it.
 */
export async function matchWorkload(workspaceId, body) {
  const sig = shapeSignals(body);

  // 1. decided before
  const known = await db.prepare(
    `SELECT w.* FROM workload_signatures s JOIN workloads w ON w.id = s.workload_id
      WHERE s.workspace_id = ? AND s.fingerprint = ?`).get(workspaceId, sig.cacheKey);
  if (known) {
    const row = await resolve(known);
    if (row) return await count(row);
  }

  // 2. near enough to something we already have
  const near = await nearest(workspaceId, sig, await maxDistanceFor(workspaceId));
  if (near) {
    await remember(workspaceId, sig, near.row.id);
    return await count(near.row);
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
    optimize_mode: 'auto', status: 'new', status_note: null, floor_pct: null,
    promoted_at: null, promoted_run_id: null,
    sample_prompt: sig.template.slice(0, 400), tool_names: JSON.stringify(sig.toolNames),
    calls_seen: 0, state: 'candidate', merged_into: null,
    named_at: null, name_source: sig.toolNames.length ? 'tool' : (sig.schemaTitle ? 'schema' : 'words'),
    created_at: now(), updated_at: now(),
  };
  await db.prepare(`INSERT INTO workloads
      (id, workspace_id, slug, fingerprint, struct_key, simhash, shape_kind, reference_model,
       routed_model, optimize_mode, status, status_note, floor_pct, promoted_at, promoted_run_id,
       sample_prompt, tool_names, calls_seen, state, merged_into, named_at, name_source,
       created_at, updated_at)
      VALUES (@id, @workspace_id, @slug, @fingerprint, @struct_key, @simhash, @shape_kind,
       @reference_model, @routed_model, @optimize_mode, @status, @status_note, @floor_pct,
       @promoted_at, @promoted_run_id, @sample_prompt, @tool_names, @calls_seen, @state,
       @merged_into, @named_at, @name_source, @created_at, @updated_at)`).run(row);
  await remember(workspaceId, sig, row.id);
  return await count(row);
}

export default matchWorkload;
