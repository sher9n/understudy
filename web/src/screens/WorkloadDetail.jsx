import React, { useEffect, useRef, useState } from 'react';
import { href } from '../router.js';
import { plainClick } from '../nav.jsx';
import { api, usd, num, dateIST, timeIST } from '../api.js';
import { CandidateChart, chartPoints } from '../Charts.jsx';
import WorkloadCalls from './WorkloadCalls.jsx';
import Measurement from './Measurement.jsx';
import SwitchedCard from './SwitchedCard.jsx';
import Learning from './Learning.jsx';
import Outcomes from './Outcomes.jsx';
import { ServingFlow, inHundred } from '../LearnCharts.jsx';
import SectionBoundary from '../SectionBoundary.jsx';

const Tile = ({ k, v, s }) => (
  <div className="tile"><div className="k">{k}</div><div className="v">{v}</div><div className="s">{s}</div></div>
);

const VERDICT = {
  cleared: ['Cleared', 'ok'], review: ['Needs review', 'wait'],
  missed: ['Missed the bar', 'q'], insufficient: ['Still running', 'wait'],
  slower: ['Slower than yours', 'wait'], failed: ['Could not answer', 'q'],
};

const secs = (ms) => (ms === null || ms === undefined ? null : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);

/* Streamed calls are timed to the first word, because that is what somebody watching them
   waits for; everything else to the whole answer. The table shows the one the run held
   models to, so a model marked slower is slower in the column beside it. */
const timedToFirstWord = (cert) => cert?.plan?.speed?.metric === 'ttft' && !!cert?.refSpeed?.ttftP50;
const typical = (x, cert) => (timedToFirstWord(cert) ? x?.ttftP50 : x?.latencyP50);
const slowOf = (x, cert) => (timedToFirstWord(cert) ? x?.ttftP90 : x?.latencyP90);

