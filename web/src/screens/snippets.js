/* The code we show on Connect, built from this workspace's own endpoint and key.

   Every snippet is a list of lines, and a line can be marked as changed. That is the whole
   point of the screen: the customer should be able to see, at a glance, which line of their
   existing code is different, and nothing else is. The plain text is joined back together
   for the Copy button, so what they paste is exactly what they read. */

const L = (text, changed = false) => ({ text, changed });

export const LANGS = [
  { key: 'python', label: 'Python' },
  { key: 'node', label: 'Node.js' },
  { key: 'curl', label: 'cURL' },
  { key: 'claude', label: 'Instruct your Claude' },
];

export const WAYS = [
  {
    key: 'route',
    tag: 'one click to switch',
    title: 'Route through us',
    body: 'Change the base URL in the client you already use. Switching a model later is one click, with no deploy.',
  },
  {
    key: 'copy',
    tag: 'stay direct',
    title: 'Send us copies',
    body: 'Keep calling your own provider. Send us the request and the answer afterwards.',
  },
];

export function snippet(way, lang, { baseUrl, key }) {
  const k = key || 'us_live_…';
  if (way === 'route') {
    if (lang === 'python') {
      return [
        L('from openai import OpenAI'),
        L(''),
        L('client = OpenAI('),
        L(`    base_url="${baseUrl}",`, true),
        L(`    api_key="${k}",`, true),
        L(')'),
        L(''),
        L('client.chat.completions.create('),
        L('    model="openai/gpt-5.4",'),
        L('    messages=[{"role": "user", "content": "Extract the line items."}],'),
        L(')'),
      ];
    }
    if (lang === 'node') {
      return [
        L("import OpenAI from 'openai';"),
        L(''),
        L('const client = new OpenAI({'),
        L(`  baseURL: '${baseUrl}',`, true),
        L(`  apiKey: '${k}',`, true),
        L('});'),
        L(''),
        L('await client.chat.completions.create({'),
        L("  model: 'openai/gpt-5.4',"),
        L("  messages: [{ role: 'user', content: 'Extract the line items.' }],"),
        L('});'),
      ];
    }
    if (lang === 'curl') {
      return [
        L(`curl ${baseUrl}/chat/completions \\`, true),
        L(`  -H "Authorization: Bearer ${k}" \\`, true),
        L('  -H "Content-Type: application/json" \\'),
        L('  -d \'{"model": "openai/gpt-5.4",'),
        L('       "messages": [{"role": "user", "content": "Extract the line items."}]}\''),
      ];
    }
    return [
      L('Point my OpenAI client at Understudy instead of OpenAI.'),
      L(''),
      L(`Base URL: ${baseUrl}`, true),
      L(`API key:  ${k}`, true),
      L(''),
      L('Everything else stays as it is. Do not change the model I ask for,'),
      L('do not change the messages, and do not add any retry logic.'),
    ];
  }

  if (lang === 'python') {
    return [
      L('import httpx'),
      L(''),
      L('# after your own provider has answered'),
      L('httpx.post('),
      L(`    "${baseUrl}/traces",`, true),
      L(`    headers={"Authorization": "Bearer ${k}"},`, true),
      L('    json={"request": request, "response": response, "latency_ms": took},'),
      L(')'),
    ];
  }
  if (lang === 'node') {
    return [
      L('// after your own provider has answered'),
      L(`await fetch('${baseUrl}/traces', {`, true),
      L("  method: 'POST',"),
      L(`  headers: { Authorization: 'Bearer ${k}',`, true),
      L("             'Content-Type': 'application/json' },"),
      L('  body: JSON.stringify({ request, response, latency_ms: took }),'),
      L('});'),
    ];
  }
  if (lang === 'curl') {
    return [
      L(`curl ${baseUrl}/traces \\`, true),
      L(`  -H "Authorization: Bearer ${k}" \\`, true),
      L('  -H "Content-Type: application/json" \\'),
      L('  -d \'{"request": {…}, "response": {…}, "latency_ms": 820}\''),
    ];
  }
  return [
    L('After each call to our model provider, send a copy to Understudy.'),
    L(''),
    L(`POST ${baseUrl}/traces`, true),
    L(`Authorization: Bearer ${k}`, true),
    L(''),
    L('Body: the request we sent, the response we got, and how long it took.'),
    L('Do not change our own call in any way, and do not wait on the copy.'),
  ];
}

export const asText = (lines) => lines.map((l) => l.text).join('\n');
