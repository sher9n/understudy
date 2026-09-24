import express from 'express';
import { safeRouter } from './safe.js';
import { db, now, id } from './db/index.js';
import { reportCallFailure } from './alerts.js';
import config, { canRoute } from './config.js';
import { verifyKey, bearerOf } from './keys.js';
import { workloadFor, recordCall, addActivity } from './traffic.js';
import { chat, chatStream, priceCall, UpstreamError, reasonOf, hintApplies } from './openrouter.js';
import { gateRouting, chargeCall, grantStarterCredit, hold, release, callShape, callBound, withFee, baseModelId, promptTokensOf,
  boundAt, mergeCeilings } from './billing.js';
import { enqueue } from './jobs.js';
import { refOf } from './learn/threads.js';
import { workloadNameOf, pinnedOf } from './classify.js';
import { report } from './learn/outcomes.js';
import { chooseStrategy, served as noteServed } from './learn/choose.js';
import { serveWith, writeAsStream, routeFor } from './learn/serve.js';
import { leadModel } from './learn/arms.js';
import { zdrFor, cacheHintFor } from './workspace.js';
import { estimateCost } from './trueup.js';
import { cadenceOf } from './eval/schedule.js';
import { planFor, usableCalls, barNeed } from './eval/plan.js';
import { callsToClear } from './eval/compare.js';
import { OUTCOME_OF } from './eval/outcome.js';

/* Roughly how many tokens an answer ran to, from what it wrote: three characters a token, which
   overcounts ordinary text, for charging a call whose provider did not say. */
const writtenTokens = (response) => {
  const m = response?.choices?.[0]?.message || {};
  const args = Array.isArray(m.tool_calls) ? m.tool_calls.reduce((n, c) => n + String(c?.function?.arguments || '').length, 0) : 0;
  return Math.ceil((String(m.content || '').length + args) / 3);
};
const hasCost = (usage) => usage?.cost !== null && usage?.cost !== undefined && Number.isFinite(Number(usage.cost));

export const v1 = safeRouter();

/** Every /v1 route is authenticated by the customer's own key, never by a session. */
async function auth(req, res, next) {
  const key = await verifyKey(bearerOf(req));
  if (!key) {
    return res.status(401).json({
      error: { message: 'Send your Understudy key as "Authorization: Bearer us_live_...".', type: 'invalid_api_key' },
    });
  }
  req.key = key;
  next();
}

v1.use(express.json({ limit: '8mb' }));
v1.use(auth);

/** What this workspace can ask for. The customer's own model ids keep working. */
v1.get('/models', async (req, res) => {
  /* An empty list is a lie here. It reads as "there are no models", when what is true is
     that this deployment cannot reach a provider, so nothing has been priced or synced.
     Say that, in the same words /chat/completions uses. */
  if (!canRoute()) {
    return res.status(503).json({
      error: { message: 'Routing is not configured on this deployment yet.', type: 'not_configured' },
    });
  }
  const rows = await db.prepare(
    `SELECT c.model_id, c.name, c.context_len, c.price_in, c.price_out, c.open_weights
       FROM models_catalog c
       LEFT JOIN workspace_models wm ON wm.model_id = c.model_id AND wm.workspace_id = ?
      WHERE COALESCE(wm.enabled, 1) = 1
      ORDER BY c.model_id`).all(req.key.workspace_id);
  res.json({
    object: 'list',
    data: rows.map((m) => ({
      id: m.model_id, object: 'model', owned_by: m.model_id.split('/')[0],
      context_length: m.context_len,
      pricing: { prompt: String(m.price_in), completion: String(m.price_out) },
      open_weights: !!m.open_weights,
    })),
  });
});

/* A model named the way its maker's own SDK names it ("gpt-4o", "claude-sonnet-5") is found in the
   catalogue under its maker ("openai/gpt-4o"), so pointing an existing client at Understudy needs only
   the address changed. Where several makers sell the same name, the one that made it comes first. */
const MAKERS = ['openai', 'anthropic', 'google', 'meta-llama', 'mistralai', 'deepseek', 'qwen', 'x-ai', 'cohere', 'amazon'];
const canonical = new Map();
/* A model is routed only when the catalogue knows it, because only then can what a call costs be bound
   before it is sent (see holdFor). A name with its maker is looked up as it is, a variant after a colon
   (":nitro", ":online") as the model it varies; a bare name as its maker names it. Before the catalogue
   has been read nothing can be priced, and the call waits for it rather than going out unbounded. */
export async function canonicalModel(name) {
  if (typeof name !== 'string' || !name.trim()) return { model: name, known: true };
  const bare = name.trim();
  const hit = canonical.get(bare);
  if (hit && Date.now() - hit.at < (hit.v.known ? 600000 : 60000)) return hit.v;
  const any = Number((await db.prepare('SELECT COUNT(*) AS n FROM models_catalog').get())?.n ?? 0) > 0;
  let v;
  if (/:free$/i.test(bare)) {
    // a free variant is never routed, whether or not its paid model is (see unknownModelWords)
    v = { model: bare, known: false, empty: false };
  } else if (bare.includes('/')) {
    const found = !!(await db.prepare('SELECT 1 FROM models_catalog WHERE model_id = ANY(?::text[])').get([bare, baseModelId(bare)]));
    v = { model: bare, known: found, empty: !any };
  } else {
    const rows = await db.prepare(`SELECT model_id FROM models_catalog WHERE model_id LIKE ?`).all(`%/${bare.replace(/[\\%_]/g, '\\$&')}`);
    if (rows.length) {
      const rank = (id) => { const i = MAKERS.indexOf(id.split('/')[0]); return i < 0 ? MAKERS.length : i; };
      v = { model: rows.map((r) => r.model_id).sort((a, b) => rank(a) - rank(b))[0], known: true };
    } else {
      v = { model: bare, known: false, empty: !any };
    }
  }
  canonical.set(bare, { at: Date.now(), v });
  if (canonical.size > 2000) canonical.clear();
  return v;
}

const unknownModelWords = (m) => (/^openrouter\/auto/i.test(String(m))
  ? 'openrouter/auto picks a different model for every call, so what a call can cost is not known before it is sent, '
    + 'and there is nothing to measure a cheaper model against. Name the model you want; every model is listed at GET /v1/models.'
  : /:free$/i.test(String(m))
    ? `"${String(m).slice(0, 80)}" is a free variant. Free variants are not routed: their providers may keep or learn from `
      + 'what they are sent, which Understudy never allows. Name the paid model; every model is listed at GET /v1/models.'
  : `"${String(m).slice(0, 80)}" is not a model we route to. Name it with its maker, `
    + 'for example openai/gpt-5.4; every model is listed at GET /v1/models.');

