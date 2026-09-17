import React, { useEffect, useRef, useState } from 'react';
import { api, usd, num, dateIST } from '../api.js';
import { CandidateChart } from '../Charts.jsx';

const Tile = ({ k, v, s }) => (
  <div className="tile"><div className="k">{k}</div><div className="v">{v}</div><div className="s">{s}</div></div>
);

const VERDICT = {
  cleared: ['Cleared', 'ok'], review: ['Needs review', 'wait'],
  missed: ['Missed the bar', 'q'], insufficient: ['Still running', 'wait'],
};

export default function WorkloadDetail({ id, onBack, onChanged }) {
  const [w, setW] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [barOpen, setBarOpen] = useState(false);
  const barRef = useRef(null);

  const load = () => api.workload(id).then(setW).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (!barOpen) return undefined;
    const away = (e) => { if (barRef.current && !barRef.current.contains(e.target)) setBarOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [barOpen]);

  if (err) return <div className="errbox">{err}</div>;
  if (!w) return <div className="loading">Loading the workload…</div>;

  const act = (fn) => async () => {
    setBusy(true);
    try { await fn(); await load(); onChanged?.(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const cert = w.certificate;
  const cand = w.candidate;
  const switched = !!w.promotedAt;
  const hot = !switched && !!cand;

  return (
    <>
      <div className="phead" style={{ display: 'block' }}>
        <a className="dback lnk" onClick={onBack}>← Workloads</a>
        <div className="dhead">
          <h1 style={{ margin: 0 }}>{w.name}</h1>
          <span className={`pill ${w.tone}`}>{w.label}</span>
        </div>
      </div>

      <div className="facts">
        <Tile k="Calls" v={num(w.calls)} s="since you connected" />
        <Tile k="Shape" v={w.shape} s={w.tools.length ? `${w.tools.length} tool` : 'no tools'} />
        <Tile k="Current model" v={short(w.model)} s={vendor(w.model)} />
        <Tile k="Current cost" v={usd(w.cost)} s="last 30 days" />
      </div>

      <section className={`dcard${switched ? ' done' : hot ? ' hot' : ''}`}>
        {switched && <span className="eyebrow eyeok">Switched automatically</span>}
        {hot && <span className="eyebrow">A candidate is ready</span>}

        <h2>{headline(w, cand, switched)}</h2>
        <p>{blurb(w, cand, switched)}</p>

        {(switched || cand) && (
          <div className="kpis">
            <div className="kpi">
              <div className="kk">Accuracy</div>
              <div className="kv">{accuracy(w, cand, switched)}</div>
              <div className="ks">
                of answers matched {short(w.reference)}. Your bar is {(100 - (w.floor ?? 0)).toFixed(1)}%.
              </div>
            </div>
            <div className="kpi">
              <div className="kk">Cost</div>
              <div className="kv">{costLine(w, cand, switched)}</div>
              <div className="ks">{costSub(w, cand, switched)}</div>
            </div>
          </div>
        )}

        <div className="dacts">
          {switched && <button className="minig" disabled={busy}
            onClick={act(() => api.revert(w.id))}>Switch back to {short(w.reference)}</button>}
          {hot && w.optimizeMode === 'ask' && (
            <>
              <button className="mini" disabled={busy}
                onClick={act(() => api.promote(w.id, cand.model))}>Approve switch</button>
              <button className="minig" disabled={busy} onClick={act(() => api.measure(w.id))}>Keep testing</button>
            </>
          )}
          {!switched && !cand && (
            <button className="minig" disabled={busy} onClick={act(() => api.measure(w.id))}>Measure now</button>
          )}
        </div>

        <div className="choices">
          {[['auto', 'Optimize automatically', 'We switch as soon as a candidate clears your bar, and switch back if it slips.'],
            ['ask', 'Ask me first', 'We test and recommend. Nothing changes until you approve it.']].map(([mode, t, s]) => (
            <button key={mode} className={`choicebox${w.optimizeMode === mode ? ' picked' : ''}`}
              disabled={busy} onClick={act(() => api.setMode(w.id, mode))}>
              <span className="cbt">{t}</span><span className="cbs">{s}</span>
            </button>
          ))}
        </div>
      </section>

      {cert && cert.results.length > 1 && (
        <section className="opt ovis">
          <div className="opthead">
            <h2>How the candidates compare</h2>
            <div className="trigwrap" ref={barRef}>
              <div className="trigrow">
                <span className="pill go">Your bar · {(w.floor ?? 0).toFixed(2)}%</span>
                <button className="whyb" onClick={() => setBarOpen((v) => !v)}>
                  <span className="whyi">?</span> How is this set?
                </button>
              </div>
              {barOpen && (
                <div className="pop popover">
                  <div className="pophead">
                    <h3>How your bar is set</h3>
                    <button className="popx" onClick={() => setBarOpen(false)} aria-label="Close">×</button>
                  </div>
                  <p>We take {cert.sampleSize} of your real calls and run each one twice on {w.reference}.</p>
                  <p>Your own model did not give the same answer both times on {(cert.noise ?? 0).toFixed(2)}% of them.</p>
                  <p><b>That is where your {(cert.floor ?? 0).toFixed(2)}% bar comes from.</b> A candidate is measured
                    the same way on the same calls, and has to stay inside it.</p>
                  <p>No model is judged on fewer than 100 runs.</p>
                </div>
              )}
            </div>
          </div>
          <div className="cbody">
            <CandidateChart results={cert.results} floor={cert.floor ?? 0} reference={w.reference}
              referenceCostMonth={cert.referenceCostMonth} />
          </div>
        </section>
      )}

      <section className="opt">
        <div className="opthead">
          <h2>Candidates tested</h2>
          <span className="s">
            {cert
              ? `${cert.rounds} ${cert.rounds === 1 ? 'round' : 'rounds'}, ${cert.sampleSize} of your own calls replayed on every model.`
              : 'Nothing has been tried yet.'}
          </span>
        </div>
        {!cert ? (
          <div className="optempty">Candidates appear here after the first run, once your bar is set.</div>
        ) : (
          <>
            <div className="cdhrow">
              <span>Model</span>
              <span style={{ textAlign: 'right' }}>Runs</span>
              <span style={{ textAlign: 'right' }}>Disagreement</span>
              <span style={{ textAlign: 'right' }}>Cost a month</span>
              <span>Verdict</span>
            </div>
            <div className="cdrow cur">
              <div className="mdl">{w.reference}</div>
              <div className="num">{num(cert.sampleSize * 2 * cert.rounds)}</div>
              <div className="num">baseline</div>
              <div className="num">{cert.referenceCostMonth === null ? '—' : usd(cert.referenceCostMonth)}</div>
              <div><span className="pill q">{switched ? 'Previous model' : 'Current model'}</span></div>
            </div>
            {cert.results.map((r) => {
              const [label, tone] = VERDICT[r.verdict] || ['—', 'q'];
              const serving = r.model === w.model;
              return (
                <div className="cdrow" key={r.model}>
                  <div className="mdl">{r.model}</div>
                  <div className="num">{num(r.runs)}</div>
                  <div className="num">{r.gap === null ? '—' : `${r.gap.toFixed(2)}%`}</div>
                  <div className="num">{r.costMonth === null ? '—' : usd(r.costMonth)}</div>
                  <div><span className={`pill ${serving ? 'ok' : tone}`}>{serving ? 'Serving now' : label}</span></div>
                </div>
              );
            })}
            <div className="barnote">
              No model is judged on fewer than 100 runs, and a model we switch to is re-tested on fresh calls.
              If it stops clearing, it goes back.
              {cert.finishedAt ? ` Last run ${dateIST(cert.finishedAt)} IST.` : ''}
            </div>
          </>
        )}
      </section>
    </>
  );
}

const short = (m) => (m ? String(m).split('/').pop() : 'not set');
const vendor = (m) => (m && m.includes('/') ? `${m.split('/')[0]}, your own choice` : 'your own choice');

const accuracy = (w, cand, switched) => {
  const gap = switched
    ? (w.certificate?.results.find((r) => r.model === w.model)?.gap ?? 0)
    : (cand?.gap ?? 0);
  return `${(100 - gap).toFixed(1)}%`;
};

const headline = (w, cand, switched) => {
  if (switched) return `${short(w.model)} is serving ${w.name}`;
  if (cand) return `${short(cand.model)} cleared your bar`;
  if (w.label === 'Measuring') return 'We are still learning your bar';
  return 'Nothing has cleared your bar yet';
};

const blurb = (w, cand, switched) => {
  if (switched) {
    return `We switched it because it cleared your bar. We re-test it on fresh calls and put you back on ${short(w.reference)} the moment it stops clearing.`;
  }
  if (cand) {
    return w.optimizeMode === 'ask'
      ? 'It stayed inside your bar across your own calls, replayed and compared answer by answer. Nothing changes until you approve it.'
      : 'It stayed inside your bar across your own calls. This workload optimizes automatically, so it switches on its own.';
  }
  if (w.label === 'Measuring') {
    return 'Before we can recommend anything we measure how much your own model varies from itself. We replay your calls twice and compare the two answers, and that variation becomes the bar a cheaper model has to clear.';
  }
  return 'Every model we tried drifted further from your own model than your bar allows. We keep trying as new models land.';
};

const costLine = (w, cand, switched) => {
  const target = switched
    ? w.certificate?.results.find((r) => r.model === w.model)?.costMonth
    : cand?.costMonth;
  const base = w.certificate?.referenceCostMonth;
  if (!target || !base || base <= 0) return target ? `${usd(target)} a month` : '—';
  return `${Math.round((1 - target / base) * 100)}% lower`;
};

const costSub = (w, cand, switched) => {
  const target = switched
    ? w.certificate?.results.find((r) => r.model === w.model)?.costMonth
    : cand?.costMonth;
  const base = w.certificate?.referenceCostMonth;
  if (!target) return 'measured once a full month of traffic is in';
  if (!base) return `${usd(target)} a month at your volume`;
  return `${usd(base)} a month ${switched ? 'became' : 'would become'} ${usd(target)}. You keep ${usd(base - target)}.`;
};
