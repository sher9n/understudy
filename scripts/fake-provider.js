/* A stand-in for the model provider, for looking at the product without a real key.

   It answers /models and /chat/completions the way OpenRouter does, including the per-call
   cost the whole billing path depends on. The reference model disagrees with itself
   occasionally, which is what gives a workload a bar worth clearing; one candidate is
   steadier and much cheaper, one drifts.

   Run it, then start the server with:
     OPENROUTER_API_KEY=stand-in OPENROUTER_BASE=http://127.0.0.1:4790/api/v1 npm start

   Nothing here is used in production: the real client is src/openrouter.js and it talks to
   whatever OPENROUTER_BASE points at. */

import http from 'node:http';

const PORT = Number(process.env.FAKE_PORT || 4790);

const MODELS = [
  { id: 'openai/gpt-5.4', name: 'GPT-5.4', context_length: 400000, pricing: { prompt: '0.0000025', completion: '0.000015' } },
  { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', context_length: 200000, pricing: { prompt: '0.000001', completion: '0.000005' } },
  { id: 'mistralai/mistral-small-3.2-24b-instruct', name: 'Mistral Small 3.2', context_length: 128000, pricing: { prompt: '0.0000002', completion: '0.0000006' } },
  { id: 'deepseek/deepseek-chat-v3.1', name: 'DeepSeek V3.1', context_length: 164000, pricing: { prompt: '0.00000025', completion: '0.00000095' } },
  { id: 'google/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', context_length: 1000000, pricing: { prompt: '0.0000001', completion: '0.0000004' } },
  { id: 'qwen/qwen3-235b-a22b-2507', name: 'Qwen3 235B', context_length: 262000, pricing: { prompt: '0.00000013', completion: '0.0000006' } },
];

/* How steady each model is. 0 means it always gives the same answer for the same call. */
const WOBBLE = {
  'openai/gpt-5.4': 0.028,
  'mistralai/mistral-small-3.2-24b-instruct': 0.012,
  'deepseek/deepseek-chat-v3.1': 0.022,
  'anthropic/claude-haiku-4.5': 0.026,
  'qwen/qwen3-235b-a22b-2507': 0.041,
  'google/gemini-2.5-flash-lite': 0.098,
  // a walk can make a model steadier or shakier: FAKE_WOBBLE='{"openai/gpt-5.4":0.1}'
  ...(() => { try { return JSON.parse(process.env.FAKE_WOBBLE || '{}'); } catch { return {}; } })(),
};

let seq = 0;
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

const server = http.createServer((req, res) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: MODELS }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* not json */ }
    const model = payload.model || 'openai/gpt-5.4';
    const price = MODELS.find((m) => m.id === model)?.pricing;
    if (!price) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no endpoints for ${model}` } }));
      return;
    }
    const user = (payload.messages || []).filter((m) => m.role === 'user').map((m) => m.content).join(' ');
    const wants = JSON.stringify(payload.response_format || {});
    seq += 1;
    /* Every model answers the same call the same way, which is the point: a good candidate
       agrees with the reference almost always. Its own wobble is the only thing that makes
       an answer differ, and how often that happens is what the bar measures. */
    const steady = hash(user);
    const wobbles = Math.random() < (WOBBLE[model] ?? 0.02);
    const wobbled = wobbles ? hash(`${user}#${seq}`) : steady;
    const answer = wants.includes('enum')
      ? JSON.stringify({ label: ['invoice', 'order', 'credit-note', 'receipt', 'quote', 'other'][Math.floor(wobbled * 6)] })
      : wants.includes('json')
        ? JSON.stringify({ number: Math.floor(hash(user) * 1e6), total: Math.round(wobbled * 900) / 10, lines: 1 + Math.floor(wobbled * 5) })
        : `Thanks for getting in touch about ${Math.floor(steady * 1e6)}. `
          + (wobbles ? 'A colleague will follow up shortly.' : 'We have looked into it and will follow up.');
    const prompt_tokens = 700 + Math.floor(steady * 300);
    const completion_tokens = 40 + Math.floor(wobbled * 120);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `gen-${seq}`,
      model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer } }],
      usage: {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
        cost: Number(price.prompt) * prompt_tokens + Number(price.completion) * completion_tokens,
      },
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stand-in provider on http://127.0.0.1:${PORT}/api/v1  (${MODELS.length} models)`);
});
