import { db, now, round8 } from './db/index.js';
import config, { canRoute } from './config.js';
import { move, withFee } from './billing.js';
import { priceCall } from './openrouter.js';

/* Calls whose cost the provider did not state.

   A routed call is charged what OpenRouter says it cost, which arrives with the answer. Two kinds of
   call used to arrive without it and were charged nothing at all: an answer whose usage carried no
   cost, and a streamed answer that broke off part way, after the customer had already been sent
   some of it. Both were model calls we paid for.

   Now such a call is charged at once from what can be counted, its tokens at the model's list price,
   so it is never free, and marked. OpenRouter keeps its own record of every call under the id each
   answer carries, and a background job reads that record a minute later and corrects the charge to
   it, up or down, with a ledger row saying so. When OpenRouter has no record after a few minutes the
   estimate stands, and the call stays marked so it can be found. */

/** A cost counted from tokens, for a call whose answer did not state one. */
export async function estimateCost(model, promptTokens, completionTokens) {
  const p = model ? await priceCall(model, Math.max(0, promptTokens || 0), Math.max(0, completionTokens || 0)) : null;
  return round8(Math.max(0, p ?? 0));
}

/** What OpenRouter recorded for one generation, in dollars; null while it has no record yet. */
export async function generationCost(genId) {
  if (!genId || !canRoute()) return null;
  const res = await fetch(`${config.OPENROUTER_BASE}/generation?id=${encodeURIComponent(genId)}`, {
    headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`reading generation ${genId} answered ${res.status}`);
  const j = await res.json().catch(() => null);
  const c = Number(j?.data?.total_cost);
  return Number.isFinite(c) && c >= 0 ? c : null;
}

/* The job: read the record and correct the charge. Tried every minute while OpenRouter has no record,
   for about a quarter of an hour. The correction and the call row move in one transaction, keyed on
   the call, so running it twice changes nothing the second time. */
const GIVE_UP_AFTER = 15;

export async function trueUp({ callId }, job = null) {
  const call = await db.prepare(
    'SELECT id, workspace_id, cost_usd, charged_usd, cost_estimated, generation_id FROM calls WHERE id = ?').get(callId);
  if (!call || Number(call.cost_estimated) !== 1) return { note: 'nothing to correct' };
  if (!call.generation_id) {
    await db.prepare('UPDATE calls SET cost_estimated = 2 WHERE id = ? AND cost_estimated = 1').run(callId);
    return { note: 'no generation id; the estimate stands' };
  }
  let actual;
  try {
    actual = await generationCost(call.generation_id);
  } catch (err) {
    if ((job?.attempts ?? 0) >= GIVE_UP_AFTER) return giveUp(callId, err.message);
    return { snoozeMs: 60000, note: String(err.message).slice(0, 200) };
  }
  if (actual === null) {
    if ((job?.attempts ?? 0) >= GIVE_UP_AFTER) return giveUp(callId, 'the provider kept no record');
    return { snoozeMs: 60000, note: 'not recorded yet' };
  }
  const delta = round8(actual - Number(call.cost_usd || 0));
  let moved = 0;
  await db.tx(async (tx) => {
    const still = await tx.prepare('SELECT cost_estimated FROM calls WHERE id = ? FOR UPDATE').get(callId);
    if (Number(still?.cost_estimated) !== 1) return;
    if (delta !== 0) {
      const fee = withFee(Math.abs(delta));
      moved = delta > 0 ? -fee : fee;
      await move(call.workspace_id, {
        kind: 'call', amountUsd: moved,
        note: delta > 0 ? 'Corrected to what the provider charged for a call it did not price at the time'
          : 'Given back: the provider charged less than estimated for a call it did not price at the time',
        ref: `trueup:${callId}`,
      }, tx);
    }
    await tx.prepare('UPDATE calls SET cost_usd = ?, charged_usd = ?, cost_estimated = 0 WHERE id = ?')
      .run(round8(actual), round8(Number(call.charged_usd || 0) - moved), callId);
  });
  return { ok: true, delta, at: now() };
}

async function giveUp(callId, why) {
  await db.prepare('UPDATE calls SET cost_estimated = 2 WHERE id = ? AND cost_estimated = 1').run(callId);
  return { note: `the estimate stands: ${String(why).slice(0, 160)}` };
}
