/* How two answers to the same call are compared, and what counts as the same.
   Every function here is pure, so the numbers on a certificate can be checked by hand. */

/** What the model actually produced, pulled out the same way for every model. */
export function extract(response, shapeKind) {
  const choice = response?.choices?.[0];
  if (!choice) return { ok: false, reason: 'no choice' };
  const msg = choice.message || {};
  if (choice.finish_reason === 'length') return { ok: false, reason: 'truncated' };
  if (shapeKind === 'tool_call') {
    const calls = msg.tool_calls || [];
    if (!calls.length) return { ok: false, reason: 'no tool call' };
    const parsed = [];
    for (const c of calls) {
      let args;
      try { args = JSON.parse(c.function?.arguments ?? '{}'); }
      catch { return { ok: false, reason: 'unparseable arguments' }; }
      parsed.push({ name: c.function?.name, args });
    }
    return { ok: true, value: parsed };
  }
  const text = typeof msg.content === 'string' ? msg.content : '';
  if (shapeKind === 'json' || shapeKind === 'enum') {
    const trimmed = text.trim().replace(/^```(?:json)?|```$/g, '').trim();
    if (!trimmed) return { ok: false, reason: 'empty' };
    try { return { ok: true, value: JSON.parse(trimmed) }; }
    catch { return { ok: false, reason: 'unparseable json' }; }
  }
  if (!text.trim()) return { ok: false, reason: 'empty' };
  return { ok: true, value: text };
}

/** Stable, order-insensitive for object keys, so formatting is never mistaken for a change. */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

const leaves = (v, path = '', out = new Map()) => {
  if (v === null || typeof v !== 'object') { out.set(path || '$', v); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => leaves(x, `${path}[${i}]`, out)); return out; }
  for (const k of Object.keys(v)) leaves(v[k], path ? `${path}.${k}` : k, out);
  return out;
};

/** 0 means identical, 1 means nothing in common. Structured answers compare field by field. */
export function disagreement(a, b, shapeKind) {
  if (!a.ok || !b.ok) return 1;                       // a failure is total disagreement, never skipped
  if (shapeKind === 'free_text') {
    return a.value.trim() === b.value.trim() ? 0 : null;  // null means a judge has to decide
  }
  if (shapeKind === 'enum') return canonical(a.value) === canonical(b.value) ? 0 : 1;
  const la = leaves(a.value);
  const lb = leaves(b.value);
  const keys = new Set([...la.keys(), ...lb.keys()]);
  if (!keys.size) return 0;
  let differ = 0;
  for (const k of keys) {
    const x = la.has(k) ? la.get(k) : undefined;
    const y = lb.has(k) ? lb.get(k) : undefined;
    if (canonical(x) !== canonical(y)) differ += 1;
  }
  return differ / keys.size;
}

/** The four gates a candidate has to pass, computed on the server, never in a screen. */
export function gates(pairs, shapeKind) {
  const total = pairs.length;
  if (!total) return { structure: 0, accuracy: 0, coverage: 0, complete: 0 };
  const parsed = pairs.filter((p) => p.cand.ok).length;
  const exact = pairs.filter((p) => p.score === 0).length;
  const answered = pairs.filter((p) => p.cand.ok && p.ref.ok).length;
  let complete = total;
  if (shapeKind !== 'free_text') {
    complete = pairs.filter((p) => {
      if (!p.cand.ok || !p.ref.ok) return false;
      const want = leaves(p.ref.value).size;
      const got = leaves(p.cand.value).size;
      return want === 0 || got >= want;
    }).length;
  }
  return {
    structure: parsed / total,
    accuracy: exact / total,
    coverage: answered / total,
    complete: complete / total,
  };
}

/** The bar: how much the customer's own model disagrees with itself, with a floor under it. */
export function floorFrom(noisePct, { multiple, minPct }) {
  return Math.max(noisePct * multiple, minPct);
}

/** A bar is only meaningful while the reference agrees with itself most of the time. */
export const barIsMeaningful = (noisePct, maxPct) => noisePct <= maxPct;

