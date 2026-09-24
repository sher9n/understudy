/* Routing call by call, by the kind of request. Pure: every number can be checked by hand.
 *
 * One workload is one job, but a job is rarely one kind of request. An order-status workload gets
 * "where is my order" and "I want to return this and I was charged twice"; a cheap model can be
 * right on every one of the first and wrong on half of the second. Switched as a whole, the job
 * either keeps the customer's own model for everything, or takes the cheap one's mistakes too.
 *
 * So the workload's measured calls are grouped by how their requests read: the words and the
 * pieces of words of the last thing asked, with every figure made the same (order 2061 and order
 * 2062 are the same kind of request), and a few plain facts about the call's shape. Kinds are only
 * kept when the requests really fall apart into them (a silhouette of at least
 * ROUTER_KINDS_MIN_SILHOUETTE, and every kind at least ROUTER_KIND_MIN_CALLS calls). A setup may only
 * take a kind whose answers it gets inside the pass mark, read with a pull towards how that setup does
 * overall (a kind of eight calls says little on its own), and of every way of giving the kinds to the
 * setups allowed them, or to the customer's own model, the router is the one with the biggest saving
 * we can be sure of (see learnRouter). A request unlike any the kinds were learned from goes to the
 * customer's own model: nothing is learned from nothing. And the kinds have to matter: a router whose
 * kinds do no better than sending calls at random is not kept (see crossFitRouter).
 *
 * What is kept to route with is a handful of averages (the kinds' centres and how common each
 * feature is), never a request: a centre is the average of at least ROUTER_KIND_MIN_CALLS of them,
 * and a feature is a hashed piece of a word. */

import { wilson } from '../eval/compare.js';
import { logGamma } from '../eval/confidence.js';

export const DIMS = 256;
export const ROUTER_VERSION = 2;

/* FNV-1a, for hashing a feature to its place, and its sign from another bit of the same hash so
   two features that share a place tend to cancel rather than add up. */
function fnv(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const partText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => {
    if (typeof p?.text === 'string') return p.text;
    if (p?.type === 'image_url' || p?.type === 'input_image' || p?.type === 'image') return ' zzimagezz ';
    if (p?.type === 'file' || p?.type === 'input_file') return ' zzfilezz ';
    return '';
  }).join(' ');
};

/** The words a request is known by: the last thing the user asked, with every figure made the same. */
export function askedText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  let last = '';
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i]?.role === 'user') { last = partText(msgs[i].content); break; }
  }
  // every run of digits is one figure, whatever its length: order 5 and order 12345 are the same kind of request
  return String(last).slice(0, 4000).toLowerCase().replace(/[0-9]+/g, '0').replace(/\s+/g, ' ').trim();
}

/* A few plain facts about a call's shape, as words of their own: how long its last question is, how
   far into a conversation it is, and whether it carries a picture or tool results. */
function shapeWords(body, text) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const turns = msgs.filter((m) => m?.role === 'user').length;
  const len = text.length;
  const words = [
    `zzlen${len < 40 ? 'tiny' : len < 160 ? 'short' : len < 600 ? 'mid' : len < 2000 ? 'long' : 'huge'}`,
    `zzturns${turns <= 1 ? 'one' : turns <= 3 ? 'few' : 'many'}`,
  ];
  if (msgs.some((m) => m?.role === 'tool')) words.push('zztoolresults');
  return words;
}

/**
 * A request as counts of its hashed features: every word, every three letters of every word (so
 * "refund" and "refunded" are near), and the shape words. Sparse: { place: weight }.
 */
export function featuresRaw(body) {
  const text = askedText(body);
  const counts = new Map();
  const add = (feature, w = 1) => {
    const h = fnv(feature);
    const place = h % DIMS;
    const sign = (h >>> 16) & 1 ? 1 : -1;
    counts.set(place, (counts.get(place) || 0) + sign * w);
  };
  const words = text.split(/[^a-z0-9À-￿]+/).filter(Boolean);
  for (const w of words) {
    add(`w:${w}`);
    const padded = `^${w}$`;
    for (let i = 0; i + 3 <= padded.length; i += 1) add(`c:${padded.slice(i, i + 3)}`, 0.5);
  }
  for (const w of shapeWords(body, text)) add(`s:${w}`, 2);
  const out = {};
  for (const [place, v] of counts) {
    if (v === 0) continue;
    // a feature said many times is not many times as telling
    out[place] = Math.sign(v) * (1 + Math.log(Math.abs(v)));
  }
  return out;
}

