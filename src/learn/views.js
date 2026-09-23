import { db, now } from '../db/index.js';
import config from '../config.js';
import { defOf, SIGNALS, describe } from './outcomes.js';

/* What the pages show about how a workload's calls turned out, and the tasks they were part of.
   Read-only, from the rows the traffic and the customer's reports already wrote. */

const DAY = 86400000;
const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const short = (m) => String(m || '').split('/').pop();

/* How a call turned out, in the four groups every screen uses: a problem was seen, it was confirmed
   to have worked, nothing went wrong that anything could see, or it is too recent to say. The
   learning layer (src/learn/explore.js) agrees on what counts, silence as working and a failed call
   as a problem, and differs in two ways: it keeps partial credit where these screens round each call
   to worked or not, and it only reads calls that came through us, where these screens show copies too. A call only counts once a retry or
   a correction would have had time to arrive. Calls refused for the customer's own reasons, a
   malformed request or a spent balance, say nothing about how serving went and are left out. */
export const COUNTED = `(status_code IS NULL OR status_code = 200 OR status_code IN (0, 404, 408, 429) OR status_code >= 500)`;
export const OKAY = `(status_code IS NULL OR status_code = 200)`;
export const GROUPS = `COUNT(*) AS calls,
      COUNT(*) FILTER (WHERE NOT ${OKAY} OR reward < 0.5) AS problem,
      COUNT(*) FILTER (WHERE ${OKAY} AND reward >= 0.5) AS confirmed,
      COUNT(*) FILTER (WHERE ${OKAY} AND reward IS NULL AND created_at < ?) AS quiet,
      COUNT(*) FILTER (WHERE ${OKAY} AND reward IS NULL AND created_at >= ?) AS recent,
      COUNT(*) FILTER (WHERE reward IS NOT NULL) AS known`;
export const settledAt = () => now() - config.LEARN_SETTLE_MIN * 60000;
export const grouped = (r) => {
  const g = { calls: Number(r.calls), problem: Number(r.problem), confirmed: Number(r.confirmed), quiet: Number(r.quiet),
    recent: Number(r.recent), known: Number(r.known) };
  const judged = g.calls - g.recent;
  return { ...g, rate: judged > 0 ? (g.confirmed + g.quiet) / judged : null };
};

/** How a workspace's calls turned out over a window, across every workload. */
export async function outcomeTotals(workspaceId, since) {
  const at = settledAt();
  return grouped(await db.prepare(`SELECT ${GROUPS} FROM calls WHERE workspace_id = ? AND workload_id IS NOT NULL
      AND source IN ('routed', 'trace') AND created_at >= ? AND ${COUNTED}`).get(at, at, workspaceId, since));
}

/** How a workload's calls turned out over a window: overall, day by day, by signal, by model. */
export async function outcomeSummary(workloadId, days = 30) {
  const since = now() - days * DAY;
  const at = settledAt();
  const def = await defOf(workloadId);
  const totals = grouped(await db.prepare(`SELECT ${GROUPS}
    FROM calls WHERE workload_id = ? AND source IN ('routed', 'trace') AND created_at >= ? AND ${COUNTED}`).get(at, at, workloadId, since));

  // day by day, oldest first, each day labelled by the moment it ends (as the Dashboard does)
  const t0 = now();
  const first = t0 - (days - 1) * DAY;
  const series = Array.from({ length: days }, (_, i) => ({ at: first + i * DAY, calls: 0, problem: 0, confirmed: 0, quiet: 0, recent: 0 }));
  // counted in the database a day at a time, rather than every call brought back to be counted here
  const byDay = await db.prepare(`SELECT LEAST(${days - 1}, GREATEST(0, CEIL((created_at - ?) / 86400000.0)::int)) AS b, ${GROUPS}
    FROM calls WHERE workload_id = ? AND source IN ('routed', 'trace') AND created_at >= ? AND ${COUNTED}
    GROUP BY 1`).all(first, at, at, workloadId, since);
  for (const r of byDay) {
    const d = series[Number(r.b)];
    if (!d) continue;
    for (const k of ['calls', 'problem', 'confirmed', 'quiet', 'recent']) d[k] += Number(r[k]);
  }

  const signals = (await db.prepare(`SELECT kind, COUNT(*) AS n FROM outcomes WHERE workload_id = ? AND occurred_at >= ?
      AND kind <> 'reported' GROUP BY kind ORDER BY 2 DESC`).all(workloadId, since))
    .map((r) => ({ kind: r.kind, n: Number(r.n), worked: SIGNALS[r.kind]?.value === 1, words: SIGNALS[r.kind]?.words || r.kind }));

  const events = (await db.prepare(`SELECT event, COUNT(*) AS n, COUNT(*) FILTER (WHERE value IS NULL) AS waiting
      FROM outcomes WHERE workload_id = ? AND kind = 'reported' AND occurred_at >= ? GROUP BY event ORDER BY 2 DESC`)
    .all(workloadId, since)).map((r) => {
    const d = def.events.find((e) => e.event === r.event);
    return { event: r.event, n: Number(r.n), means: d?.means ?? null, waiting: Number(r.waiting) };
  });

  // what each model that served calls here achieved, the same four ways
  const byModel = (await db.prepare(`SELECT served_model AS model, ${GROUPS},
      AVG(COALESCE(NULLIF(charged_usd, 0), cost_usd)) AS cost, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) AS latency
    FROM calls WHERE workload_id = ? AND source IN ('routed', 'trace') AND created_at >= ? AND served_model IS NOT NULL AND ${COUNTED}
    GROUP BY served_model ORDER BY 2 DESC LIMIT 8`).all(at, at, workloadId, since))
    .map((r) => ({ model: r.model, ...grouped(r), cost: r.cost === null ? null : Number(r.cost),
      latency: r.latency === null ? null : Math.round(Number(r.latency)) }));

  const failures = (await db.prepare(`SELECT id, created_at, served_model, reward_json, status_code FROM calls WHERE workload_id = ?
      AND source IN ('routed', 'trace') AND created_at >= ? AND ${COUNTED} AND (reward < 0.5 OR NOT ${OKAY})
      ORDER BY created_at DESC LIMIT 5`)
    .all(workloadId, since)).map((r) => ({ id: r.id, at: r.created_at, model: r.served_model,
    // always a list, whatever went wrong: a failed call is one reason, a signal-read call has its own
    why: r.status_code !== null && r.status_code !== undefined && Number(r.status_code) !== 200
      ? [Number(r.status_code) === 0 ? 'the provider could not be reached' : `the provider failed the call (${r.status_code})`]
      : describe(parse(r.reward_json, [])) }));

  return {
    days,
    ...totals,
    // kept under their first names too: a call confirmed to have worked, and one with a problem
    worked: totals.confirmed,
    failed: totals.problem,
    settleMin: config.LEARN_SETTLE_MIN,
    series,
    signals,
    events,
    byModel,
    failures,
    def: { events: def.events, signals: def.signals, windowDays: def.windowDays, custom: def.custom },
  };
}

