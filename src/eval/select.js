import { routedCallPrice, callPrice, healthOf } from '../models/facts.js';

/* Which models a measurement tries, and in what order. Pure: everything it needs is handed to
 * it, so the same inputs always give the same answer, and a backtest can run it over any
 * workload without touching a database or spending anything.
 *
 * It works in two steps.
 *
 * First, rule out every model that cannot do this job, each with the reason in words. Before
 * this existed, four of the ten models chosen for the one real measurement on production never
 * answered a single call: one has no provider that keeps nothing, which every call requires,
 * and three think before they answer and ran out of the 180 tokens the customer allows.
 *
 * Then rank what is left by what each model is expected to save: what it would save a month if
 * it matched, times the chance that it matches. The chance is estimated from Jev's reading of
 * how well the model suits the task, the model's rating against the customer's own model on
 * the public Arena leaderboard, and how it did on this customer's calls before. */

const vendorOf = (id) => String(id).split('/')[0];

/* How a model thinks, and whether that fits a workload whose answers are capped.
 *
 * A thinking model writes hidden notes before its answer, and on most providers those notes
 * count against the answer's length limit. With a tight cap it runs out of room before it
 * answers. When its thinking can be switched off it is measured that way, and routed that way
 * if it wins. When it cannot, it is left out. */
export function thinkingFit(model, profile, room) {
  const r = model.reasoning;
  if (!r) return { ok: true, recipe: null };
  const efforts = Array.isArray(r.supported_efforts) ? r.supported_efforts : [];
  /* "Off unless asked" is stated either as default_enabled false or as a default effort of none.
     When neither is stated, a model with a reasoning block does think: on production,
     deepseek-v4-pro and gpt-5.3-codex both say nothing and both thought. */
  const thinksByDefault = r.mandatory === true || r.default_enabled === true
    || (r.default_enabled !== false && r.default_effort !== 'none');
  if (!thinksByDefault) return { ok: true, recipe: null };
  const tight = profile.outCap !== null && profile.outCap !== undefined && profile.outCap < room;
  if (!tight) return { ok: true, recipe: null, thinks: true };
  if (r.mandatory === true) {
    return { ok: false, reason: `thinks before every answer and cannot be told not to, and your answers are capped at ${profile.outCap} tokens` };
  }
  return {
    ok: true,
    thinks: true,
    recipe: { reasoning: efforts.includes('none') ? { effort: 'none' } : { enabled: false } },
    note: 'measured with its thinking switched off, because your answers are capped',
  };
}

/* Everything that rules a model out, in the order it is checked. The first that applies is the
   reason given, so the reason is always the most basic one. */
export function eligibility(model, ctx) {
  const { profile, reference, zdrKnown, zdrOnly, room, expiryMs, at, minUptime } = ctx;
  if (model.id === reference) return { ok: false, step: 'current', reason: 'is the model you use now' };
  if (zdrOnly && zdrKnown && !(model.endpoints || []).length) {
    return { ok: false, step: 'private', reason: 'has no provider that keeps nothing, so every call to it is refused' };
  }
  const params = Array.isArray(model.params) ? model.params : null;
  if (profile.tools && params && !params.includes('tools')) {
    return { ok: false, step: 'features', reason: 'cannot call tools, which your requests use' };
  }
  if (profile.toolChoice && params && !params.includes('tool_choice')) {
    return { ok: false, step: 'features', reason: 'cannot be told which tool to call, which your requests do' };
  }
  if (profile.json === 'schema' && params && !params.includes('structured_outputs') && !params.includes('response_format')) {
    return { ok: false, step: 'features', reason: 'cannot follow a JSON schema, which your requests set' };
  }
  if (profile.json === 'object' && params && !params.includes('response_format') && !params.includes('structured_outputs')) {
    return { ok: false, step: 'features', reason: 'cannot be asked for JSON, which your requests are' };
  }
  if (profile.images && Array.isArray(model.inputs) && !model.inputs.includes('image')) {
    return { ok: false, step: 'features', reason: 'cannot read images, which your requests send' };
  }
  const need = Math.ceil((profile.promptMax || 0) + (profile.outCap || profile.outP95 || 0));
  if (model.contextLen && need > model.contextLen) {
    return { ok: false, step: 'features', reason: `can read ${model.contextLen.toLocaleString('en-US')} tokens, and your longest call needs ${need.toLocaleString('en-US')}` };
  }
  const outNeed = Math.max(profile.outCap || 0, profile.outP95 || 0);
  if (model.maxOutput && outNeed > model.maxOutput) {
    return { ok: false, step: 'features', reason: `writes at most ${model.maxOutput.toLocaleString('en-US')} tokens, and your answers can run to ${outNeed.toLocaleString('en-US')}` };
  }
  const think = thinkingFit(model, profile, room);
  if (!think.ok) return { ok: false, step: 'thinking', reason: think.reason };
  if (model.expiresAt && model.expiresAt - at < expiryMs) {
    return { ok: false, step: 'retiring', reason: 'is being retired soon' };
  }
  if (zdrOnly && zdrKnown) {
    const h = healthOf(model);
    if (h.bestUptime !== null && h.bestUptime < minUptime) {
      return { ok: false, step: 'health', reason: `answered only ${h.bestUptime.toFixed(1)}% of calls over the last day at its best provider` };
    }
    if (!h.healthyProviders) {
      return { ok: false, step: 'health', reason: 'has no provider answering reliably right now' };
    }
  }
  return { ok: true, recipe: think.recipe, note: think.note || null, thinks: !!think.thinks };
}

