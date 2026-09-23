import { db } from './db/index.js';
import config from './config.js';

/* Choices a workspace makes that the proxy reads on every call, kept for half a minute so a busy
   workload does not ask the database the same question thousands of times. A change on Settings
   forgets the copy, so it takes effect at once on this instance and within half a minute on others. */

const memo = new Map();
const TTL_MS = 30000;

async function choicesOf(workspaceId) {
  const hit = memo.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const ws = await db.prepare('SELECT zdr_required, cache_hints, daily_limit_usd, monthly_limit_usd FROM workspaces WHERE id = ?').get(workspaceId);
  const v = {
    zdr: ws ? Number(ws.zdr_required ?? 1) !== 0 : config.ZDR_ONLY,
    cacheHints: ws ? Number(ws.cache_hints ?? 1) !== 0 : true,
    dailyLimit: ws?.daily_limit_usd === null || ws?.daily_limit_usd === undefined ? null : Number(ws.daily_limit_usd),
    monthlyLimit: ws?.monthly_limit_usd === null || ws?.monthly_limit_usd === undefined ? null : Number(ws.monthly_limit_usd),
  };
  memo.set(workspaceId, { at: Date.now(), v });
  if (memo.size > 5000) memo.clear();
  return v;
}

/** Whether this workspace's calls may only go to providers that keep nothing. */
export async function zdrFor(workspaceId) {
  if (!workspaceId) return config.ZDR_ONLY;
  // a deployment that requires it for everybody is never loosened by one workspace
  if (config.ZDR_FORCED) return true;
  return (await choicesOf(workspaceId)).zdr;
}

/* Whether calls from this workload to this model come often enough, and the workspace lets us, to mark
   a long instruction for caching: a cache written and never read costs a quarter more than no cache at
   all. Counted for the model the call is sent to, because only calls to the same model read a cache
   back. Counted for the whole workload, every call was marked: the customer's own model answering a few
   calls a day as the yardstick, a runner-up an experiment tries, a switch's first small share, each
   paid to write a cache it seldom read back within its five minutes. That cost the customer more, and
   the yardstick's inflated price made what serves look cheaper against it than it is. Read at most
   every five minutes a workload and model, never on every call. */
const hintMemo = new Map();
export async function cacheHintFor(workspaceId, workload, model) {
  if (!config.CACHE_HINTS || !workload?.id || !workspaceId || !model) return false;
  if (!(await choicesOf(workspaceId)).cacheHints) return false;
  const key = `${workload.id}|${model}`;
  const hit = hintMemo.get(key);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.v;
  const n = (await db.prepare(
    `SELECT COUNT(*) AS n FROM calls WHERE workload_id = ? AND source = 'routed' AND served_model = ? AND status_code = 200
        AND created_at >= ?`).get(workload.id, model, Date.now() - 3600000))?.n ?? 0;
  const v = Number(n) >= config.CACHE_HINT_MIN_PER_HOUR;
  hintMemo.set(key, { at: Date.now(), v });
  if (hintMemo.size > 5000) hintMemo.clear();
  return v;
}

/** The most this workspace's calls may cost through us in a day and in a month, or null for none. */
export async function limitsFor(workspaceId) {
  if (!workspaceId) return { dailyLimit: null, monthlyLimit: null };
  const c = await choicesOf(workspaceId);
  return { dailyLimit: c.dailyLimit, monthlyLimit: c.monthlyLimit };
}

/** Forget every workload's call rates, so the next call reads them again (for tests, and after a setting changes). */
export const forgetHints = () => hintMemo.clear();

export const forgetWorkspace = (workspaceId) => memo.delete(workspaceId);
