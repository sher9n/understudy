import { request } from './api.js';

/* The calls the newer screens make: workspace choices in Settings, and what a workload's page needs
   about a switch in progress. They go through the main client, so a failure is an ApiError with a
   sentence somebody can read, and a session that ended is told to the frame like any other; a copy of
   the client here used to throw that 401 away, so the app never offered to sign in again. */

const send = request;

export const more = {
  // how new workloads are switched, and whether workloads you have follow
  setDefaultMode: (mode, applyToExisting = false) => send('POST', '/settings/default-mode', { mode, applyToExisting }),
  // whether your results (never your content) help other workspaces choose
  setShareStats: (enabled) => send('POST', '/settings/share-stats', { enabled }),
  // the most optimizing may spend over thirty days; null for no budget
  // the testing limit: an amount, null for the default, or { none: true } for no limit at all
  setOptimizeBudget: (amountUsd, { none = false } = {}) => send('POST', '/settings/optimize-budget', none ? { none: true } : { amountUsd }),
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