/* The chance a model gives answers the customer would accept in place of their own model's.
 *
 * Each source of evidence is turned into a probability and they are averaged, weighted by how
 * much each one knows. What the model did on this very workload before counts most, because it
 * is a measurement; Jev's reading of the task counts next; the public leaderboard least, because
 * it rates models on everybody's questions rather than on these. A sibling of the customer's own
 * model gets a small lift, because models from one family tend to answer alike. With no evidence
 * at all the chance is a plain 0.3. */
export function chanceOf(model, ctx) {
  const parts = [];
  const hist = ctx.history?.own?.get(model.id);
  if (hist) {
    // "slower" is about speed, and the same speed setting will most likely drop it again
    const p = { cleared: 0.95, review: 0.6, slower: 0.25, missed: 0.1, failed: 0.05 }[hist.verdict];
    // measured on these very calls, so it outweighs everything else put together
    if (p !== undefined) parts.push({ source: 'before', p, w: 6, note: hist.verdict });
  }
  const shape = ctx.history?.shape?.get(model.id);
  if (shape && shape.n) {
    const rate = (shape.cleared + 1) / (shape.n + 2);
    parts.push({ source: 'elsewhere', p: rate, w: Math.min(2, shape.n / 2), note: `${shape.cleared} of ${shape.n}` });
  }
  const fit = ctx.fits?.get(model.id);
  if (fit !== undefined && fit !== null) {
    parts.push({ source: 'jev', p: 0.05 + 0.9 * fit.fit, w: 2, note: fit.label || null });
  }
  const mine = ctx.arena?.get(model.id);
  const theirs = ctx.arena?.get(ctx.reference);
  if (mine && theirs) {
    // how often people prefer this model to the customer's own, from the two ratings
    let p = 1 / (1 + 10 ** ((theirs - mine) / 400));
    // a routine task forgives a weaker model; a demanding one does not
    const easy = 1 - (ctx.difficulty ?? 0.5);
    p += (1 - p) * easy * 0.5;
    parts.push({ source: 'arena', p, w: 1, note: `${Math.round(mine)} against ${Math.round(theirs)}` });
  }
  let chance = parts.length
    ? parts.reduce((a, x) => a + x.p * x.w, 0) / parts.reduce((a, x) => a + x.w, 0)
    : 0.3;
  const family = vendorOf(model.id) === vendorOf(ctx.reference);
  if (family) chance = Math.min(0.97, chance + 0.08);
  return { chance, parts, family };
}

/**
 * The whole choice. `want` is how many models the workspace wants measured to the end; a
 * measurement may try up to `want * tryMultiple`, because models are dropped as soon as they
 * cannot win and the next in line takes their place.
 */