/* The tasks a workload's calls were steps in: recent ones in full, step by step, and what tasks
   look like overall. A task here is a conversation or an agent's loop that took more than one
   call; a single call on its own is not shown as one. */
export async function tasksFor(workloadId, { limit = 6, days = 30 } = {}) {
  const since = now() - days * DAY;
  const like = `%"${workloadId}"%`;
  /* Read through the workspace, which the tasks are kept under, so a page open never reads every
     customer's tasks; and counted in the database, so a busy workload's figures are all of its tasks
     rather than the newest few hundred. A task is two calls or more: one call on its own is not one. */
  const w = await db.prepare('SELECT workspace_id FROM workloads WHERE id = ?').get(workloadId);
  const ws = w?.workspace_id ?? '';
  const agg = await db.prepare(`SELECT COUNT(*) AS n, AVG(steps) AS steps, AVG(cost_usd) AS cost, AVG(latency_ms) AS latency,
      COUNT(*) FILTER (WHERE tool_errors > 0) AS tool_errors,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) AS known,
      COUNT(*) FILTER (WHERE outcome >= 0.5) AS worked,
      COUNT(*) FILTER (WHERE steps = 2) AS s2, COUNT(*) FILTER (WHERE steps = 3) AS s3,
      COUNT(*) FILTER (WHERE steps = 4) AS s4, COUNT(*) FILTER (WHERE steps = 5) AS s5,
      COUNT(*) FILTER (WHERE steps >= 6) AS s6
    FROM tasks WHERE workspace_id = ? AND workloads_json LIKE ? AND ended_at >= ? AND steps > 1`).get(ws, like, since);
  const n = Number(agg?.n || 0);
  const known = Number(agg?.known || 0);
  const overall = {
    tasks: n,
    avgSteps: n ? Number(agg.steps) : null,
    avgCost: n ? Number(agg.cost) : null,
    avgLatency: n ? Number(agg.latency) : null,
    withToolErrors: Number(agg?.tool_errors || 0),
    rate: known ? Number(agg.worked) / known : null,
    known,
    // how many steps tasks take, for a small bar chart
    steps: [2, 3, 4, 5, 6].map((k) => ({ steps: k === 6 ? '6+' : String(k), n: Number(agg?.[`s${k}`] || 0) })),
  };
  const all = await db.prepare(`SELECT id, steps, tool_calls, tool_errors, retries, corrections, cost_usd, latency_ms, outcome,
      started_at, ended_at, workloads_json FROM tasks WHERE workspace_id = ? AND workloads_json LIKE ? AND ended_at >= ? AND steps > 1
      ORDER BY ended_at DESC LIMIT ?`).all(ws, like, since, limit);
  const recent = [];
  for (const t of all.slice(0, limit)) {
    const steps = await db.prepare(`SELECT c.id, c.step, c.workload_id, w.slug, c.served_model, c.latency_ms,
        COALESCE(NULLIF(c.charged_usd, 0), c.cost_usd) AS cost, c.reward, c.reward_json, c.response_json, c.created_at
      FROM calls c LEFT JOIN workloads w ON w.id = c.workload_id WHERE c.task_id = ? ORDER BY c.created_at LIMIT 30`).all(t.id);
    recent.push({
      id: t.id, steps: Number(t.steps), toolErrors: Number(t.tool_errors), retries: Number(t.retries), corrections: Number(t.corrections),
      cost: Number(t.cost_usd), latency: Number(t.latency_ms), outcome: t.outcome === null ? null : Number(t.outcome),
      startedAt: Number(t.started_at), endedAt: Number(t.ended_at),
      detail: steps.map((s) => {
        const msg = parse(s.response_json, null)?.choices?.[0]?.message;
        const tools = Array.isArray(msg?.tool_calls) ? msg.tool_calls.map((c) => c?.function?.name).filter(Boolean) : [];
        return {
          id: s.id, step: Number(s.step || 1), workload: s.slug || null, here: s.workload_id === workloadId,
          model: short(s.served_model), latency: s.latency_ms === null ? null : Number(s.latency_ms),
          cost: s.cost === null ? null : Number(s.cost), tools, reward: s.reward === null ? null : Number(s.reward),
          why: describe(parse(s.reward_json, [])),
        };
      }),
    });
  }
  return { overall, recent };
}
