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
 * it worked out, times the chance that it does. Working out means two things, and both have to
 * happen: its answers match, and it is quick enough for the workload's speed setting. The first
 * is estimated from how it did on this customer's calls before, Jev's reading of how well it
 * suits the task, and its rating against the customer's own model on the public Arena
 * leaderboard; the second from how fast it has been against the customer's kind of model in
 * recent measurements, and from its providers' published speeds. */

const vendorOf = (id) => String(id).split('/')[0];

/* Whether a model thinks before it answers when nobody says otherwise. "Off unless asked" is
   stated either as default_enabled false or as a default effort of none. When neither is
   stated, a model with a reasoning block is taken to think: on production, deepseek-v4-pro and
   gpt-5.3-codex both said nothing and both thought, and mimo-v2.5 says nothing and thinks. */
export function thinksByDefault(r) {
  if (!r) return false;
  if (r.mandatory === true) return true;
  // "on, at an effort of none" is off: gpt-5.1 says exactly that
  if (r.default_effort === 'none') return false;
  return r.default_enabled === true || r.default_enabled !== false;
}

/* Whether the customer's own model thinks on these calls: true, false, or null when nothing
 * says. What was measured comes first, because every answer carries a count of the thinking
 * behind it; then what its catalogue entry states. A model whose entry says nothing either way
 * is not assumed to think here, unlike a candidate, because the two mistakes cost differently:
 * a candidate wrongly assumed not to think can be cut off mid-answer, while this guess only
 * decides how the candidates are asked, and a measurement corrects it as soon as it has timed
 * the customer's model on the calls. */
export function refThinksOf(refModel, measured = null, asked = null) {
  // the customer's own requests saying so beats everything
  if (asked === 'off') return false;
  if (asked === 'on') return true;
  if (measured && measured.n >= 3) return measured.share >= 0.3;
  if (!refModel) return null;
  const r = refModel.reasoning;
  if (!r) return false;
  if (r.mandatory === true) return true;
  if (r.default_enabled === false || r.default_effort === 'none') return false;
  if (r.default_enabled === true || r.default_effort) return true;
  return null;
}

/** How a recipe asks a model to think: switched off, kept light, or left as it comes. */
export function recipeKind(recipe) {
  const r = recipe?.reasoning;
  if (!r) return 'default';
  return r.enabled === false || r.effort === 'none' ? 'off' : 'light';
}

// lightest first; "none" is not among them, because that is off rather than light
const LIGHT = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/* How a model is asked to think, and whether it can do the job at all.
 *
 * A thinking model writes hidden notes before its answer. They are billed like the answer, and
 * they are slow: on the four measurements that first tested racing, models left to think wrote
 * far more than the customer's model did for the whole answer (hy3 176 tokens of thinking
 * against 17, glm-5.3-flash 108), and every one of them was then dropped as too slow. So a
 * model is measured the way the customer's own model works. When that one answers straight
 * away, a candidate that can be told not to think is told so, and one that has to think is
 * asked to think as little as it allows. When the customer's model thinks too, or the
 * customer's own requests say how much to think, the candidate is left as it comes. Whatever
 * it is measured with, it is routed with if it wins, because that is the model that cleared.
 *
 * A tight cap on the answer decides first: on most providers the notes count against it, so a
 * model that thinks runs out of room before it answers. If it cannot be told not to think, it
 * is left out. */
export function thinkingFit(model, profile, room, refThinks = null) {
  const r = model.reasoning;
  if (!r || !thinksByDefault(r)) return { ok: true, recipe: null };
  const efforts = Array.isArray(r.supported_efforts) ? r.supported_efforts : [];
  const off = { reasoning: efforts.includes('none') ? { effort: 'none' } : { enabled: false } };
  const tight = profile.outCap !== null && profile.outCap !== undefined && profile.outCap < room;
  if (tight) {
    if (r.mandatory === true) {
      return { ok: false, reason: `thinks before every answer and cannot be told not to, and your answers are capped at ${profile.outCap} tokens` };
    }
    return { ok: true, thinks: true, recipe: off, note: 'measured with its thinking switched off, because your answers are capped' };
  }
  // the customer's requests say how much to think, and they are sent as they are
  if (profile.reasoningSet) return { ok: true, recipe: null, thinks: true };
  // the customer's model thinks as well, so this one is measured thinking: like for like
  if (refThinks === true) return { ok: true, recipe: null, thinks: true };
  if (r.mandatory !== true) {
    return { ok: true, thinks: true, recipe: off, note: 'measured with its thinking switched off, like your model' };
  }
  const lightest = LIGHT.find((e) => efforts.includes(e)) || null;
  return {
    ok: true,
    thinks: true,
    mustThink: true,
    recipe: lightest && lightest !== r.default_effort ? { reasoning: { effort: lightest } } : null,
    note: 'has to think before every answer, so it is measured thinking as little as it allows',
  };
}