/** How common each feature is across a set of requests, as a weight: rarer counts for more. */
export function idfOf(raws) {
  const n = raws.length;
  const df = new Array(DIMS).fill(0);
  for (const r of raws) for (const k of Object.keys(r)) df[Number(k)] += 1;
  return df.map((d) => Math.log((n + 1) / (d + 1)) + 1);
}

/** A request's weighted features, scaled to length one. An empty one stays all zeros. */
export function weigh(raw, idf) {
  const v = new Array(DIMS).fill(0);
  for (const [k, x] of Object.entries(raw || {})) {
    const i = Number(k);
    if (i >= 0 && i < DIMS) v[i] = x * (idf?.[i] ?? 1);
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
};
const unit = (v) => {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return n > 0 ? v.map((x) => x / n) : v;
};

/* A seeded random number, so the same calls always give the same kinds. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k kinds by spherical k-means (similarity is the cosine), started the k-means++ way. */
export function kmeans(xs, k, { seed = 7, iters = 30 } = {}) {
  const n = xs.length;
  if (n < k || k < 1) return null;
  const rand = seeded(seed);
  const centres = [xs[Math.floor(rand() * n)]];
  while (centres.length < k) {
    const d = xs.map((x) => Math.max(0, 1 - Math.max(...centres.map((c) => dot(x, c)))));
    const total = d.reduce((a, b) => a + b, 0);
    if (total <= 1e-12) break;
    let r = rand() * total;
    let pick = 0;
    for (; pick < n - 1; pick += 1) {
      r -= d[pick];
      if (r <= 0) break;
    }
    centres.push(xs[pick]);
  }
  if (centres.length < k) return null;
  let assign = new Array(n).fill(0);
  let cs = centres.map((c) => [...c]);
  for (let it = 0; it < iters; it += 1) {
    const next = xs.map((x) => {
      let best = 0;
      let bestSim = -Infinity;
      cs.forEach((c, j) => {
        const s = dot(x, c);
        if (s > bestSim) { bestSim = s; best = j; }
      });
      return best;
    });
    const moved = next.some((a, i) => a !== assign[i]) || it === 0;
    assign = next;
    cs = cs.map((c, j) => {
      const members = xs.filter((_, i) => assign[i] === j);
      if (!members.length) return c;
      const sum = new Array(DIMS).fill(0);
      for (const m of members) for (let d = 0; d < DIMS; d += 1) sum[d] += m[d];
      return unit(sum);
    });
    if (!moved) break;
  }
  const fit = xs.reduce((a, x, i) => a + dot(x, cs[assign[i]]), 0);
  return { centres: cs, assign, fit };
}

/** How well the calls fall apart into these kinds: the mean silhouette, with 1 - cosine as distance. */
export function silhouette(xs, assign, k) {
  const n = xs.length;
  if (k < 2 || n < 3) return -1;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const sums = new Array(k).fill(0);
    const counts = new Array(k).fill(0);
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      sums[assign[j]] += 1 - dot(xs[i], xs[j]);
      counts[assign[j]] += 1;
    }
    const own = assign[i];
    if (counts[own] === 0) continue;
    const a = sums[own] / counts[own];
    let b = Infinity;
    for (let c = 0; c < k; c += 1) if (c !== own && counts[c] > 0) b = Math.min(b, sums[c] / counts[c]);
    if (!Number.isFinite(b)) continue;
    const m = Math.max(a, b);
    total += m > 0 ? (b - a) / m : 0;
  }
  return total / n;
}

/**
 * The kinds a set of requests falls into, or null when they do not fall apart well enough.
 * Tries 2 to kMax kinds, several starts each, and keeps the clearest split.
 */