/* What a request asks for whose cost cannot be known before it is sent. A file given by its address can
   be any length; a plugin we do not know can charge anything. Those calls are refused with a way round,
   rather than sent unbounded on a balance that has to cover them. */
/* Plugins whose cost is known before a call is sent: web search (allowed for per call), the PDF reader
   (a PDF sent inline is counted by its pages), and the two that cost nothing. One switched off costs
   nothing either, whatever it is. */
const PLUGINS_WE_PRICE = new Set(['web', 'file-parser', 'response-healing', 'context-compression']);
function unpriceable(body) {
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    for (const p of Array.isArray(m?.content) ? m.content : []) {
      const given = p?.type === 'file' ? [p.file?.file_data, p.file?.url] : [];
      if (given.some((data) => typeof data === 'string' && data && !data.startsWith('data:'))) {
        return 'A file given by its address can be any length, so what the call would cost is not known before it is sent. '
          + 'Send the file\'s contents inline (as a data URL), or send us a copy of the call instead.';
      }
      const video = p?.type === 'video_url' ? (typeof p.video_url === 'string' ? p.video_url : p.video_url?.url) : null;
      if (typeof video === 'string' && !video.startsWith('data:')) {
        return 'A video given by its address can be any length, so what the call would cost is not known before it is sent. '
          + 'Send it inline, or send us a copy of the call instead.';
      }
    }
  }
  /* A tool the provider runs itself (web search, an adviser that asks another model, image making) is
     billed on top of the model and can run several times in one call, so its cost is not known before
     the call is sent. Tools the customer's own code runs are ordinary text, and priced as such. */
  for (const t of Array.isArray(body?.tools) ? body.tools : []) {
    if (t && t.type !== 'function') {
      return `The "${String(t.type).slice(0, 60)}" tool runs on the provider's side and can cost any amount in one call, `
        + 'so it is not routed. Offer it as a function your own code runs, or send us a copy of the call instead.';
    }
  }
  for (const p of Array.isArray(body?.plugins) ? body.plugins : []) {
    if (p?.enabled === false) continue;
    if (!PLUGINS_WE_PRICE.has(p?.id)) {
      return `The "${String(p?.id).slice(0, 40)}" plugin is not one we can price before a call is sent. `
        + 'Call without it, or send us a copy of the call instead.';
    }
  }
  return null;
}

/* Every model a strategy's chain can reach: what serves, what it falls back to, and on to the customer's
   own model, as routeOnce walks it (chainOf). */
const chainModels = (strategy) => {
  const out = new Set();
  for (let s = strategy, n = 0; s && n < 4; s = s.fallback, n += 1) {
    const spec = s.spec;
    if (!spec) continue;
    if (spec.kind === 'cascade') { out.add(spec.first?.model); out.add(spec.fallback?.model); }
    else if (spec.kind === 'router') {
      out.add(spec.cheap?.model);
      out.add(spec.strong?.model);
      // a router by kind of request can send a call to any of its setups
      for (const o of Array.isArray(spec.options) ? spec.options : []) out.add(o?.model);
    }
    else out.add(spec.model);
  }
  out.delete(undefined);
  out.delete(null);
  return [...out];
};
async function allCatalogued(models) {
  const ids = [...new Set(models.map(baseModelId))];
  if (!ids.length) return true;
  const n = Number((await db.prepare('SELECT COUNT(*) AS n FROM models_catalog WHERE model_id = ANY(?::text[])').get(ids))?.n ?? 0);
  return n === ids.length;
}

/* Everything a routed call needs before it is sent, or the reason it cannot be, so the
   streaming path, the ordinary path and Connect's test call all answer the same way. */
async function prepare(wsId, body, { classify = true, name = null, pinned = false } = {}) {
  const no = (status, message, type) => ({ error: { status, json: { error: { message, type } } } });
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return no(400, '"messages" is required.', 'invalid_request_error');
  }
  if (!canRoute()) return no(503, 'Routing is not configured on this deployment yet.', 'not_configured');
  if (body.model) {
    const named = await canonicalModel(body.model);
    if (!named.known) {
      if (named.empty) return no(503, 'The list of models we route to is being read. Try again shortly.', 'not_ready');
      return no(400, unknownModelWords(body.model), 'model_not_found');
    }
    body.model = named.model;
  }
  // models named to fall back to are each paid for when used, so each has to be one we can price
  if (body.models !== undefined) {
    if (!Array.isArray(body.models) || body.models.some((m) => typeof m !== 'string')) {
      return no(400, '"models" is a list of model ids.', 'invalid_request_error');
    }
    const named = [];
    for (const m of body.models) {
      const k = await canonicalModel(m);
      if (!k.known) {
        return no(k.empty ? 503 : 400, k.empty ? 'The list of models we route to is being read. Try again shortly.' : unknownModelWords(m),
          k.empty ? 'not_ready' : 'model_not_found');
      }
      named.push(k.model);
    }
    // sent under the name that was priced, so what answers is what was held for
    body.models = named;
  }
  const cannot = unpriceable(body);
  if (cannot) return no(400, cannot, 'unsupported_feature');
  await grantStarterCredit(wsId);
  const gate = await gateRouting(wsId);
  if (!gate.ok) return { error: { status: 402, json: { error: { message: gate.message, type: gate.code } } } };
  /* A test call is not the customer's traffic, so it is never fingerprinted into a
     workload: it would leave a one-call workload in their list that nothing produced. */
  const workload = classify ? await workloadFor(wsId, body, { name }) : null;
  const requested = body.model || workload?.reference_model || null;
  /* A call that names no model goes to the model its workload was made with, which can be one that is not
     routed (openrouter/auto, from copies sent to us): it is checked the same way a named one is. */
  if (!body.model && requested) {
    const k = await canonicalModel(requested);
    if (!k.known) {
      return no(k.empty ? 503 : 400, k.empty ? 'The list of models we route to is being read. Try again shortly.'
        : `This call names no model, and its workload's model is not one we route to. ${unknownModelWords(requested)}`,
        k.empty ? 'not_ready' : 'model_not_found');
    }
  }
  /* The strategy that serves this call: the one the workload was switched to (a model asked the
     way it was measured, or a cascade, or a pick made call by call), or, now and then and within
     the workload's limits, one being tried. None, and the call goes to the model it asked for. */
  // a pinned call is answered by the model it names: no switch, no experiment
  let strategy = workload && !pinned ? await chooseStrategy(workload, { body }) : null;
  /* A strategy whose chain reaches a model the catalogue no longer lists cannot be priced, so this call
     is answered by the model it asked for; watchCatalogue switches the workload back within the hour. */
  if (strategy && !(await allCatalogued(chainModels(strategy)))) strategy = null;
  const lead = strategy ? leadModel(strategy.spec) : null;
  const served = lead?.model || requested;
  if (!served) return no(400, '"model" is required.', 'invalid_request_error');
  const recipe = lead?.recipe ?? null;
  const zdr = await zdrFor(wsId);
  return { workload, requested, served, recipe, strategy, zdr };
}

