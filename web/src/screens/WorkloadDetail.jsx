import React, { useEffect, useRef, useState } from 'react';
import { href } from '../router.js';
import { plainClick } from '../nav.jsx';
import { api, usd, num, dateIST, timeIST } from '../api.js';
import { CandidateChart, chartPoints } from '../Charts.jsx';
import WorkloadCalls from './WorkloadCalls.jsx';
import Measurement from './Measurement.jsx';
import SwitchedCard from './SwitchedCard.jsx';

const Tile = ({ k, v, s }) => (
  <div className="tile"><div className="k">{k}</div><div className="v">{v}</div><div className="s">{s}</div></div>
);

const VERDICT = {
  cleared: ['Cleared', 'ok'], review: ['Needs review', 'wait'],
  missed: ['Missed the bar', 'q'], insufficient: ['Still running', 'wait'],
  slower: ['Slower than yours', 'wait'], failed: ['Could not answer', 'q'],
};

const secs = (ms) => (ms === null || ms === undefined ? null : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);

/* Why a model got the verdict it did, in a few words under the verdict. */
function whyOf(r, refSpeed, cert) {
  if (r.verdict === 'failed') return r.errorText ? `Provider said: ${r.errorText}` : 'Its provider refused the calls';
  if (r.verdict === 'slower') {
    const mine = r.latencyP50;
    const theirs = refSpeed?.latencyP50;
    return mine && theirs ? `Typically ${secs(mine)}, against ${secs(theirs)} for yours` : 'Slower than your speed setting allows';
  }
  if (r.stopped === 'bar') return `Stopped after ${r.runs} of ${cert.sampleSize} calls, once it could not reach your bar`;
  if (r.verdict === 'missed' && r.difference) return `Mostly ${r.difference}`;
  if (r.thinkingOff) return 'Measured with its thinking switched off';
  if (r.difference && r.gap > 0) return `Where it differed: ${r.difference}`;
  return null;
}