export function chooseKinds(xs, { kMax = 4, minSize = 8, minSilhouette = 0.1, seed = 7 } = {}) {
  const n = xs.length;
  let best = null;
  for (let k = 2; k <= Math.min(kMax, Math.floor(n / minSize)); k += 1) {
    let top = null;
    for (let s = 0; s < 6; s += 1) {
      const r = kmeans(xs, k, { seed: seed + 101 * s + 13 * k });
      if (r && (!top || r.fit > top.fit)) top = r;
    }
    if (!top) continue;
    const sizes = new Array(k).fill(0);
    for (const a of top.assign) sizes[a] += 1;
    if (sizes.some((z) => z < minSize)) continue;
    const sil = silhouette(xs, top.assign, k);
    if (sil < minSilhouette) continue;
    if (!best || sil > best.silhouette) best = { ...top, k, sizes, silhouette: sil };
  }
  return best;
}

/**
 * The route for one request: the option's index, or -1 for the customer's own model, with the kind it
 * was taken for and how like that kind it is.
 */
export function routeOf(spec, raw) {
  if (!spec?.centroids?.length) return { option: -1, kind: null, sim: 0, why: 'no kinds' };
  const x = weigh(raw, spec.idf);
  let kind = 0;
  let sim = -Infinity;
  spec.centroids.forEach((c, j) => {
    const s = dot(x, c);
    if (s > sim) { sim = s; kind = j; }
  });
  if (!(sim >= (spec.minSim?.[kind] ?? 1))) return { option: -1, kind, sim, why: 'unfamiliar' };
  const option = Number.isInteger(spec.table?.[kind]) ? spec.table[kind] : -1;
  return { option, kind, sim, why: option < 0 ? 'kind kept on yours' : 'kind' };
}

/* The per-call readings the router is learned from and judged on:
   calls[i] = { raw, results: [{ ok, score, cost, latency, ttft } for each option], ref: { noise, cost, latency, ttft } }
   options[j] = { model, recipe, key, ratio }, cheapest first. */
const scoreOf = (r) => (r && r.ok ? Number(r.score) || 0 : 1);

/* The most worse answers a look at n calls can hold and still clear a pass mark of floorPct, read by the
   verdict's own rule (verdictWith: an answer worse outright counts whole, and the range is Wilson's at z).
   -1 when not even a perfect look at n calls could clear it. */
function mostWorse(n, floorPct, z) {
  if (!(n > 0) || wilson(0, n, z).hi * 100 > floorPct) return -1;
  let k = 0;
  while (k < n && wilson((k + 1) / n, n, z).hi * 100 <= floorPct) k += 1;
  return k;
}

/* How many worse answers a setup gives on its next N calls, as a list of chances for 0, 1, ... `most`,
   read from its record: `worse` worse answers in `m` calls, pulled towards how it does over every call
   (`toward`, with the weight of `shrink` calls). The rate is not known, only what the record says of it
   (a beta distribution), so the count is a beta-binomial: wider than a plain binomial at the rate the
   record shows, which is what a record of a few dozen calls deserves. */
const lbeta = (a, b) => logGamma(a) + logGamma(b) - logGamma(a + b);
const lchoose = (n, k) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
function worseCounts(N, worse, m, toward, shrink, most, prior = 0) {
  /* `prior` more of each would keep a clean record from reading as a rate of exactly nothing. It is 0 by
     default, as measured (ROUTER_KIND_PRIOR in src/config.js): half of one each, the usual "nothing known",
     made every setup a table used look riskier, so the tables that split the work well were passed over
     for ones that saved less, while the looks themselves already turn down a table that was lucky. What
     these odds decide is which of the tables to try; they never clear one. */
  const a = worse + shrink * toward + prior;
  const b = Math.max(1e-9, m - worse + shrink * (1 - toward) + prior);
  const out = new Array(most + 1).fill(0);
  if (!(a > 1e-9)) { out[0] = 1; return out; }
  for (let x = 0; x <= Math.min(most, N); x += 1) out[x] = Math.exp(lchoose(N, x) + lbeta(x + a, N - x + b) - lbeta(a, b));
  return out;
}
// the same for the customer's own model's disagreements with itself, at a known rate (Poisson)
function noiseCounts(expected, most) {
  const out = new Array(most + 1).fill(0);
  let term = Math.exp(-Math.max(0, expected));
  for (let x = 0; x <= most; x += 1) {
    out[x] = term;
    term *= expected / (x + 1);
  }
  return out;
}
// the chances for the sum of independent counts, up to `most`
function together(counts, most) {
  let acc = new Array(most + 1).fill(0);
  acc[0] = 1;
  for (const c of counts) {
    const next = new Array(most + 1).fill(0);
    for (let i = 0; i <= most; i += 1) {
      if (!acc[i]) continue;
      for (let j = 0; i + j <= most; j += 1) next[i + j] += acc[i] * c[j];
    }
    acc = next;
  }
  return acc;
}