/* Whether a long instruction may be marked for caching on a try sent to this model (see hintApplies
   and cacheHintFor): decided for the model each try goes to, never once for the whole call, so only
   a model that answers this workload often enough to read the cache back is marked. Marking only
   saves money, so a slip while deciding it leaves the call unmarked, never failed or sent elsewhere. */
const hintFor = async (ready, model) => (ready.workload
  ? await cacheHintFor(ready.workload.workspace_id, ready.workload, model).catch(() => false) : false);

/* Every model one call could end up paying for: the one it is served by, the customer's own model,
   and whatever a strategy may send it on to. */
function modelsOf(ready) {
  // with no strategy only the model asked for answers; with one, its whole chain and the customer's own model
  const out = new Set([ready.served, ready.requested].filter(Boolean));
  if (ready.strategy) {
    if (ready.workload?.reference_model) out.add(ready.workload.reference_model);
    for (const m of chainModels(ready.strategy)) out.add(m);
  }
  return [...out];
}

/* Set aside what this call could cost before it is sent: the most it can cost (see callBound) on the
   dearest of the requests it may send, twice that when a strategy can pay for two models on one call,
   and a quarter more for a cascade's check. A model the call can reach that cannot be priced refuses the
   call; nothing is held at a guess. The request itself is never changed but for the price ceiling it
   carries, which is what makes the hold a bound. */
async function holdFor(wsId, body, ready) {
  const shape = await callShape(body, { owner: wsId });
  if (shape.refuse) return { ok: false, refused: shape.refuse, busy: !!shape.busy };
  // the models the request itself names to fall back to: any of them may answer a request, and be paid for
  const fallbacks = Array.isArray(body.models) ? body.models.filter((m) => typeof m === 'string') : [];
  // each of these is sent a request of its own, carrying those fallbacks
  const senders = modelsOf(ready);
  const bounds = {};
  for (const m of new Set([...senders, ...fallbacks])) {
    const b = await callBound(m, shape, { zdr: ready.zdr });
    /* A model the call can reach that cannot be priced (the catalogue changed a moment ago) is not
       held at a guess: the call is refused, and the next one finds the catalogue as it is now. */
    if (!b) return { ok: false, unpriced: m };
    bounds[m] = b;
  }
  /* OpenRouter applies one ceiling to a request, whichever of its models answers: the one it is sent to,
     or a fallback it names. So each request's ceiling is the dearest of those models' own, and what the
     request can cost is read at that ceiling for each of them, with the tokens each can use: a cheap
     model with a long window, let through at a dearer fallback's prices, is counted at them. A strategy's
     requests are separate, so each keeps its own ceiling. */
  let worst = 0;
  const caps = {};
  for (const m of senders) {
    const group = [m, ...fallbacks];
    const ceiling = mergeCeilings(group.map((x) => bounds[x].ceiling));
    caps[m] = ceiling;
    for (const x of group) worst = Math.max(worst, boundAt(bounds[x].parts, ceiling));
  }
  const est = worst;
  /* A strategy can pay for two models on one call (a cheap answer, then the one it sends on to), and a
     cascade also pays for the check that reads the cheap answer: twice, and a quarter more for that. */
  const cascade = chainModels(ready.strategy || {}).length && [ready.strategy?.spec?.kind, ready.strategy?.fallback?.spec?.kind].includes('cascade');
  const twice = !!ready.strategy?.fallback || cascade;
  const h = await hold(wsId, withFee(est * (cascade ? 2.25 : twice ? 2 : 1)), 'call');
  return { ...h, capped: shape.cap !== null, caps };
}

/* Why a call that did not fit was refused, in words that say what to do. A workspace's own limit is
   said as that limit; otherwise the balance is empty, or what is free is set aside for calls in
   flight, and a call with no cap on its answer sets aside the most its longest answer could cost. */
const cannotCover = (h) => {
  // a PDF counter that is busy is a moment's wait, said as one; a file that cannot be counted is refused
  if (h.refused && h.busy) return { status: 503, json: { error: { message: h.refused, type: 'not_ready' } } };
  if (h.refused) return { status: 400, json: { error: { message: h.refused, type: 'unsupported_feature' } } };
  if (h.unpriced) {
    return { status: 503, json: { error: {
      message: `${String(h.unpriced).slice(0, 80)} cannot be priced just now, so the call was not sent. Try again shortly.`,
      type: 'not_ready' } } };
  }
  if (h.code === 'daily_limit' || h.code === 'monthly_limit') {
    return { status: 402, json: { error: { message: h.message, type: h.code } } };
  }
  const asks = h.want > 0 ? ` This call sets aside up to $${Number(h.want).toFixed(2)}` : '';
  const why = h.capped ? '.' : ', because a call without max_tokens sets aside what its longest possible answer could cost; setting max_tokens sets aside less.';
  return {
    status: 402,
    json: { error: {
      message: h.inFlight > 0
        ? `Your balance is set aside for calls still in flight and cannot cover this one.${asks ? `${asks}${why}` : ''} Add credit, or send fewer calls at once.`
        : 'Your balance is empty. Add credit in Settings and calls resume immediately.',
      type: 'no_balance',
    } },
  };
};

/* What a call says about how it was decided, kept on its row: the strategy, the chance it had of
   being chosen, whether it was an experiment, and for a cascade whether it was sent on and why. */
const decisionOf = (strategy, out = null) => (strategy ? {
  armId: strategy.armId, propensity: strategy.propensity, explored: strategy.explored,
  escalated: out ? !!out.escalated : null, check: out?.check ?? null,
} : null);

/* One routed call, from the gate to the ledger. The proxy uses this for every ordinary
   call, and so does Connect's "Send a test call", which is the point: what the test
   proves is what a real call does, because it is the same path, the same gate, the same
   charge and the same row. */