const fmt = (n) => Number(n).toLocaleString('en-US');
const INPUT_WORDS = { image: 'images', audio: 'audio', video: 'video', file: 'files' };

/* What one way of reaching a model can do, against what the workload's requests need: the
   catalogue's entry, or one provider's. The first thing it cannot do, in words, or null. `where`
   is put after the ability, for a model that could do it somewhere, just not privately. */
function cannotServe(x, profile, where = '') {
  const params = Array.isArray(x.params) ? x.params : null;
  if (profile.tools && params && !params.includes('tools')) return `cannot call tools${where}, which your requests use`;
  if (profile.toolChoice && params && !params.includes('tool_choice')) {
    return `cannot be told which tool to call${where}, which your requests do`;
  }
  if (profile.json === 'schema' && params && !params.includes('structured_outputs') && !params.includes('response_format')) {
    return `cannot follow a JSON schema${where}, which your requests set`;
  }
  if (profile.json === 'object' && params && !params.includes('response_format') && !params.includes('structured_outputs')) {
    return `cannot be asked for JSON${where}, which your requests are`;
  }
  const need = Math.ceil((profile.promptMax || 0) + (profile.outCap || profile.outP95 || 0));
  if (x.contextLen && need > x.contextLen) {
    return `can read ${fmt(x.contextLen)} tokens${where}, and your longest call needs ${fmt(need)}`;
  }
  const outNeed = Math.max(profile.outCap || 0, profile.outP95 || 0);
  if (x.maxOutput && outNeed > x.maxOutput) {
    return `writes at most ${fmt(x.maxOutput)} tokens${where}, and your answers can run to ${fmt(outNeed)}`;
  }
  return null;
}

/* Everything that rules a model out, in the order it is checked. The first that applies is the
   reason given, so the reason is always the most basic one.

   When every call has to go to a provider that keeps nothing, what counts is what those
   providers can do, not what the model can do somewhere: a catalogue entry describes all of a
   model's providers together. gpt-4o-mini's says it calls tools, and neither of its providers
   that keep nothing does; qwen3-30b-a3b's says it reads 131,072 tokens, and its only private
   provider reads 40,960. The providers that can do the job are handed back as `routes`, so the
   price and the health are read from them alone. */