/**
 * Learn a router from calls: the kinds, and which setup answers each kind. Null when the calls do not
 * fall into kinds, or when the best way to route them sends every kind the same way.
 *
 * Which setup answers a kind is chosen in two steps. First, a setup may only take a kind it does well
 * enough on its own: its share of worse answers on that kind, pulled a little towards how it does over
 * every call (a kind of eight calls says little on its own), inside `margin` of the pass mark. That keeps
 * any one kind from being given a model that is worse on it, however well the other kinds hide it.
 * Second, of every way of giving the kinds to the setups allowed them (the customer's own model is
 * always allowed), the one with the biggest saving we can be sure of: what it saves, after our fee,
 * times the chance it clears both looks it still has to pass (the calls it did not learn from, then
 * calls nobody has seen, `looks`). Taking the cheapest setup allowed for each kind in turn looked
 * cheaper, and was worse: a setup wrong on one refund in a hundred is inside the pass mark, but at a
 * pass mark of 3% one worse answer in 120 calls fails a look, so a router that gave it the refunds
 * usually failed, where one that kept them on the customer's own model cleared and saved most of it.
 */
/** How like a kind a request has to be to be taken for it, from how like the kind's own members are to its centre
    (see learnRouter): the least like of them less a little, after setting aside the few least like (one in twenty,
    rounded up) where a gap wider than ODD_GAP parts them from the rest, cut at the last such gap among them. Cut at
    the widest instead, a joke at 0.10 and a stray at 0.60 among members at 0.90 kept the stray and a line of 0.58;
    and with one in twenty rounded down, two jokes in a kind of 39 were one too many to set aside, and the line
    fell to 0.08. A floor under the kind's middle was tried as well and sent 7 of every 100 ordinary requests on:
    a kind of one phrasing has a close variant a good way below its middle, and that is a member. */
const ODD_GAP = 0.1;
export function familiarLine(sims) {
  const s = [...sims].sort((a, b) => a - b);
  if (!s.length) return 1;
  const most = Math.max(1, Math.ceil(s.length * 0.05));
  let cut = 0;
  for (let j = 1; j <= most && j < s.length; j += 1) if (s[j] - s[j - 1] > ODD_GAP) cut = j;
  return Math.max(0, s[cut] - 0.02);
}

