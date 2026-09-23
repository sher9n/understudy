import { ApiError, messageOf, OFFLINE } from './api.js';

/* The calls the newer screens make: workspace choices in Settings, and what a workload's page needs
   about a switch in progress. The same rules as the main client: every failure is an ApiError with
   a sentence somebody can read. */

const send = async (method, path, body) => {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(OFFLINE, { network: true });
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new ApiError(messageOf(json, res.status), { status: res.status, signedOut: res.status === 401 });
  return json;
};

export const more = {
  // how new workloads are switched, and whether workloads you have follow
  setDefaultMode: (mode, applyToExisting = false) => send('POST', '/settings/default-mode', { mode, applyToExisting }),
  // whether your results (never your content) help other workspaces choose
  setShareStats: (enabled) => send('POST', '/settings/share-stats', { enabled }),
  // the most optimizing may spend over thirty days; null for no budget
  setOptimizeBudget: (amountUsd) => send('POST', '/settings/optimize-budget', { amountUsd }),
  // marking long instructions for caching where that pays
  setCacheHints: (enabled) => send('POST', '/settings/cache-hints', { enabled }),
  // the most calls may cost through us in a day and a month; null for none
  setLimits: (dailyUsd, monthlyUsd) => send('POST', '/settings/limits', { dailyUsd, monthlyUsd }),
  // which emails the workspace gets
  setNotify: (kinds) => send('POST', '/settings/notify', { kinds }),
  // only providers that keep nothing, or also ones that keep data briefly
  setZdr: (required) => send('POST', '/settings/zdr', { required }),
  // a switch: all at once rather than a share at a time, when a person approves it
  promote: (id, model, { rollout = true } = {}) => send('POST', `/workloads/${id}/promote`, { model, rollout }),
  // a switch still taking over, given every call now
  finishRollout: (id) => send('POST', `/workloads/${id}/rollout/finish`),
};
