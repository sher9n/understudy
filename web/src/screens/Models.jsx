import React, { useState } from 'react';
import { api, num } from '../api.js';

const Tile = ({ k, v, s }) => (
  <div className="tile"><div className="k">{k}</div><div className="v">{v}</div><div className="s">{s}</div></div>
);

const Sw = ({ on, onClick, busy }) => (
  <button className={`sw${on ? ' swon' : ''}`} disabled={busy} onClick={onClick}
    aria-label={on ? 'Turn off' : 'Turn on'}><i /></button>
);

const per1m = (v) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3).replace(/0$/, '')}`);

export default function Models({ data, reload }) {
  const [busy, setBusy] = useState(null);
  const toggle = (m) => async () => {
    setBusy(m.id);
    try { await api.setModel(m.id, !m.enabled); await reload(); } finally { setBusy(null); }
  };
  const enabled = data.models.filter((m) => m.enabled);
  const serving = data.models.filter((m) => m.where.length);
  const cheapest = enabled.length ? Math.min(...enabled.map((m) => m.priceIn)) : 0;

  return (
    <>
      <div className="phead"><h1>Models</h1><button className="chip">{data.models.length} available</button></div>
      <div className="tiles">
        <Tile k="Enabled" v={num(enabled.length)} s={`of ${data.models.length} available`} />
        <Tile k="Serving your traffic" v={num(serving.length)}
          s={serving.length ? serving.map((m) => m.id.split('/').pop()).slice(0, 2).join(' and ') : 'nothing routed yet'} />
        <Tile k="Open weights" v={num(enabled.filter((m) => m.openWeights).length)} s="enabled" />
        <Tile k="Cheapest enabled" v={enabled.length ? per1m(cheapest) : '—'} s="per 1M input tokens" />
      </div>

      <section className="opt">
        <div className="opthead">
          <h2>Candidate models</h2>
          <span className="s">We only try what you enable here, and every one is measured on your own calls before anything switches.</span>
        </div>
        {data.models.length === 0 ? (
          <div className="optempty">
            The model list syncs from the provider once routing is configured. Nothing can be tried until then.
          </div>
        ) : (
          <>
            <div className="gthead" style={{ gridTemplateColumns: 'minmax(0, 1.5fr) 128px 104px minmax(0, 1.2fr) 78px' }}>
              <span>Model</span>
              <span style={{ textAlign: 'right' }}>Price per 1M</span>
              <span style={{ textAlign: 'center' }}>Open weights</span>
              <span>Where it runs</span>
              <span style={{ textAlign: 'right' }}>Enabled</span>
            </div>
            {data.models.map((m) => (
              <div className="gtrow" key={m.id}
                style={{ gridTemplateColumns: 'minmax(0, 1.5fr) 128px 104px minmax(0, 1.2fr) 78px' }}>
                <div className="mdl">{m.id}</div>
                <div className="num">{per1m(m.priceIn)} / {per1m(m.priceOut)}</div>
                <div className="shp" style={{ textAlign: 'center' }}>{m.openWeights ? 'yes' : 'no'}</div>
                <div className="shp">{m.where.length ? m.where.join(', ') : m.enabled ? 'candidate' : 'not enabled'}</div>
                <div style={{ textAlign: 'right' }}>
                  <Sw on={m.enabled} busy={busy === m.id} onClick={toggle(m)} />
                </div>
              </div>
            ))}
          </>
        )}
      </section>

      <section className="opt">
        <div className="opthead"><h2>Provider rules</h2></div>
        <div className="kvrow">
          <span className="kvk">Zero data retention only</span>
          <span className="kvv">Calls only go to providers that keep nothing.</span>
          <span className="kva"><Sw on={data.zdrOnly} onClick={() => {}} busy /></span>
        </div>
        <div className="kvrow">
          <span className="kvk">Skip preview and alias models</span>
          <span className="kvv">An alias can change model under you, so a result would not hold.</span>
          <span className="kva"><Sw on onClick={() => {}} busy /></span>
        </div>
      </section>
    </>
  );
}