export function learnRouter(calls, options, { floorPct, margin = 0.8, shrink = 2, kMax = 4, minSize = 8, minSilhouette = 0.1, seed = 7,
  feePct = 1, looks = null, prior = 0, sureShrink = 0, pick = 'best' } = {}) {
  const pull = sureShrink ?? 0;
  if (!calls.length || !options.length) return null;
  const idf = idfOf(calls.map((c) => c.raw));
  const xs = calls.map((c) => weigh(c.raw, idf));
  const kinds = chooseKinds(xs, { kMax, minSize, minSilhouette, seed });
  if (!kinds) return null;
  const n = calls.length;
  const limit = (Number(floorPct) / 100) * margin;
  // how each option does over every call: what a small kind is pulled towards
  const overall = options.map((_, j) => calls.reduce((a, c) => a + scoreOf(c.results[j]), 0) / n);
  const per = [];
  for (let k = 0; k < kinds.k; k += 1) {
    const members = calls.map((c, i) => (kinds.assign[i] === k ? i : -1)).filter((i) => i >= 0);
    const m = members.length;
    const refCost = members.reduce((a, i) => a + (Number(calls[i].ref.cost) || 0), 0);
    const tried = options.map((o, j) => {
      const sum = members.reduce((a, i) => a + scoreOf(calls[i].results[j]), 0);
      const cost = members.reduce((a, i) => a + (Number(calls[i].results[j]?.cost) || 0), 0);
      const pulled = (sum + shrink * overall[j]) / (m + shrink);
      return { option: j, share: sum / m, pulled, cost: refCost > 0 ? cost / refCost : Number(o.ratio) || 1, allowed: pulled <= limit };
    });
    per.push({ kind: k, calls: m, weight: m / n, noise: members.reduce((a, i) => a + (Number(calls[i].ref.noise) || 0), 0) / m, tried });
  }
  const sizes = (looks && looks.length ? looks : [{ n }, { n }]).map((l) => ({ n: l.n, most: mostWorse(l.n, Number(floorPct), l.z ?? 1.6449) }));
  const choices = per.map((p) => [-1, ...p.tried.filter((t) => t.allowed).map((t) => t.option)]);
  let best = null;
  const table = [];
  /* How sure a table is to clear a look: each setup's record over all the kinds the table gives it, taken
     as one record (the kinds were given to it because it does them well, so they are read together, not
     one thin record each), and the customer's own model's disagreements with itself on the kinds kept on
     it. The chance the worse answers of a look of n calls stay within what the verdict allows. */
  const sureOf = (tbl) => {
    const groups = new Map();
    let refCalls = 0;
    let refNoise = 0;
    per.forEach((p, q) => {
      const c = tbl[q];
      if (c < 0) {
        refCalls += p.calls;
        refNoise += p.noise * p.calls;
        return;
      }
      const g = groups.get(c) || { m: 0, worse: 0 };
      g.m += p.calls;
      g.worse += p.tried[c].share * p.calls;
      groups.set(c, g);
    });
    return sizes.reduce((acc, l) => {
      if (l.most < 0) return 0;
      const counts = [...groups].map(([j, g]) => worseCounts(Math.round((l.n * g.m) / n), g.worse, g.m, overall[j], pull, l.most, prior));
      if (refCalls) counts.push(noiseCounts((l.n * refNoise) / n, l.most));
      return acc * Math.min(1, together(counts, l.most).reduce((a, b) => a + b, 0));
    }, 1);
  };
  // what a table saves after our fee, times the chance it clears both looks, and what it costs against the customer's model
  const valueOf = (tbl) => {
    let ratio = 0;
    per.forEach((p, q) => {
      const t = tbl[q] < 0 ? null : p.tried[tbl[q]];
      ratio += p.weight * (t ? t.cost : 1);
    });
    const saving = Math.max(0, 1 - ratio * (1 + feePct / 100));
    // a table that saves nothing is not worth working out the odds of
    const sure = saving > 0 ? sureOf(tbl) : 0;
    return { value: saving * sure, sure, ratio };
  };
  /* Every kind to one setup that may take every kind: that setup on its own. A router has to beat the best
     of those, or it is that setup with a detour to the customer's own model for nothing. */
  let alone = 0;
  options.forEach((_, j) => {
    if (per.every((p) => p.tried[j].allowed)) alone = Math.max(alone, valueOf(per.map(() => j)).value);
  });
  const walk = (k) => {
    if (k === per.length) {
      /* Only a table that really splits the calls: every kind to the customer's own model saves nothing,
         and every kind to one setup is that setup, which is measured on its own and competes with the
         router for the switch (rankCleared). Letting it win here meant a router that would save more was
         never even tried whenever one dearer setup was about as safe. */
      if (new Set(table).size < 2) return;
      const v = valueOf(table);
      if (!best || v.value > best.value + 1e-12 || (Math.abs(v.value - best.value) <= 1e-12 && v.ratio < best.ratio)) {
        best = { table: [...table], ...v };
      }
      return;
    }
    for (const c of choices[k]) {
      table.push(c);
      walk(k + 1);
      table.pop();
    }
  };
  if (pick === 'greedy') {
    // each kind to the cheapest setup allowed it, in turn (kept to measure the search against)
    table.push(...per.map((p) => {
      const ok = p.tried.filter((t) => t.allowed).sort((a, b) => a.cost - b.cost);
      return ok.length ? ok[0].option : -1;
    }));
    walk(per.length);
  } else {
    walk(0);
  }
  /* A router that sends every kind the same way is one setup with extra steps: all of them to the
     customer's own model saves nothing, and all of them to one option is that option, measured on its
     own already. And one that does no better than a single setup alone is not worth its moving part. */
  if (!best || !(best.value > 0) || new Set(best.table).size < 2 || !(best.value > alone + 1e-9)) return null;
  const readings = per.map((p, q) => ({ kind: p.kind, calls: p.calls, option: best.table[q], noise: p.noise, tried: p.tried }));
  /* How like a kind a request has to be to be taken for it (familiarLine): as like as the least like of its
     members, less a little. But not of every member: one odd request among a kind's (a joke asked of an order
     workload) lowered the line so far that anything at all was taken for that kind and sent to its cheaper
     setup. So the few least like members are set aside when a clear gap parts them from the rest. A kind with
     no such gap keeps the line it always had, variants and all: a kind of one phrasing with a close variant now
     and then is not made of odd requests. Tried on synthetic workloads of orders and refunds: an ordinary
     request went to the customer's model as unfamiliar 1.2 times in a hundred, and 15 of 456 odd ones were
     taken for a kind, where a rule that called a member odd only far under the middle in spread terms let one
     member at 0.60 in a kind at 0.95 or more pull the line to 0.58 (24 of 456 taken), and the lowest twentieth
     of the members (the other rule tried) sent 2.2 in a hundred and could not set aside a lone odd member of a
     small kind at all. Held at the middle less a fixed margin instead, a kind of near-identical requests drew
     its line so tight that one in five of its own requests went on. */
  const minSim = kinds.centres.map((c, k) => familiarLine(xs.filter((_, i) => kinds.assign[i] === k).map((x) => dot(x, c))));
  const round = (x) => Math.round(x * 10000) / 10000;
  return {
    centroids: kinds.centres.map((c) => c.map(round)),
    minSim: minSim.map(round),
    idf: idf.map(round),
    table: best.table,
    sizes: kinds.sizes,
    silhouette: round(kinds.silhouette),
    // what the table was chosen on: its chance of clearing both looks, and what it costs against the customer's model
    expected: { sure: round(best.sure), ratio: round(best.ratio) },
    readings,
  };
}

