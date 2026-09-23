import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, usd, ago } from '../api.js';
import { LANGS, WAYS, snippet, asText } from './snippets.js';
import { COPIED_MS } from './ConnectWizard.jsx';

/* Connect, for a customer whose traffic has already arrived.

   The three step guide is for somebody who has not connected yet, and it lives in
   ConnectWizard. This is what the same screen becomes afterwards: a page they come back to,
   to copy the endpoint, wire a second service, or check that the connection is still good.
   The steps do not disappear, they become a record of what already happened, in the panel
   on the right, beside the numbers that prove it. */

/* "under a cent" was a way around a formatter that could not print one. It can now, so the
   test call says what it actually cost. */
const priceOf = (n) => (n ? usd(n) : 'no charge');

const Copy = ({ text, label = 'Copy' }) => {
  const [done, setDone] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button className="ghost" onClick={async () => {
      try { await navigator.clipboard.writeText(text); } catch { return; }
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), COPIED_MS);
    }}>{done ? 'Copied' : label}</button>
  );
};

export default function ConnectPage({ data, reload, freshKey, onFreshKey }) {
  const [way, setWay] = useState('route');
  const [lang, setLang] = useState('python');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(data.lastTest || null);
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [keyError, setKeyError] = useState('');

  /* A key is only ever stored as a hash, so the whole one exists on this screen only just
     after it was made. While we have it, everything shows it in full and the snippet is
     something that will actually run; otherwise the prefix stands in for it and the page
     says how to get one that works rather than handing over a key with a gap in it. */
  const usable = freshKey || data.key || null;
  const shown = usable || (data.keyPrefix ? `${data.keyPrefix}…` : null);
  const lines = snippet(way, lang, { baseUrl: data.baseUrl, key: shown });

  const regenerate = async () => {
    setRotating(true); setKeyError('');
    try {
      const r = await api.regenerateKey();
      onFreshKey(r.key);
      setConfirming(false);
      await reload();
    } catch (e) { setKeyError(e.message); } finally { setRotating(false); }
  };

  const sendTest = useCallback(async () => {
    setTesting(true);
    try {
      const r = await api.testCall();
      setTest(r);
      await reload();
    } catch (e) {
      setTest({ ok: false, reason: e.message, at: Date.now() });
    } finally {
      setTesting(false);
    }
  }, [reload]);

  return (
    <div className="connectpage">
      <div className="phead" style={{ display: 'block' }}>
        <div className="headrow"><h1>Connect</h1></div>
        <p className="headnote">
          Route through us, or keep calling your own provider and send us copies. You can
          wire a second service to the same endpoint whenever you like.
        </p>
      </div>

      <div className="twocol">
        <div>
          <section className="opt" style={{ marginTop: 0 }}>
            <div className="opthead"><h2>How your calls reach us</h2>
              <span className="s">You can change your mind at any time.</span></div>
            <div className="cardpad">
              <div className="ways" style={{ marginTop: 0 }}>
                {WAYS.map((w) => (
                  <button key={w.key} className={w.key === way ? 'way on' : 'way'}
                    onClick={() => setWay(w.key)}>
                    <span className="m tag">{w.tag}</span>
                    <div className="t">{w.title}</div>
                    <div className="b">{w.body}</div>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="opt">
            <div className="opthead"><h2>Code</h2>
              <span className="s">The changed lines are the only ones that are new.</span></div>
            <div className="cardpad">
              <div className="codebox" style={{ marginTop: 0 }}>
                <div className="tabs">
                  {LANGS.map((l) => (
                    <button key={l.key} className={l.key === lang ? 'tab on' : 'tab'}
                      onClick={() => setLang(l.key)}>{l.label}</button>
                  ))}
                  <div style={{ flexGrow: 1 }} />
                  <Copy text={asText(lines)} />
                </div>
                <pre className="m code" tabIndex={0} aria-label="Code to copy">
                  {lines.map((l, i) => (
                    <span key={i} style={{ display: 'block' }}>
                      {l.text === '' ? ' ' : (
                        <span className={l.changed ? 'hl' : undefined}
                          style={l.changed ? undefined : { color: 'var(--ink)' }}>{l.text}</span>
                      )}
                    </span>
                  ))}
                </pre>
              </div>
              <p className="codenote">
                <b>Any provider works.</b> The model id is what names it, so{' '}
                <code>anthropic/claude-haiku-4.5</code> or{' '}
                <code>google/gemini-2.5-flash-lite</code> need nothing else changed.
              </p>
            </div>
          </section>

          <section className="opt">
            <div className="opthead"><h2>Your endpoint and key</h2></div>
            <div className="rowpair">
              <span className="rowk">Base URL</span>
              <code className="rowv">{data.baseUrl}</code>
              <Copy text={data.baseUrl} />
            </div>
            <div className="rowpair">
              <span className="rowk">API key</span>
              <code className="rowv keyfull">{shown || 'no key yet'}</code>
              <span className="keyacts2">
                {usable && <Copy text={usable} />}
                <button className="ghost" disabled={rotating}
                  onClick={() => setConfirming(true)}>
                  {usable ? 'Replace' : 'Regenerate'}
                </button>
              </span>
            </div>
            {freshKey && (
              <div className="keynote ok">
                This is your new key. The one before it has stopped working, so anything
                still using it needs this pasted in.
              </div>
            )}
            {confirming && (
              <div className="keynote warn">
                <div><b>Anything already using your current key stops working.</b> Whatever
                  you have deployed will need the new key pasted in before it can send
                  another call.</div>
                <div className="keyacts">
                  <button className="mini" disabled={rotating} onClick={regenerate}>
                    {rotating ? 'Regenerating…' : 'Yes, regenerate it'}
                  </button>
                  <button className="minig" disabled={rotating}
                    onClick={() => setConfirming(false)}>Keep the one I have</button>
                </div>
              </div>
            )}
            {keyError && <div className="errbox">{keyError}</div>}
          </section>

          <section className="opt" aria-labelledby="headers-h">
            <div className="opthead"><h2 id="headers-h">Headers you can send, and read</h2>
              <span className="s">None of these is needed. Each is taken off before the call goes on to a provider.</span></div>
            <div className="cbody">
              <div className="rowpair"><code className="rowk">x-understudy-workload</code>
                <span className="rowv">Names the job a call belongs to. Calls with the same name are measured together, whatever their words, and the workload is called by it.</span></div>
              <div className="rowpair"><code className="rowk">x-understudy-pin: 1</code>
                <span className="rowv">This call is answered by the model it names, whatever the workload was switched to. For the calls you cannot risk on anything else.</span></div>
              <div className="rowpair"><code className="rowk">x-understudy-ref</code>
                <span className="rowv">Your own reference for a call, to report later how it turned out (POST /v1/outcomes).</span></div>
              <div className="rowpair"><code className="rowk">x-understudy-served-model</code>
                <span className="rowv">On every answer: the model that actually answered it. With <code>x-understudy-workload</code> (the workload it joined) and <code>x-understudy-call-id</code>.</span></div>
            </div>
          </section>

          {data.turnedAway?.length > 0 && (
            <section className="opt" aria-labelledby="refused-h">
              <div className="opthead"><h2 id="refused-h">Calls we turned away</h2>
                <span className="s">The latest, with the reason each was given. Fix the cause and they go through.</span></div>
              <div className="cbody">
                {data.turnedAway.map((t) => (
                  <div className="rowpair" key={`${t.at}-${t.status}`}>
                    <span className="rowk">{ago(t.at)} · {t.status}</span>
                    <span className="rowv">{t.why || 'No reason was recorded.'}{t.model ? ` (model: ${t.model})` : ''}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="opt sidecard" style={{ marginTop: 0 }}>
          <div className="opthead"><h2>Connection</h2></div>
          <div className="cardpad">
            <div style={{ marginBottom: 13 }}>
              <span className="pill ok"><span className="dotok" />Connected</span>
            </div>

            <div className="checkrow"><span className="tick">✓</span><span>Traffic connected</span></div>
            <div className="checkrow"><span className="tick">✓</span><span>First call received</span></div>
            <div className="checkrow">
              <span className="tick">✓</span>
              <span>{data.workloadCount > 0 ? 'Measuring on its own' : 'Watching for a pattern'}</span>
            </div>

            <div style={{ height: 15 }} />
            <div className="statrow"><span className="statk">Calls received</span>
              <span className="statv">{data.calls.toLocaleString('en-GB')}</span></div>
            <div className="statrow"><span className="statk">Last call</span>
              <span className="statv">{data.lastCallAt ? ago(data.lastCallAt) : 'none yet'}</span></div>
            <div className="statrow"><span className="statk">Workloads found</span>
              <span className="statv">{data.workloadCount}</span></div>
            {data.workloadCount === 0 && data.candidates > 0 && (
              <p className="sticknote" style={{ marginTop: 9 }}>
                {data.candidates === 1 ? 'One shape so far' : `${data.candidates} shapes so far`},
                {' '}none seen {data.minCalls} times yet. A workload appears once one has been,
                so a handful of calls is too few to group anything by.
              </p>
            )}

            <div style={{ height: 16 }} />
            <button className="mini" style={{ width: '100%' }} disabled={testing || !data.canRoute}
              onClick={sendTest}>{testing ? 'Sending…' : 'Send a test call'}</button>

            {!data.canRoute && (
              <p className="sticknote" style={{ marginTop: 10 }}>
                Routing is not configured on this deployment, so a test call cannot be sent.
              </p>
            )}

            {test && (
              <div className={test.ok ? 'testout ok' : 'testout bad'}>
                {test.ok ? (
                  <>
                    <div className="testline1">It went through</div>
                    <div className="m testline2">
                      {test.model} · {test.latencyMs} ms · {priceOf(test.costUsd)}
                    </div>
                    {test.reply && <div className="testline3">It answered “{test.reply}”</div>}
                  </>
                ) : (
                  <>
                    <div className="testline1">It did not get through</div>
                    <div className="testline3">{test.reason}</div>
                  </>
                )}
              </div>
            )}

            <div style={{ height: 14 }} />
            <p className="sticknote">
              Routed calls only reach providers that keep nothing. What we store is cleared
              after the window you chose in Settings.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