/* A verdict is a claim about a rate seen on a sample, so it carries how sure the sample can make
 * anybody: nineteen times in twenty the true rate is under the upper bound (Wilson's, one-sided).
 * The bound is worked out from the mean score, which for scores between 0 and 1 is conservative,
 * because nothing varies more than a yes-or-no with the same mean.
 *
 * cleared: even the upper bound is inside the bar.
 * missed: even the lower bound is past the review band.
 * review: the sample straddles the bar, so a person should look.
 * insufficient: a perfect run on this many calls could not clear the bar; nothing can be said.
 */
const Z95 = 1.6449;
export function wilson(mean, n, z = Z95) {
  if (!(n > 0)) return { lo: 0, hi: 1 };
  const p = Math.max(0, Math.min(1, mean));
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const d = 1 + (z * z) / n;
  return { lo: Math.max(0, (centre - half) / d), hi: Math.min(1, (centre + half) / d) };
}

/** The fewest calls on which a perfect run clears a bar (in percent). */
export function callsToClear(floorPct, z = Z95) {
  return Math.ceil((z * z) / (floorPct / 100) - z * z);
}

/**
 * The verdict for one candidate from its per-call scores (each 0 to 1, 1 meaning a different answer).
 *
 * A score is two things: whether the call differed at all, and by how much when it did. The first
 * is a count, which Wilson bounds properly; the second is bounded between 0 and 1 and gets its own
 * small margin. Bounding the mean as if every score were a yes or no read a candidate that only
 * ever differs slightly (one JSON field wrong on a few calls) as far more uncertain than it is.
 */
export function verdictWith(scores, floorPct, { reviewBand = 1.25 } = {}) {
  const n = scores.length;
  const gap = n ? (scores.reduce((a, b) => a + b, 0) / n) * 100 : 100;
  const differed = scores.filter((x) => x > 0);
  const k = differed.length;
  const share = wilson(n ? k / n : 0, n);
  let sevLo = 1;
  let sevHi = 1;
  if (k) {
    const mean = differed.reduce((a, b) => a + b, 0) / k;
    const sd = Math.sqrt(differed.reduce((a, b) => a + (b - mean) ** 2, 0) / k);
    const margin = (Z95 * Math.max(sd, 0.1)) / Math.sqrt(k);
    sevLo = Math.max(0, mean - margin);
    sevHi = Math.min(1, mean + margin);
  }
  const lo = share.lo * sevLo;
  const hi = share.hi * sevHi;
  const loPct = lo * 100;
  const hiPct = hi * 100;
  if (n === 0 || wilson(0, n).hi * 100 > floorPct) {
    return { verdict: 'insufficient', gap, lo: loPct, hi: hiPct, need: callsToClear(floorPct) };
  }
  if (hiPct <= floorPct) return { verdict: 'cleared', gap, lo: loPct, hi: hiPct };
  if (loPct > floorPct * reviewBand) return { verdict: 'missed', gap, lo: loPct, hi: hiPct };
  return { verdict: 'review', gap, lo: loPct, hi: hiPct };
}

/** Kept for the pages that still read a verdict from a gap alone; every measurement uses verdictWith. */
export function verdictFor(gapPct, floorPct, runs, { minRuns, reviewBand }) {
  if (runs < minRuns) return 'insufficient';
  if (gapPct <= floorPct) return 'cleared';
  if (gapPct <= floorPct * reviewBand) return 'review';
  return 'missed';
}

/** Seeded and stratified by answer length, because length is what breaks a model.
 *
 * `preferred` is the calls whose answers are already paid for. Within each length band they are
 * taken first, so a measurement repeated on unchanged traffic reuses what the last one bought,
 * while the spread across short and long answers stays exactly as it was. */
export function sampleCalls(calls, size, seed = 1, preferred = null) {
  const withLen = calls.map((c) => ({ ...c, len: (c.response_json || '').length }));
  withLen.sort((a, b) => a.len - b.len);
  const quartiles = [[], [], [], []];
  withLen.forEach((c, i) => quartiles[Math.min(3, Math.floor((i * 4) / Math.max(1, withLen.length)))].push(c));
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = [];
  const perQ = Math.ceil(size / 4);
  quartiles.forEach((q, qi) => {
    const pool = [...q];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const ordered = preferred && preferred.size
      ? [...pool.filter((c) => preferred.has(c.id)), ...pool.filter((c) => !preferred.has(c.id))]
      : pool;
    out.push(...ordered.slice(0, perQ).map((c) => ({ ...c, quartile: qi })));
  });
  return out.slice(0, size);
}
