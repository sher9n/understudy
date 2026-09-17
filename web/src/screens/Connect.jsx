import React, { useState } from 'react';
import { api } from '../api.js';

const snippets = (base, key) => ({
  python: `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="${key}",
)

client.chat.completions.create(
    model="openai/gpt-5.4",
    messages=[{"role": "user", "content": "Extract the line items."}],
)`,
  node: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: "${key}",
});

await client.chat.completions.create({
  model: "openai/gpt-5.4",
  messages: [{ role: "user", content: "Extract the line items." }],
});`,
  curl: `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "openai/gpt-5.4",
    "messages": [{"role": "user", "content": "Extract the line items."}]
  }'`,
  claude: `Point our OpenAI client at Understudy.

Change only the base URL to ${base} and read the key from
UNDERSTUDY_KEY in the environment. Leave every model argument exactly as it
is: Understudy substitutes the model itself once a cheaper one has proved it
answers the same, so a hardcoded override would undo the point of it.

Do not touch any other call site, and do not add retry or fallback logic.
Streaming, tools and response_format all pass through unchanged.`,
});

export default function Connect({ data, reload }) {
  const [lang, setLang] = useState('python');
  const [copied, setCopied] = useState(false);
  const key = data.keyPrefix ? `${data.keyPrefix}…` : 'us_live_…';
  const code = snippets(data.baseUrl, key)[lang];

  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { /* clipboard blocked */ }
  };

  return (
    <>
      <div className="phead"><h1>Connect your traffic</h1></div>
      <p style={{ fontSize: 14.5, color: 'var(--mut-read)', lineHeight: 1.6, margin: '10px 0 0', maxWidth: '72ch' }}>
        Change one line. Your existing client keeps working exactly as it does now, and we start grouping
        your calls into workloads the moment the first one lands.
      </p>

      <section className="opt" style={{ marginTop: 20 }}>
        <div className="opthead">
          <h2>Point your client here</h2>
          <span className="s">{data.calls > 0 ? `${data.calls} calls received so far.` : 'Waiting for your first call.'}</span>
        </div>
        <div style={{ padding: '16px 20px 6px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {['python', 'node', 'curl', 'claude'].map((l) => (
            <button key={l} className={lang === l ? 'tab on' : 'tab'} onClick={() => setLang(l)}>
              {l === 'claude' ? 'instruct your Claude' : l}
            </button>
          ))}
          <div style={{ flexGrow: 1 }} />
          <button className="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <div style={{ padding: '6px 20px 20px' }}>
          <pre className="m code">{code}</pre>
        </div>
        <div className="barnote">
          Your key is shown once when it is created. Make a new one in Settings if you no longer have it.
          {!data.canRoute && ' Routing is not configured on this deployment yet, so calls will answer 503 until a provider key is set.'}
        </div>
      </section>

      <section className="opt">
        <div className="opthead">
          <h2>Or send us copies</h2>
          <span className="s">Your provider answers first; we get a copy afterwards.</span>
        </div>
        <div style={{ padding: '16px 20px 20px' }}>
          <pre className="m code">{`curl ${data.baseUrl}/traces \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "request":  { "model": "openai/gpt-5.4", "messages": [ ... ] },
    "response": { "model": "openai/gpt-5.4", "choices": [ ... ],
                  "usage": { "prompt_tokens": 812, "completion_tokens": 96 } },
    "latency_ms": 1840
  }'

# up to 200 at a time as { "traces": [ ... ] }`}</pre>
        </div>
      </section>

      {data.workloads.length > 0 && (
        <section className="opt">
          <div className="opthead"><h2>What has arrived</h2>
            <span className="s">Grouped by the job they do, with nothing labelled by you.</span></div>
          {data.workloads.map((w) => (
            <div className="kvrow" key={w.slug}>
              <span className="kvk">{w.slug}</span>
              <span className="kvv kvm">{w.reference_model || 'model not stated'}</span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
