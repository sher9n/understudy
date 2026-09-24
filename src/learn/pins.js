import { db } from '../db/index.js';
import { addActivity } from '../traffic.js';
import { revert, rollBack } from '../eval/promote.js';
import { zdrFor } from '../workspace.js';
import { setStatus } from './arms.js';
import { forgetState } from './memo.js';

/* A strategy pinned to providers that no longer serve it.
 *
 * A model whose weights anyone can run is served, once it clears, only by the providers that answered it
 * in the measurement (servedRecipe in src/eval/run.js), and the customer's own model "from its cheapest
 * provider" only by that provider: the same open model can be run differently by different providers,
 * and a switch serves what was measured. Those providers are read from the list of providers that keep
 * nothing, which is read again every hour. When none of a strategy's pinned providers is on it any more,
 * every call it is given fails, and each one is answered by the customer's own model at full price after
 * the failure, until the live watch has seen enough failures to switch back. Nothing checked the pins:
 * the catalogue watch only asks whether the model is offered at all.
 *
 * So every hour, a strategy that serves or is being tried, whose pinned providers for some model are all
 * gone from the list, is switched back (or rolled back, while it takes over) or set aside, with the reason
 * in the activity feed. It is not moved onto the model's other providers: none of them was measured, and
 * a switch serves what was measured. It can be measured again on the providers there are now.
 *
 * Only where the list says something: a list never read, or one that failed to load, says nothing about
 * any provider, and it names only providers that keep nothing, so a missing provider may still serve a
 * workspace that allows retention. Those are left to the live watch, which sees their calls fail. */

const short = (m) => String(m || '').split('/').pop();

/* Every model a strategy may send a call to, with the providers it is pinned to. */
function pinsOf(spec) {
  if (!spec) return [];
  const parts = spec.kind === 'cascade' ? [spec.first, spec.fallback]
    : spec.kind === 'router' ? [spec.cheap, spec.strong, ...(Array.isArray(spec.options) ? spec.options : [])] : [spec];
  return parts.filter((p) => p?.model && Array.isArray(p?.recipe?.providers) && p.recipe.providers.length)
    .map((p) => ({ model: p.model, providers: p.recipe.providers.map(String) }));
}

export async function watchPins() {
  const listed = Number((await db.prepare('SELECT COUNT(*) AS n FROM model_endpoints').get())?.n || 0);
  if (!listed) return { reverted: 0, rested: 0 };
  const arms = await db.prepare(
    `SELECT a.id, a.workload_id, a.spec_json, a.label, a.status FROM arms a JOIN workloads w ON w.id = a.workload_id
      WHERE a.status IN ('serving', 'trying') AND w.merged_into IS NULL AND a.spec_json LIKE '%"providers"%'`).all();
  let reverted = 0;
  let rested = 0;
  for (const arm of arms) {
    let spec = null;
    try { spec = JSON.parse(arm.spec_json); } catch { continue; }
    const pins = pinsOf(spec);
    if (!pins.length) continue;
    const workload = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(arm.workload_id);
    if (!workload || !(await zdrFor(workload.workspace_id))) continue;
    let gone = null;
    for (const pin of pins) {
      const still = await db.prepare('SELECT 1 FROM model_endpoints WHERE model_id = ? AND tag = ANY(?::text[]) LIMIT 1').get(pin.model, pin.providers);
      if (!still) { gone = pin; break; }
    }
    if (!gone) continue;
    const others = Number((await db.prepare('SELECT COUNT(*) AS n FROM model_endpoints WHERE model_id = ?').get(gone.model))?.n || 0);
    const what = `${arm.label} is served only by the providers ${short(gone.model)} was measured on (${gone.providers.join(', ')}), `
      + `and none of them serves it without keeping what it is sent any more`
      + (others ? `. ${others === 1 ? 'Another provider does' : `${others} other providers do`}, but it was never measured there` : '');
    if (workload.routed_arm_id === arm.id) {
      const reason = `${what}. Switched back ${workload.rollout_share !== null && workload.rollout_share !== undefined ? 'to what served before it' : `to ${workload.reference_model}`}, `
        + 'and it can be measured again on the providers that serve it now.';
      const r = workload.rollout_share !== null && workload.rollout_share !== undefined
        ? await rollBack(workload, reason)
        : await revert(workload, { auto: true, soft: true, reason });
      if (r?.ok) reverted += 1;
      continue;
    }
    if (arm.status !== 'trying') continue;
    await setStatus(arm.id, 'resting');
    forgetState(workload.id);
    await addActivity(workload.workspace_id, {
      kind: 'floor', title: `Stopped trying ${arm.label} on ${workload.slug}`,
      detail: `${what}. It can be measured again on the providers that serve it now.`,
      workloadId: workload.id,
    });
    rested += 1;
  }
  return { reverted, rested };
}