/* Why a model got the verdict it did, in a few words under the verdict. */
function whyOf(r, refSpeed, cert) {
  if (r.verdict === 'failed') {
    if (r.stopped === 'errors') {
      return 'Its provider was too busy to answer, so its answers were never judged. It can be tried again later.';
    }
    return r.errorText ? `Provider said: ${r.errorText}` : 'Its provider refused the calls';
  }
  if (r.verdict === 'slower') {
    const mine = typical(r, cert);
    const theirs = typical(refSpeed, cert);
    const factor = cert?.plan?.speed?.factor || 1.5;
    /* Slow at the end rather than typically: most calls as quick as allowed, too many far slower.
       Said as it is, because a typical time as good as yours under "Slower than yours" reads as
       a mistake. */
    if (mine && theirs && mine <= theirs * factor + 300) {
      const end = slowOf(r, cert);
      const theirsEnd = slowOf(refSpeed, cert);
      if (end && theirsEnd) return `Usually quick enough, but one call in ten took ${secs(end)}, against ${secs(theirsEnd)} for yours`;
    }
    const what = timedToFirstWord(cert) ? 'Starts answering in' : 'Typically';
    return mine && theirs ? `${what} ${secs(mine)}, against ${secs(theirs)} for yours` : 'Slower than your speed setting allows';
  }
  if (r.stopped === 'bar') return `Stopped after ${r.runs} of ${cert.sampleSize} calls, once it could not reach your bar`;
  if (r.verdict === 'missed' && r.difference) return `Mostly ${r.difference}`;
  if (r.thinking && r.thinking !== 'default') {
    // why thinking was changed, as the plan said it: because of the cap, or to match your model
    const planned = cert?.plan?.order?.find((o) => o.model === r.model);
    if (planned?.note) return planned.note.charAt(0).toUpperCase() + planned.note.slice(1);
    return r.thinking === 'off' ? 'Measured with its thinking switched off' : 'Measured thinking as little as it allows';
  }
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

  // what live calls are teaching us: read beside the workload, and again whenever it changes
  const [learn, setLearn] = useState(null);
  const [learnErr, setLearnErr] = useState(null);
  const loadLearn = () => api.learning(id).then((x) => { setLearn(x); setLearnErr(null); }).catch((e) => setLearnErr(e.message));
  const load = () => Promise.all([api.workload(id).then(setW).catch((e) => setErr(e.message)), loadLearn()]);
  // another workload's records are never shown under this one's name while its own are read
  useEffect(() => { setLearn(null); setLearnErr(null); load(); }, [id]);
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
    refSpeed: runData.refSpeed, reused: runData.reused, saved: runData.saved, plan: runData.plan,
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
  /* Its calls reach us as copies, after the customer's own provider has answered them: a switch
     here is set up and waits for the first call that comes through Understudy. */
  const copiesOnly = !!w.traffic && !w.traffic.carries;

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
          <SectionBoundary><SwitchedCard s={w.switched} learn={learn} /></SectionBoundary>
        ) : (
          <>
            {switched && <span className="eyebrow eyeok">Switched automatically</span>}
            {hot && <span className="eyebrow">A candidate is ready</span>}

            <h2>{headline(w, cand, switched)}</h2>
            <p>{blurb(w, cand, switched)}</p>
            {hot && cand.name && cand.name.kind !== 'model' && (
              <ServingFlow kind={cand.name.kind} first={cand.name.first} fallback={cand.name.fallback} reference={w.reference}
                sentOn={cand.escalated === null || cand.escalated === undefined ? null : cand.escalated / 100} sentOnFrom="measured" />
            )}

            {/* A candidate's figures come from the measurement that found it, and so does the
                bar it is held to: the workload's own bar is cleared by a measurement that
                could not set one, and read as 0 it made this say "your bar is 100%". */}
            {hot && (
              <div className={`kpis${candBg(cand, learn) ? ' three' : ''}`}>
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
                {candBg(cand, learn) && (
                  <div className="kpi">
                    <div className="kk">On your live calls</div>
                    <div className="kv">{`${(candBg(cand, learn).rate * 100).toFixed(1)}%`}</div>
                    <div className="ks">
                      of {num(candBg(cand, learn).calls)} background answers matched yours. Your app never saw them, and nothing was changed.
                    </div>
                  </div>
                )}
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
          {hot && copiesOnly && (
            <>
              <a className="minig lnk" href={href('connect')}>Send calls through Understudy</a>
              {/* a strategy runs its check here, so it cannot be copied into anybody's code as a model name */}
              {(!cand.name || cand.name.kind === 'model') && (
                <>
                  <code className="recmodel m">{cand.model}</code>
                  <button className="minig" onClick={() => { navigator.clipboard?.writeText(cand.model).catch(() => {}); }}>
                    Copy model name
                  </button>
                </>
              )}
            </>
          )}
        </div>

        {copiesOnly && (
          <p className="choicenote">
            Either way, a switch here is set up and waits: it starts with the first call that comes through Understudy.
          </p>
        )}
        <div className="choices">
          {/* The live watch looks at a switched model's calls every hour, and each measurement on
              the workspace's schedule checks its answers again; either switches it back. */}
          {[['auto', 'Optimize automatically', 'We switch as soon as a candidate clears your bar, and switch back on our own if it stops clearing it, starts failing calls or slows down. You can switch back yourself at any time.'],
            ['ask', 'Ask me first', 'We test and recommend. Nothing is switched until you approve it.']].map(([mode, t, s]) => (
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
            <div className="trigwrap" ref={barRef}
              onKeyDown={(e) => { if (e.key === 'Escape' && barOpen) { e.stopPropagation(); setBarOpen(false); e.currentTarget.querySelector('.whyb')?.focus(); } }}>
              <div className="trigrow">
                <span className="pill go">Your bar · {(cert.floor ?? w.floor ?? 0).toFixed(2)}%</span>
                <button className="whyb" onClick={() => setBarOpen((v) => !v)}
                  aria-expanded={barOpen} aria-controls="bar-how">
                  <span className="whyi" aria-hidden="true">?</span> How is this set?
                </button>
              </div>
              {barOpen && (
                <div className="pop popover" id="bar-how" role="dialog" aria-labelledby="bar-how-title">
                  <div className="pophead">
                    <h3 id="bar-how-title">How your bar is set</h3>
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

      <section className={`opt${timedToFirstWord(cert) ? ' cands-ttft' : ''}`}>
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
              <span style={{ textAlign: 'right' }}>{timedToFirstWord(cert) ? 'First word' : 'Typical time'}</span>
              <span style={{ textAlign: 'right' }}>Cost a month</span>
              <span>Verdict</span>
            </div>
            <div className="cdrow cd6 cur">
              <div className="mdl">{measuredOn}</div>
              <div className="num">{num(cert.sampleSize * 2)}</div>
              <div className="num">baseline</div>
              <div className="num">{secs(typical(cert.refSpeed, cert)) ?? 'not timed'}</div>
              <div className="num">{cert.referenceCostMonth === null ? 'not priced' : usd(cert.referenceCostMonth)}</div>
              <div><span className="pill q">{measuredOn !== w.reference ? 'Your model then' : switched ? 'Previous model' : 'Current model'}</span></div>
            </div>
            {cert.results.map((r) => {
              const [label, tone] = VERDICT[r.verdict] || [r.verdict, 'q'];
              // what serves, by its measurement's own name: a cascade's row, not its cheap model's
              const serving = r.model === (w.servingKey || w.model);
              const why = whyOf(r, cert.refSpeed, cert);
              const strategy = r.name && r.name.kind !== 'model';
              return (
                <div className="cdrow cd6" key={r.model}>
                  <div className="mdl">
                    {strategy ? r.name.label : r.model}
                    {strategy && <span className="cdkind">{kindWords(r)}</span>}
                  </div>
                  <div className="num">{num(r.runs)}</div>
                  <div className="num">{r.gap === null || r.verdict === 'failed' ? 'not judged' : `${r.gap.toFixed(2)}%`}</div>
                  <div className={`num cdspeed${r.verdict === 'slower' ? ' slow' : ''}`}>{secs(typical(r, cert)) ?? 'not timed'}</div>
                  <div className="num">{r.costMonth === null ? 'not priced' : usd(r.costMonth)}</div>
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

      <SectionBoundary title="What live calls are teaching us">
        <Learning w={w} d={learn} err={learnErr} onReload={loadLearn} onSwitched={async () => { await load(); onChanged?.(); }} />
      </SectionBoundary>
      <SectionBoundary title="How calls turned out">
        <Outcomes key={w.id} w={w} />
      </SectionBoundary>

      <WorkloadCalls workloadId={w.id} />
    </>
  );
}

/* What a candidate's background answers on live calls showed, when it has given any. */
function candBg(cand, learn) {
  const o = cand && learn?.others?.find((x) => x.key === cand.model);
  return o && o.shadow?.calls > 0 && o.shadow.rate !== null ? o.shadow : null;
}

/* What a strategy is, in a few words under its name in the table. */
function kindWords(r) {
  const on = r.escalated === null || r.escalated === undefined ? null : inHundred(r.escalated / 100);
  if (r.name.kind === 'cascade') return `A cheaper model, checked${on ? `: ${on} calls sent on` : ''}`;
  if (r.name.kind === 'router') return `Picked call by call${on ? `: ${on} calls to ${String(r.name.fallback).split('/').pop()}` : ''}`;
  return 'Your own model, asked to think less';
}

/* Asked through the chart's own rule, so the page never draws an empty box above it. */
const plottable = (cert, reference) => chartPoints(cert?.results, reference, cert?.referenceCostMonth).length >= 2;

const short = (m) => (m ? String(m).split('/').pop() : 'not set');
const vendor = (m) => (m && m.includes('/') ? `${m.split('/')[0]}, your own choice` : 'your own choice');

const accuracy = (w, cand, switched) => {
  const gap = switched
    ? (w.certificate?.results.find((r) => r.model === (w.servingKey || w.model))?.gap ?? 0)
    : (cand?.gap ?? 0);
  return `${(100 - gap).toFixed(1)}%`;
};

const headline = (w, cand, switched) => {
  if (switched) return `${short(w.model)} is serving ${w.name}`;
  if (cand && cand.name?.kind === 'cascade') return `A checked cheaper model cleared your bar`;
  if (cand && cand.name?.kind === 'router') return `Picking a model call by call cleared your bar`;
  if (cand && cand.name?.kind === 'lighter') return `${short(w.reference)} thinking less cleared your bar`;
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
  if (cand && cand.name && cand.name.kind !== 'model' && w.traffic && !w.traffic.carries) {
    return `It stayed inside your bar across your own calls. It checks answers, or picks the model call by call, here at `
      + `Understudy, so it can only run on calls that come through us, not by changing the model your code asks for: that `
      + `is one change of base URL. Your calls reach us as copies today, so nothing changes until they do.`;
  }
  if (cand && w.traffic && !w.traffic.carries) {
    return `It stayed inside your bar across your own calls, replayed and compared answer by answer. Your calls `
      + `reach us as copies, after your own provider has answered them, so a switch here starts with the first `
      + `call that comes through Understudy: that is one change of base URL in your code. If you call OpenRouter `
      + `yourself, you can instead change the model your code asks for to the one below.`;
  }
  if (cand && cand.name && cand.name.kind !== 'model') {
    const lead = cand.name.kind === 'cascade'
      ? `${short(cand.name.first)} answers each call and a quick check reads the answer; when the check is unsure, ${short(cand.name.fallback)} answers instead.`
      : cand.name.kind === 'router'
        ? `A small model learned from your own calls sends each one either to ${short(cand.name.first)} or to ${short(cand.name.fallback)}.`
        : `The same model, asked to think less before it answers.`;
    return `${lead} Worked out on your own calls, it stayed inside your bar. `
      + (w.optimizeMode === 'ask' ? 'Nothing changes until you approve it.' : 'This workload optimizes automatically, so it switches on its own.');
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
  /* Said from what the models actually did: "drifted" is only true of the ones whose answers
     missed. A model that matched but was too slow, or whose provider could not be reached, did
     not drift at all. */
  const rs = w.certificate?.results || [];
  const matchedSlow = rs.some((r) => r.verdict === 'slower' && !r.stopped);
  const missed = rs.some((r) => r.verdict === 'missed');
  if (rs.length && rs.every((r) => r.verdict === 'failed')) {
    return 'None of the models we tried could be reached this time: their providers refused them or were too busy. We try again on the next measurement.';
  }
  if (matchedSlow && !missed) {
    return 'The models whose answers matched yours were slower than your speed setting allows. A setting that allows more time would let them through; otherwise we keep trying as faster models land.';
  }
  if (matchedSlow) {
    return 'No model we tried both matched your answers and kept to your speed setting. We keep trying as new models land.';
  }
  return 'Every model we tried drifted further from your own model than your bar allows. We keep trying as new models land.';
};

const costLine = (w, cand, switched) => {
  const target = switched
    ? w.certificate?.results.find((r) => r.model === (w.servingKey || w.model))?.costMonth
    : cand?.costMonth;
  const base = w.certificate?.referenceCostMonth;
  if (!target || !base || base <= 0) return target ? `${usd(target)} a month` : '—';
  return `${Math.round((1 - target / base) * 100)}% lower`;
};

const costSub = (w, cand, switched) => {
  const target = switched
    ? w.certificate?.results.find((r) => r.model === (w.servingKey || w.model))?.costMonth
    : cand?.costMonth;
  const base = w.certificate?.referenceCostMonth;
  if (!target) return 'measured once a full month of traffic is in';
  if (!base) return `${usd(target)} a month at your volume`;
  return `${usd(base)} a month ${switched ? 'became' : 'would become'} ${usd(target)}. You keep ${usd(base - target)}.`;
};
