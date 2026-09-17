import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import config from '../config.js';

const dir = path.resolve(process.cwd(), config.DATA_DIR);
fs.mkdirSync(dir, { recursive: true });

export const db = new Database(path.join(dir, config.DB_FILE));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export const now = () => Date.now();

/** A short, sortable id. Readable in a log, unique enough for one workspace's traffic. */
export const id = (prefix) =>
  `${prefix}_${now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Money is stored as a number of dollars, rounded where it is written, never on read. */
export const round8 = (n) => Math.round(n * 1e8) / 1e8;
export const usd = (n) => Math.round(n * 100) / 100;

export default db;
