import { db, now } from '../db/index.js';
import { defOf, SIGNALS, describe } from './outcomes.js';

/* What the pages show about how a workload's calls turned out, and the tasks they were part of.
   Read-only, from the rows the traffic and the customer's reports already wrote. */

const DAY = 86400000;
const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const short = (m) => String(m || '').split('/').pop();

/** How a workload's calls turned out over a window: overall, day by day, by signal, by model. */
export async function outcomeSummary(workloadId, days = 30) {
  const since = now() - days * DAY;
  const def = await defOf(workloadId);
  const totals = await db.prepare(`SELECT COUNT(*) AS calls,
      COUNT(*) FILTER (WHERE reward IS NOT NULL) AS known,
      COUNT(*) FILTER (WHERE reward >= 0.5) AS worked,
      COUNT(*) FILTER (WHERE reward < 0.5) AS failed
    FROM calls WHERE workload_id = ? AND source IN ('routed', 'trace') AND created_at >= ?`).get(workloadId, since);

  // day by day, oldest first, each day labelled by the moment it ends (as the Dashboard does)
  const t0 = now();
  const first = t0 - (days - 1) * DAY;
  const series = Array.from({ length: days }, (_, i) => ({ at: first + i * DAY, calls: 0, known: 0, worked: 0 }));
  const rows = await db.prepare(`SELECT created_at, reward FROM calls WHERE workload_id = ? AND source IN ('routed', 'trace')
      AND created_at >= ?`).all(workloadId, since);
  for (const r of rows) {
    const b = Math.min(days - 1, Math.max(0, Math.ceil((Number(r.created_at) - first) / DAY)));
    series[b].calls += 1;
    if (r.reward !== null && r.reward !== undefined) {
      series[b].known += 1;
      if (Number(r.reward) >= 0.5) series[b].worked += 1;
    }
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

  // what each model that served calls here achieved, when anything is known about it
  const byModel = (await db.prepare(`SELECT served_model AS model, COUNT(*) AS calls,
      COUNT(*) FILTER (WHERE reward IS NOT NULL) AS known,
      COUNT(*) FILTER (WHERE reward >= 0.5) AS worked,
      AVG(COALESCE(NULLIF(charged_usd, 0), cost_usd)) AS cost, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) AS latency
    FROM calls WHERE workload_id = ? AND source IN ('routed', 'trace') AND created_at >= ? AND served_model IS NOT NULL
    GROUP BY served_model ORDER BY 2 DESC LIMIT 8`).all(workloadId, since))
    .map((r) => ({ model: r.model, calls: Number(r.calls), known: Number(r.known), worked: Number(r.worked),
      rate: Number(r.known) ? Number(r.worked) / Number(r.known) : null, cost: r.cost === null ? null : Number(r.cost),
      latency: r.latency === null ? null : Math.round(Number(r.latency)) }));

  const failures = (await db.prepare(`SELECT id, created_at, served_model, reward_json FROM calls WHERE workload_id = ?
      AND source IN ('routed', 'trace') AND reward < 0.5 AND created_at >= ? ORDER BY created_at DESC LIMIT 5`)
    .all(workloadId, since)).map((r) => ({ id: r.id, at: r.created_at, model: r.served_model, why: describe(parse(r.reward_json, [])) }));

  const known = Number(totals.known);
  return {
    days,
    calls: Number(totals.calls),
    known,
    worked: Number(totals.worked),
    failed: Number(totals.failed),
    rate: known ? Number(totals.worked) / known : null,
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
  const all = await db.prepare(`SELECT id, steps, tool_calls, tool_errors, retries, corrections, cost_usd, latency_ms, outcome,
      started_at, ended_at, workloads_json FROM tasks WHERE workloads_json LIKE ? AND ended_at >= ? ORDER BY ended_at DESC LIMIT 400`)
    .all(like, since);
  const n = all.length;
  const known = all.filter((t) => t.outcome !== null && t.outcome !== undefined);
  const overall = {
    tasks: n,
    avgSteps: n ? all.reduce((a, t) => a + Number(t.steps), 0) / n : null,
    avgCost: n ? all.reduce((a, t) => a + Number(t.cost_usd), 0) / n : null,
    avgLatency: n ? all.reduce((a, t) => a + Number(t.latency_ms), 0) / n : null,
    withToolErrors: all.filter((t) => Number(t.tool_errors) > 0).length,
    rate: known.length ? known.filter((t) => Number(t.outcome) >= 0.5).length / known.length : null,
    known: known.length,
    // how many steps tasks take, for a small bar chart
    steps: [1, 2, 3, 4, 5, 6].map((k) => ({ steps: k === 6 ? '6+' : String(k), n: all.filter((t) => (k === 6 ? Number(t.steps) >= 6 : Number(t.steps) === k)).length })),
  };
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