/* A call we refused is still a call that arrived, and it is the only evidence the customer
   has that their wiring works. Refusing it silently was the worst of both: their integration
   was correct, nothing appeared anywhere, and the getting started guide sat waiting for a
   call that could never come. Recorded at most once a minute per workspace, so a client
   retrying in a loop leaves one line rather than ten thousand. */
const lastRefusal = new Map();
async function recordRefusal(wsId, body, status, json) {
  const last = lastRefusal.get(wsId) || 0;
  if (Date.now() - last < 60000) return;
  lastRefusal.set(wsId, Date.now());
  await recordCall({
    workspaceId: wsId, workloadId: null, source: 'routed',
    requestedModel: body?.model ?? null, servedModel: null,
    statusCode: status, latencyMs: 0, request: body,
    response: json ?? null,
  }).catch(() => { /* never let bookkeeping break the answer */ });
}

/* What a strategy serves a call with, before anything reaches the customer. */
const leadOf = (strategy, ready) => {
  if (!strategy) return { served: ready.served, recipe: ready.recipe };
  const lead = leadModel(strategy.spec);
  return { served: lead.model, recipe: lead.recipe ?? null };
};
const failureOf = (err) => ({
  status: err instanceof UpstreamError ? err.status : 502,
  json: err instanceof UpstreamError ? err.body : { error: { message: 'The provider could not be reached.' } },
});

/* An experiment's call that the provider failed, kept as its own row so what learning reads about
   that strategy includes the failure, before the call is served the usual way instead. */
async function keepFailedTry({ wsId, workload, requested, served, started, body, ref, source, strategy, err, fellBack = false }) {
  const f = failureOf(err);
  await recordCall({
    workspaceId: wsId, workloadId: workload?.id ?? null, source, requestedModel: requested, servedModel: served,
    statusCode: f.status, latencyMs: Date.now() - started, request: body, ref, costUsd: Number(err?.spent) || 0,
    ...(decisionOf(strategy) || {}),
    // "fell back" is what the watch and the learning review count against what serves
    /* "counts" when the failure is one the customer's own model would likely not have had (busy, down,
       too slow, too long for this model): an experiment failing that way is held to it, as what serves
       is, rather than let off as a failed experiment. */
    check: { by: fellBack ? 'fell back' : 'experiment failed', status: f.status, why: reasonOf(err).slice(0, 160),
      counts: worthFallback(err) },
  }).catch(() => { /* never let bookkeeping stand in the way of the answer */ });
}

/* The strategies one call may be served by, in order: an experiment, then what serves, then the
   customer's own model. */
const chainOf = (strategy) => {
  const out = [];
  for (let s = strategy, n = 0; s && n < 4; s = s.fallback, n += 1) out.push(s);
  return out;
};

/* Whether the customer's own model would likely answer where what serves failed: the provider was
   down, busy or slow, the model has gone, or the call is longer or asks for more than this model
   takes. A request that is simply malformed would fail on their model too, and is answered as it is. */
export function worthFallback(err) {
  const st = err instanceof UpstreamError ? err.status : 502;
  if (st === 0 || st === 404 || st === 408 || st === 429 || st >= 500) return true;
  if (st === 400 || st === 413 || st === 422) {
    return /context|too long|too many tokens|maximum|max_tokens|token limit|length|not supported|unsupported|does not support|no endpoints|not available/i
      .test(reasonOf(err));
  }
  return false;
}

/* How long a live call waits on a busy provider. A measurement can wait out a rate limit; somebody
   whose app is waiting on this call cannot, so a live call gets one short retry and then the next
   strategy in its chain.

   Every way of serving a call gets the same, the ones an experiment tries included. Learning compares
   them on how often their calls fail, and a rate limit or a timeout counts as a failure, so an
   experiment given no retry and a shorter time limit failed more often than what it was compared with
   for no reason of its own: at one busy reply in twenty the customer's own model, as the yardstick,
   failed about one call in twenty against one in four hundred for what serves, so a strategy several
   points worse was never switched back, and on a workload whose answers take longer than the old limit
   the yardstick failed every call. A cascade or a router is held to the same through serveWith. */
const liveOpts = () => ({ retries: config.LIVE_RETRIES, maxWaitMs: config.LIVE_RETRY_WAIT_MAX_MS });

/* The bookkeeping after an answer, apart from the provider's part: a slip in it is logged, and never
   turns an answer the customer has already been sent, and paid for, into an error. */
async function settle(args) {
  try {
    return await finish(args);
  } catch (err) {
    /* The answer was sent and could not be charged. Its hold is given back rather than left to freeze the
       balance for the hold's whole lifetime, and we are told: an uncharged call is a failure of ours. */
    console.error(`bookkeeping for ${args.callId} failed: ${err?.message || err}`);
    reportCallFailure({ kind: 'charging a call', model: args.served, status: 0, message: err?.message || String(err), workspaceId: args.wsId });
    await release(args.holdId).catch(() => {});
    return null;
  }
}

