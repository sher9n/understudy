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

/* Structured answers, field by field, by what kind of field each one is.

   A field that DECIDES something (a label, an amount, a date, an id, a yes or no, which tool was
   called) has to match: an answer that gets one of those wrong is a wrong answer, whatever else it
   gets right. The old rule counted the share of fields that differed, so a reversed decision in an
   eight field answer counted as an eighth of a mistake, and a model that flipped the decision on
   nine calls in a hundred cleared a 3% bar and was switched to.

   A field that is WRITTEN (a "reason", a "summary", a sentence) is never the same string twice, even
   from the customer's own model, and counting its wording as a difference made the model look
   inconsistent with itself: that noise then loosened the bar for the fields that decide. Written
   fields are read for meaning by the judge instead, and only when every deciding field matches. */
const PROSE_CHARS = 40;
const PROSE_WORDS = 6;
export const isProse = (v) => typeof v === 'string' && v.trim().length >= PROSE_CHARS
  && v.trim().split(/\s+/).length >= PROSE_WORDS;

/** A number written as text, read the way people write it: 1,234.56, 1.234,56, 1234,5. */
export function asNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let t = v.trim().replace(/^[$€£¥₹]\s*|\s*[$€£¥₹%]$/g, '');
  if (!/^-?\d[\d.,\s]*$/.test(t)) return null;
  t = t.replace(/\s/g, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The same value, written two ways: spacing, a number with separators, the case of a one-word label. */
export function sameValue(x, y) {
  if (x === y) return true;
  if (x === undefined || y === undefined || x === null || y === null) return false;
  const nx = asNumber(x);
  const ny = asNumber(y);
  if (nx !== null && ny !== null) return Math.abs(nx - ny) <= 1e-9 * Math.max(1, Math.abs(nx), Math.abs(ny));
  if (typeof x === 'boolean' || typeof y === 'boolean') return String(x).toLowerCase() === String(y).toLowerCase();
  if (typeof x === 'string' && typeof y === 'string') {
    const a = x.trim().replace(/\s+/g, ' ');
    const b = y.trim().replace(/\s+/g, ' ');
    if (a === b) return true;
    return /^[A-Za-z][A-Za-z _-]{0,40}$/.test(a) && a.toLowerCase() === b.toLowerCase();
  }
  return canonical(x) === canonical(y);
}

/** Two structured answers compared: whether any deciding field differs, and the written fields that do. */
export function structuredCompare(av, bv, shapeKind) {
  let x = av;
  let y = bv;
  if (shapeKind === 'tool_call') {
    const names = (calls) => (Array.isArray(calls) ? calls.map((c) => c?.name ?? '').join('|') : '');
    if (names(x) !== names(y)) return { decision: 1, fields: 1, differ: 1, prose: [] };
    x = (x || []).map((c) => c?.args);
    y = (y || []).map((c) => c?.args);
  }
  const la = leaves(x);
  const lb = leaves(y);
  const keys = new Set([...la.keys(), ...lb.keys()]);
  const prose = [];
  let differ = 0;
  let decided = 0;
  for (const k of keys) {
    const p = la.has(k) ? la.get(k) : undefined;
    const q = lb.has(k) ? lb.get(k) : undefined;
    if (isProse(p) && isProse(q)) {
      if (p.trim() !== q.trim()) prose.push({ path: k, a: p, b: q });
      continue;
    }
    decided += 1;
    if (!sameValue(p, q)) differ += 1;
  }
  return { decision: differ > 0 ? 1 : 0, fields: decided, differ, prose };
}

/** Which fields two structured answers differ in, by the rules structuredCompare counts with: the deciding fields
    whose values differ, and the written ones worded differently, which a judge reads for meaning rather than counts.
    What a person opening one request of a test is shown beside the two answers. */
export function differingFields(av, bv, shapeKind) {
  let x = av;
  let y = bv;
  if (shapeKind === 'tool_call') {
    const names = (calls) => (Array.isArray(calls) ? calls.map((c) => c?.name ?? '').join(', ') : '');
    if (names(x) !== names(y)) return { decide: ['the tool called'], written: [] };
    x = (x || []).map((c) => c?.args);
    y = (y || []).map((c) => c?.args);
  }
  if (shapeKind === 'enum' && (x === null || typeof x !== 'object') && (y === null || typeof y !== 'object')) {
    return { decide: sameValue(x, y) ? [] : ['the answer'], written: [] };
  }
  const la = leaves(x);
  const lb = leaves(y);
  const decide = [];
  const written = [];
  for (const k of new Set([...la.keys(), ...lb.keys()])) {
    const p = la.has(k) ? la.get(k) : undefined;
    const q = lb.has(k) ? lb.get(k) : undefined;
    if (isProse(p) && isProse(q)) { if (p.trim() !== q.trim()) written.push(k); continue; }
    if (!sameValue(p, q)) decide.push(k);
  }
  return { decide, written };
}

/** The written fields of a structured answer, as one text a judge can read. */
export function proseText(pairs, side) {
  return pairs.map((p) => `${p.path}: ${p[side]}`).join('\n');
}

/** 0 means identical, 1 means a different answer. Null means a judge has to decide: free text, or a
 *  structured answer whose deciding fields all match and whose written fields differ in wording. */
export function disagreement(a, b, shapeKind) {
  if (!a.ok || !b.ok) return 1;                       // a failure is total disagreement, never skipped
  if (shapeKind === 'free_text') {
    return a.value.trim() === b.value.trim() ? 0 : null;
  }
  if (shapeKind === 'enum') return sameValue(a.value, b.value) || canonical(a.value) === canonical(b.value) ? 0
    : structuredCompare(a.value, b.value, 'json').decision;
  const c = structuredCompare(a.value, b.value, shapeKind);
  if (c.decision) return 1;
  return c.prose.length ? null : 0;
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

/* The bar under "at least as good": no more often clearly worse than the customer's own model is against its own
   other answer, plus a margin in points. A multiple of that rate had to be cut off somewhere, since a customer's
   model clearly worse than itself on half its calls made a bar no answer could miss, and the cut-off was where a
   written workload "could not be measured" at all. Plus a margin, a varied workload's bar is simply wide, and
   showing a setup keeps it takes more calls, which the verdict counts (verdictWith) rather than giving up.

   Never past half, plus the margin. Two answers from one model can each be the clearly better one only half the
   time, so a model is clearly worse than its own other answer on half its calls at most. More than that says the
   answers it was held against (the ones it gave the customer, recorded) are better than what it gives now, and a
   bar read from it would pass a setup clearly worse on every call: a model replayed today clearly worse on all of
   them made a bar of 105%. Capped, a setup is held to answers like the recorded ones, most of the time. */
export function marginFloor(noisePct, { marginPct, minPct }) {
  return Math.min(Math.max(noisePct + marginPct, minPct), 50 + marginPct);
}

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
export function verdictWith(scores, floorPct, { reviewBand = 1.25, z = Z95 } = {}) {
  /* `z` is how sure the bound is: 1.6449 is one-sided 95%, the default; a cautious workload's second
     look is held to 1.96, one-sided 97.5%, the convention for showing a new treatment is not worse. */
  const zz = Number.isFinite(Number(z)) && Number(z) > 0 ? Number(z) : Z95;
  const n = scores.length;
  const gap = n ? (scores.reduce((a, b) => a + b, 0) / n) * 100 : 100;
  const differed = scores.filter((x) => x > 0);
  const k = differed.length;
  const share = wilson(n ? k / n : 0, n, zz);
  let sevLo = 1;
  let sevHi = 1;
  if (k) {
    const mean = differed.reduce((a, b) => a + b, 0) / k;
    const sd = Math.sqrt(differed.reduce((a, b) => a + (b - mean) ** 2, 0) / k);
    const margin = (zz * Math.max(sd, 0.1)) / Math.sqrt(k);
    sevLo = Math.max(0, mean - margin);
    sevHi = Math.min(1, mean + margin);
  }
  const lo = share.lo * sevLo;
  const hi = share.hi * sevHi;
  const loPct = lo * 100;
  const hiPct = hi * 100;
  if (n === 0 || wilson(0, n, zz).hi * 100 > floorPct) {
    return { verdict: 'insufficient', gap, lo: loPct, hi: hiPct, need: callsToClear(floorPct, zz) };
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
export function sampleCalls(calls, size, seed = 1, preferred = null, { fresh = null } = {}) {
  const withLen = calls.map((c) => ({ ...c, len: (c.response_json || '').length }));
  withLen.sort((a, b) => a.len - b.len);
  const quartiles = [[], [], [], []];
  withLen.forEach((c, i) => quartiles[Math.min(3, Math.floor((i * 4) / Math.max(1, withLen.length)))].push(c));
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  /* How many from each band. The share left over after an even split goes to the longest answers
     first, because length is what breaks a model; it used to be the longest band that was cut short
     (a pool of twenty sampled three, three, three and one). A band too small for its share passes
     the rest on to the others. */
  const want = [0, 0, 0, 0];
  let left = Math.min(size, withLen.length);
  for (let round = 0; left > 0 && round < 8; round += 1) {
    const open = [3, 2, 1, 0].filter((q) => quartiles[q].length > want[q]);
    if (!open.length) break;
    const each = Math.floor(left / open.length);
    const extra = left - each * open.length;
    open.forEach((q, k) => {
      const give = Math.min(quartiles[q].length - want[q], each + (k < extra ? 1 : 0));
      want[q] += give;
      left -= give;
    });
  }
  const out = [];
  quartiles.forEach((q, qi) => {
    const pool = [...q];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    /* A re-check wants calls no earlier measurement used, so a lucky sample is not simply measured
       again; a first measurement prefers calls whose answers are already paid for. */
    const rank = (c) => (fresh && fresh.size ? (fresh.has(c.id) ? 0 : 2) : 0)
      + (preferred && preferred.size && preferred.has(c.id) ? 0 : 1);
    const ordered = [...pool].sort((a, b) => rank(a) - rank(b));
    out.push(...ordered.slice(0, want[qi]).map((c) => ({ ...c, quartile: qi })));
  });
  return out.slice(0, size);
}
