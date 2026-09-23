import { db, id, now } from './db/index.js';
import config from './config.js';
import send, { noticeEmail } from './email.js';

/* Emails about a customer's own workspace, for the things they would want to hear about without
 * opening a page: a switch made, a candidate waiting for their say, a switch taken back, money or a
 * limit about to stop their calls.
 *
 * Each event is told once (the table's unique key is the workspace, the kind and the thing it is
 * about), at most NOTIFY_MAX_PER_DAY emails a workspace a day, and only the kinds the workspace keeps
 * switched on in Settings. Sent to the workspace's owner. Nothing here ever holds up a call or a
 * measurement: an email that fails is noted, and the work goes on. */

export const NOTIFY_KINDS = {
  switched: 'A workload was switched to a cheaper model, or its switch grew to all of its calls',
  waiting: 'A cheaper model cleared and is waiting for your approval',
  reverted: 'A switch was taken back',
  money: 'Your balance is running low, a top up failed, or a spending limit was reached',
};

export function notifyPrefs(ws) {
  const out = Object.fromEntries(Object.keys(NOTIFY_KINDS).map((k) => [k, true]));
  try {
    const saved = ws?.notify_json ? JSON.parse(ws.notify_json) : null;
    if (saved && typeof saved === 'object') for (const k of Object.keys(out)) if (typeof saved[k] === 'boolean') out[k] = saved[k];
  } catch { /* an unreadable choice keeps the defaults */ }
  return out;
}

const DAY = 86400000;

/**
 * Tell the workspace about one event, once.
 * @param kind  one of NOTIFY_KINDS
 * @param ref   what it is about (a workload and a run, a date), so the same event is never told twice
 */
export async function notify(workspaceId, kind, ref, { title, lines = [], path = null, linkText = null }) {
  try {
    if (!config.NOTIFY_ENABLED || !NOTIFY_KINDS[kind] || !workspaceId) return { sent: false, reason: 'off' };
    const ws = await db.prepare(
      `SELECT w.id, w.notify_json, u.email FROM workspaces w JOIN users u ON u.id = w.owner_user_id WHERE w.id = ?`).get(workspaceId);
    if (!ws?.email) return { sent: false, reason: 'no one to tell' };
    if (!notifyPrefs(ws)[kind]) return { sent: false, reason: 'switched off' };
    const today = (await db.prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND created_at >= ? AND status = 'sent'`)
      .get(workspaceId, now() - DAY)).n;
    if (Number(today) >= config.NOTIFY_MAX_PER_DAY) return { sent: false, reason: 'enough for today' };
    const nid = id('ntf');
    const claimed = await db.prepare(
      `INSERT INTO notifications (id, workspace_id, kind, ref, sent_to, subject, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?) ON CONFLICT (workspace_id, kind, ref) DO NOTHING RETURNING id`)
      .run(nid, workspaceId, kind, String(ref).slice(0, 300), ws.email, String(title).slice(0, 300), now());
    if (!claimed.rows.length) return { sent: false, reason: 'already told' };
    const link = path ? `${config.PUBLIC_URL}${path}` : null;
    const mail = noticeEmail({
      title, lines, link, linkText: linkText || 'Open it in Understudy',
      footer: `You get these because they are switched on in Settings, under Emails. ${config.PUBLIC_URL}/settings`,
    });
    const r = await send({ to: ws.email, ...mail });
    await db.prepare('UPDATE notifications SET status = ?, error = ?, sent_at = ? WHERE id = ?')
      .run(r.ok ? 'sent' : 'failed', r.ok ? null : String(r.reason || '').slice(0, 300), now(), nid);
    return { sent: !!r.ok };
  } catch (err) {
    console.error(`notifying ${workspaceId} of ${kind} failed: ${err?.message || err}`);
    return { sent: false, reason: 'error' };
  }
}
