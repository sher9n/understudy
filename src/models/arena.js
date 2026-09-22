import { db, now } from '../db/index.js';
import config, { canJev } from '../config.js';
import { ask, jevUsable } from '../jev.js';
import { markSynced } from './facts.js';

/* The public Arena leaderboard, as one hint about how capable a model is.
 *
 * Arena (formerly LMArena) publishes its ratings as a dataset under CC BY 4.0, which allows
 * this use with credit: "Arena ratings, lmarena-ai/leaderboard-dataset, CC BY 4.0". Artificial
 * Analysis publishes richer scores, but its terms forbid using them in a product whose purpose
 * is choosing models, which is this product, so they are not used anywhere.
 *
 * A rating says how often people preferred one model's answer to another's, across everybody's
 * questions. It is a weak hint about one customer's calls, so it is weighted least of the
 * evidence a measurement ranks by, and never decides anything on its own. */

const DATASET = 'lmarena-ai/leaderboard-dataset';
const HOST = 'https://datasets-server.huggingface.co';

/* The dataset service is shared and asks callers to go gently, so pages are fetched one at a
   time with a pause between them, and a refusal is waited out rather than hammered. This runs
   once a week in the background, where taking a minute costs nobody anything. */
async function getJson(url, { tries = 5 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const body = await res.json().catch(() => null);
    const busy = res.status === 429 || res.status >= 500
      || /loading|try again/i.test(String(body?.error || ''));
    if (busy && attempt < tries) {
      const after = Number(res.headers.get('retry-after')) * 1000;
      await pause(Number.isFinite(after) && after > 0 ? after : 3000 * 2 ** attempt);
      continue;
    }
    if (!res.ok || !body || body.error) throw new Error(body?.error || `HTTP ${res.status}`);
    await pause(400);
    return body;
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* Every "overall" row of the latest text leaderboard. The dataset's filter endpoint is tried
   first; it is sometimes still indexing, and then the rows are paged through and filtered here. */
async function fetchOverall() {
  const where = encodeURIComponent('"category"=\'overall\'');
  try {
    const out = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const j = await getJson(`${HOST}/filter?dataset=${encodeURIComponent(DATASET)}&config=text&split=latest`
        + `&where=${where}&offset=${offset}&length=100`);
      out.push(...j.rows.map((r) => r.row));
      if (offset + 100 >= j.num_rows_total) break;
    }
    if (out.length) return out;
  } catch { /* fall through to paging */ }
  const out = [];
  let total = Infinity;
  for (let offset = 0; offset < total && offset < 20000; offset += 100) {
    const j = await getJson(`${HOST}/rows?dataset=${encodeURIComponent(DATASET)}&config=text&split=latest`
      + `&offset=${offset}&length=100`);
    total = j.num_rows_total;
    for (const r of j.rows) if (r.row?.category === 'overall') out.push(r.row);
  }
  return out;
}

export async function syncArena() {
  const rows = await fetchOverall();
  if (!rows.length) throw new Error('the Arena leaderboard came back empty');
  const at = now();
  await db.tx(async (tx) => {
    await tx.prepare('DELETE FROM arena_ratings').run();
    const stmt = tx.prepare(`INSERT INTO arena_ratings (name, organization, rating, votes, published, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING`);
    for (const r of rows) {
      if (!r.model_name || !Number.isFinite(Number(r.rating))) continue;
      await stmt.run(r.model_name, r.organization ?? null, Number(r.rating), r.vote_count ?? null,
        r.leaderboard_publish_date ?? null, at);
    }
  });
  await markSynced('arena', `${rows.length} models`);
  return rows.length;
}

/* Matching a leaderboard name to one of ours.
 *
 * The two lists name the same model differently: "openai/gpt-4.1-nano" against
 * "gpt-4.1-nano-2025-04-14", "meta-llama/llama-4-maverick" against
 * "llama-4-maverick-17b-128e-instruct". Names are reduced to their core and compared; when that
 * leaves more than one possibility, or none but a close one, Jev is asked which entry is the
 * same model, which is the entity-matching judgement it is built for. */
export const core = (s) => String(s || '').toLowerCase()
  .replace(/^[a-z0-9-]+\//, '')
  .replace(/[._:\s]+/g, '-')
  .replace(/-(20\d\d-?[01]\d-?[0-3]\d)(?=-|$)/g, '')
  .replace(/-(instruct|chat|it|hf|latest|preview|exp)(?=-|$)/g, '')
  .replace(/-+/g, '-').replace(/^-|-$/g, '');

/* Arena lists some models once per thinking setting ("-high", "-thinking"). The plain entry is
   the one that matches how a model is measured here, so it is preferred. */
const EFFORT = /-(thinking|reasoning|high|medium|low|minimal|max|xhigh|no-thinking|nothink)$/;

const tokens = (s) => new Set(core(s).split('-').filter(Boolean));
const overlap = (a, b) => {
  const x = tokens(a);
  const y = tokens(b);
  let n = 0;
  for (const t of x) if (y.has(t)) n += 1;
  return n / Math.max(1, Math.max(x.size, y.size));
};

/** The rating of each model we could place on the leaderboard, linking any not yet linked. */
export async function ratingsFor(modelIds, facts, { link = true, maxJev = 60 } = {}) {
  const ratings = await db.prepare('SELECT name, rating FROM arena_ratings').all();
  const out = new Map();
  if (!ratings.length) return out;
  const byName = new Map(ratings.map((r) => [r.name, r.rating]));
  const ids = [...new Set(modelIds)];
  const links = new Map((await db.prepare(
    `SELECT model_id, arena_name, linked_at FROM arena_links WHERE model_id = ANY(?)`).all(ids))
    .map((l) => [l.model_id, l]));
  const ttl = config.ARENA_LINK_TTL_DAYS * 86400000;
  const cores = ratings.map((r) => ({ name: r.name, core: core(r.name), plain: core(r.name).replace(EFFORT, '') }));
  let asked = 0;
  for (const id of ids) {
    const l = links.get(id);
    if (l && now() - l.linked_at < ttl) {
      if (l.arena_name && byName.has(l.arena_name)) out.set(id, byName.get(l.arena_name));
      continue;
    }
    if (!link) continue;
    const want = core(id);
    // exact core first, the plain entry preferred over a thinking-setting variant
    const exact = cores.filter((c) => c.core === want);
    const plain = exact.length ? exact : cores.filter((c) => c.plain === want);
    let name = null;
    let how = 'name';
    if (plain.length === 1) name = plain[0].name;
    else if (plain.length > 1) name = plain.sort((a, b) => a.name.length - b.name.length)[0].name;
    else if (jevUsable() && asked < maxJev) {
      const close = cores.map((c) => ({ ...c, s: overlap(id, c.name) })).filter((c) => c.s >= 0.5)
        .sort((a, b) => b.s - a.s).slice(0, 8);
      if (close.length) {
        asked += 1;
        name = await jevMatch(id, facts?.models?.get(id), close.map((c) => c.name));
        how = 'jev';
        /* Jev did not answer: nothing is known, so nothing is written. Written as "not on the
           leaderboard", a failure was believed for a month, and with Jev out of credit every
           model it was asked about read as unrated. */
        if (name === undefined) continue;
      }
    }
    await db.prepare(`INSERT INTO arena_links (model_id, arena_name, how, linked_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (model_id) DO UPDATE SET arena_name = excluded.arena_name, how = excluded.how,
                linked_at = excluded.linked_at`).run(id, name, how, now());
    if (name && byName.has(name)) out.set(id, byName.get(name));
  }
  return out;
}

async function jevMatch(id, model, names) {
  const criteria = { none: 'None of these entries is the same model' };
  names.forEach((n) => { criteria[n] = `The leaderboard entry named ${n}`; });
  try {
    const r = await ask(
      { model: { id, name: model?.name || id, description: String(model?.description || '').slice(0, 400) } },
      {
        same: {
          type: 'choice',
          instructions: 'Which leaderboard entry names exactly the same model as `model`: the same family, '
            + 'the same version and the same size? A different version or a different size is not the same '
            + 'model. Choose none when no entry is that exact model.',
          criteria,
        },
      },
    );
    const a = r.answers?.same;
    // no answer is not an answer: left unknown, and asked again next time
    if (!a || !a.choice) return undefined;
    if (a.choice === 'none' || (a.confidence ?? 0) < 0.6) return null;
    return names.includes(a.choice) ? a.choice : null;
  } catch {
    return undefined;
  }
}
