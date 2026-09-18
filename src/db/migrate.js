import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'migrations');

/** Numbered SQL files, applied once each, in name order. Never edit one that has shipped.
 *
 *  Each file runs inside its own transaction together with the row that records it, so a
 *  migration either lands completely or not at all, and a crash halfway through cannot
 *  leave the database believing it has a table it does not have. */
export async function migrate({ quiet = false } = {}) {
  await db.exec(`CREATE TABLE IF NOT EXISTS migrations (
                   name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`);
  const done = new Set((await db.prepare('SELECT name FROM migrations').all()).map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await db.tx(async (tx) => {
      await tx.exec(sql);
      await tx.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(file, now());
    });
    applied += 1;
    if (!quiet) console.log(`migrated ${file}`);
  }
  return { applied, total: files.length };
}

export default migrate;