/**
 * What a learned router would have done on a set of calls: each call routed, and scored, priced and
 * timed as the setup it went to answered it. A call routed to an option that failed counts as a miss,
 * the careful reading (live, it would be answered by the customer's own model instead).
 */
export function simulateRoutes(spec, calls) {
  let sum = 0;
  let cost = 0;
  let refCost = 0;
  let toRef = 0;
  const scores = [];
  const latency = [];
  const ttft = [];
  const served = [];
  for (const c of calls) {
    refCost += Number(c.ref.cost) || 0;
    const r = routeOf(spec, c.raw);
    if (r.option < 0) {
      toRef += 1;
      const s = Number(c.ref.noise) || 0;
      sum += s;
      scores.push(s);
      cost += Number(c.ref.cost) || 0;
      latency.push(c.ref.latency ?? null);
      ttft.push(c.ref.ttft ?? c.ref.latency ?? null);
      served.push(-1);
      continue;
    }
    const got = c.results[r.option];
    const s = scoreOf(got);
    sum += s;
    scores.push(s);
    cost += Number(got?.cost) || 0;
    latency.push(got?.latency ?? null);
    ttft.push(got?.ttft ?? got?.latency ?? null);
    served.push(r.option);
  }
  const n = calls.length;
  return {
    gap: n ? (sum / n) * 100 : 100, scores, cost, refCost, ratio: refCost > 0 ? cost / refCost : null,
    escalated: n ? toRef / n : 1, latency: latency.filter((x) => x !== null), ttft: ttft.filter((x) => x !== null), served,
  };
}

