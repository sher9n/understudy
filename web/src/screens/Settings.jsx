import React, { useState } from 'react';
import { api, usd, usdHeld, dateIST, ago } from '../api.js';

const Sw = ({ on, onClick, busy }) => (
  <button className={`sw${on ? ' swon' : ''}`} disabled={busy} onClick={onClick}
    aria-label={on ? 'Turn off' : 'Turn on'}><i /></button>
);

const AMOUNTS = [10, 25, 50, 100];

/* A few round numbers up to the ceiling, rather than every integer to twenty. */
const modelChoices = (max) => [3, 5, 10, 15, 20].filter((n) => n <= max);

export default function Settings({ data, reload }) {
  /* Adding credit leaves the app, so the button's job is to get to Stripe and nothing else.
     The money and the saved card both come back through the webhook, which is the only
     thing that writes a balance, so there is nothing to do on return but reload. */
  const [picking, setPicking] = useState(false);
  const [paying, setPaying] = useState(null);
  const [payError, setPayError] = useState('');
  const buy = async (amountUsd) => {
    setPaying(amountUsd); setPayError('');
    try {
      const { url } = await api.addCredit(amountUsd);
      window.location.assign(url);
    } catch (e) { setPayError(e.message); setPaying(null); }
  };

  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(null);
  const [err, setErr] = useState(null);
  const [name, setName] = useState(data.name);
  const [email, setEmail] = useState(data.email);

  const run = (fn) => async () => {
    setBusy(true); setErr(null);
    try { await fn(); await reload(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="settingspage">
      <div className="phead"><h1>Settings</h1></div>
      {err && <div className="errbox">{err}</div>}

      <section className="opt">
        <div className="opthead"><h2>Account</h2></div>
        <div className="kvrow">
          <span className="kvk">Name</span>
          <span className="kvv">
            <input className="inp" value={name} onChange={(e) => setName(e.target.value)} />
          </span>
          <span className="kva">
            <button className="minig" disabled={busy || name === data.name}
              onClick={run(() => api.profile({ name }))}>Save</button>
          </span>
        </div>
        <div className="kvrow">
          <span className="kvk">Email</span>
          <span className="kvv">
            <input className="inp" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)} />
          </span>
          <span className="kva">
            <button className="minig" disabled={busy || email.trim().toLowerCase() === data.email}
              onClick={run(() => api.profile({ email }))}>Save</button>
          </span>
        </div>
      </section>

      <section className="opt">
        <div className="opthead">
          <h2>API keys</h2>
          <span className="s">Only part of a key is kept, so a lost one is replaced rather than shown again.</span>
        </div>
        <div className="gthead" style={{ gridTemplateColumns: 'minmax(0, 1fr) 148px 138px 138px 92px' }}>
          <span>Name</span><span>Prefix</span><span>Created</span><span>Last used</span><span />
        </div>
        {data.keys.map((k) => (
          <div className="gtrow" key={k.id} style={{ gridTemplateColumns: 'minmax(0, 1fr) 148px 138px 138px 92px' }}>
            <div className="on">{k.name}</div>
            <div className="mdl">{k.prefix}</div>
            <div className="shp">{dateIST(k.created_at)}</div>
            <div className="shp">{k.last_used_at ? ago(k.last_used_at) : 'never'}</div>
            <div style={{ textAlign: 'right' }}>
              <button className="minig" disabled={busy}
                onClick={run(() => api.revokeKey(k.id))}>Revoke</button>
            </div>
          </div>
        ))}
        <div className="barnote" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button className="mini" disabled={busy}
            onClick={run(async () => { const r = await api.newKey('production'); setFresh(r.key); })}>
            Create a key
          </button>
          <span>The whole key appears here, once. Lose it and make another.</span>
        </div>
        {fresh && <div className="okbox">{fresh}</div>}
      </section>

      <section className="opt">
        <div className="opthead">
          <h2>Money</h2>
          {!data.canBill && <span className="s">No payment provider is configured, so this is read only.</span>}
        </div>
        <div className="kvrow">
          <span className="kvk">Balance</span>
          <span className="kvv kvm">{usdHeld(data.balance)}</span>
          <span className="kva">
            <button className="mini" disabled={!data.canBill || busy || paying}
              onClick={() => setPicking((v) => !v)}>
              {data.balance > 0 ? 'Add credit' : 'Add credit to start'}
            </button>
          </span>
        </div>
        {picking && (
          <div className="kvrow amountrow">
            <span className="kvk">How much</span>
            <span className="kvv">
              <span className="amounts">
                {AMOUNTS.map((a) => (
                  <button key={a} className="minig" disabled={paying}
                    onClick={() => buy(a)}>{paying === a ? 'Opening…' : `$${a}`}</button>
                ))}
              </span>
              <span className="s amountnote">
                Your card is saved at the same time, so we can top you up automatically
                later. You can turn that off below.
              </span>
            </span>
            <span className="kva" />
          </div>
        )}
        {payError && <div className="errbox">{payError}</div>}
        <div className="kvrow">
          <span className="kvk">Automatic top up</span>
          <span className="kvv">
            Charge {usd(data.topUpAmount)} when the balance falls below {usd(data.topUpThreshold)}.
            {data.cardNote ? ` Turned off after a card was declined (${data.cardNote}).` : ''}
          </span>
          <span className="kva">
            <Sw on={data.autoTopUp} busy={busy || !data.canBill}
              onClick={run(() => api.autoTopUp(!data.autoTopUp))} />
          </span>
        </div>
        <div className="kvrow">
          <span className="kvk">Card</span>
          <span className="kvv kvm">{data.card ? `${data.card.brand} ···· ${data.card.last4}` : 'none saved'}</span>
        </div>
        {data.ledger.length > 0 && (
          <div className="barnote">
            {data.ledger.slice(0, 3).map((l, i) => (
              <div key={i}>{l.amount_usd >= 0 ? '+' : ''}{usd(l.amount_usd)} · {l.note || l.kind} · {ago(l.created_at)}</div>
            ))}
          </div>
        )}
      </section>

      <section className="opt">
        <div className="opthead"><h2>Data</h2></div>
        <div className="kvrow">
          <span className="kvk">Measure</span>
          <span className="kvv">
            {/* How often measuring happens by itself. "Only when I ask" is a real choice rather
                than an off switch: everything else keeps working, and nothing is spent unasked.
                The choices come from the server with the setting, so the default is always one
                of them: this screen kept its own list once, and the default was not on it. */}
            <span className="seg">
              {(data.measureChoices || []).map((c) => (
                <button key={c.days} disabled={busy}
                  className={c.days === data.measureEveryDays ? 'segb on' : 'segb'}
                  onClick={run(() => api.setMeasureEvery(c.days))}>{c.label}</button>
              ))}
            </span>
            <span className="segnote">
              {data.measureEveryDays
                ? `Every workload is measured again on this cadence, and you are charged for the calls it replays. `
                  /* it said a switched model "goes back if it stops clearing your bar", which
                     nothing does yet; said as it is until it does */
                  + 'A model we switched you to stays in place until you switch it back.'
                : 'Nothing is measured, and nothing is spent on measuring, until you press Measure now on a workload. '
                  + 'A model we already switched you to stays where it is.'}
            </span>
          </span>
        </div>
        <div className="kvrow">
          <span className="kvk">Models tried each time</span>
          <span className="kvv">
            <span className="seg">
              {modelChoices(data.evalModelsMax).map((n) => (
                <button key={n} disabled={busy}
                  className={n === data.evalModels ? 'segb on' : 'segb'}
                  onClick={run(() => api.setModelsTested(n))}>{n}</button>
              ))}
            </span>
            <span className="segnote">
              How many cheaper models a measurement tries. More of them is a fuller picture of
              where quality falls away, and costs proportionally more, since each one answers
              every sampled call. {data.evalModelsMax} is the most we will run.
            </span>
          </span>
        </div>
        <div className="kvrow">
          <span className="kvk">Keep call content for</span>
          <span className="kvv">
            <span className="seg">
              {data.retentionChoices.map((c) => (
                <button key={c.days} disabled={busy}
                  className={c.days === data.retentionDays ? 'segb on' : 'segb'}
                  onClick={run(() => api.retention(c.days))}>{c.label}</button>
              ))}
            </span>
            <span className="segnote">
              {data.retentionDays
                ? 'After this, the request and the answer are cleared. What they cost, which model ran them and every measurement are kept, so your charts do not change.'
                : 'Nothing is cleared on a schedule. Keep this if you want old traffic available to measure a new model against.'}
            </span>
          </span>
        </div>
        <div className="kvrow">
          <span className="kvk">Zero data retention</span>
          <span className="kvv">Every routed call goes only to providers that keep nothing.</span>
          <span className="kva"><Sw on={data.zdrOnly} busy onClick={() => {}} /></span>
        </div>
      </section>
    </div>
  );
}
