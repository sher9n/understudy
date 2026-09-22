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
