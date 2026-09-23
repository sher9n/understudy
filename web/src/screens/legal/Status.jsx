import React, { useCallback, useEffect, useState } from 'react';
import { api, ago, num, stampIST } from '../../api.js';
import { Doc } from './Public.jsx';

/* What is working right now.
 *
 * Read from the service itself, twice: the plain health check, which answers as long as the
 * application and its database do, and the status report, which says whether each part that
 * depends on somebody else (routing calls, email, payments) is switched on and when the model
 * list was last read. The page asks again every minute while it is open, and says when it last
 * asked, in IST, because "working" means nothing without "as of when". */

const EVERY_MS = 60000;

/* One part of the service, as a row: its name, what it does, and whether it is working. */
function Row({ tone, name, state, note }) {
  return (
    <div className="healthrow">
      <span className={`healthdot ${tone}`} aria-hidden="true" />
      <div className="healthname">{name}<span className="healthnote">{note}</span></div>
      <span className={`healthstate ${tone}`}>{state}</span>
    </div>
  );
}

const PAYMENTS = {
  live: ['ok', 'Working', 'Payments are switched on, so credit can be added to a balance.'],
  test: ['warn', 'Test mode', 'Payments run in test mode on this deployment, so no real money moves.'],
  test_refused: ['bad', 'Not working', 'This deployment is set up with test payments, and those are not added to balances.'],
  off: ['bad', 'Not working', 'Adding credit is not available on this deployment right now.'],
};

const readAt = (ms) => (ms ? `${stampIST(ms)}, ${ago(ms)}` : 'not read yet');

export default function Status() {
  const [s, setS] = useState(null);       // what /api/status said, or { failed }
  const [h, setH] = useState(null);       // what /health said, or { failed }
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(null);

  const check = useCallback(async () => {
    setBusy(true);
    const [a, b] = await Promise.allSettled([api.status(), api.health()]);
    setS(a.status === 'fulfilled' ? a.value : { failed: a.reason?.message || 'no answer' });
    setH(b.status === 'fulfilled' ? b.value : { failed: b.reason?.message || 'no answer' });
    setAsked(Date.now());
    setBusy(false);
  }, []);

  useEffect(() => {
    check();
    const t = setInterval(() => { if (!document.hidden) check(); }, EVERY_MS);
    return () => clearInterval(t);
  }, [check]);

  const rows = [];
  const up = !!(h && !h.failed && h.ok) || !!(s && !s.failed && s.ok);
  if (s || h) {
    rows.push(up
      ? ['ok', 'The application', 'Working', 'The site, the API and the database are answering.']
      : ['bad', 'The application', 'Not answering', 'Neither the health check nor the status report answered.']);
  }
  if (s && !s.failed) {
    rows.push(s.routing
      ? ['ok', 'Model calls', 'Working', 'Routing is switched on, so routed calls and measurement replays go on to model providers.']
      : ['bad', 'Model calls', 'Not working', 'Routed calls are turned away with an error until this is back. Copies of calls are still accepted.']);
    rows.push(s.email
      ? ['ok', 'Email', 'Working', 'Email is switched on, so sign-in codes and notifications are sent.']
      : ['bad', 'Email', 'Not working', 'Sign-in codes cannot be emailed right now. Signing in with a password still works.']);
    const [tone, state, note] = PAYMENTS[s.payments] || ['warn', 'Unknown', 'The status report did not say.'];
    rows.push([tone, 'Payments', state, note]);
    rows.push(s.models > 0
      ? ['ok', 'Model list', 'Working', `${num(s.models)} models listed. Last read ${readAt(s.catalogSyncedAt)}.`]
      : ['bad', 'Model list', 'Empty', 'No models are listed, so no call can be priced or measured.']);
    rows.push(s.providersSyncedAt
      ? ['ok', 'Providers that keep nothing', 'Working', `The list of zero data retention providers was last read ${readAt(s.providersSyncedAt)}.`]
      : ['warn', 'Providers that keep nothing', 'Not read yet', 'The list of zero data retention providers has not been read yet.']);
  }

  const bad = rows.filter((r) => r[0] === 'bad').length;
  const warn = rows.filter((r) => r[0] === 'warn').length;
  const summary = !rows.length ? null
    : !up ? ['bad', 'Understudy is not answering right now', 'This page keeps checking every minute.']
      : bad || warn ? ['warn', bad + warn === 1 ? 'One part is not working' : `${bad + warn} parts are not working`,
        'Everything else below is working.']
        : ['ok', 'Everything is working', 'Every part below answered as it should.'];

  return (
    <Doc eyebrow="Status" title="Is Understudy working?" dated={false}
      lead="Each part of the service, read from the service itself. This page checks again every minute while it is open.">
      <div aria-live="polite">
        {!summary ? (
          <div className="healthsum"><div><div className="healthsumt">Checking…</div></div></div>
        ) : (
          <div className={`healthsum ${summary[0]}`}>
            <span className={`healthdot ${summary[0]}`} aria-hidden="true" />
            <div>
              <div className="healthsumt">{summary[1]}</div>
              <div className="healthsums">{summary[2]}</div>
            </div>
          </div>
        )}
      </div>
      {rows.length > 0 && (
        <div className="healthlist">
          {rows.map(([tone, name, state, note]) => <Row key={name} tone={tone} name={name} state={state} note={note} />)}
        </div>
      )}
      <p className="healthmeta">
        {asked ? <>Last checked {stampIST(asked)}.</> : null}
        {s && !s.failed && s.version ? <> Version <code>{s.version}</code>.</> : null}
      </p>
      <div className="healthacts">
        <button type="button" className="minig" onClick={check} disabled={busy}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </Doc>
  );
}
