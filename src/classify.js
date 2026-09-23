import crypto from 'node:crypto';

/* A workload is a request SHAPE, not a request. Two calls belong together when the
   job is the same, even though the data in them is completely different. No model
   call is involved in deciding this. */

/** Strip the data out of a prompt so only the template survives. */
export function normalizeSystem(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/"[^"]*"/g, ' str ')
    .replace(/'[^']*'/g, ' str ')
    .replace(/\b[0-9a-f]{8,}\b/g, ' id ')
    .replace(/\d+/g, ' n ')
    .replace(/\s+/g, ' ')
    .trim();
}

const schemaKeys = (schema, depth = 0) => {
  if (!schema || typeof schema !== 'object' || depth > 4) return [];
  const out = [];
  if (schema.properties && typeof schema.properties === 'object') {
    for (const k of Object.keys(schema.properties).sort()) {
      out.push(k);
      out.push(...schemaKeys(schema.properties[k], depth + 1).map((c) => `${k}.${c}`));
    }
  }
  if (schema.items) out.push(...schemaKeys(schema.items, depth + 1).map((c) => `[].${c}`));
  return out;
};

/** What kind of answer the call wants back. This decides how two answers are compared. */
export function shapeOf(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (tools.length) return 'tool_call';
  const rf = body?.response_format;
  const schema = rf?.json_schema?.schema ?? rf?.schema;
  if (rf?.type === 'json_schema' || rf?.type === 'json_object' || schema) {
    const props = schema?.properties ? Object.keys(schema.properties) : [];
    if (props.length === 1) {
      const only = schema.properties[props[0]];
      if (Array.isArray(only?.enum) && only.enum.length) return 'enum';
    }
    return 'json';
  }
  return 'free_text';
}

/** The signature two calls share when they are the same job. */
export function signatureOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages.filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .map((t) => t?.function?.name || t?.name || '').filter(Boolean).sort();
  const rf = body?.response_format;
  const schema = rf?.json_schema?.schema ?? rf?.schema;
  const shapeKind = shapeOf(body);
  const parts = [
    `sys:${normalizeSystem(system)}`,
    `tools:${tools.join(',')}`,
    `rf:${rf?.type || ''}`,
    `keys:${schemaKeys(schema).join(',')}`,
    `roles:${messages.map((m) => m.role).join('>')}`,
    `shape:${shapeKind}`,
  ];
  return {
    fingerprint: crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32),
    shapeKind,
    toolNames: tools,
    systemSample: system.slice(0, 400),
    schemaTitle: rf?.json_schema?.name || schema?.title || '',
  };
}

const FILLER = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'our', 'your', 'my', 'their',
  'is', 'are', 'was', 'be', 'to', 'of', 'in', 'on', 'at', 'for', 'from', 'with', 'and', 'or', 'but',
  'it', 'its', 'you', 'we', 'us', 'please', 'kindly', 'given', 'following', 'below', 'above', 'as',
  'into', 'out', 'up', 'down', 'by', 'about', 'only', 'just', 'each', 'every', 'any', 'all']);