export async function routeOnce(wsId, body, { source = 'routed', classify = true, ref = null, name = null, pinned = false } = {}) {
  const ready = await prepare(wsId, body, { classify, name, pinned });
  if (ready.error) {
    if (source === 'routed') await recordRefusal(wsId, body, ready.error.status, ready.error.json);
    return { ok: false, status: ready.error.status, json: ready.error.json };
  }
  const h = await holdFor(wsId, body, ready);
  if (!h.ok) {
    const f = cannotCover(h);
    if (source === 'routed') await recordRefusal(wsId, body, f.status, f.json);
    return { ok: false, status: f.status, json: f.json };
  }
  const { workload, requested } = ready;
  // made up front, so the answer can carry it and the customer can report how this call went
  const callId = id('call');
  const started = Date.now();
  // the strategy for this call, then what serves as usual, then the customer's own model
  const tries = chainOf(ready.strategy);
  if (!tries.length) tries.push(null);
  for (const [k, strategy] of tries.entries()) {
    const next = tries[k + 1];
    const { served, recipe } = leadOf(strategy, ready);
    let out;
    // whether this try's instruction is marked for caching, kept so the saving is counted on the call it was marked on
    let hint = false;
    try {
      if (strategy && strategy.spec.kind !== 'model') {
        out = await serveWith(strategy.spec, body, { shape: workload.shape_kind, scope: wsId, zdr: ready.zdr, call: { ...liveOpts(), priceCaps: h.caps } });
      } else {
        hint = await hintFor(ready, served);
        const r = await chat(body, served, { recipe, zdr: ready.zdr, cacheHint: hint, ...liveOpts(), priceCaps: h.caps });
        // a cost the answer did not state stays unstated here, so the charge estimates it (see finish)
        out = { json: r.json, served, cost: hasCost(r.json?.usage) ? Number(r.json.usage.cost) : null, latencyMs: r.latencyMs ?? Date.now() - started };
      }
    } catch (err) {
      if (next && (!next.isFallback || worthFallback(err))) {
        // a router says which of its models it sent the call to, and that one is what failed
        await keepFailedTry({ wsId, workload, requested, served: err?.model || served, started, body, ref, source, strategy, err, fellBack: !!next.isFallback });
        continue;
      }
      const f = failureOf(err);
      reportCallFailure({
        kind: source === 'test' ? 'test call' : 'routed call',
        model: err?.model || served, status: f.status, workspaceId: wsId,
        message: f.json?.error?.message || err.message,
      });
      await recordCall({
        id: callId, workspaceId: wsId, workloadId: workload?.id ?? null, source, requestedModel: requested,
        servedModel: served, statusCode: f.status, latencyMs: Date.now() - started, request: body, ref,
        // what a strategy had already spent on it before it failed, kept, though nobody is charged for it
        costUsd: Number(err?.spent) || 0, ...(decisionOf(strategy) || {}),
      }).catch(() => {});
      await release(h.holdId).catch(() => {});
      return { ok: false, status: f.status, json: f.json, served, requested, callId };
    }
    // charged for everything the strategy spent on it: a cascade's check, and a call it sent on
    const done = await settle({ wsId, workload, requested, served: out.served, usage: { ...(out.json?.usage || {}), cost: out.cost },
      started, body, response: out.json, status: 200, latencyMs: out.latencyMs, source, callId, ref,
      decision: decisionOf(strategy, strategy && strategy.spec.kind !== 'model' ? out : null), holdId: h.holdId,
      cacheHint: hint, partsEstimated: !!out.costEstimated });
    return { ok: true, status: 200, json: out.json, served: out.served, requested, callId,
      latencyMs: out.latencyMs, costUsd: done?.cost ?? out.cost ?? 0, workload: workload?.slug ?? null };
  }
  await release(h.holdId).catch(() => {});
  return { ok: false, status: 502, json: { error: { message: 'The provider could not be reached.' } }, callId };
}

/* The routed path. The customer's client is unchanged except for the base URL, and
   the model they name is the model we measure against, not necessarily the one we send. */
v1.post('/chat/completions', async (req, res) => {
  const wsId = req.key.workspace_id;
  const body = req.body || {};
  const ref = refOf(req.headers, body);
  // the workload the customer says this call is, if they name their jobs
  const name = workloadNameOf(req.headers, body);
  // and whether it must be answered by the model it names
  const pinned = pinnedOf(req.headers, body);
  if (!body.stream) {
    const out = await routeOnce(wsId, body, { ref, name, pinned });
    if (out.callId) res.setHeader('x-understudy-call-id', out.callId);
    // which model answered, and which workload the call joined, for the customer's own logs
    if (out.served) res.setHeader('x-understudy-served-model', out.served);
    if (out.workload) res.setHeader('x-understudy-workload', out.workload);
    return res.status(out.status).json(out.json);
  }
  const ready = await prepare(wsId, body, { name, pinned });
  if (ready.error) {
    await recordRefusal(wsId, body, ready.error.status, ready.error.json);
    return res.status(ready.error.status).json(ready.error.json);
  }
  const h = await holdFor(wsId, body, ready);
  if (!h.ok) {
    const f = cannotCover(h);
    await recordRefusal(wsId, body, f.status, f.json);
    return res.status(f.status).json(f.json);
  }
  const { workload, requested } = ready;
  const callId = id('call');
  const started = Date.now();
  const tries = chainOf(ready.strategy);
  if (!tries.length) tries.push(null);
  for (const [k, strategy] of tries.entries()) {
    const next = tries[k + 1];
    const r = await streamWith({ res, wsId, workload, requested, body, ref, callId, started, strategy, ready, holdId: h.holdId, priceCaps: h.caps });
    // an answer that failed part way was charged for what it wrote, which took its hold; this is only a safety
    if (r.sent) await release(h.holdId).catch(() => {});
    if (r.ok || r.sent) return undefined;
    // nothing has reached the customer yet: a failure is kept, and the call served the next way
    if (next && (!next.isFallback || worthFallback(r.err))) {
      await keepFailedTry({ wsId, workload, requested, served: r.served, started, body, ref, source: 'routed', strategy, err: r.err, fellBack: !!next.isFallback });
      continue;
    }
    const f = failureOf(r.err);
    reportCallFailure({ kind: 'streamed call', model: r.served, status: f.status, workspaceId: wsId,
      message: f.json?.error?.message || r.err?.message });
    await recordCall({
      id: callId, workspaceId: wsId, workloadId: workload.id, source: 'routed', requestedModel: requested,
      servedModel: r.served, statusCode: f.status, latencyMs: Date.now() - started, request: body, ref,
      costUsd: Number(r.err?.spent) || 0, ...(decisionOf(strategy) || {}),
    }).catch(() => {});
    await release(h.holdId).catch(() => {});
    return res.status(f.status).json(f.json);
  }
  await release(h.holdId).catch(() => {});
  return undefined;
});

/* One streamed call on one strategy. Answers { ok } once the whole answer has gone out; { sent } when
   the provider failed part way, after the answer had started, which is ended as it stands; or the
   failure, with nothing sent yet, so the caller can try again or say so. */
