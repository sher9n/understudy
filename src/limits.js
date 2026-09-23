import { db, now } from './db/index.js';
import config from './config.js';

/* Counting requests, so one machine or one address cannot hammer the doors that are open to
   anybody: signing in, asking for codes, signing up, the contact form.

   The counts live in the database rather than in memory, so they hold across a restart and
   across more than one instance. Two requests arriving in the same instant can both squeeze in
   under a limit, which is fine for this purpose: it is a brake, not a ledger. */

/** Record one event and say whether it was within the limit. Events over the limit are not counted. */
export async function allow(bucket, key, { max, windowMs }) {
  if (!key || !(max > 0)) return true;
  const since = now() - windowMs;
  const n = Number((await db.prepare(
    'SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND key = ? AND created_at > ?')
    .get(bucket, String(key).slice(0, 200), since))?.n ?? 0);
  if (n >= max) return false;
  await db.prepare('INSERT INTO rate_events (bucket, key, created_at) VALUES (?, ?, ?)')
    .run(bucket, String(key).slice(0, 200), now());
  return true;
}

/** How many events a key has in the window, without adding one. */
export async function countOf(bucket, key, windowMs) {
  return Number((await db.prepare(
    'SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND key = ? AND created_at > ?')
    .get(bucket, String(key).slice(0, 200), now() - windowMs))?.n ?? 0);
}

/* The address a request came from, which every per-address limit is keyed on.

   Railway's edge sets X-Real-IP to the address that connected to it, and has refused a client's own
   X-Real-IP since August 2024, so it cannot be forged from outside. Production answers straight from
   the edge (server: railway-hikari, no CDN headers, checked 2026-09-23), where that address is the
   client's. With Railway's CDN in front it is the CDN's instead, which would put every visitor behind
   one address into one limit; Railway's advice for that case (March 2026) is the first entry of
   X-Forwarded-For, which its edge controls. CLIENT_IP_FROM chooses: 'x-real-ip' (the default) or
   'xff-first'. Without either header, the right-most X-Forwarded-For entry, then the socket. */
export function clientIp(req) {
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (config.CLIENT_IP_FROM === 'xff-first' && xff.length) return xff[0];
  const real = req.headers?.['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  if (xff.length) return xff[xff.length - 1];
  return req.socket?.remoteAddress || 'unknown';
}

/** Old events are only ever read inside their window, so anything past a couple of days goes. */
export async function pruneLimits() {
  return (await db.prepare('DELETE FROM rate_events WHERE created_at < ?').run(now() - 2 * 86400000)).changes;
}