export function eligibility(model, ctx) {
  const { profile, reference, zdrKnown, zdrOnly, room, expiryMs, at, minUptime } = ctx;
  if (model.id === reference) return { ok: false, step: 'current', reason: 'is the model you use now' };
  const privately = zdrOnly && zdrKnown;
  if (privately && !(model.endpoints || []).length) {
    return { ok: false, step: 'private', reason: 'has no provider that keeps nothing, so every call to it is refused' };
  }
  const inputs = profile.inputs || (profile.images ? ['image'] : []);
  if (Array.isArray(model.inputs)) {
    const missing = inputs.find((x) => !model.inputs.includes(x));
    if (missing) return { ok: false, step: 'features', reason: `cannot read ${INPUT_WORDS[missing] || missing}, which your requests send` };
  }
  let routes = null;
  if (privately) {
    // a provider that does not say what it supports is taken to support what the model does
    const asRoute = (e) => ({ params: e.params ?? model.params, contextLen: e.context_len ?? model.contextLen, maxOutput: e.max_output ?? model.maxOutput });
    const eps = model.endpoints;
    const why = eps.map((e) => cannotServe(asRoute(e), profile));
    routes = eps.filter((e, i) => why[i] === null);
    if (!routes.length) {
      const anywhere = cannotServe(model, profile) === null;
      return { ok: false, step: 'features', reason: cannotServe(asRoute(eps[0]), profile, anywhere ? ' at any provider that keeps nothing' : '') };
    }
  } else {
    const why = cannotServe(model, profile);
    if (why) return { ok: false, step: 'features', reason: why };
  }
  const think = thinkingFit(model, profile, room, ctx.refThinks ?? null);
  if (!think.ok) return { ok: false, step: 'thinking', reason: think.reason };
  if (model.expiresAt && model.expiresAt - at < expiryMs) {
    return { ok: false, step: 'retiring', reason: 'is being retired soon' };
  }
  if (privately) {
    const h = healthOf({ endpoints: routes });
    if (h.bestUptime !== null && h.bestUptime < minUptime) {
      return { ok: false, step: 'health', reason: `answered only ${h.bestUptime.toFixed(1)}% of calls over the last day at its best provider` };
    }
    if (!h.healthyProviders) {
      return { ok: false, step: 'health', reason: 'has no provider answering reliably right now' };
    }
  }
  return {
    ok: true, recipe: think.recipe, note: think.note || null, thinks: !!think.thinks, mustThink: !!think.mustThink, routes,
  };
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
    /* Only what the verdict says about its answers. "Slower" at the end means they matched and
       the time did not, and speed is weighed on its own below; "slower" in the first calls, or
       "failed" because its provider was busy or refused it, says nothing about the answers. */
    const p = hist.verdict === 'slower'
      ? (hist.stopped ? undefined : 0.9)
      : { cleared: 0.95, review: 0.6, missed: 0.1 }[hist.verdict];
    // measured on these very calls, so it outweighs everything else put together
    if (p !== undefined) parts.push({ source: 'before', p, w: 6, note: hist.verdict === 'slower' ? 'matched' : hist.verdict });
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
  /* Live calls elsewhere: a model whose calls worked less often than most on this kind of task,
     for other customers, is a little less likely to suit this one, and one that worked more often
     a little more. A nudge rather than a vote, so it can never drag every model to the middle, and
     it grows with the calls behind it. */
  const lived = ctx.history?.live?.get(model.id);
  if (lived) {
    const lift = Math.max(-0.4, Math.min(0.15, 3 * (lived.rate - lived.fleet))) * Math.min(1, lived.n / 400);
    chance = Math.max(0.01, Math.min(0.97, chance * (1 + lift)));
    // said in words only: a count or a rate from other customers' calls never reaches a page
    const note = lift > 0.02 ? 'above average' : lift < -0.02 ? 'below average' : 'about average';
    parts.push({ source: 'live', p: null, w: 0, note });
  }
  return { chance, parts, family };
}

/* The chance a model keeps to the workload's speed setting, or null when speed does not matter.
 *
 * Measured first: in recent measurements of any workload, how long it took against the
 * customer's model in the same measurement, asked to think the same way. A ratio travels
 * between workloads far better than a time does, because a long answer is slow on every model.
 * Its providers' published speeds come next, against the customer's model's, over the last
 * half hour; they come from everybody's traffic, and they describe a model left to think, so
 * they count for less, and for less again when it will be asked not to. With neither, a
 * middling 0.7. The allowance is the setting's own: one and a half times, or one and a fifth,
 * plus the fixed slack every measurement gives. */