async function streamWith({ res, wsId, workload, requested, body, ref, callId, started, strategy, ready, holdId = null, priceCaps = null }) {
  let { served, recipe } = leadOf(strategy, ready);
  let decision = decisionOf(strategy);
  if (strategy && strategy.spec.kind === 'cascade') {
    /* A cascade cannot stream its first answer before the check has read it, so the answer is
       worked out whole and then sent as a stream. The first word arrives when the whole answer
       would have; a measurement holds a cascade to the workload's speed setting on exactly that. */
    let out;
    try {
      out = await serveWith(strategy.spec, body, { shape: workload.shape_kind, scope: wsId, zdr: ready.zdr, call: { ...liveOpts(), priceCaps } });
    } catch (err) {
      return { ok: false, err, served };
    }
    res.status(200);
    res.setHeader('x-understudy-call-id', callId);
    res.setHeader('x-understudy-served-model', out.served);
    if (workload?.slug) res.setHeader('x-understudy-workload', workload.slug);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    writeAsStream(res, out.json);
    res.end();
    await settle({ wsId, workload, requested, served: out.served, usage: { ...(out.json?.usage || {}), cost: out.cost },
      started, body, response: out.json, status: 200, latencyMs: out.latencyMs, ttftMs: out.latencyMs, callId, ref,
      decision: decisionOf(strategy, out), holdId, partsEstimated: !!out.costEstimated });
    return { ok: true };
  }
  if (strategy && strategy.spec.kind === 'router') {
    // picked before anything is sent, from what can be seen of the call, so it streams as ever
    const pick = routeFor(strategy.spec, body, { fallback: { model: workload.reference_model } });
    // a router that names nothing to answer sends the call to the customer's own model, never to an error
    served = pick.use?.model ?? workload.reference_model;
    recipe = pick.use ? pick.use.recipe ?? null : null;
    decision = { ...decision, escalated: pick.escalated, check: pick.check };
  }
  let upstream;
  // marked for caching only where this model answers the workload often enough (see hintFor)
  const hint = await hintFor(ready, served);
  try {
    upstream = await chatStream(body, served, { recipe, zdr: ready.zdr, cacheHint: hint, priceCaps });
  } catch (err) {
    return { ok: false, err, served };
  }
  res.status(200);
  res.setHeader('x-understudy-call-id', callId);
  res.setHeader('x-understudy-served-model', served);
  if (workload?.slug) res.setHeader('x-understudy-workload', workload.slug);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  let usage = null;
  /* The answer, put back together from the pieces it streamed in. It used to be thrown
     away, so a streamed call could be counted and charged but never read: the workload
     page could show what was asked and nothing of what came back. */
  let answer = '';
  const toolCalls = [];
  let finish_reason = null;
  let model = null;
  // the provider's id for this answer, under which OpenRouter keeps what it cost
  let genId = null;
  // when the first word reached the customer: what somebody watching a streamed answer waits for
  let firstAt = null;
  const read = (line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') return;
    try {
      const j = JSON.parse(payload);
      // the last chunk carries usage, which is what the customer is charged on
      if (j.usage) usage = j.usage;
      if (j.model) model = j.model;
      if (typeof j.id === 'string' && !genId) genId = j.id;
      const ch = j.choices?.[0];
      if (typeof ch?.delta?.content === 'string') answer += ch.delta.content;
      if (Array.isArray(ch?.delta?.tool_calls)) {
        for (const tc of ch.delta.tool_calls) {
          const at = Number.isInteger(tc.index) ? tc.index : toolCalls.length;
          const c = toolCalls[at] || (toolCalls[at] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.function.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') c.function.arguments += tc.function.arguments;
        }
      }
      if (firstAt === null && ((typeof ch?.delta?.content === 'string' && ch.delta.content)
        || (Array.isArray(ch?.delta?.tool_calls) && ch.delta.tool_calls.length))) firstAt = Date.now();
      if (ch?.finish_reason) finish_reason = ch.finish_reason;
    } catch { /* not a JSON line, which SSE comments and keep-alives are allowed to be */ }
  };
  try {
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = dec.decode(value, { stream: true });
      buf += text;
      /* Only lines that have ENDED are read. The last piece of a chunk may be half a line,
         and a half line that happens to be valid JSON on its own would otherwise be read
         now and again when it completes, doubling that part of the answer. */
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) read(line);
      res.write(text);
    }
    if (buf) read(buf);
    res.end();
  } catch (err) {
    // the answer had started, so it cannot be tried again: it is ended where it stands
    reportCallFailure({ kind: 'streamed call', model: served, status: 502, workspaceId: wsId, message: err?.message });
    /* What the provider wrote before it broke off was paid for, and used to be charged nothing: a
       customer could stream long answers and cut them off for free. It is charged from what was
       written, at list price, and corrected from OpenRouter's record of the call. */
    const partial = { id: genId, choices: [{ message: { content: answer, ...(toolCalls.length ? { tool_calls: toolCalls.filter(Boolean) } : {}) } }] };
    let cost = 0;
    let charged = 0;
    try {
      cost = hasCost(usage) ? Number(usage.cost)
        : await estimateCost(served, usage?.prompt_tokens ?? promptTokensOf(body), usage?.completion_tokens ?? writtenTokens(partial));
      charged = await chargeCall(wsId, cost, `${workload?.slug ?? 'a call'} on ${served}, broken off`, { holdId });
    } catch (e) {
      console.error(`charging a broken stream ${callId} failed: ${e?.message || e}`);
    }
    await recordCall({
      id: callId, workspaceId: wsId, workloadId: workload.id, source: 'routed', requestedModel: requested,
      servedModel: served, statusCode: 502, latencyMs: Date.now() - started, request: body, ref, ...(decision || {}),
      costUsd: cost, chargedUsd: charged, costEstimated: !hasCost(usage), generationId: genId,
    }).catch(() => {});
    if (!hasCost(usage) && genId) await enqueue('true_up', { callId }, { runAfter: now() + 60000 }).catch(() => {});
    res.end();
    return { ok: false, sent: true };
  }
  const calls = toolCalls.filter(Boolean);
  const response = {
    id: genId, model, streamed: true, usage,
    choices: [{ index: 0, message: { role: 'assistant', content: answer, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason }],
  };
  await settle({ wsId, workload, requested, served, usage, started, body, response, status: 200,
    ttftMs: firstAt === null ? null : firstAt - started, callId, ref, decision, holdId, cacheHint: hint });
  return { ok: true };
}