/**
 * The router as it would do on calls it did not learn from: learned on all folds but one, run on that
 * one, pooled. And the router learned on every call, which is the one served. Null when the calls do
 * not fall into kinds at all.
 */
export function crossFitRouter(calls, options, opts = {}, { folds = 5 } = {}) {
  const full = learnRouter(calls, options, opts);
  if (!full) return null;
  const n = calls.length;
  const k = Math.max(2, Math.min(folds, n));
  const pooled = { scores: [], latency: [], ttft: [], cost: 0, refCost: 0, toRef: 0, n: 0, served: [] };
  // how each option does over every call, and the customer's model's own noise: what routing at random would give
  const overall = options.map((_, j) => calls.reduce((a, c) => a + scoreOf(c.results[j]), 0) / n);
  const refNoise = calls.reduce((a, c) => a + (Number(c.ref.noise) || 0), 0) / n;
  for (let f = 0; f < k; f += 1) {
    const test = calls.filter((_, i) => i % k === f);
    const train = calls.filter((_, i) => i % k !== f);
    if (!test.length || !train.length) continue;
    /* A fold whose calls do not fall into kinds sends every call to the customer's own model, which is
       what that router would have done: a router that only works on some samples is judged on all. */
    const spec = learnRouter(train, options, opts);
    const r = spec ? simulateRoutes(spec, test)
      : simulateRoutes({ centroids: [] }, test);
    pooled.scores.push(...r.scores);
    pooled.latency.push(...r.latency);
    pooled.ttft.push(...r.ttft);
    pooled.cost += r.cost;
    pooled.refCost += r.refCost;
    pooled.toRef += r.escalated * test.length;
    pooled.n += test.length;
    pooled.served.push(...r.served);
  }
  const gap = pooled.n ? (pooled.scores.reduce((a, b) => a + b, 0) / pooled.n) * 100 : 100;
  /* Whether the kinds mattered. Each cheaper setup got some number of answers worse over all the calls. If
     the kinds meant nothing, those worse answers would land on the calls the router gave that setup no more
     often than on any others: of m calls out of n, about m/n of them. A router whose kinds mean something
     does far better than that, because it keeps each setup off the requests it gets wrong. One whose kinds
     mean nothing does no better: it only mixes a worse model into part of the traffic, and clears the bar
     by diluting its mistakes rather than avoiding them. Counted on the calls each router did not learn
     from, and read as the draw it is (hypergeometric: m calls drawn from n, holding a setup's worse answers
     fixed), which is what lets a clean split of a few mistakes show: four worse answers, all on the 40% of
     calls the router kept away, happen by chance about once in forty. `kindsZ` is how many spreads fewer
     worse answers the router's calls had than chance would give (see ROUTER_KIND_LIFT_Z). */
  let observed = 0;
  let expected = 0;
  let spread = 0;
  options.forEach((_, j) => {
    const m = pooled.served.filter((s) => s === j).length;
    if (!m) return;
    const p = overall[j];
    observed += pooled.served.reduce((a, s, i) => a + (s === j ? Number(pooled.scores[i]) || 0 : 0), 0);
    expected += m * p;
    spread += n > 1 ? m * p * (1 - p) * ((n - m) / (n - 1)) : 0;
  });
  const kindsZ = spread > 1e-12 ? (expected - observed) / Math.sqrt(spread) : 0;
  const randomGap = pooled.n
    ? pooled.served.reduce((a, j) => a + (j < 0 ? refNoise : overall[j]), 0) / pooled.n : 0;
  return {
    spec: full,
    heldOut: {
      gap, scores: pooled.scores, latency: pooled.latency, ttft: pooled.ttft, cost: pooled.cost, refCost: pooled.refCost,
      ratio: pooled.refCost > 0 ? pooled.cost / pooled.refCost : null, escalated: pooled.n ? pooled.toRef / pooled.n : 1,
      randomGap: randomGap * 100, kindsZ, worseKept: observed, worseAtRandom: expected,
    },
    inSample: simulateRoutes(full, calls),
  };
}