export function speedChanceOf(model, recipe, ctx) {
  const { speed, speedHistory, refHealth, profile, config } = ctx;
  if (!speed || !speed.factor) return null;
  const refMs = speed.metric === 'ttft' ? (refHealth?.ttftP50 || 900) : (profile.refLatencyP50 || 1500);
  const allowed = speed.factor + config.SPEED_SLACK_MS / Math.max(300, refMs);
  const curve = (ratio) => 1 / (1 + (ratio / allowed) ** 6);
  const parts = [];
  const kind = recipeKind(recipe);
  const h = speedHistory?.get(`${model.id}|${kind}`);
  const measuredRatio = h ? (speed.metric === 'ttft' ? h.ttft ?? h.latency : h.latency) : null;
  // each measurement is a few calls timed side by side with the customer's model: real evidence
  if (measuredRatio) parts.push({ source: 'measured', p: curve(measuredRatio), w: Math.min(8, 2 * h.n), ratio: measuredRatio, n: h.n });
  const mine = healthOf(model);
  let pub = null;
  if (refHealth?.ttftP50 && mine.ttftP50) {
    if (speed.metric === 'ttft') pub = mine.ttftP50 / refHealth.ttftP50;
    else if (mine.tpsP50 && refHealth.tpsP50) {
      const out = Math.max(1, profile.outP50 || 50);
      pub = (mine.ttftP50 + (out / mine.tpsP50) * 1000) / (refHealth.ttftP50 + (out / refHealth.tpsP50) * 1000);
    }
  }
  if (pub) parts.push({ source: 'published', p: curve(pub), w: kind === 'default' ? 0.5 : 0.2, ratio: pub });
  parts.push({ source: 'prior', p: 0.7, w: 1 });
  const p = parts.reduce((a, x) => a + x.p * x.w, 0) / parts.reduce((a, x) => a + x.w, 0);
  return { p, measured: measuredRatio ?? null, n: h?.n ?? 0, published: pub };
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
    refThinks = null, speedHistory = null, busy = null,
    config, at = Date.now(),
  } = input;
  const zdrOnly = config.ZDR_ONLY;
  const ctx = {
    profile, reference, zdrKnown: facts.zdrKnown, zdrOnly, room: config.EVAL_THINKING_ROOM_TOKENS,
    expiryMs: config.EVAL_EXPIRY_DAYS * 86400000, at, minUptime: config.EVAL_MIN_UPTIME_PCT,
    history, fits, arena, difficulty, refThinks,
  };
  const refModel = facts.models.get(reference) || null;
  const pin = profile.promptAvg || 0;
  const pout = profile.outAvg || 0;
  /* The price a routed call would really cost: through a provider that keeps nothing, when we
     know which those are. When that list has never been read, the catalogue's price is the best
     there is, and ruling every model out for want of a list would measure nothing. */
  const priceOf = (m, routes = null) => (zdrOnly && facts.zdrKnown
    ? routedCallPrice(routes ? { ...m, endpoints: routes } : m, pin, pout, profile.hours, { zdrOnly })
    : callPrice(m, pin, pout, profile.hours));
  // the customer's model, through the providers that can serve these requests
  const refRoutes = refModel ? (refModel.endpoints || []).filter((e) => cannotServe(
    { params: e.params ?? refModel.params, contextLen: e.context_len ?? refModel.contextLen, maxOutput: e.max_output ?? refModel.maxOutput },
    profile) === null) : [];
  /* What a call on the customer's model costs. A model the catalogue does not list (a free
     variant, an alias, one we cannot reach) is priced from what its calls have actually cost,
     because without a price nothing can be ruled out as dearer, and ranking by chance alone
     favours the dearest models. */
  const refPrice = (refModel
    ? (priceOf(refModel, refRoutes.length ? refRoutes : null) ?? callPrice(refModel, pin, pout, profile.hours))
    : null) || profile.refCostPerCall || null;
  const refHealth = refModel ? healthOf(refRoutes.length ? { endpoints: refRoutes } : refModel) : null;

  const funnel = [];
  const excluded = [];
  const count = (step, label, left) => funnel.push({ step, label, left });

  const all = [...facts.models.values()];
  /* The model serving the workload now is always checked again, even if it has since been
     switched off in Models, become dearer or been set aside: a model left serving unmeasured is
     the one that can quietly cost the customer. */
  const pool = all.filter((m) => (enabled === null || enabled.has(m.id) || m.id === serving) && m.id !== reference);
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
    kept.push({ m, recipe: e.recipe, note: e.note, thinks: e.thinks, mustThink: e.mustThink, routes: e.routes || null });
  }
  let left = pool.length;
  // a check that cannot apply to this workload is not shown: the length cap, when there is none
  const capped = profile.outCap !== null && profile.outCap !== undefined && profile.outCap < ctx.room;
  for (const [step, label] of [
    ['private', 'reachable with nothing kept'],
    ['features', 'able to handle your requests'],
    ['thinking', 'able to answer within your length cap'],
    ['retiring', 'not being retired'],
    ['health', 'answering reliably'],
  ]) {
    left -= byStep.get(step) || 0;
    if (step === 'thinking' && !capped && !byStep.get(step)) continue;
    count(step, label, left);
  }

  // cheaper, at the price we would actually pay
  const priced = [];
  for (const k of kept) {
    const price = priceOf(k.m, k.routes);
    const isServing = k.m.id === serving;
    if (isServing) {
      // measured again whatever it costs now: the measurement finds out what it really costs
      priced.push({ ...k, price: price > 0 ? price : callPrice(k.m, pin, pout, profile.hours) });
      continue;
    }
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
    if (!reverted.has(k.m.id) || k.m.id === serving) return true;
    excluded.push({ model: k.m.id, step: 'reverted', reason: 'was switched to before on this workload and switched back' });
    return false;
  });

  // far too slow to start or to write, going by its providers' published speeds
  const quick = fresh.filter((k) => {
    if (!speed || !speed.factor || !refHealth || k.m.id === serving) return true;
    const h = healthOf(k.routes ? { endpoints: k.routes } : k.m);
    const x = config.SPEED_PREFILTER_X;
    /* The published time to a first word is of a model left to think. One that will be asked
       not to, or to think less, starts sooner than that, so it is not ruled out on it. */
    const asPublished = recipeKind(k.recipe) === 'default';
    if (asPublished && speed.metric === 'ttft' && h.ttftP50 && refHealth.ttftP50 && h.ttftP50 > x * refHealth.ttftP50) {
      excluded.push({ model: k.m.id, step: 'speed', reason: `usually takes ${sec(h.ttftP50)} to start answering, against ${sec(refHealth.ttftP50)} for ${short(reference)}` });
      return false;
    }
    if ((profile.outP50 || 0) >= 200 && h.tpsP50 && refHealth.tpsP50 && h.tpsP50 * x < refHealth.tpsP50) {
      excluded.push({ model: k.m.id, step: 'speed', reason: `writes about ${Math.round(h.tpsP50)} tokens a second, against ${Math.round(refHealth.tpsP50)} for ${short(reference)}` });
      return false;
    }
    return true;
  });
  if (speed && speed.factor) count('speed', 'quick enough for your speed setting', quick.length);

  /* Rank by expected saving: what it saves if it works out, times the chance that it does.
     Its answers have to match and it has to be quick enough, so the two chances multiply. A
     model whose provider was too busy to answer a measurement in the last few hours is likely
     to be busy again, so it waits behind the rest for a while; that says nothing about its
     answers, and it is forgotten once the providers have had time to recover. */
  const ranked = quick.map((k) => {
    const c = chanceOf(k.m, { ...ctx, reference });
    const reach = k.routes ? { ...k.m, endpoints: k.routes } : k.m;
    const sp = speedChanceOf(reach, k.recipe, { speed, speedHistory, refHealth, profile, config });
    const wasBusy = busy?.get(k.m.id) || null;
    const overall = c.chance * (sp ? sp.p : 1) * (wasBusy ? 0.35 : 1);
    const saving = refPrice === null ? null : refPrice - k.price;
    return {
      model: k.m.id,
      name: k.m.name,
      price: k.price,
      refPrice,
      savingShare: refPrice ? saving / refPrice : null,
      chance: overall,
      answerChance: c.chance,
      speedChance: sp ? sp.p : null,
      speedMeasured: sp ? sp.measured : null,
      busy: !!wasBusy,
      expected: saving === null ? overall : saving * overall,
      parts: c.parts,
      family: c.family,
      recipe: k.recipe,
      note: k.note,
      thinks: k.thinks,
      mustThink: !!k.mustThink,
      health: healthOf(reach),
    };
  });

  /* The customer's own model, thinking less. When it thinks before every answer and can be asked to
     think less, that is often the safest saving there is: the same model, very likely the same
     answers, and a good share of the billed tokens gone, since thinking is billed like the answer.
     Its price is a guess until measured (six tenths of the model's own); the measurement finds the
     real one. It is raced under its own name, and served the way it was measured if it wins. */
  // never again once it was switched back, like any model: it has said something about itself
  if (refModel && refThinks === true && !profile.reasoningSet && refPrice && !reverted.has(`${reference}#lighter`)) {
    const r = refModel.reasoning || {};
    const efforts = Array.isArray(r.supported_efforts) ? r.supported_efforts : [];
    let reasoning = null;
    if (r.mandatory !== true && efforts.includes('none')) reasoning = { effort: 'none' };
    else {
      /* The lightest setting it offers that is lighter than the one it uses unasked: with "minimal"
         as its own setting, "low" would have it think more, not less. */
      const ladder = ['minimal', 'low', 'medium', 'high'];
      const own = ladder.indexOf(r.default_effort ?? 'medium');
      const lightest = ladder.find((e, i) => efforts.includes(e) && (own < 0 || i < own));
      if (lightest) reasoning = { effort: lightest };
    }
    if (reasoning) {
      const price = refPrice * 0.6;
      const chance = 0.6;
      ranked.push({
        model: reference, key: `${reference}#lighter`, label: `${short(reference)}, thinking less`, name: refModel.name,
        price, refPrice, savingShare: 0.4, chance, answerChance: chance, speedChance: null, speedMeasured: null, busy: false,
        expected: (refPrice - price) * chance,
        parts: [{ source: 'same model', p: chance, w: 1, note: 'your own model, asked to think less' }],
        family: true, recipe: { reasoning }, note: 'your own model, asked to think less', thinks: true, mustThink: false,
        health: refHealth,
      });
    }
  }
  ranked.sort((a, b) => b.expected - a.expected || a.price - b.price);

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
