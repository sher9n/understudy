import React from 'react';
import { usd, num } from './api.js';

const CHEV = (
  <span className="chev">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
  </span>
);

export default function WorkloadTable({ rows, onOpen, priced = true, title = 'Your workloads' }) {
  return (
    <section className="opt">
      <div className="opthead"><h2>{title}</h2></div>
      {rows.length === 0 ? (
        <div className="optempty">
          Your workloads will appear here as we classify your calls. Usually within a minute of the first one.
        </div>
      ) : (
        <>
          <div className="opthrow">
            <span>Workload</span>
            <span style={{ textAlign: 'right' }}>Calls</span>
            <span>Shape</span>
            <span style={{ textAlign: 'right' }}>Current cost</span>
            <span>Current model</span>
            <span>Status</span>
            <span />
          </div>
          {rows.map((r) => (
            <div className="optrow" key={r.id} onClick={() => onOpen(r.id)}>
              <div className="on">{r.name}</div>
              <div className="num">{num(r.calls)}</div>
              <div className="shp">{r.shape}</div>
              <div className="num">{priced ? usd(r.cost) : '—'}</div>
              <div className="mdl">{r.model}</div>
              <div><span className={`pill ${r.tone}`}>{r.label}</span></div>
              {CHEV}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