/** A name a person would recognise, taken from the call itself. */
export function nameFor(sig) {
  if (sig.toolNames.length) return slug(sig.toolNames[0]);
  if (sig.schemaTitle) return slug(sig.schemaTitle);
  /* The instruction, wherever it was found. Falling back to the system prompt alone left
     every call that carries its instruction in the user turn named after a hash. */
  const words = (sig.template || sig.systemSample || '')
    .replace(/[^a-zA-Z ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !FILLER.has(w.toLowerCase()))
    .slice(0, 3);
  return words.length ? slug(words.join('-')) : `workload-${sig.fingerprint.slice(0, 6)}`;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  || 'workload';

export { slug };

/* Grouping calls that are the same job but not the same text -----------------------

   The exact fingerprint above is fast and right when it hits, and useless when it misses,
   which is most of the time. A prompt that carries a customer name, a date, or a rotating
   example produces a different fingerprint on every call, and a workspace ends up with
   thousands of workloads of one call each. The mirror of that is just as bad: with no
   system prompt at all there is almost nothing left to hash, and two completely different
   jobs collapse into one.

   So matching happens in two parts.

   STRUCTURE is hashed exactly, because it is stable: the tool names, the response format
   and its schema keys, the answer shape, the shape of the conversation. For a call with
   tools or a schema this is most of the answer already, because the schema IS the job.

   PROSE is compared by similarity rather than equality, using a SimHash of the instruction
   with the data normalised out of it. Two calls from the same code path share a template
   and differ only in what was interpolated, which survives that comparison; two different
   jobs do not. It costs nothing per call and gives the same answer every time, which
   matters more than it sounds: a call classified differently on different days would
   quietly change what the measurement underneath it was measuring. */

/** Where the instruction actually lives. Many apps put it in the user turn, not a system one. */
export function templateOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const text = (m) => (typeof m?.content === 'string'
    ? m.content
    : (Array.isArray(m?.content) ? m.content.map((p) => p?.text || '').join(' ') : ''));
  const system = messages.filter((m) => m.role === 'system').map(text).join('\n').trim();
  if (system) return normalizeSystem(system).slice(0, 600);
  /* An instruction comes before the data it acts on, and hands over at a colon, a newline
     or a fence. Taking the whole turn would let one pasted document drown the sentence it
     arrived with, which is the difference between "summarise this thread" matching another
     summarise call and matching nothing at all. */
  const first = normalizeSystem(text(messages.find((m) => m.role === 'user')));
  const cut = first.search(/[:\n]|\s-{3,}|```/);
  const head = cut > 8 ? first.slice(0, cut) : first;
  return head.split(/\s+/).filter(Boolean).slice(0, 14).join(' ');
}

/* The instruction a call opens its user turn with, when a system turn is there too.

   A long instruction shared by many jobs ("You are Acme's assistant. Follow these rules: ...") is
   most of what the matcher sees, and the part that says which job this is ("Summarise the thread
   below:", "Translate this into French:") comes after it, in the user turn, where the matcher does
   not look. Counted per workload, openings like these show when one workload is really several jobs:
   a chat's user turns open differently every time, and a job's open the same way every time. */
export function userHeadOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.some((m) => m.role === 'system')) return null;
  const user = messages.find((m) => m.role === 'user');
  const raw = typeof user?.content === 'string' ? user.content
    : (Array.isArray(user?.content) ? user.content.map((p) => p?.text || '').join(' ') : '');
  // cut where the instruction hands over to its data, before the line breaks are folded away
  const cut = raw.search(/[:\n]|\s-{3,}|```/);
  const head = normalizeSystem(cut > 8 ? raw.slice(0, cut) : raw);
  if (!head) return null;
  const words = head.split(/\s+/).filter(Boolean).slice(0, 10);
  return words.length >= 3 ? words.join(' ') : null;
}

export const headHashOf = (head) => crypto.createHash('sha256').update(String(head)).digest('hex').slice(0, 16);

/* The workload a call says it belongs to: the x-understudy-workload header, or metadata.workload in
   the body. A customer who names their jobs knows better than any matcher which calls are the same. */
export function workloadNameOf(headers, body) {
  const h = headers?.['x-understudy-workload'];
  const fromHeader = Array.isArray(h) ? h[0] : h;
  const meta = body?.metadata && typeof body.metadata === 'object' ? body.metadata : null;
  const v = fromHeader ?? meta?.understudy_workload ?? meta?.workload ?? null;
  if (v === null || v === undefined) return null;
  const name = String(v).trim().slice(0, 80);
  return /[a-z0-9]/i.test(name) ? name : null;
}

/* Whether a call must be answered by the model it names, whatever the workload was switched to:
   x-understudy-pin (or x-understudy-no-substitute) set to anything but "0" or "false", or
   metadata.understudy_pin. For the calls a customer cannot risk on anything else. */
export function pinnedOf(headers, body) {
  const h = headers?.['x-understudy-pin'] ?? headers?.['x-understudy-no-substitute'];
  const v = Array.isArray(h) ? h[0] : h;
  const meta = body?.metadata && typeof body.metadata === 'object' ? body.metadata.understudy_pin : undefined;
  const given = v ?? meta;
  if (given === undefined || given === null) return false;
  return !['0', 'false', 'no', ''].includes(String(given).trim().toLowerCase());
}

/** The part of a call that does not vary with the data, hashed exactly. */
export function structKeyOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .map((t) => t?.function?.name || t?.name || '').filter(Boolean).sort();
  const rf = body?.response_format;
  const schema = rf?.json_schema?.schema ?? rf?.schema;
  /* The exact number of turns varies with conversation length, so only the pattern counts:
     whether there is a system turn, and whether the exchange is one shot or a back and
     forth. Otherwise a chat on its fourth turn would be a different job from its third. */
  const roles = messages.map((m) => m.role);
  const pattern = [
    roles.includes('system') ? 'sys' : 'nosys',
    roles.filter((r) => r === 'assistant').length ? 'multi' : 'single',
  ].join(':');
  const parts = [
    `tools:${tools.join(',')}`,
    `rf:${rf?.type || ''}`,
    `keys:${schemaKeys(schema).join(',')}`,
    `shape:${shapeOf(body)}`,
    `turns:${pattern}`,
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

const shingles = (text, width = 3) => {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length < width) return words.length ? [words.join(' ')] : [];
  const out = [];
  for (let i = 0; i + width <= words.length; i += 1) out.push(words.slice(i, i + width).join(' '));
  return out;
};

/* 64 bits, kept as hex rather than a number on purpose. A 64-bit value does not fit in a
   JS number, and this project parses Postgres int8 into one, so storing it as an integer
   would round it and silently ruin every comparison. */
export function simhashOf(text) {
  const grams = shingles(text);
  if (!grams.length) return '0000000000000000';
  const bits = new Array(64).fill(0);
  /* The opening of an instruction counts for more than its tail, because that is how
     prompts are written: the framing comes first and stays put, and what varies is bolted
     on after it, a rotating example or a pasted document. Weighted evenly, a prompt whose
     last clause rotates drifts as far from itself as it does from a different job, and
     measured on real prompts the two ranges overlap outright: same-job pairs reached 27
     while different-job pairs came down to 25, so no threshold could separate them. */
  const n = grams.length;
  for (let gi = 0; gi < n; gi += 1) {
    const weight = gi < n / 3 ? 3 : (gi < (2 * n) / 3 ? 2 : 1);
    const h = crypto.createHash('sha1').update(grams[gi]).digest();
    for (let i = 0; i < 64; i += 1) {
      const bit = (h[i >> 3] >> (i & 7)) & 1;
      bits[i] += bit ? weight : -weight;
    }
  }
  let hex = '';
  for (let nibble = 0; nibble < 16; nibble += 1) {
    let v = 0;
    for (let b = 0; b < 4; b += 1) if (bits[nibble * 4 + b] > 0) v |= 1 << b;
    hex += v.toString(16);
  }
  return hex;
}

const POPCOUNT = new Uint8Array(16);
for (let i = 0; i < 16; i += 1) POPCOUNT[i] = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1);

/** How many of the 64 bits differ. 0 is identical text, 64 is nothing in common. */
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let n = 0;
  for (let i = 0; i < a.length; i += 1) n += POPCOUNT[(parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 15];
  return n;
}

/** Everything the matcher needs from one request, computed without calling a model. */
export function shapeSignals(body) {
  const sig = signatureOf(body);
  const template = templateOf(body);
  const structKey = structKeyOf(body);
  return {
    ...sig,
    structKey,
    template,
    userHead: userHeadOf(body),
    simhash: simhashOf(template),
    /* What the exact-match cache is keyed on. It has to carry the instruction: the older
       fingerprint hashes the system prompt, and a call with no system prompt has so little
       in it that unrelated jobs land on the same value and merge without ever being
       compared. */
    cacheKey: crypto.createHash('sha256').update(`${structKey}|${template}`).digest('hex').slice(0, 32),
  };
}
