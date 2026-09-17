/* Two accounts for looking around, with a short password on purpose. Sign up through the
   product still requires 8 characters; this deliberately goes around that, which is why it
   is a script you run rather than something the app will do for you. */

import crypto from 'node:crypto';
import { db, id, now } from '../src/db/index.js';
import { issueKey } from '../src/keys.js';
import migrate from '../src/db/migrate.js';
import config from '../src/config.js';

migrate({ quiet: true });

const PASSWORD = 'demo';
const PEOPLE = [
  { email: 'sherancorera@gmail.com', name: 'Sheran Corera' },
  { email: 'sheran.corera@docupath.ai', name: 'Sheran Corera' },
  /* Deliberately left with no traffic, and never seeded, so there is always an account
     that still sees the three step getting started guide. The other two have traffic, so
     they are connected and go straight to the dashboard, which is the intended behaviour
     and is why onboarding cannot be seen from them. */
  { email: 'new@understudy.demo', name: 'New Customer' },
];

for (const p of PEOPLE) {
  const email = p.email.toLowerCase();
  const salt = crypto.randomBytes(16).toString('hex');
  const pw_hash = crypto.scryptSync(PASSWORD, salt, 64).toString('hex');
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

  if (existing) {
    db.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, name = ? WHERE id = ?')
      .run(pw_hash, salt, p.name, existing.id);
    console.log(`${email}: password reset`);
    continue;
  }

  const user = { id: id('usr'), email, name: p.name, pw_hash, pw_salt: salt, created_at: now() };
  const ws = { id: id('ws'), owner_user_id: user.id, name: 'Understudy', mode: 'route', retention_days: config.RETENTION_DAYS, created_at: now() };
  db.transaction(() => {
    db.prepare(`INSERT INTO users (id, email, name, pw_hash, pw_salt, created_at)
                VALUES (@id, @email, @name, @pw_hash, @pw_salt, @created_at)`).run(user);
    db.prepare(`INSERT INTO workspaces (id, owner_user_id, name, mode, retention_days, created_at)
                VALUES (@id, @owner_user_id, @name, @mode, @retention_days, @created_at)`).run(ws);
    db.prepare('INSERT INTO billing_accounts (workspace_id, balance_usd, updated_at) VALUES (?, 0, ?)')
      .run(ws.id, now());
  })();
  const key = issueKey(ws.id);
  console.log(`${email}: created, key ${key.secret}`);
}
console.log(`\nThey all sign in with the password "${PASSWORD}".`);