async function finish({ wsId, workload, requested, served, usage, started, body, response, status,
  latencyMs, ttftMs = null, source = 'routed', callId = null, ref = null, decision = null, holdId = null, cacheHint = false,
  partsEstimated = false }) {
  /* What the provider said it cost. An answer that did not say used to be charged nothing; it is
     charged from its tokens now and corrected once OpenRouter's own record of it can be read. A
     strategy's cost is summed from its parts (a cheap answer, the check, the answer it sent on), and a
     part whose answer said nothing is estimated where it was made (see src/learn/cost.js): that call is
     marked an estimate that stands, because its several generations cannot be read back as one. */
  const estimated = !hasCost(usage);
  const cost = estimated
    ? await estimateCost(served, usage?.prompt_tokens ?? promptTokensOf(body), usage?.completion_tokens ?? writtenTokens(response))
    : Number(usage.cost);
  const note = workload ? `${workload.slug} on ${served}` : `Test call on ${served}`;
  // charged, and what the call set aside given back, in one step
  const charged = await chargeCall(wsId, cost, note, { holdId });
  await recordCall({
    id: callId, workspaceId: wsId, workloadId: workload?.id ?? null, source, requestedModel: requested,
    servedModel: served, statusCode: status,
    promptTokens: usage?.prompt_tokens ?? 0, completionTokens: usage?.completion_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    // whether we marked its instruction for caching, so what that saved is counted as ours
    hinted: !!(cacheHint && hintApplies(body, served)),
    costUsd: cost, chargedUsd: charged, latencyMs: latencyMs ?? Date.now() - started, ttftMs,
    request: body, response, ref, ...(decision || {}),
    costEstimated: estimated ? true : partsEstimated ? 2 : false, generationId: response?.id ?? null,
  });
  if (estimated && response?.id) await enqueue('true_up', { callId }, { runAfter: now() + 60000 }).catch(() => {});
  if (workload) await considerMeasuring(wsId, workload);
  // a customer's answered call, which the learning layer may answer again in the background
  if (workload && source === 'routed' && status === 200) noteServed({ workload, body, response, callId, decision, costUsd: cost });
  return { cost, charged, estimated };
}

/* A workload waiting for calls (see waitForCalls in src/eval/schedule.js) is measured by the call that brings its
   count to what it needs, as soon as that call is recorded: counted exactly as the measurement counts them
   (usableCalls), so the call that starts it is one the measurement can use. Counted no more often than every
   MEASURE_READY_CHECK_MS for one workload on one server, so a busy one's calls do not each count its calls again,
   and a call inside that wait has them counted again the moment it is up: the last call of a burst still starts
   it when no call comes after. Answers whether it was started. */
const readyLooked = new Map();
// the workloads this server will count again when their wait is up, one timer each however many calls came
const readyAgain = new Set();
export async function measureWhenReady(wsId, workload) {
  const need = Number(workload?.measure_at_calls);
  if (!(need > 0) || workload.merged_into) return false;
  const wait = config.MEASURE_READY_CHECK_MS - (Date.now() - (readyLooked.get(workload.id) || 0));
  if (wait > 0) {
    if (!readyAgain.has(workload.id)) {
      readyAgain.add(workload.id);
      setTimeout(() => {
        readyAgain.delete(workload.id);
        // read again, since what it waits for may have changed in the meantime
        db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id)
          .then((fresh) => (fresh ? measureWhenReady(wsId, fresh) : false))
          .catch((err) => console.error(`counting the calls of ${workload.id} again failed: ${err?.message || err}`));
      }, wait).unref();
    }
    return false;
  }
  readyLooked.set(workload.id, Date.now());
  if (readyLooked.size > 10000) readyLooked.clear();
  return startIfReady(workload);
}

/* One waiting for calls, started if its calls are here. Never in a workspace that measures only when asked,
   whatever it waited for, and once however many calls, and servers, reach it together: the one that clears the
   count in one statement queues it. */
async function startIfReady(workload) {
  const need = Number(workload.measure_at_calls);
  if (!(need > 0) || workload.merged_into) return false;
  if (!(await cadenceOf(workload.workspace_id))) return false;
  if ((await usableCalls(workload)) < need) return false;
  const claimed = await db.prepare(
    `UPDATE workloads SET measure_at_calls = NULL, recheck_after = ? WHERE id = ? AND measure_at_calls IS NOT NULL RETURNING id`)
    .run(now() + 3600000, workload.id);
  if (!claimed.rows?.length) return false;
  await enqueue('eval_run', { workloadId: workload.id, trigger: workload.status === 'new' ? 'first' : 'automatic' }, { unique: true });
  return true;
}

/* Every workload waiting for calls whose calls are here, started: the ones whose last call came as a server stopped,
   before it could count them again. When a server starts, and on the hourly pass. Answers how many it started. */
export async function startWaiting() {
  let started = 0;
  for (const w of await db.prepare(
    'SELECT * FROM workloads WHERE measure_at_calls IS NOT NULL AND merged_into IS NULL').all()) {
    try {
      if (await startIfReady(w)) started += 1;
    } catch (err) {
      console.error(`starting ${w.id}, waiting for calls, failed: ${err?.message || err}`);
    }
  }
  return started;
}

/* Workloads the rule before measureWhenReady left waiting: turned down for want of calls and booked for when the
   calls were guessed to arrive. Each is given the count it waits for, and one that has it already is measured now.
   Only workloads never measured, because the booking of one that was is its workspace's rhythm and never a wait for
   calls; only live ones, in a workspace that measures by itself; never one being measured, waiting in the queue, or
   stopped by a person. Then those whose last measurement was too small to switch anything wait for the calls one
   that can needs (waitAfterSmall), and every one already waiting whose calls are here is started (startWaiting). Run when the
   server starts; running it again changes nothing. */
export async function convertWaits({ plan = planFor } = {}) {
  const rows = await db.prepare(
    `SELECT w.* FROM workloads w
      WHERE w.state = 'live' AND w.merged_into IS NULL AND w.status = 'new' AND w.measure_at_calls IS NULL
        AND w.recheck_after IS NOT NULL AND w.recheck_after > ?
        AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.workload_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'eval_run' AND j.status IN ('queued', 'claimed')
                          AND j.payload LIKE '%' || w.id || '%')`).all(now());
  let started = 0;
  let waiting = 0;
  for (const w of rows) {
    if (!(await cadenceOf(w.workspace_id))) continue;
    let p;
    try {
      p = await plan(w, { canRoute: canRoute(), automatic: true, forRun: false });
    } catch (err) {
      console.error(`looking again at ${w.id}, left waiting for calls, failed: ${err?.message || err}`);
      continue;
    }
    if (p.canRun) {
      // claimed in one statement, so two servers starting together measure it once
      const claimed = await db.prepare(
        `UPDATE workloads SET recheck_after = ? WHERE id = ? AND status = 'new' AND measure_at_calls IS NULL AND recheck_after = ?
          RETURNING id`).run(now() + 3600000, w.id, w.recheck_after);
      if (!claimed.rows?.length) continue;
      await enqueue('eval_run', { workloadId: w.id, trigger: 'first' }, { unique: true });
      started += 1;
    } else if (p.needCalls) {
      await db.prepare('UPDATE workloads SET measure_at_calls = ? WHERE id = ? AND measure_at_calls IS NULL').run(p.needCalls, w.id);
      waiting += 1;
    }
  }
  waiting += await waitAfterSmall();
  started += await startWaiting();
  return { looked: rows.length, started, waiting };
}