export default function WorkloadDetail({ id, onBack, onChanged }) {
  const [w, setW] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [barOpen, setBarOpen] = useState(false);
  const [openRun, setOpenRun] = useState(null);
  const [runData, setRunData] = useState(null);
  const barRef = useRef(null);

  const load = () => api.workload(id).then(setW).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    if (!openRun) { setRunData(null); return undefined; }
    let live = true;
    api.workloadRun(id, openRun).then((d) => { if (live) setRunData(d); }).catch(() => {});
    return () => { live = false; };
  }, [id, openRun]);

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

  /* Either the newest measurement, or the older one somebody opened from the history. The
     table below reads from whichever it is, so the page shows one run at a time rather than
     two sets of numbers that look alike. */
  const cert = openRun && runData ? {
    runId: runData.id, outcome: runData.outcome, nothing: runData.nothing,
    rounds: 1, sampleSize: runData.sample, floor: runData.floor, noise: runData.noise,
    reference: runData.reference, finishedAt: runData.finishedAt,
    referenceCostMonth: runData.referenceCostMonth, results: runData.results,
    refSpeed: runData.refSpeed, reused: runData.reused, saved: runData.saved,
  } : w.certificate;
  /* Whether the measurement shown tried any model. One that could not set a bar, ran out of
     balance or was stopped early tried none, and the sections below say why instead of
     disappearing, and offer the newest measurement that did compare models. */
  const compared = !!cert && cert.results.length > 0;
  /* With nothing finished at all, a measurement that was stopped part way can still have
     finished some models, and Stop promised they keep their results, so they are offered too. */
  const earlier = !compared && w.lastComparison && w.lastComparison.runId !== cert?.runId
    ? w.lastComparison : null;
  // the row in the history that the page is showing, whether somebody opened it or not
  const showingId = openRun || w.certificate?.runId || null;
  /* The model this measurement's bar came from. Usually the workload's own, but an older run
     opened from the history may have been measured against a model it has since moved off,
     and its chart and table have to name that one, not today's. */
  const measuredOn = cert?.reference || w.reference;
  const cand = w.candidate;
  const switched = !!w.promotedAt;
  const hot = !switched && !!cand;

  return (
    <>
      <div className="phead" style={{ display: 'block' }}>
        <a className="dback lnk" href={href('work')} onClick={plainClick(onBack)}>← Workloads</a>
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
        {switched && w.switched ? (
          <SwitchedCard s={w.switched} />
        ) : (
          <>
            {switched && <span className="eyebrow eyeok">Switched automatically</span>}
            {hot && <span className="eyebrow">A candidate is ready</span>}

            <h2>{headline(w, cand, switched)}</h2>
            <p>{blurb(w, cand, switched)}</p>

            {/* A candidate's figures come from the measurement that found it, and so does the
                bar it is held to: the workload's own bar is cleared by a measurement that
                could not set one, and read as 0 it made this say "your bar is 100%". */}
            {hot && (
              <div className="kpis">
                <div className="kpi">
                  <div className="kk">Accuracy</div>
                  <div className="kv">{accuracy(w, cand, switched)}</div>
                  <div className="ks">
                    of answers matched {short(w.reference)}.
                    {w.certificate?.floor != null ? ` Your bar is ${(100 - w.certificate.floor).toFixed(1)}%.` : ''}
                  </div>
                </div>
                <div className="kpi">
                  <div className="kk">Cost</div>
                  <div className="kv">{costLine(w, cand, switched)}</div>
                  <div className="ks">{costSub(w, cand, switched)}</div>
                </div>
              </div>
            )}
          </>
        )}

        <div className="dacts">
          {switched && <button className="minig" disabled={busy}
            onClick={act(() => api.revert(w.id))}>Switch back to {short(w.reference)}</button>}
          {hot && w.optimizeMode === 'ask' && (
            <>
              <button className="mini" disabled={busy}
                onClick={act(() => api.promote(w.id, cand.model))}>Approve switch</button>
            </>
          )}
        </div>

        <div className="choices">
          {/* It said "and switch back if it slips", which nothing does yet: a model that stops
              clearing is not switched back automatically. Said as it is until it does. */}
          {[['auto', 'Optimize automatically', 'We switch as soon as a candidate clears your bar. Switching back is one click, at any time.'],
            ['ask', 'Ask me first', 'We test and recommend. Nothing changes until you approve it.']].map(([mode, t, s]) => (
            <button key={mode} className={`choicebox${w.optimizeMode === mode ? ' picked' : ''}`}
              disabled={busy} onClick={act(() => api.setMode(w.id, mode))}>
              <span className="cbt">{t}</span><span className="cbs">{s}</span>
            </button>
          ))}
        </div>
      </section>

      <Measurement w={w} busy={busy} onRan={load}
        openRunId={openRun} onOpenRun={setOpenRun} showingId={showingId} />

      {(cert || earlier) && (
        <section className="opt ovis">
          <div className="opthead">
            <h2>How the candidates compare</h2>
            {compared && (
            <div className="trigwrap" ref={barRef}>
              <div className="trigrow">
                <span className="pill go">Your bar · {(cert.floor ?? w.floor ?? 0).toFixed(2)}%</span>
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
                  <p>We take {cert.sampleSize} of your real calls and run each one twice on {measuredOn}.</p>
                  <p>Your own model did not give the same answer both times on {(cert.noise ?? 0).toFixed(2)}% of them.</p>
                  <p><b>That is where your {(cert.floor ?? 0).toFixed(2)}% bar comes from.</b> A candidate is measured
                    the same way on the same calls, and has to stay inside it.</p>
                  <p>Every model is judged on the same {num(cert.sampleSize)} calls. That is half of this
                    workload&rsquo;s recent traffic, between ten and a hundred, so there is always
                    fresh traffic left to re-check a model we switch you to.</p>
                </div>
              )}
            </div>
            )}
          </div>
          <div className="cbody">
            {compared ? (
              <>
                <CandidateChart results={cert.results} floor={cert.floor ?? 0} reference={measuredOn}
                  referenceCostMonth={cert.referenceCostMonth} />
                {cert.results.some((r) => r.stopped || r.verdict === 'failed') && (
                  <p className="cdnote">
                    {(() => {
                      const n = cert.results.filter((r) => r.stopped || r.verdict === 'failed').length;
                      return `${n} ${n === 1 ? 'model was' : 'models were'} dropped before answering every call, `
                        + 'so they are listed in the table below rather than drawn here: a disagreement from a '
                        + 'few calls is not comparable with one from all of them.';
                    })()}
                  </p>
                )}
                {!plottable(cert, measuredOn) && (
                  <div className="optempty">
                    There is nothing to place on the chart yet: every model in this measurement
                    stopped before it had answered enough calls to be judged.
                  </div>
                )}
              </>
            ) : (
              <div className="optempty mnone">
                <p>{!cert ? 'No measurement has finished yet.'
                  : cert.nothing || 'No models were compared in this measurement.'}</p>
                {earlier && (
                  <button className="minig" onClick={() => setOpenRun(earlier.runId)}>
                    Show the measurement from {timeIST(earlier.at)} IST, which
                    compared {num(earlier.models)} {earlier.models === 1 ? 'model' : 'models'}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      <section className="opt">
        <div className="opthead">
          <h2>Candidates tested</h2>
          <span className="s">
            {!cert ? (earlier ? '' : 'Nothing has been tried yet.')
              : compared ? `Up to ${cert.sampleSize} of your own calls replayed on each model.` : ''}
            {openRun && runData ? (
              <>
                {' '}Showing the measurement from {dateIST(runData.at)} IST.{' '}
                <button className="plainb" onClick={() => setOpenRun(null)}>Back to the latest</button>
              </>
            ) : null}
          </span>
        </div>
        {!cert ? (
          <div className="optempty">
            {earlier
              ? 'No measurement has finished yet. The one above that was stopped part way shows the models it finished.'
              : 'Candidates appear here after the first run, once your bar is set.'}
          </div>
        ) : !compared ? (
          <div className="optempty">No models were tried in this measurement.</div>
        ) : (
          <>
            <div className="cdhrow cd6">
              <span>Model</span>
              <span style={{ textAlign: 'right' }}>Calls</span>
              <span style={{ textAlign: 'right' }}>Disagreement</span>
              <span style={{ textAlign: 'right' }}>Typical time</span>
              <span style={{ textAlign: 'right' }}>Cost a month</span>
              <span>Verdict</span>
            </div>
            <div className="cdrow cd6 cur">
              <div className="mdl">{measuredOn}</div>
              <div className="num">{num(cert.sampleSize * 2)}</div>
              <div className="num">baseline</div>
              <div className="num">{secs(cert.refSpeed?.latencyP50) ?? '—'}</div>
              <div className="num">{cert.referenceCostMonth === null ? '—' : usd(cert.referenceCostMonth)}</div>
              <div><span className="pill q">{measuredOn !== w.reference ? 'Your model then' : switched ? 'Previous model' : 'Current model'}</span></div>
            </div>
            {cert.results.map((r) => {
              const [label, tone] = VERDICT[r.verdict] || ['—', 'q'];
              const serving = r.model === w.model;
              const why = whyOf(r, cert.refSpeed, cert);
              return (
                <div className="cdrow cd6" key={r.model}>
                  <div className="mdl">{r.model}</div>
                  <div className="num">{num(r.runs)}</div>
                  <div className="num">{r.gap === null || r.verdict === 'failed' ? '—' : `${r.gap.toFixed(2)}%`}</div>
                  <div className={`num cdspeed${r.verdict === 'slower' ? ' slow' : ''}`}>{secs(r.latencyP50) ?? '—'}</div>
                  <div className="num">{r.costMonth === null ? '—' : usd(r.costMonth)}</div>
                  <div>
                    <span className={`pill ${serving ? 'ok' : tone}`}>{serving ? 'Serving now' : label}</span>
                    {why && <span className="cdwhy">{why}</span>}
                  </div>
                </div>
              );
            })}
            {/* Said now because it is done: a re-check that finds the switched-to model no longer
                clears, fails calls or is too slow switches back, and so does the live watch. */}
            <div className="barnote">
              Every model was tried on the same {num(cert.sampleSize)} calls, and dropped as soon as it
              could not win, so a model that stopped early was not paid for on every call. A model we
              switch to is re-tested on fresh calls, and watched on your live traffic: if it stops
              clearing, fails calls, or slows down, it goes back.
              {cert.reused ? ` ${num(cert.reused)} answers were reused from earlier measurements${cert.saved ? `, saving ${usd(cert.saved)}` : ''}.` : ''}
              {cert.finishedAt ? ` Last run ${dateIST(cert.finishedAt)} IST.` : ''}
            </div>
          </>
        )}
      </section>

      <WorkloadCalls workloadId={w.id} />
    </>
  );
}

/* Asked through the chart's own rule, so the page never draws an empty box above it. */
const plottable = (cert, reference) => chartPoints(cert?.results, reference, cert?.referenceCostMonth).length >= 2;

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
  if (w.certificate?.outcome === 'unmeasurable' || w.certificate?.outcome === 'refused') return 'We could not set a bar for this workload';
  return 'Nothing has cleared your bar yet';
};

const blurb = (w, cand, switched) => {
  if (switched) {
    // only when the switch's own record is missing; the card above is the ordinary case
    return `We switched it because it cleared your bar. Switch back at any time and your calls go to ${short(w.reference)} again from the next one.`;
  }
  if (cand) {
    return w.optimizeMode === 'ask'
      ? 'It stayed inside your bar across your own calls, replayed and compared answer by answer. Nothing changes until you approve it.'
      : 'It stayed inside your bar across your own calls. This workload optimizes automatically, so it switches on its own.';
  }
  if (w.label === 'Measuring') {
    return 'Before we can recommend anything we measure how much your own model varies from itself. We replay your calls twice and compare the two answers, and that variation becomes the bar a cheaper model has to clear.';
  }
  /* No model was tried at all, so "every model we tried drifted" would be untrue: say what the
     measurement actually found. */
  if ((w.certificate?.outcome === 'unmeasurable' || w.certificate?.outcome === 'refused') && w.certificate.nothing) {
    return w.certificate.nothing;
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
