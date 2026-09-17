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
  const words = sig.systemSample
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
