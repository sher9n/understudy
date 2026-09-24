/* How a way of serving a workload is named on every screen, from its spec, so a router reads the same
 * wherever it appears. A router of the older kind picks between one cheaper model and the customer's own;
 * one by kind of request (version 2) sends each kind of request it learned to one of a few setups, and
 * everything else to the customer's own model. */

const short = (m) => (m ? String(m).split('/').pop() : 'your model');

/** Whether a spec is a router by kind of request. */
export const isKindsRouter = (spec) => spec?.kind === 'router' && Array.isArray(spec.options);

/** One setup a router sends requests to, in a few words. */
export function partName(p, ref) {
  if (!p) return '';
  if (ref && p.model === ref && p.recipe?.reasoning) return `${short(ref)} thinking less`;
  if (ref && p.model === ref && p.recipe?.pinned) return `${short(ref)} from its cheapest provider`;
  return short(p.model);
}

/** A router's name: every setup it sends requests to, the customer's own model last. */
export function routerName(spec, ref) {
  if (isKindsRouter(spec)) {
    const names = [...spec.options.map((o) => partName(o, ref)), short(spec.strong?.model || ref)];
    return names.join(', ').replace(/, ([^,]*)$/, ' or $1');
  }
  return `${short(spec?.cheap?.model)} or ${short(spec?.strong?.model || ref)}`;
}

/**
 * The kinds of request a router by kind learned, and where each goes: every setup with how many kinds it
 * answers and the share of the measured calls those were, and the same for the customer's own model.
 */
export function kindsOf(spec, ref) {
  if (!isKindsRouter(spec)) return null;
  const table = spec.table || [];
  const sizes = spec.sizes || [];
  const total = sizes.reduce((a, b) => a + (Number(b) || 0), 0);
  const shareOf = (pick) => (total > 0 ? table.reduce((a, t, k) => a + (pick(t) ? Number(sizes[k]) || 0 : 0), 0) / total : null);
  return {
    count: table.length,
    parts: spec.options.map((o, j) => ({
      model: o.model, label: partName(o, ref), kinds: table.filter((t) => t === j).length, share: shareOf((t) => t === j),
    })),
    yours: { kinds: table.filter((t) => t < 0).length, share: shareOf((t) => t < 0) },
  };
}

/** "1 kind" or "3 kinds". */
export const kindsWord = (n) => `${n} ${n === 1 ? 'kind' : 'kinds'}`;
