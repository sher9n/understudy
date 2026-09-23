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
  const ws = await db.prepare('SELECT zdr_required FROM workspaces WHERE id = ?').get(workspaceId);
  const v = { zdr: ws ? Number(ws.zdr_required ?? 1) !== 0 : config.ZDR_ONLY };
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

export const forgetWorkspace = (workspaceId) => memo.delete(workspaceId);
