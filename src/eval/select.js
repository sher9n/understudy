import { calibrated } from './calibrate.js';
import { routedCallPrice, callPrice, healthOf, healthy } from '../models/facts.js';

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
 * model that thinks runs out of room before it answers. One that can be told not to think is
 * told so. One that cannot is measured thinking as little as it allows, with `allowance` tokens
 * more than the cap to think in (recipe.room, which buildUpstream adds to the request's cap, and
 * the call's hold counts), so its answer still has the whole cap; it is left out only when it
 * cannot write that many tokens, or with no allowance at all. Left out whatever the cap, the
 * strongest models there are were never tried on a workload capped at 900 tokens (30 Sep 2026):
 * the three that ran out of a 180-token cap on the first real measurement had no room above it. */
export function thinkingFit(model, profile, room, refThinks = null, allowance = 0) {
  const r = model.reasoning;
  if (!r || !thinksByDefault(r)) return { ok: true, recipe: null };
  const efforts = Array.isArray(r.supported_efforts) ? r.supported_efforts : [];
  const off = { reasoning: efforts.includes('none') ? { effort: 'none' } : { enabled: false } };
  const tight = profile.outCap !== null && profile.outCap !== undefined && profile.outCap < room;
  if (tight) {
    if (r.mandatory === true) {
      const cap = Math.floor(profile.outCap);
      if (!(allowance > 0)) {
        return { ok: false, reason: `thinks before every answer and cannot be told not to, and your answers are capped at ${cap} tokens` };
      }
      const writes = Number(model.maxOutput) || null;
      if (writes && cap + allowance > writes) {
        return { ok: false, reason: `thinks before every answer and writes at most ${fmt(writes)} tokens, too few to think in and still give your ${fmt(cap)}-token answers` };
      }
      const lightest = LIGHT.find((e) => efforts.includes(e)) || null;
      const reasoning = lightest && lightest !== r.default_effort ? { effort: lightest } : null;
      return {
        ok: true,
        thinks: true,
        mustThink: true,
        recipe: { ...(reasoning ? { reasoning } : {}), room: Math.floor(allowance) },
        note: `has to think before every answer, so it is measured thinking as little as it allows, with room to think beyond your ${fmt(cap)}-token cap`,
      };
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
  const think = thinkingFit(model, profile, room, ctx.refThinks ?? null, ctx.allowance ?? 0);
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
  let measured = false;
  if (hist) {
    /* Only what the verdict says about its answers. "Slower" at the end means they matched and
       the time did not, and speed is weighed on its own below; "slower" in the first calls, or
       "failed" because its provider was busy or refused it, says nothing about the answers. */
    let p = hist.verdict === 'slower'
      ? (hist.stopped ? undefined : 0.9)
      : { cleared: 0.95, review: 0.6, missed: 0.1 }[hist.verdict];
    let note = hist.verdict === 'slower' ? 'matched' : hist.verdict;
    /* Unless the answers it did give, before it was stopped, were far outside the bar: twice what is allowed is a miss
       whatever stopped it. llama-3.1-8b, stopped for speed on the museum guide with 96% of its answers worse against
       20.8% allowed, read as never tested, and was put sixth in line for the next test. */
    if (p === undefined && Number.isFinite(hist.gap) && Number(hist.floor) > 0 && hist.gap >= 2 * hist.floor) {
      p = 0.1;
      note = 'missed before it was stopped';
    }
    // measured on these very calls, so it outweighs everything else put together
    if (p !== undefined) {
      parts.push({ source: 'before', p, w: 6, note });
      measured = true;
    }
  }
  /* What this workload's own results say about a model of its strength (workloadCurve): the models tested here, each
     placed on one scale of strength, show how strong a model has to be to pass on these very calls. Only for a model not
     tested here itself, whose own result says more. Before this, a model never tested here was read from the task and
     the leaderboard alone, which rated an 8-billion-parameter model and claude-haiku-4.5 about the same (0.44 and 0.47)
     on a workload where every small model had missed by far; a strength read from a price counts for half. Tested here
     with nothing its answers can be read from (stopped early, failed), it is read from the curve like one never tested. */
  const here = ctx.here;
  if (here && !measured) {
    const s = ctx.strength ? ctx.strength(model.id) : null;
    if (s) {
      parts.push({ source: 'here', p: here.curve(s.value - here.ref), w: Math.min(4, here.n / 4) * (s.read ? 0.5 : 1),
        note: `${here.n} models tested here` });
    }
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

/* How strong a model is, on one scale: its rating on the public leaderboard where it has one, and otherwise one read from
 * its price along a line drawn through the rated models (a dearer model is a stronger one, on the whole; only a line
 * that rises with price is drawn). A read rating is rough and is marked as read. Answers a function of a model id, which
 * gives { value, read } or null where nothing can be said. */
export function strengthScale(models, arena) {
  const blend = (m) => Number(m?.priceIn || 0) + Number(m?.priceOut || 0);
  const pts = [];
  for (const m of models) {
    const r = Number(arena?.get(m.id));
    if (r > 0 && blend(m) > 0) pts.push([Math.log10(blend(m)), r]);
  }
  let line = null;
  if (pts.length >= 8) {
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n;
    const my = pts.reduce((a, p) => a + p[1], 0) / n;
    const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    const sxy = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
    if (sxx > 0 && sxy > 0) line = { a: my - (sxy / sxx) * mx, b: sxy / sxx };
  }
  const byId = new Map(models.map((m) => [m.id, m]));
  return (id) => {
    const r = Number(arena?.get(id));
    if (r > 0) return { value: r, read: false };
    const p = blend(byId.get(id));
    return line && p > 0 ? { value: line.a + line.b * Math.log10(p), read: true } : null;
  };
}

/* What a workload's own results say about how strong a model has to be to pass there. Each model tested on it that was
 * judged on its answers is placed on the strength scale against the customer's own model: passed (1), came close (a
 * half) or missed (0). One number is fitted, the strength at which a model has an even chance on these calls, and the
 * chance falls away either side of it, from three in four to one in four over `scale` points. Two imagined results
 * anchor it where the real ones say little: a model clearly stronger than the customer's that passed, and one far
 * weaker that missed. With the curve, the share of them that missed, which is what a task's difficulty turns out to be.
 * Null with fewer than four placed. */
export function workloadCurve(own, strength, reference, scale = 60) {
  const ref = strength(reference);
  if (!ref || !own) return null;
  const pts = [];
  for (const [id, h] of own) {
    // "slower" at the end matched, and was too slow; stopped for speed, or failed, it was never judged on its answers
    const y = h.verdict === 'cleared' ? 1 : h.verdict === 'review' ? 0.5 : h.verdict === 'missed' ? 0
      : h.verdict === 'slower' && !h.stopped ? 1 : null;
    if (y === null) continue;
    /* A model that thinks, measured with its thinking switched off, is not the model its rating describes: on the museum
       guide deepseek-v4-pro and grok-4.3 missed that way, and read at their ratings they said a model had to be far
       stronger than gpt-5.4 to pass there. Its own result still counts for it (chanceOf); only the curve leaves it out. */
    if (h.thinkingOff) continue;
    const s = strength(id);
    if (!s) continue;
    pts.push({ x: s.value - ref.value, y, w: s.read ? 0.5 : 1 });
  }
  if (pts.length < 4) return null;
  const k = (2 * Math.log(3)) / scale;
  const sig = (z) => 1 / (1 + Math.exp(-z));
  const all = [...pts, { x: scale, y: 1, w: 1 }, { x: -3 * scale, y: 0, w: 1 }];
  let best = null;
  for (let theta = -800; theta <= 400; theta += 5) {
    let ll = 0;
    for (const p of all) {
      const q = Math.min(1 - 1e-9, Math.max(1e-9, sig(k * (p.x - theta))));
      ll += p.w * (p.y * Math.log(q) + (1 - p.y) * Math.log(1 - q));
    }
    if (!best || ll > best.ll) best = { theta, ll };
  }
  const weight = pts.reduce((a, p) => a + p.w, 0);
  return {
    n: pts.length, ref: ref.value, theta: best.theta,
    curve: (x) => sig(k * (x - best.theta)),
    difficulty: 1 - pts.reduce((a, p) => a + p.w * p.y, 0) / weight,
  };
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
  /* `serving` is the model a switch sends calls to (for a strategy, its lead model); `servingAs` is
     what serves by its own name (see servingKey in src/eval/promote.js), which tells the customer's
     own model thinking less, or from its cheapest provider, from the customer's own model; and
     `servingRecipe` is how it is sent. */
  const {
    facts, profile, reference, enabled, want, tryMultiple = 3, reverted = new Set(), cantKeepUp = new Set(), serving = null,
    servingAs = null, servingRecipe = null,
    history = null, fits = null, arena = null, difficulty = null, speed = null,
    refThinks = null, speedHistory = null, busy = null,
    config, at = Date.now(),
  } = input;
  // the workspace's own choice, where it made one; the deployment's otherwise
  const zdrOnly = input.zdrOnly ?? config.ZDR_ONLY;
  const ctx = {
    profile, reference, zdrKnown: facts.zdrKnown, zdrOnly, room: config.EVAL_THINKING_ROOM_TOKENS,
    allowance: config.EVAL_THINK_ALLOWANCE_TOKENS ?? 0,
    expiryMs: config.EVAL_EXPIRY_DAYS * 86400000, at, minUptime: config.EVAL_MIN_UPTIME_PCT,
    history, fits, arena, difficulty, refThinks,
  };
  const refModel = facts.models.get(reference) || null;
  const pin = profile.promptAvg || 0;
  const pout = profile.outAvg || 0;
  /* The price a routed call would really cost: through a provider that keeps nothing, when we
     know which those are. When that list has never been read, the catalogue's price is the best
     there is, and ruling every model out for want of a list would measure nothing. `out` is the
     tokens it is expected to write. */
  const priceOf = (m, routes = null, out = pout) => (zdrOnly && facts.zdrKnown
    ? routedCallPrice(routes ? { ...m, endpoints: routes } : m, pin, out, profile.hours, { zdrOnly })
    : callPrice(m, pin, out, profile.hours));
  /* A model given room to think beyond the cap (thinkingFit) is billed for its thinking like its answer, so it is priced
     with some: about four times the answer, and never more than the room. The measurement finds what it really costs;
     priced on the answer alone, one dearer than the customer's model once it thinks took a place it could never win. */
  const thinkingOut = (k) => (k.recipe?.room ? Math.min(k.recipe.room, Math.max(200, 4 * pout)) : 0);
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
    const price = priceOf(k.m, k.routes, pout + thinkingOut(k));
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
    /* Cheaper, but by less than our fee: a switch to it could never be made (the run only switches to a
       setup cheaper once the fee is added), so a place in the race spent on it is spent on nothing. */
    if (refPrice !== null && price * (1 + (Number(config.ROUTING_FEE_PCT) || 0) / 100) >= refPrice) {
      excluded.push({ model: k.m.id, step: 'price', reason: `would save less than our ${config.ROUTING_FEE_PCT}% fee on your calls, so a switch to it could not save you anything` });
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
  }).filter((k) => {
    /* failed a test of this workload because its provider could not keep up with the requests (cantKeepUpOn in
       src/eval/history.js): never tried on it again */
    if (!cantKeepUp.has(k.m.id) || k.m.id === serving) return true;
    excluded.push({ model: k.m.id, step: 'busy', reason: "couldn't keep up in an earlier test of this workload: its provider kept turning requests away even at the slowest pace, so it isn't tried again" });
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

  /* What this workload's own results say about strength (workloadCurve), and what they make the task's difficulty: read
     from the models tested here, the difficulty a task was guessed to have beforehand counts as five of them. The museum
     guide was guessed fairly easy (0.37), which lifted every weak model's leaderboard reading, when all but one of the
     models tested on it had missed. */
  const strength = strengthScale(all, arena);
  const here = workloadCurve(history?.own, strength, reference, config.EVAL_HERE_SCALE ?? 60);
  if (here) {
    ctx.here = here;
    ctx.difficulty = ((difficulty ?? 0.5) * 5 + here.difficulty * here.n) / (5 + here.n);
  }
  ctx.strength = strength;
  /* The last test of this workload that compared models found nothing to switch to (lastFailed in src/eval/history.js),
     so this one climbs: it tries the models likeliest to pass first, and the cheaper of two about as likely, rather than
     the next cheapest ones, which are the least likely of all to do what the cheapest could not. */
  const climb = !!history?.lastFailed;

  /* Rank by expected saving: what it saves if it works out, times the chance that it does.
     Its answers have to match and it has to be quick enough, so the two chances multiply. A
     model whose provider was too busy to answer a measurement in the last few hours is likely
     to be busy again, so it waits behind the rest for a while; that says nothing about its
     answers, and it is forgotten once the providers have had time to recover. */
  const ranked = quick.map((k) => {
    const c = chanceOf(k.m, { ...ctx, reference });
    /* Read through how often chances like it came true (src/eval/calibrate.js), where there is a
       record to read it through; the chance as worked out is kept beside it for that record. */
    const answer = calibrated(ctx.calibration, c.chance);
    const reach = k.routes ? { ...k.m, endpoints: k.routes } : k.m;
    const sp = speedChanceOf(reach, k.recipe, { speed, speedHistory, refHealth, profile, config });
    const wasBusy = busy?.get(k.m.id) || null;
    const overall = answer * (sp ? sp.p : 1) * (wasBusy ? 0.35 : 1);
    const saving = refPrice === null ? null : refPrice - k.price;
    return {
      model: k.m.id,
      name: k.m.name,
      price: k.price,
      refPrice,
      savingShare: refPrice ? saving / refPrice : null,
      chance: overall,
      answerChance: answer,
      rawChance: c.chance,
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
  /* Never again once it was switched back, like any model: it has said something about itself. And
     always when it is what serves the workload now, measured the way it is served, like any model
     serving: whatever the catalogue says about its thinking today, a strategy left serving unmeasured
     is the one that can quietly cost the customer. */
  const lighterKey = `${reference}#lighter`;
  const servesLighter = servingAs === lighterKey;
  if (refModel && refPrice && (servesLighter || (refThinks === true && !profile.reasoningSet && !reverted.has(lighterKey)))) {
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
    if (servesLighter && servingRecipe?.reasoning) reasoning = servingRecipe.reasoning;
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
  /* The customer's own model, from the provider that charges least for it. Where several providers
     sell it at different prices, calls are spread over them, and the one that charges least can be a
     good deal cheaper than that mix. The same model, so very likely the same answers; but a provider
     can run it differently (a smaller number format, an older build), so it is measured like any
     model before anything is switched, and served only from that provider if it clears. */
  const cheapestKey = `${reference}#cheapest`;
  const servesCheapest = servingAs === cheapestKey;
  if (refModel && refPrice && (servesCheapest || !reverted.has(cheapestKey))) {
    const byPrice = refRoutes.filter(healthy)
      .map((e) => ({ e, price: callPrice({ priceIn: e.price_in, priceOut: e.price_out, overrides: e.overrides }, pin, pout, profile.hours) }))
      .filter((x) => x.price > 0)
      .sort((a, b) => a.price - b.price);
    /* The provider serving it now, when it serves, whether or not it is still the cheapest: it is
       re-checked where it is served. A provider that has gone is still tried there, and the provider's
       refusal is what switches it back. */
    const pinned = servesCheapest ? (Array.isArray(servingRecipe?.providers) ? servingRecipe.providers : []) : null;
    const pick = pinned
      ? (byPrice.find((x) => pinned.includes(x.e.tag)) || { e: { tag: pinned[0] ?? null, provider: null }, price: refPrice, gone: true })
      : byPrice.length >= 2 && byPrice[0].price < refPrice * 0.9 ? byPrice[0] : null;
    if (pick) {
      const { e, price } = pick;
      /* A fixed guess, not a reading of any evidence: it is not written down as a raw chance, so the
         record of how often chances came true (src/eval/calibrate.js) never counts it. */
      const chance = 0.8;
      const where = e.provider || e.tag || 'its cheapest provider';
      ranked.push({
        model: reference, key: cheapestKey, label: `${short(reference)}, from ${where}`, name: refModel.name,
        price, refPrice, savingShare: (refPrice - price) / refPrice, chance, answerChance: chance, rawChance: null,
        speedChance: null, speedMeasured: null, busy: false,
        expected: (refPrice - price) * chance,
        parts: [{ source: 'same model', p: chance, w: 1, note: `your own model, from ${where}, the provider that charges least for it` }],
        family: true, recipe: pinned && servingRecipe ? servingRecipe : { providers: [e.tag], pinned: true },
        note: `your own model, from ${where}`, thinks: !!refThinks, mustThink: false,
        health: pick.gone ? refHealth : healthOf({ endpoints: [e] }),
      });
    }
  }
  const band = config.EVAL_CLIMB_BAND || 0.05;
  ranked.sort(climb
    ? (a, b) => Math.floor(b.chance / band) - Math.floor(a.chance / band) || b.expected - a.expected || a.price - b.price
    : (a, b) => b.expected - a.expected || a.price - b.price);

  /* Places kept for the strongest models the workload can afford, whatever each would save (EVAL_STRONG_PLACES): ranked
     on saving, every place in the museum guide's tests went to small cheap models, and the strong ones it needed waited
     at the back. The strongest by the leaderboard first, one read from its price only where too few rated ones are left;
     never one that already missed here, which has said what it can do, nor the customer's own model asked another way.
     They go to the front, before the rest, and say so. */
  const places = Math.max(0, Math.floor(Number(config.EVAL_STRONG_PLACES) || 0));
  const strong = [];
  if (places) {
    const worth = ranked.filter((r) => !r.key && r.model !== serving && strength(r.model)
      && ctx.history?.own?.get(r.model)?.verdict !== 'missed');
    const rated = worth.filter((r) => !strength(r.model).read);
    const read = worth.filter((r) => strength(r.model).read);
    const byStrength = (a, b) => strength(b.model).value - strength(a.model).value || a.price - b.price;
    /* one from each maker: kept by strength alone, every place on every workload went to three versions of one maker's
       model, and the rule of two from a maker in front then kept one of them back */
    const makers = new Set();
    for (const r of [...rated.sort(byStrength), ...read.sort(byStrength)]) {
      if (strong.length >= places) break;
      if (makers.has(vendorOf(r.model))) continue;
      makers.add(vendorOf(r.model));
      strong.push(r);
    }
    for (const r of strong) {
      r.strongPlace = true;
      r.note = [r.note, 'given a place as one of the strongest models you can afford'].filter(Boolean).join('; ');
    }
    ranked.splice(0, ranked.length, ...strong, ...ranked.filter((r) => !strong.includes(r)));
  }

  /* At most two from one maker in the list, so one family's shared weakness cannot take every
     place; the rest of that family waits behind everybody else rather than being dropped. The
     model serving the workload now always goes first, so it is always checked again: found by its
     own name, so that the customer's own model thinking less and the same model from its cheapest
     provider, both the customer's model by name, are not both put first as the one serving. A
     strategy's lead model goes first for it. */
  const servesNow = (r) => (servingAs
    ? (r.key || r.model) === servingAs || (!r.key && r.model === serving)
    : !!serving && r.model === serving);
  const perVendor = new Map();
  const first = [];
  const later = [];
  for (const r of ranked) {
    if (servesNow(r)) { first.unshift(r); continue; }
    const v = vendorOf(r.model);
    const n = perVendor.get(v) || 0;
    if (n < 2) { perVendor.set(v, n + 1); first.push(r); } else later.push(r);
  }
  const order = [...first, ...later];
  const limit = Math.max(want, Math.round(want * tryMultiple));
  // how strong each ruled-out model is, so what a page says of them names the strongest first (noteRuledOut in run.js)
  for (const e of excluded) {
    const s = strength(e.model);
    e.strength = s ? Math.round(s.value) : null;
  }
  return {
    funnel,
    excluded,
    ranked: order,
    order: order.slice(0, limit),
    waiting: Math.max(0, order.length - limit),
    refPrice,
    refHealth,
    // what the workload's own results said (workloadCurve), whether this test climbs, and the places kept for strength
    here: here ? { n: here.n, theta: here.theta, difficulty: Math.round(here.difficulty * 1000) / 1000 } : null,
    difficulty: ctx.difficulty ?? null,
    climb,
    strong: strong.map((r) => r.key || r.model),
  };
}

const short = (id) => String(id || '').split('/').pop();
const sec = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} seconds`;
const pctMore = (a, b) => {
  const x = a / b;
  if (x < 1.005) return 'as much as';
  return x >= 1.995 ? `${x.toFixed(1)} times` : `${Math.round((x - 1) * 100)}% more than`;
};