/* Workloads whose last measurement was on too few calls for its own bar, measured before such a measurement went
   back to waiting for the calls (see the end of runEvaluation), and booked a rhythm out instead: each is given
   the count a measurement that can switch needs. Only live ones in a workspace that measures by itself, none
   being measured or waiting in the queue, and none whose bar no sample could clear. Answers how many. */
export async function waitAfterSmall() {
  let waiting = 0;
  const rows = await db.prepare(
    `SELECT w.* FROM workloads w
      WHERE w.state = 'live' AND w.merged_into IS NULL AND w.measure_at_calls IS NULL AND w.floor_pct > 0
        AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.workload_id = w.id AND r.status = 'running')
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'eval_run' AND j.status IN ('queued', 'claimed')
                          AND (j.payload::jsonb ->> 'workloadId') = w.id)`).all();
  for (const w of rows) {
    const last = await db.prepare(
      `SELECT sample_size, ${OUTCOME_OF()} AS outcome FROM eval_runs WHERE workload_id = ? AND status = 'done'
        ORDER BY created_at DESC LIMIT 1`).get(w.id);
    if (!last || last.outcome !== 'compared') continue;
    const need = callsToClear(Number(w.floor_pct));
    if (!(Number(last.sample_size) < need) || need > config.EVAL_SAMPLE_MAX) continue;
    if (!(await cadenceOf(w.workspace_id))) continue;
    const set = await db.prepare('UPDATE workloads SET measure_at_calls = ? WHERE id = ? AND measure_at_calls IS NULL')
      .run(barNeed(w).calls, w.id);
    if (set.changes) waiting += 1;
  }
  return waiting;
}

/** Once a workload has enough calls to be trusted, it measures itself without being asked. */
export async function considerMeasuring(wsId, workload) {
  // one waiting for calls starts the moment it has them
  if (await measureWhenReady(wsId, workload)) return;
  if (workload.status !== 'new') return;
  /* A workspace that measures only when asked is never measured by itself, and that includes a new
     workload's first measurement: "only when I ask" is the promise that nothing is spent unasked. */
  if (!(await cadenceOf(wsId))) return;
  /* A workload somebody stopped measuring is "new" again, but a person has answered it, and the
     very next call must not start it again behind their back: the schedule on Settings takes it
     from there. Only a stop counts. A run a restart interrupted, or one the balance cut short,
     was answered by nobody, and waiting a whole cadence for it would leave a new workload
     unmeasured for a month. */
  if (await db.prepare(`SELECT 1 FROM eval_runs WHERE workload_id = ? AND status = 'stopped' LIMIT 1`)
    .get(workload.id)) return;
  if (workload.recheck_after && Number(workload.recheck_after) > now()) return;
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM calls WHERE workload_id = ?').get(workload.id)).n;
  if (n < config.EVAL_FIRST_RUN_MIN_CALLS) return;
  /* Booked, not announced: the measurement decides whether it can show anything yet, and says so when
     it starts. The booking is claimed in one statement, so the calls that follow do not book it again
     while it decides, and one it turns down is looked at again when it is due, not on every call. */
  const claimed = (await db.prepare(
    `UPDATE workloads SET recheck_after = ? WHERE id = ? AND status = 'new'
        AND (recheck_after IS NULL OR recheck_after <= ?)`).run(now() + 3600000, workload.id, now())).changes;
  if (!claimed) return;
  await enqueue('eval_run', { workloadId: workload.id, trigger: 'first' }, { unique: true });
}

/* The observe path. Their provider answered; we get a copy afterwards. */
v1.post('/traces', async (req, res) => {
  const wsId = req.key.workspace_id;
  const body = req.body || {};
  const list = Array.isArray(body.traces) ? body.traces : [body];
  if (list.length > 200) {
    return res.status(400).json({ error: { message: 'Send at most 200 traces at a time.', type: 'too_many' } });
  }
  await grantStarterCredit(wsId);
  let accepted = 0;
  for (const t of list) {
    const request = t?.request;
    if (!request || !Array.isArray(request.messages)) continue;
    // a copy names its model however the customer's SDK did; it is priced and grouped under the catalogue's name
    if (request.model) request.model = (await canonicalModel(request.model)).model;
    if (t?.response?.model && !String(t.response.model).includes('/')) {
      const named = await canonicalModel(t.response.model);
      if (named.model.includes('/')) t.response.model = named.model;
    }
    const named = typeof t?.workload === 'string' && t.workload.trim() ? t.workload.trim().slice(0, 80) : workloadNameOf(req.headers, request);
    const workload = await workloadFor(wsId, request, { name: named });
    const usage = t?.response?.usage || {};
    const served = t?.response?.model || request.model || null;
    // we do not bill a traced call, but we do price it, because it is what their traffic costs today
    const own = served ? await priceCall(served, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0) : null;
    await recordCall({
      workspaceId: wsId, workloadId: workload.id, source: 'trace',
      requestedModel: request.model || null, servedModel: served,
      statusCode: 200,
      promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
      /* Priced, not charged. A copy is a call the customer already paid their own provider
         for; we take nothing for it. Recording it as charged put their provider's bill into
         "what you paid us", so a customer who only sends copies appeared to be paying us and
         the two lines on the spend chart were the same line drawn twice. */
      costUsd: own ?? 0, chargedUsd: 0,
      latencyMs: Number.isFinite(t?.latency_ms) ? t.latency_ms : null,
      request, response: t?.response ?? null,
      ref: t?.ref !== undefined && t?.ref !== null && t?.ref !== '' ? String(t.ref).slice(0, 200) : refOf(req.headers, request),
    });
    await considerMeasuring(wsId, workload);
    accepted += 1;
  }
  res.json({ accepted, rejected: list.length - accepted });
});

/* How calls turned out, told to us afterwards: a ticket resolved, an email answered, a form a
   person had to correct. Named by the call id each answer carries in x-understudy-call-id, or by
   the customer's own reference sent with the call (x-understudy-ref, or metadata.ref). One or
   many at once. */
v1.post('/outcomes', async (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body.outcomes) ? body.outcomes : Array.isArray(body) ? body : [body];
  if (!list.length) return res.status(400).json({ error: { message: 'Send an outcome, or a list of them under "outcomes".', type: 'invalid_request_error' } });
  if (list.length > 500) return res.status(400).json({ error: { message: 'Send at most 500 outcomes at a time.', type: 'too_many' } });
  const out = await report(req.key.workspace_id, list);
  return res.json(out);
});

export default v1;
