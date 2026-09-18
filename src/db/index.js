/* Postgres, behind the same small surface the app already used.

   The app was written against better-sqlite3, which is synchronous. Postgres is not, so
   every call site gains an `await`. Nothing else about them changes: `prepare(sql)` still
   returns something with `.get`, `.all` and `.run`, and the SQL keeps whichever placeholder
   style it was written in. That is deliberate. Rewriting a hundred and twenty statements by
   hand to a new API would have been a hundred and twenty chances to change behaviour by
   accident, in code that moves money.

   Two conversions happen here:

     ?      positional, in the order they appear        -> $1, $2, ...
     @name  named, filled from a single object argument -> $1, $2, ...

   A placeholder inside a quoted string is left alone, because '?' is data. */

import pg from 'pg';
import config from '../config.js';

/* Postgres returns int8 as a string, because it can hold more than a JS number can. Every
   timestamp in this schema is epoch milliseconds, which is nowhere near that limit, and the
   whole app does arithmetic on them. Left alone, `now() - created_at` would concatenate two
   strings, and every age on every screen would be quietly wrong rather than broken. */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ...(config.PG_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on('error', (err) => {
  // an idle client dropped by the server: the pool replaces it, we only note it
  console.error('postgres idle client error:', err.message);
});

/** Split SQL on placeholders while ignoring anything inside single quotes. */
function compile(sql) {
  let out = '';
  let n = 0;
  const names = [];
  let quoted = false;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (c === "'") { quoted = !quoted; out += c; continue; }
    if (quoted) { out += c; continue; }
    if (c === '?') { n += 1; names.push(null); out += `$${n}`; continue; }
    if (c === '@') {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (m) { n += 1; names.push(m[1]); out += `$${n}`; i += m[0].length - 1; continue; }
    }
    out += c;
  }
  return { text: out, names };
}

const cache = new Map();
const compiled = (sql) => {
  let hit = cache.get(sql);
  if (!hit) { hit = compile(sql); cache.set(sql, hit); }
  return hit;
};

/** Turn whatever the call site passed into the positional array Postgres wants. */
function bind(names, args) {
  if (!names.some(Boolean)) return args;
  const obj = args[0] || {};
  return names.map((name, i) => (name ? obj[name] : args[i]));
}

const runner = (exec) => (sql) => {
  const { text, names } = compiled(sql);
  return {
    async get(...args) { return (await exec(text, bind(names, args))).rows[0]; },
    async all(...args) { return (await exec(text, bind(names, args))).rows; },
    async run(...args) {
      const r = await exec(text, bind(names, args));
      // better-sqlite3 reported `changes`, and a few places still read that name
      return { changes: r.rowCount ?? 0, rows: r.rows };
    },
  };
};

export const db = {
  prepare: runner((text, params) => pool.query(text, params)),
  async exec(sql) { await pool.query(sql); },
  /** Everything inside runs on one connection, and rolls back together if it throws. */
  async tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = {
        prepare: runner((text, params) => client.query(text, params)),
        exec: async (sql) => { await client.query(sql); },
      };
      const result = await fn(scoped);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* the connection is going anyway */ }
      throw err;
    } finally {
      client.release();
    }
  },
  async close() { await pool.end(); },
};

export const now = () => Date.now();

/** A short, sortable id. Readable in a log, unique enough for one workspace's traffic. */
export const id = (prefix) =>
  `${prefix}_${now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Money is stored as a number of dollars, rounded where it is written, never on read. */
export const round8 = (n) => Math.round(n * 1e8) / 1e8;
export const usd = (n) => Math.round(n * 100) / 100;

export default db;
