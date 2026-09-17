import React, { useState } from 'react';
import { api, usd, dateIST, ago } from '../api.js';

const Sw = ({ on, onClick, busy }) => (
  <button className={`sw${on ? ' swon' : ''}`} disabled={busy} onClick={onClick}
    aria-label={on ? 'Turn off' : 'Turn on'}><i /></button>
);

export default function Settings({ data, reload }) {
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(null);
  const [err, setErr] = useState(null);
  const [name, setName] = useState(data.name);
  const [workspace, setWorkspace] = useState(data.workspace);

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
          <span className="kvv kvm">{data.email}</span>
        </div>
        <div className="kvrow">
          <span className="kvk">Workspace</span>
          <span className="kvv">
            <input className="inp" value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
          </span>
          <span className="kva">
            <button className="minig" disabled={busy || workspace === data.workspace}
              onClick={run(() => api.profile({ workspace }))}>Save</button>
          </span>
        </div>
      </section>

      <section className="opt">
        <div className="opthead">
          <h2>API keys</h2>
          <span className="s">A key is shown once, when it is created.</span>
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
          <span>It is shown once, right here, and never again.</span>
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
          <span className="kvv kvm">{usd(data.balance)}</span>
          <span className="kva">
            <button className="mini" disabled={!data.canBill || busy}>Add credit</button>
          </span>
        </div>
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
          <span className="kvk">Keep call content for</span>
          <span className="kvv kvm">{data.retentionDays} days</span>
          <span className="kva"><span className="shp">set by this deployment</span></span>
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