export function selectCandidates(input) {
  const {
    facts, profile, reference, enabled, want, tryMultiple = 3, reverted = new Set(), serving = null,
    history = null, fits = null, arena = null, difficulty = null, speed = null,
    config, at = Date.now(),
  } = input;
  const zdrOnly = config.ZDR_ONLY;
  const ctx = {
    profile, reference, zdrKnown: facts.zdrKnown, zdrOnly, room: config.EVAL_THINKING_ROOM_TOKENS,
    expiryMs: config.EVAL_EXPIRY_DAYS * 86400000, at, minUptime: config.EVAL_MIN_UPTIME_PCT,
    history, fits, arena, difficulty,
  };
  const refModel = facts.models.get(reference) || null;
  const pin = profile.promptAvg || 0;
  const pout = profile.outAvg || 0;
  /* The price a routed call would really cost: through a provider that keeps nothing, when we
     know which those are. When that list has never been read, the catalogue's price is the best
     there is, and ruling every model out for want of a list would measure nothing. */
  const priceOf = (m) => (zdrOnly && facts.zdrKnown
    ? routedCallPrice(m, pin, pout, profile.hours, { zdrOnly })
    : callPrice(m, pin, pout, profile.hours));
  const refPrice = refModel ? (priceOf(refModel) ?? callPrice(refModel, pin, pout, profile.hours)) : null;
  const refHealth = refModel ? healthOf(refModel) : null;

  const funnel = [];
  const excluded = [];
  const count = (step, label, left) => funnel.push({ step, label, left });

  const all = [...facts.models.values()];
  const pool = all.filter((m) => (enabled === null || enabled.has(m.id)) && m.id !== reference);
  count('enabled', 'switched on in Models', pool.length);

  const kept = [];
  const byStep = new Map();
  for (const m of pool) {
    const e = eligibility(m, ctx);
    if (!e.ok) {
      excluded.push({ model: m.id, step: e.step, reason: e.reason });
      byStep.set(e.step, (byStep.get(e.step) || 0) + 1);
      continue;
    }
    kept.push({ m, recipe: e.recipe, note: e.note, thinks: e.thinks });
  }
  let left = pool.length;
  for (const [step, label] of [
    ['private', 'reachable with nothing kept'],
    ['features', 'able to handle your requests'],
    ['thinking', 'able to answer within your length cap'],
    ['retiring', 'not being retired'],
    ['health', 'answering reliably'],
  ]) {
    left -= byStep.get(step) || 0;
    count(step, label, left);
  }

  // cheaper, at the price we would actually pay
  const priced = [];
  for (const k of kept) {
    const price = priceOf(k.m);
    if (price === null || !(price > 0)) {
      excluded.push({ model: k.m.id, step: 'price', reason: 'has no price we could reach it at' });
      continue;
    }
    if (refPrice !== null && price >= refPrice) {
      excluded.push({ model: k.m.id, step: 'price', reason: `costs ${pctMore(price, refPrice)} what ${short(reference)} does on your calls, so it cannot save you anything` });
      continue;
    }
    priced.push({ ...k, price });
  }
  count('price', 'cheaper than your model on your calls', priced.length);

  // switched back once already on this workload: not tried again
  const fresh = priced.filter((k) => {
    if (!reverted.has(k.m.id)) return true;
    excluded.push({ model: k.m.id, step: 'reverted', reason: 'was switched to before on this workload and switched back' });
    return false;
  });

  // far too slow to start or to write, going by its providers' published speeds
  const quick = fresh.filter((k) => {
    if (!speed || !speed.factor || !refHealth) return true;
    const h = healthOf(k.m);
    const x = config.SPEED_PREFILTER_X;
    if (speed.metric === 'ttft' && h.ttftP50 && refHealth.ttftP50 && h.ttftP50 > x * refHealth.ttftP50) {
      excluded.push({ model: k.m.id, step: 'speed', reason: `usually takes ${sec(h.ttftP50)} to start answering, against ${sec(refHealth.ttftP50)} for ${short(reference)}` });
      return false;
    }
    if ((profile.outP50 || 0) >= 200 && h.tpsP50 && refHealth.tpsP50 && h.tpsP50 * x < refHealth.tpsP50) {
      excluded.push({ model: k.m.id, step: 'speed', reason: `writes about ${Math.round(h.tpsP50)} tokens a second, against ${Math.round(refHealth.tpsP50)} for ${short(reference)}` });
      return false;
    }
    return true;
  });
  count('speed', 'quick enough for your speed setting', quick.length);

  // rank by expected saving
  const ranked = quick.map((k) => {
    const c = chanceOf(k.m, { ...ctx, reference });
    const saving = refPrice === null ? null : refPrice - k.price;
    const perCall = saving;
    return {
      model: k.m.id,
      name: k.m.name,
      price: k.price,
      refPrice,
      savingShare: refPrice ? saving / refPrice : null,
      chance: c.chance,
      expected: perCall === null ? c.chance : perCall * c.chance,
      parts: c.parts,
      family: c.family,
      recipe: k.recipe,
      note: k.note,
      thinks: k.thinks,
      health: healthOf(k.m),
    };
  }).sort((a, b) => b.expected - a.expected || a.price - b.price);

  /* At most two from one maker in the list, so one family's shared weakness cannot take every
     place; the rest of that family waits behind everybody else rather than being dropped. The
     model serving the workload now always goes first, so it is always checked again. */
  const perVendor = new Map();
  const first = [];
  const later = [];
  for (const r of ranked) {
    if (serving && r.model === serving) { first.unshift(r); continue; }
    const v = vendorOf(r.model);
    const n = perVendor.get(v) || 0;
    if (n < 2) { perVendor.set(v, n + 1); first.push(r); } else later.push(r);
  }
  const order = [...first, ...later];
  const limit = Math.max(want, Math.round(want * tryMultiple));
  return {
    funnel,
    excluded,
    ranked: order,
    order: order.slice(0, limit),
    waiting: Math.max(0, order.length - limit),
    refPrice,
    refHealth,
  };
}

const short = (id) => String(id || '').split('/').pop();
const sec = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} seconds`;
const pctMore = (a, b) => {
  const x = a / b;
  if (x < 1.005) return 'as much as';
  return x >= 1.995 ? `${x.toFixed(1)} times` : `${Math.round((x - 1) * 100)}% more than`;
};
