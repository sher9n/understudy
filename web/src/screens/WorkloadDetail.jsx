import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { href, modelHref } from '../router.js';
import { plainClick } from '../nav.jsx';
import { api, num, timeIST } from '../api.js';
import { more } from '../moreApi.js';
import { dayIST } from '../dates.js';
import { I, toneColor, plotted, Meter, CompareChart, FlowSvg, CostBars, SelfPic } from '../WorkloadCharts.jsx';
import '../workload-page.css';

/* A workload's page, as the approved artboard (version 2, 26 Sep 2026) draws it, with as few words as it can:
 *   1. What Understudy is doing for it, whatever its state: one sentence; the drawing of where its requests go now,
 *      which moves only while they arrive; a switch's takeover as one strip; and a few figures, each a label and a
 *      number. Before its first test, how many more requests a test needs, counted the way a test counts them.
 *   2. What needs a person: a cheaper model waiting for a yes, or one calm line when nothing does.
 *   3. Every model test, each opening to the chart of how its models compared, across the full width, and the list of
 *      them, each opening its own page; and when the next test comes.
 *   4. The recent requests, and which model answered each.
 * Under the name, what the workspace has chosen should happen when a cheaper model passes, as a chip that opens
 * Settings; and for written answers, how another model's are judged against the original model's.
 * Its words keep one noun for each thing: requests (never calls), a test (never a measurement), a model, the original
 * model (the customer's own), and the allowed difference (never the bar); and every outcome says what it means.
 * Its actions: testing now, with its progress and a way to stop; approving a switch a person has to say yes to;
 * switching back; giving a switch still taking over every request; and for a workload whose requests reach us only
 * as copies, the way to route them. The figures come from GET /api/workloads/:id/page (src/workloadPage.js); the
 * actions from the workload itself. Amounts are written as the design writes them: what a test or a month cost to
 * the cent, what one request costs to a hundredth of a cent. */

const KIND = {
  json: ['braces', 'Structured answers'],
  free_text: ['text', 'Written answers'],
  tool_call: ['tools', 'Tool calls'],
  enum: ['choice', 'Fixed choices'],
};
const MODE = { auto: 'Automatic', ask: 'Ask me first', off: 'Never switch' };

/* How a workload's answers are judged when another model is tested on them (judge_mode; see judgeMode in
   src/eval/run.js): Understudy's choice at each test, or always one of the two ways. */
const JUDGING = [
  { mode: 'auto', chip: 'Automatically', label: 'Automatically',
    note: "Understudy decides at each test: at least as good for open-ended writing such as poems and stories, and wherever the original model's own answers vary too much to match; the same answer for everything else." },
  { mode: 'same', chip: 'Same answer', label: 'The same answer',
    note: "Another model passes only when it gives the same answers as the original model. Right when facts, figures or decisions have to match." },
  { mode: 'quality', chip: 'At least as good', label: 'At least as good',
    note: "Another model passes when its answers are at least as good as the original model's, even when they're worded differently. Right for creative writing." },
];
// why the newest test judged answers as at least as good (planRecord.judging.reason)
const JUDGED_WHY = {
  'open-ended': 'these requests ask for open-ended writing',
  varied: 'the original model answers the same request differently each time',
  chosen: "this workload's setting asks for it",
};

const short = (m) => (m ? String(m).split('/').pop() : 'your model');
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
const pct0 = (x) => `${Math.round(x * 100)}%`;
// a time in seconds to a tenth, and a quick one in milliseconds, which to a tenth of a second reads as nothing
const secs = (ms) => (ms < 95 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const withFee = (v, feePct) => (Number(v) || 0) * (1 + (Number(feePct) || 0) / 100);
// a date as India tells it, without its year: "24 Oct"
const dateShort = dayIST;
/* Money to the cent: what a test, a month or thirty days of requests cost, "$0.14". A charge too small to reach a
   cent says so rather than reading as nothing. */
const cents = (v) => {
  const x = Number(v) || 0;
  if (x !== 0 && Math.abs(x) < 0.005) return x < 0 ? 'under -$0.01' : 'under $0.01';
  return `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
/* What one request costs, to a hundredth of a cent, where the cost of a model call lives: "$0.0038". From a dollar up
   to the cent, and one too small for a hundredth of a cent says so. */
const perCall = (v) => {
  const x = Number(v) || 0;
  if (Math.abs(x) >= 1) return cents(x);
  if (x !== 0 && Math.abs(x) < 0.00005) return 'under $0.0001';
  return `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(4)}`;
};

/* A second look that confirmed: cleared again on requests never seen, or for a way of serving that is checked as it
   runs, looked at on live requests once switched. No second look at all (a measurement from before there were any)
   reads as confirmed, as it did then. */
const confirmedLook = (c) => !c || c.verdict === 'cleared' || c.verdict === 'live';

export default function WorkloadDetail({ id, onBack, onChanged, go, goTo }) {
  const [w, setW] = useState(null);
  const [pg, setPg] = useState(null);
  const [err, setErr] = useState(null);
  // what went wrong with something pressed on the page, said beside it; the page itself stays
  const [actErr, setActErr] = useState(null);
  const [busy, setBusy] = useState(false);
  // how its answers are judged, opened from the chip under its name
  const [judgingOpen, setJudgingOpen] = useState(false);

  const load = useCallback(() => Promise.all([
    api.workload(id).then((x) => { setW(x); setErr(null); }).catch((e) => setErr(e.message)),
    api.workloadPage(id).then(setPg).catch((e) => setErr(e.message)),
  ]), [id]);
  // another workload's figures are never shown under this one's name while its own are read
  useEffect(() => { setW(null); setPg(null); load(); }, [id, load]);

  const live = useLive(w, async () => { await load(); onChanged?.(); });

  /* The drawing moves only while requests arrive: whether they are is read again every half minute, and the page's
     figures every few minutes while it is on the screen, so a drawing never goes on moving after they stop. */
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') api.workloadPage(id).then(setPg).catch(() => { /* the figures shown stay */ });
    }, 180000);
    return () => clearInterval(t);
  }, [id]);

  if (err && !(w && pg)) {
    return (
      <div className="errbox" role="alert">
        The workload could not be read: {err}{' '}
        <button type="button" className="linkbtn" onClick={() => { setErr(null); load(); }}>Try again</button>
      </div>
    );
  }
  if (!w || !pg) return <div className="loading">Loading the workload…</div>;

  const act = (fn) => async () => {
    setBusy(true);
    setActErr(null);
    try { await fn(); await load(); onChanged?.(); } catch (e) { setActErr(e.message); } finally { setBusy(false); }
  };

  const m = w.measure || {};
  const cand = w.candidate;
  const switched = !!w.promotedAt;
  const hot = !switched && !!cand;
  /* Approval is offered wherever nothing will switch by itself: a workspace that asks first or never switches, a
     candidate the second look did not confirm, and one switched back from before. */
  const waitsForPerson = hot && (w.optimizeMode !== 'auto' || !confirmedLook(cand.confirm) || !!cand.heldBack);
  // its requests reach us as copies, after the customer's own provider has answered them
  const copiesOnly = !!w.traffic && !w.traffic.carries;
  const kind = KIND[pg.kind] || ['text', w.shape || 'Requests'];
  const running = !!live.run;

  // nothing is wrong with a workload still on its own model, so that is said as a fact, not a warning
  const pill = running ? { tone: 'brand', text: live.run.queued ? 'Starting a test' : 'Testing now' }
    : switched && copiesOnly ? { tone: 'warn', text: 'Switched, waiting for requests' }
      : switched ? { tone: 'ok', text: 'Switched' }
        : waitsForPerson ? { tone: 'brand', text: 'Waiting for your yes' }
          : { tone: 'mut', text: 'Original model still in use' };
  const toSettings = go ? plainClick(() => go('settings', null, { hash: 'optimize' })) : undefined;

  return (
    <div className="wp-page">
      <div className="wp wp-main">
        <div className="wp-crumb"><a href={href('work')} onClick={plainClick(onBack)}>Workloads</a></div>
        <div>
          <div className="wp-wlhead">
            <div>
              <h1 className="wp-title">{w.name}</h1>
              <div className="wp-chips">
                <span className="wp-chip">{I[kind[0]]}{kind[1]}</span>
                <span className="wp-chip" title="The model this workload uses now, which every other model is compared with">
                  Original: <span className="m">{w.reference || 'none named yet'}</span>
                </span>
                {/* what happens when a cheaper model passes; testing goes on whichever is chosen */}
                <a className="wp-chip set" href={href('settings', null, 'optimize')} onClick={toSettings}
                  title="What happens when a cheaper model passes: the workspace's choice, in Settings">{I.gear}Switching: {MODE[w.optimizeMode] || MODE.auto}</a>
                {/* how another model's answers are compared with the original model's: this workload's own choice, for written
                    answers only (answers with a set shape are compared field by field) */}
                {w.judgeChoice && (
                  <button type="button" className="wp-chip set" aria-expanded={judgingOpen} aria-controls="wp-judging"
                    onClick={() => setJudgingOpen((v) => !v)} title="How another model's answers are compared with the original model's when it is tested">
                    {I.gear}Answers judged: {(JUDGING.find((j) => j.mode === w.judgeMode) || JUDGING[0]).chip}
                  </button>
                )}
              </div>
            </div>
            <div className="wp-headacts">
              <span className={`wp-pill is-${pill.tone}`}><span className="wp-pd" />{pill.text}</span>
              <span className="wp-testnow">
                <button type="button" className="wp-btn" disabled={!m.canRun || busy || live.starting || running} onClick={live.start}
                  title={m.canRun && m.atMostUsd > 0 ? `About ${cents(m.aboutUsd)}, and never more than ${cents(m.atMostUsd)}` : undefined}>
                  {live.starting ? 'Starting…' : m.canRun && m.aboutUsd > 0 && !running ? `Test now, about ${cents(m.aboutUsd)}` : 'Test now'}
                </button>
                {/* what a test would cost, before anybody presses it: the most it may spend is where it stops. Under the button
                    it is about, wherever the button wraps to */}
                {!running && m.canRun && m.atMostUsd > 0 && <span className="wp-most">Never more than {cents(m.atMostUsd)}</span>}
              </span>
            </div>
          </div>
          {/* why Test now cannot run, unless it is that there are too few requests yet, which the top says */}
          {!running && !m.canRun && m.reason && pg.enough.yes && <p className="wp-why">{m.reason}</p>}
        </div>

        {judgingOpen && w.judgeChoice && <Judging w={w} busy={busy} act={act} onClose={() => setJudgingOpen(false)} />}

        {(actErr || live.err) && (
          <div className="wp-err" role="alert">
            <span>{actErr || live.err}</span>
            <button type="button" className="wp-textbtn" onClick={() => { setActErr(null); live.setErr(''); }}>Close</button>
          </div>
        )}

        {/* what Understudy is doing, then what needs you, then the tests and the requests */}
        <Summary w={w} pg={pg} cand={cand} waitsForPerson={waitsForPerson} copiesOnly={copiesOnly} running={running}
          busy={busy} act={act} go={go} clock={clock} />
        {waitsForPerson
          ? <Waiting w={w} cand={cand} busy={busy} copiesOnly={copiesOnly} act={act} go={go} goTo={goTo} />
          : <div className="wp-calm">{I.check}<b>Nothing needs you.</b></div>}
        <Measurements w={w} pg={pg} live={live} goTo={goTo} />
        <Calls w={w} pg={pg} />
      </div>
    </div>
  );
}

/* A measurement running now: started, its progress read every two seconds while it lasts, and stopped only once a
   person has said yes twice, because a stopped measurement cannot be picked up again. A progress check sent just
   before a stop was written comes back saying nothing about it, so the stop is remembered here until the run
   itself says it is stopping or has ended. */
function useLive(w, reload) {
  const [run, setRun] = useState(w?.measure?.running || null);
  const [starting, setStarting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [halting, setHalting] = useState(false);
  const [notice, setNotice] = useState('');
  const [err, setErr] = useState('');
  const stopAsked = useRef(false);
  const stopReply = useRef(null);
  const sawStopping = useRef(false);
  const again = useRef(reload);
  again.current = reload;
  const wid = w?.id;

  useEffect(() => { setRun(w?.measure?.running || null); }, [w?.measure?.running]);
  useEffect(() => { if (!run) setAsking(false); }, [run]);
  useEffect(() => {
    if (!run || !wid) return undefined;
    const t = setInterval(async () => {
      try {
        const d = await api.workload(wid);
        const now = d.measure?.running;
        if (now) {
          if (now.stopping) sawStopping.current = true;
          setRun(stopAsked.current ? { ...now, stopping: true } : now);
        } else {
          if (stopReply.current === 'stopping' || sawStopping.current) setNotice(await stopOutcome(wid));
          stopAsked.current = false;
          stopReply.current = null;
          sawStopping.current = false;
          setRun(null);
          again.current();
        }
      } catch { /* the next tick tries again */ }
    }, 2000);
    return () => clearInterval(t);
  }, [run, wid]);

  const start = async () => {
    setStarting(true); setErr(''); setNotice('');
    stopAsked.current = false; stopReply.current = null; sawStopping.current = false;
    try {
      await api.measure(wid);
      const d = await api.workload(wid);
      setRun(d.measure?.running || { queued: true, total: 0, done: 0, spend: 0, phase: null });
      again.current();
    } catch (e) { setErr(e.message); } finally { setStarting(false); }
  };

  const stop = async () => {
    setHalting(true); setErr('');
    stopAsked.current = true;
    try {
      const out = await api.stopMeasuring(wid);
      setAsking(false);
      stopReply.current = out?.state ?? null;
      if (out?.state === 'stopping') setRun((l) => (l ? { ...l, stopping: true } : l));
      else {
        stopAsked.current = false;
        setNotice(AFTER_STOP[out?.state] ?? '');
        setRun(null);
        again.current();
      }
    } catch (e) {
      stopAsked.current = false;
      stopReply.current = null;
      setErr(e.message);
    } finally { setHalting(false); }
  };

  return { run, starting, start, stop, asking, setAsking, halting, notice, setNotice, err, setErr };
}

const STOPPED = 'Stopped. You were charged only for what it had already run, and nothing was switched.';
const FINISHED = 'It had already finished when the stop reached it, so it was not stopped. What it found is below.';
const AFTER_STOP = { stopped: STOPPED, cancelled: 'Stopped before it started, so nothing was spent.', finished: FINISHED, idle: '' };

/* What a stop came to, read from the run itself: a test can finish between the press and the stop arriving. */
async function stopOutcome(workloadId) {
  try {
    const { runs } = await api.workloadRuns(workloadId);
    if (runs?.[0]?.status === 'done') return FINISHED;
  } catch { /* say what was asked for */ }
  return STOPPED;
}

/* When a workload is next tested, in a few words: a date, soon, when a person asks, or once it has the requests a test
   needs; or why the last one nobody asked for did not run, where that is what stands in the way (pageOf's skip). */
const nextWords = (e, skip = null) => {
  if (skip?.short) return skip.short;
  if (!e.yes) return `after ${num(e.need - e.have)} more ${e.need - e.have === 1 ? 'request' : 'requests'}`;
  if (!(e.everyDays > 0)) return 'when you ask';
  if (!e.nextAt || e.nextAt <= Date.now()) return 'soon';
  return dateShort(e.nextAt);
};
// what a thousand requests cost, to the cent: "$0.11"
const perK = (v) => cents((Number(v) || 0) * 1000);

/* What Understudy is doing for a workload, at the top of its page whatever its state: one sentence, the drawing of where
   its requests go now, moving only while they arrive, a switch's takeover as one strip with what moves it on, and a few
   figures, each a label and a number. Before its first test it says how many more requests a test needs; after, the
   tests say when the next one comes. */
function Summary({ w, pg, cand, waitsForPerson, copiesOnly, running, busy, act, go, clock }) {
  const d = pg.doing;
  const f = pg.flow || {};
  const e = pg.enough;
  const refShort = short(w.reference);
  const switched = !!w.promotedAt && !!d;
  // set up and switched, but its requests reach us only as copies: nothing is answered here until one comes through
  const setUp = switched && (d.waiting || copiesOnly);
  const tested = pg.measurements.some((r) => !r.live);
  const lastAt = f.lastAt ?? null;
  const arriving = !!lastAt && clock - lastAt <= (f.liveMs || 15 * 60000);
  const passed = w.certificate?.passedCheaper ?? 0;
  const candName = cand ? (cand.name && cand.name.kind !== 'model' ? cand.name.label : cand.model) : null;
  const auto = e.everyDays > 0;
  const toConnect = go ? plainClick(() => go('connect')) : undefined;

  // the one sentence
  let line;
  let sub = null;
  if (setUp) {
    line = <><span className="m">{d.cheap}</span> is ready, and starts with the first request sent through Understudy.</>;
  } else if (switched) {
    const taking = !!w.rollout && Number(w.rollout.share) < 1;
    // the original model set up another way ("gpt-5.4, cheaper") reads as its whole name, set off by commas
    const who = String(d.cheap || '').includes(',') ? <>{d.label},</> : <span className="m">{d.cheap}</span>;
    line = <>{who} {taking ? 'is taking over.' : 'answers your requests.'}{d.less > 0 ? ` ${pct0(d.less)} cheaper.` : ''}</>;
  } else if (cand) {
    line = <><span className="m">{refShort}</span> answers every request.{passed > 0 ? ` ${num(passed)} cheaper ${passed === 1 ? 'model' : 'models'} passed.` : ''}</>;
  } else if (running) {
    line = <>Testing cheaper models now. <span className="m">{refShort}</span> answers every request meanwhile.</>;
  } else if (!tested && !e.yes) {
    line = `Collecting requests for its first test: ${num(e.have)} of ${num(e.need)}.`;
    sub = auto ? "It starts by itself once they're in." : "Press Test now once they're in.";
  } else if (!tested) {
    line = 'Ready for its first test.';
    sub = auto ? 'It starts by itself soon. You can also press Test now.' : 'Press Test now to run it.';
  } else {
    line = <><span className="m">{refShort}</span> answers every request. No cheaper model has passed yet.</>;
  }

  // the drawing: where its requests go now; a workload whose requests reach us only as copies has none to draw
  const drawn = switched || !copiesOnly;
  const flowD = switched ? d : { kind: 'model', reference: w.reference, perDay: f.perDay, rollout: null, share: 0, label: w.reference };
  const state = switched ? 'switched' : cand ? 'yes' : 'original';
  const pending = cand ? { name: candName, sub: waitsForPerson ? 'waiting for your yes' : 'passed' }
    : { sub: running ? 'testing now' : tested ? 'none passed yet' : 'tested soon' };
  const cap = setUp ? 'Waiting for requests sent through Understudy'
    : arriving ? 'Live' : lastAt ? `No requests since ${timeIST(lastAt)} IST` : 'No requests yet';

  // a switch still taking over: its steps, the one it is on, and what moves it to the next
  const r = switched && !setUp ? w.rollout : null;
  const stages = r ? [...(r.stages || []), 1] : [];
  const at = r ? Math.min(Number(r.stage) || 0, stages.length - 1) : 0;
  const next = r ? stages[at + 1] : undefined;
  const hours = r ? ((r.stageHours || [])[at] ?? (r.stageHours || []).slice(-1)[0] ?? 0) : 0;

  const quality = d?.checks?.yardstick === 'quality';
  const slipNote = d?.checks?.n > 0 && d.checks.rate !== null
    ? `Checked daily: ${pct1(d.checks.rate)} ${quality ? 'worse' : 'different'}, ${Math.round(d.checks.bar * 1000) / 10}% allowed.`
    : null;
  const couldSave = cand && w.certificate?.referenceCostMonth > 0 && cand.costMonth !== null && cand.costMonth !== undefined
    ? w.certificate.referenceCostMonth - cand.costMonth : null;
  const spent = (
    <div className="wp-tile">
      <span className="wp-k">Spent on testing</span>
      <span className="wp-v">{cents(pg.spentMonth)}<small>this month</small></span>
    </div>
  );
  const nextTile = (
    <div className="wp-tile">
      <span className="wp-k">Next test</span>
      <span className="wp-v words" title={pg.skip?.text || undefined}>{nextWords(e, pg.skip)}</span>
    </div>
  );

  return (
    <section className="wp-card wp-sum" aria-labelledby="wp-sum-h">
      <h2 id="wp-sum-h" className="wp-headline">{line}</h2>
      {sub && <p className="wp-sumline">{sub}</p>}
      {!tested && !e.yes && !running && <Meter have={e.have} need={e.need} auto={auto} />}

      {drawn ? (
        <div className="wp-flowwrap">
          <div className="wp-flowcap"><span className={`wp-live${arriving && !setUp ? '' : ' idle'}`} aria-hidden="true" />{cap}</div>
          <FlowSvg d={flowD} state={state} pending={pending} waiting={setUp} still={setUp} idle={!setUp && !arriving} />
        </div>
      ) : (
        <p className="wp-sumline">
          Your requests reach Understudy as copies, after your provider has answered them.{' '}
          <a className="wp-link" href={href('connect')} onClick={toConnect}>Send requests through Understudy</a>
        </p>
      )}
      {setUp && (
        <p className="wp-sumline">
          It takes one change of base URL.{' '}
          <a className="wp-link" href={href('connect')} onClick={toConnect}>Send requests through Understudy</a>
        </p>
      )}

      {r && (
        <div className="wp-steppart">
          <div className="wp-steps" style={{ '--n': stages.length }} role="img"
            aria-label={`Step ${at + 1} of ${stages.length}: ${pct0(stages[at])} of requests now`}>
            {stages.map((s, i) => (
              <span key={s} className={i === at ? 'on' : i < at ? 'done' : ''}>{s >= 1 ? 'All' : pct0(s)}{i === at ? ' now' : ''}</span>
            ))}
          </div>
          <div className="wp-stepline">
            <span>{next !== undefined
              ? `Moves to ${next >= 1 ? 'every request' : pct0(next)} after it answers ${num(r.minCalls)} requests, ${num(hours)} ${hours === 1 ? 'hour' : 'hours'} at least.`
              : ''}</span>
            <button type="button" className="wp-btn small" disabled={busy} onClick={act(() => more.finishRollout(w.id))}>Give it every request now</button>
          </div>
        </div>
      )}

      <div className="wp-tiles">
        {switched ? (
          <>
            {d.expectedMonth !== null && d.expectedMonth !== undefined ? (
              <div className={`wp-tile${d.expectedMonth > 0 ? ' hero' : ''}`}>
                <span className="wp-k">Expected saving</span>
                <span className="wp-v">{cents(d.expectedMonth)}<small>a month</small></span>
              </div>
            ) : (
              <div className={`wp-tile${d.savedMonth > 0 ? ' hero' : ''}`}>
                <span className="wp-k">Saved this month</span>
                <span className="wp-v">{cents(d.savedMonth)}</span>
              </div>
            )}
            <div className="wp-tile">
              <span className="wp-k">Per 1,000 requests</span>
              <span className="wp-v">{d.after > 0 ? perK(d.after) : 'not yet'}</span>
              {d.before > 0 && d.after > 0 && <CostBars before={d.before * 1000} after={d.after * 1000} fmt={cents} />}
              {d.less !== null && d.less !== undefined && <span className="wp-n">{pct0(d.less)} less than {refShort}</span>}
            </div>
            {spent}
            <div className="wp-tile">
              <span className="wp-k">If it slips</span>
              <span className="wp-v words">Back to {refShort}, by itself</span>
              {slipNote && <span className="wp-n">{slipNote}</span>}
              <span><button type="button" className="wp-btn small" disabled={busy} onClick={act(() => api.revert(w.id))}>Switch back now</button></span>
            </div>
          </>
        ) : cand ? (
          <>
            {couldSave !== null && (
              <div className={`wp-tile${couldSave > 0 ? ' hero' : ''}`}>
                <span className="wp-k">Could save</span>
                <span className="wp-v">{cents(couldSave)}<small>a month</small></span>
              </div>
            )}
            {spent}
            {nextTile}
          </>
        ) : (
          <>
            {spent}
            {nextTile}
          </>
        )}
      </div>
    </section>
  );
}

/* A cheaper model that passed and is waiting for a person's yes: one question, why it has not switched by itself, its
   three figures, and the way to say yes; its own page shows each request it answered. */
function Waiting({ w, cand, busy, copiesOnly, act, go, goTo }) {
  const [rp, setRp] = useState(null);
  const runId = w.certificate?.runId;
  useEffect(() => {
    if (!runId) return undefined;
    let on = true;
    api.workloadRunPage(w.id, runId).then((x) => { if (on) setRp(x); }).catch(() => {});
    return () => { on = false; };
  }, [w.id, runId]);
  const row = rp?.cands.find((c) => c.key === cand.model) || null;
  const before = rp?.yours?.perCall ?? null;
  const after = row?.perCall ?? null;
  const name = cand.name && cand.name.kind !== 'model' ? cand.name.label : cand.model;
  const refShort = short(w.reference);
  const quality = rp?.yardstick === 'quality';
  const why = w.optimizeMode === 'ask' ? 'Your workspace asks first, so nothing switches until you say yes.'
    : w.optimizeMode === 'off' ? 'Your workspace never switches by itself.'
      : cand.heldBack ? "It was switched back before, so it won't switch by itself again."
        : 'It has to pass a second test, on new requests it has never seen, before it switches by itself.';
  /* Where it stands on that second test, when it has not passed one: one that did not hold up there is never offered
     (failedSecondLook in src/eval/outcome.js), so it is either waiting for enough new requests (booked to run the moment
     they arrive, see bookSecondLook in src/eval/run.js) or was not reached. */
  const waitingFor = w.measure?.waitingFor || null;
  const moreCalls = waitingFor ? Math.max(1, Number(waitingFor.calls) - Number(waitingFor.have)) : null;
  const second = confirmedLook(cand.confirm) ? null
    : cand.confirm?.verdict === 'insufficient'
      ? (moreCalls ? `It has passed one test. There weren't enough new requests to test it again yet, so that runs by itself as soon as ${num(moreCalls)} more arrive.`
        : "It has passed one test. There weren't enough new requests to test it again yet, so the next test does.")
      : "It has passed one test, and hasn't been tested again on new requests yet.";
  const to = runId ? modelHref(w.id, runId, cand.model) : null;
  const open = () => { if (goTo) goTo(to); else window.location.assign(to); };
  return (
    <section className="wp-att" aria-labelledby="wp-att-h">
      <p className="wp-attlabel"><i aria-hidden="true" />Waiting for your yes</p>
      <h2 id="wp-att-h">Switch to <span className="m">{name}</span>?</h2>
      <p className="wp-one">{why}</p>
      {second && <p className="wp-one">{second}</p>}
      {copiesOnly && (
        <p className="wp-one">
          Your requests reach Understudy only as copies, so a switch waits for the first request sent through Understudy.{' '}
          <a className="wp-link" href={href('connect')} onClick={go ? plainClick(() => go('connect')) : undefined}>Send requests through Understudy</a>
        </p>
      )}
      <dl className="wp-inline">
        <div>
          <dt>{quality ? 'Worse' : 'Different'}</dt>
          <dd className="m">{cand.gap !== null && cand.gap !== undefined ? `${Number(cand.gap).toFixed(1)}%` : 'not judged'}
            {rp?.bar > 0 && <span>{Math.round(rp.bar * 1000) / 10}% allowed</span>}</dd>
        </div>
        <div>
          <dt>Per 1,000 requests</dt>
          <dd className="m">{after > 0 ? perK(after) : 'not priced'}
            {before > 0 && after > 0 && <span>{Math.round(Math.max(0, 1 - after / before) * 100)}% less</span>}</dd>
        </div>
        {row?.p50 > 0 && (
          <div>
            <dt>{rp.metric === 'ttft' ? 'First word' : 'Time'}</dt>
            <dd className="m">{secs(row.p50)}{rp.yours?.p50 > 0 && <span>{refShort} {secs(rp.yours.p50)}</span>}</dd>
          </div>
        )}
      </dl>
      <div className="wp-acts">
        <button type="button" className="wp-btn pri" disabled={busy} onClick={act(() => more.promote(w.id, cand.model))}>Switch to it</button>
        {to && <a className="wp-link" href={to} onClick={plainClick(open)}>See its answers</a>}
        {copiesOnly && (!cand.name || cand.name.kind === 'model') && (
          <button type="button" className="wp-btn" onClick={() => { navigator.clipboard?.writeText(cand.model).catch(() => {}); }}>Copy the model name</button>
        )}
      </div>
    </section>
  );
}

/* How another model's answers are compared with the original model's when one is tested on this workload (judge_mode;
   see judgeMode in src/eval/run.js): Automatically unless it is changed, as three cards in a radio group like the
   workspace's choices in Settings, the arrow keys moving between them. Opened from the chip under the workload's name
   and closed from its own button. Under the cards, how the newest test judged and why; a change applies from the next. */
function Judging({ w, busy, act, onClose }) {
  const chosen = JUDGING.some((j) => j.mode === w.judgeMode) ? w.judgeMode : 'auto';
  const refs = useRef({});
  const choose = (mode) => { if (mode !== chosen) act(() => api.setJudging(w.id, mode))(); };
  const onKey = (e) => {
    const i = JUDGING.findIndex((j) => j.mode === chosen);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = JUDGING[(i + step + JUDGING.length) % JUDGING.length].mode;
    refs.current[next]?.focus();
    choose(next);
  };
  const last = w.judgedAs;
  const lastWords = !last ? 'No test has compared models on this workload yet.'
    : last.yardstick === 'quality'
      ? `The newest test checked for answers at least as good as the original model's${JUDGED_WHY[last.reason] ? `, because ${JUDGED_WHY[last.reason]}` : ''}.`
      : `The newest test checked for the same answers as the original model's${last.mode === 'same' ? ", as this workload's setting asked"
        : last.closed === 'facts' ? ', because its answers state figures, facts or decisions, which have to match'
          : last.closed === 'requests' ? ", because its requests don't ask for open-ended writing like poems or stories" : ''}.`;
  return (
    <section className="wp-card" id="wp-judging" aria-labelledby="wp-judging-h">
      <div className="wp-cardhead">
        <h3 id="wp-judging-h">How answers are judged</h3>
        <button type="button" className="wp-textbtn" onClick={onClose}>Close</button>
      </div>
      <div className="wp-cardbody wp-judging">
        <p className="wp-lead" style={{ margin: 0 }}>
          When another model is tested on this workload, each of its answers is compared with the original model's answer to the same request.
        </p>
        <div className="wp-opts" role="radiogroup" aria-labelledby="wp-judging-h" onKeyDown={onKey}>
          {JUDGING.map((j) => (
            <button type="button" key={j.mode} ref={(el) => { refs.current[j.mode] = el; }} className="wp-opt" role="radio"
              aria-checked={j.mode === chosen} tabIndex={j.mode === chosen ? 0 : -1} disabled={busy} onClick={() => choose(j.mode)}>
              <div className="wp-optop">
                <span className="wp-optnm"><span className="wp-radio" aria-hidden="true" />{j.label}</span>
                {j.mode === 'auto' && <span className="wp-def">Recommended</span>}
              </div>
              <div className="wp-optd">{j.note}</div>
            </button>
          ))}
        </div>
        <div className="wp-applies">{I.info}<span>{lastWords} A change applies from the next test.</span></div>
      </div>
    </section>
  );
}

/* 2. Model tests: a test running now first, with its progress and Stop, then each one there has been, newest first,
   the newest open. */
function Measurements({ w, pg, live, goTo }) {
  const rows = pg.measurements.filter((r) => !r.live);
  /* The test the page's address names (#run_...) opens instead of the newest, and is brought into view: that is where Back
     from one of its models' pages lands, and what a link to one test shows. */
  const named = (() => { const h = window.location.hash.replace(/^#/, ''); return rows.some((r) => r.id === h) ? h : null; })();
  const [open, setOpen] = useState(() => new Set(named ? [named] : rows.length ? [rows[0].id] : []));
  useEffect(() => {
    if (!named) return undefined;
    const t = setTimeout(() => document.getElementById(`wp-run-${named}`)?.scrollIntoView({ block: 'start' }), 80);
    return () => clearTimeout(t);
  // read once, as the page is first drawn
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // a test that has just finished opens, as the newest one does when the page is first read
  const newest = rows[0]?.id ?? null;
  const seen = useRef(newest);
  useEffect(() => {
    if (newest && newest !== seen.current) setOpen((s) => new Set([...s, newest]));
    seen.current = newest;
  }, [newest]);
  const count = rows.length + (live.run ? 1 : 0);
  const toggle = (rid) => setOpen((s) => { const n = new Set(s); if (n.has(rid)) n.delete(rid); else n.add(rid); return n; });
  return (
    <section className="wp-card" aria-labelledby="wp-runs-h">
      <div className="wp-cardhead">
        <h3 id="wp-runs-h">Tests</h3>
        <span className="wp-s" title={pg.skip?.text || undefined}>Next: {nextWords(pg.enough, pg.skip)}</span>
      </div>
      {live.notice && !live.run && <p className="wp-empty" style={{ paddingTop: 10, paddingBottom: 0 }}>{live.notice}</p>}
      {!count ? (
        <p className="wp-empty" style={{ paddingTop: 12 }}>No tests yet.</p>
      ) : (
        <div className="wp-runs">
          {live.run && <LiveRun w={w} live={live} feePct={pg.feePct} />}
          {rows.map((r) => <RunRow key={r.id} w={w} r={r} open={open.has(r.id)} onToggle={() => toggle(r.id)} goTo={goTo} />)}
        </div>
      )}
    </section>
  );
}

/* The test running now, as the first line of the list. */
function LiveRun({ w, live, feePct }) {
  const r = live.run;
  const stopping = !!r.stopping;
  const queued = !!r.queued;
  const pct = r.total ? Math.min(100, Math.round((r.done / r.total) * 100)) : 0;
  /* The progress bar never goes back while a test lasts: the answers still to come are counted afresh as models are
     dropped and replaced, and grow when the second look starts. The time left says what is coming. */
  const most = useRef({ id: null, pct: 0 });
  if (most.current.id !== (r.id ?? null)) most.current = { id: r.id ?? null, pct: 0 };
  most.current.pct = Math.max(most.current.pct, pct);
  const title = stopping ? stoppingLine(r) : queued ? (r.planning ? 'Choosing which models to try' : waitingLine(r.startsAt)) : (r.phase || 'Testing');
  const sub = queued ? (r.planning ? 'Asking which of the models switched on fit your requests. None tried yet.' : 'Nothing has been sent yet, so nothing has been spent.')
    : `${num(r.done)} of ${num(r.total)} model answers`;
  return (
    <div className="wp-run">
      <div className="wp-runbtn">
        <span className="wp-spin" aria-hidden="true" />
        <span className="wp-ww"><span className="wp-when">{title}</span><span className="wp-what">{sub}</span></span>
        <span className="wp-num">{r.sample ? `${num(r.sample)} requests` : ''}</span>
        <span className="wp-num">{queued ? '' : leftLine(r.leftMs)}</span>
        <span className="wp-num">{queued ? '' : `${cents(withFee(r.spend, feePct))}${r.quote > 0 ? ` of about ${cents(r.quote)}` : ''}`}</span>
        <span className={`wp-tag ${stopping ? 'is-mut' : 'is-brand'}`}>{stopping ? 'Stopping' : queued ? 'Waiting to start' : 'Testing now'}</span>
      </div>
      <div className="wp-liverow">
        <div className="wp-livebar" aria-hidden="true"><i style={{ width: `${most.current.pct}%` }} /></div>
        {live.asking && !stopping ? (
          <div className="wp-take" role="group" aria-label="Stop this test" style={{ display: 'grid', gap: 10 }}>
            <span>
              {queued
                ? `Stop testing ${w.name}? It hasn't started, so nothing has been spent and nothing will be.`
                : `Stop testing ${w.name}? You're charged only for what it has already run. Any model that has answered every request keeps its result, and nothing is switched.`}
            </span>
            <span className="wp-acts">
              <button type="button" className="wp-btn pri small" disabled={live.halting} onClick={live.stop}>{live.halting ? 'Stopping…' : 'Stop testing'}</button>
              <button type="button" className="wp-btn small" disabled={live.halting} onClick={() => live.setAsking(false)}>Keep going</button>
            </span>
          </div>
        ) : (
          <div className="wp-acts" style={{ justifyContent: 'space-between' }}>
            <p className="wp-livenote">
              {stopping
                ? `Nothing more is sent after the request in progress. It is charged like the rest, and nothing is switched.${quietFor(r) >= 60000 ? ` If nothing is running it any more, it is closed ${num(r.staleMin || 15)} minutes after it was last heard from.` : ''}`
                : 'You can leave this page, it keeps going.'}
            </p>
            {!stopping && <button type="button" className="wp-btn small" onClick={() => live.setAsking(true)}>Stop</button>}
          </div>
        )}
      </div>
    </div>
  );
}

/* One test: its line, and opened, what it found and every model it tried. The line's tag says what it means when hovered. */
function RunRow({ w, r, open, onToggle, goTo }) {
  const [rp, setRp] = useState(null);
  const [err, setErr] = useState(null);
  const read = useCallback(() => {
    setErr(null);
    api.workloadRunPage(w.id, r.id).then(setRp).catch((e) => setErr(e.message));
  }, [w.id, r.id]);
  useEffect(() => { if (open && !rp) read(); }, [open, rp, read]);
  const did = `wp-rd-${r.id}`;
  return (
    <div className="wp-run" id={`wp-run-${r.id}`}>
      <button type="button" className="wp-runbtn" aria-expanded={open} aria-controls={did} onClick={onToggle}>
        {I.chev}
        <span className="wp-ww">
          {/* what its quote said before it ran, beside what it cost (tests from before quotes were kept have none) */}
          <span className="wp-when">{timeIST(r.at)} IST</span><span className="wp-what">{r.what}{r.quote > 0 ? `, quoted ${cents(r.quote)}` : ''}</span>
          {/* on a narrow screen the figures beside it have no room, so they are a line under it instead */}
          <span className="wp-what narrow">{`${num(r.n)} requests${r.mins ? `, ${num(r.mins)} min` : ''}, ${cents(r.usd)}`}</span>
        </span>
        <span className="wp-num">{num(r.n)} requests</span>
        <span className="wp-num">{r.mins ? `${num(r.mins)} min` : ''}</span>
        <span className="wp-num">{cents(r.usd)}</span>
        <span className={`wp-tag is-${r.tag.tone}`} title={r.tag.why || undefined}>{r.tag.text}</span>
      </button>
      <div className="wp-rundetail" id={did} hidden={!open}>
        {open && (err ? (
          <p className="wp-loadline">This test could not be read: {err}{' '}<button type="button" className="wp-textbtn" onClick={read}>Try again</button></p>
        ) : !rp ? (
          <p className="wp-loadline">Reading this test…</p>
        ) : (
          <>
            <div className="wp-take">{I.info}<span>{rp.take}</span></div>
            {rp.cands.length > 0 ? <RunDetail rp={rp} wid={w.id} goTo={goTo} /> : rp.self && (
              <div className="wp-chartbox wp-selfbox">
                <p className="wp-sub">{rp.self.noise !== null ? 'Original model against itself' : 'How far it got'}</p>
                <SelfPic self={rp.self} yardstick={rp.yardstick} />
              </div>
            )}
          </>
        ))}
      </div>
    </div>
  );
}

/* What the first figure in a test's table means, in the words its information bubble says (see Help). */
export function ColumnWords({ rp }) {
  return rp.yardstick === 'quality' ? (
    <>
      <p><b>Worse than original model</b></p>
      <p>How often this model gave a clearly worse answer than the original model on the requests tested.</p>
      <p>For example, 10% means its answer was clearly worse on 10% of those requests.</p>
    </>
  ) : (
    <>
      <p><b>Different from original model</b></p>
      <p>How often this model gave a different answer from the original model on the requests tested.</p>
      <p>For example, 45% means the two models gave different answers on 45% of those requests.</p>
    </>
  );
}

/* One model on a test's chart, pointed at, focused or tapped: its number and name, its outcome, and each figure its row
   in the table has, beside the original model's where the test has it. */
function DotWords({ c, rp }) {
  if (!c) return null;
  const quality = rp.yardstick === 'quality';
  const ref = rp.yours || {};
  // a saving short of the whole cost is never rounded up to all of it: 99.5% less is "99% less", not "100% less"
  const less = (x) => `${Math.min(99, Math.round(x * 100))}%`;
  const vs = !(ref.perCall > 0) ? '' : Math.abs(c.perCall / ref.perCall - 1) < 0.005 ? `, about the same as the original model's ${perK(ref.perCall)}`
    : `, ${c.perCall < ref.perCall ? `${less(1 - c.perCall / ref.perCall)} less` : `${pct0(c.perCall / ref.perCall - 1)} more`} than the original model's ${perK(ref.perCall)}`;
  return (
    <>
      <p className="wp-dt-head"><span className="wp-dt-no" style={{ background: toneColor(c.tone) }}>{c.no}</span><span>{c.label}</span></p>
      <p className="wp-dt-out" style={{ color: toneColor(c.tone) }}>{c.verdict}</p>
      <dl>
        <div><dt>{quality ? 'Worse than original model' : 'Different from original model'}</dt>
          <dd>{pct1(c.gap)} of requests{rp.bar > 0 ? `, at most ${pct1(rp.bar)} allowed` : ''}</dd></div>
        <div><dt>Per 1,000 requests</dt><dd>{perK(c.perCall)}{vs}</dd></div>
        <div><dt>{rp.metric === 'ttft' ? 'Time to first word' : 'Typical time'}</dt>
          <dd>{c.p50 ? `${secs(c.p50)}${ref.p50 ? `, the original model ${secs(ref.p50)}` : ''}` : 'not timed'}</dd></div>
        <div><dt>Requests answered</dt><dd>{num(c.n)}</dd></div>
      </dl>
    </>
  );
}

/* What the dashed line is: the most another model may differ from the original model, set from how often the original
   model differs from itself, with a little more allowed because a variation measured on one test moves by chance. */
function AllowedWords({ rp }) {
  const f = (x) => `${Math.round(x * 1000) / 10}%`;
  const has = rp.noise !== null && rp.noise !== undefined;
  return rp.yardstick === 'quality' ? (
    <>
      <p><b>Allowed difference</b></p>
      <p>The original model's answers aren't always as good as each other.{has ? ` In this test, one of its two answers to the same request was clearly worse on ${f(rp.noise)} of requests.` : ''}</p>
      <p>Another model counts as a close enough match when its answer is clearly worse than the original model's on at most {f(rp.bar)} of requests{has ? ', a little more than that, because the figure one test measures moves by chance' : ''}.</p>
    </>
  ) : (
    <>
      <p><b>Allowed difference</b></p>
      <p>The original model doesn't always give the same answer when the same request is run again.{has ? ` In this test it answered differently from itself on ${f(rp.noise)} of requests.` : ''}</p>
      <p>Another model counts as a close enough match when it answers differently from the original model on at most {f(rp.bar)} of requests{has ? ', a little more than that, because the figure one test measures moves by chance' : ''}.</p>
    </>
  );
}

/* A small "i" beside a name that says what it means: shown while the pointer or the keyboard is on it, and on a tap,
   which is all a phone has, until a tap elsewhere or Escape. The words float above the page rather than inside the
   table, whose sideways-scrolling box would cut them off, or grow a scrollbar, on a measurement with a row or two. */
export function Help({ label, children, trigger = null }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [at, setAt] = useState(null);
  const btn = useRef(null);
  const box = useRef(null);
  const id = `wp-help-${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const shown = hover || pinned;
  /* Under the "i", centred and kept on the screen; above it where below would run off the bottom; and where it fits
     neither way (both columns' words on a phone), as low as it can sit while staying on the screen, scrolling in
     itself if it is taller than the screen. */
  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(300, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 12));
    const h = Math.min(box.current?.offsetHeight || 0, window.innerHeight - 24);
    const below = r.bottom + 8;
    const above = r.top - 8 - h;
    const top = !h || below + h <= window.innerHeight - 12 ? below : above >= 12 ? above : Math.max(12, window.innerHeight - 12 - h);
    setAt({ top, left, width });
  }, []);
  useLayoutEffect(() => {
    if (!shown) { setAt(null); return undefined; }
    place();
    // placed again once it is drawn and its height is known, and whenever the page or the table moves under it
    const raf = requestAnimationFrame(place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [shown, place]);
  useEffect(() => {
    if (!pinned) return undefined;
    const away = (e) => { if (!btn.current?.contains(e.target) && !box.current?.contains(e.target)) setPinned(false); };
    const esc = (e) => { if (e.key === 'Escape') { setPinned(false); setHover(false); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [pinned]);
  return (
    <>
      <button ref={btn} type="button" className={trigger ? 'wp-helptag' : 'wp-help'} aria-label={trigger ? `${label}: what this means` : `What ${label} means`} aria-expanded={pinned}
        aria-describedby={shown ? id : undefined}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHover(true); }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(false); }}
        onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) setHover(true); }}
        onBlur={() => setHover(false)}
        onClick={() => setPinned((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Escape') { setHover(false); setPinned(false); } }}>
        {trigger ?? I.info}
      </button>
      {/* inside the app's own box, which carries the colours of the light or dark theme; the page's body has none */}
      {shown && at && createPortal(
        <div ref={box} id={id} role="tooltip" className="wp-tipbox" style={{ top: at.top, left: at.left, width: at.width }}>{children}</div>,
        btn.current?.closest('[data-mode]') ?? document.body,
      )}
    </>
  );
}

/* What a test's "Requests sampled" column counts, in the words its information bubble says (see Help): the user's
   sentence, as given on 25 Sep. */
export function SampledWords() {
  return (
    <>
      <p><b>Requests sampled</b></p>
      <p>How many requests were tested on this model.</p>
    </>
  );
}

function RunDetail({ rp, wid, goTo }) {
  const quality = rp.yardstick === 'quality';
  const axis = quality ? 'Worse than original model' : 'Different from original model';
  const col = quality ? 'Worse' : 'Different';
  const time = rp.metric === 'ttft' ? 'Time to first word' : 'Typical time';
  const run = { ...rp, axis };
  const chart = rp.cands.some(plotted);
  const barWords = `${Math.round(rp.bar * 1000) / 10}%`;
  return (
    <div className="wp-detailgrid">
      {/* one heading over the chart and the table under it, which show the same models two ways */}
      <p className="wp-sub wp-detailhead">
        Models tested
        {/* a phone shows no column names, so the first figure is explained here instead */}
        <span className="wp-phonehelp"><Help label={axis}><ColumnWords rp={rp} /></Help></span>
      </p>
      {chart && (
        <div className="wp-chartbox">
          <CompareChart run={run} tip={(c) => <DotWords c={c} rp={rp} />} />
          <div className="wp-legend">
            <span><i style={{ background: 'var(--ok)' }} />passed</span>
            <span><i style={{ background: 'var(--warn)' }} />close match, slower, or too few to be sure</span>
            <span><i style={{ background: 'var(--bad)' }} />not a match</span>
            <span><i style={{ background: 'var(--mut)' }} />stopped early</span>
            {rp.bar > 0 && <span><i className="wp-dash" />allowed difference, {barWords}<Help label="the allowed difference"><AllowedWords rp={rp} /></Help></span>}
          </div>
        </div>
      )}
      <div className="wp-tablewrap">
        <p className="wp-loadline wp-candhint">Select a model to see its answers.</p>
        <table className="wp-cands">
          <thead>
            <tr>
              <th aria-label="Number" />
              <th>Model</th>
              <th>Outcome</th>
              <th className="r">{col}<Help label={axis}><ColumnWords rp={rp} /></Help></th>
              <th className="r">Requests sampled<Help label="Requests sampled"><SampledWords /></Help></th>
              <th className="r">Per 1,000</th>
              <th className="r">{time}</th>
            </tr>
          </thead>
          <tbody>
            {rp.cands.map((c, i) => (
              <CandRow key={c.key} c={c} i={i} rp={rp} wid={wid} col={col} time={time} goTo={goTo} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* One model in a test's table: its row, which opens the model's own page, every request the test ran through it
   (ModelPage). The whole row answers a click; the model's name is the link, for the keyboard, a screen reader and a new
   tab. On the way, this test is written into the page's address, so Back opens this same test again. */
function CandRow({ c, i, rp, wid, col, time, goTo }) {
  const tag = <span className={`wp-tag is-${c.tone}`}>{c.verdict}</span>;
  const to = modelHref(wid, rp.id, c.key);
  const open = () => {
    try { window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${rp.id}`); } catch { /* no history */ }
    if (goTo) goTo(to); else window.location.assign(to);
  };
  // the test's own requests, and the new ones a second look read it on
  const sampled = `${!rp.sample || c.n >= rp.sample ? num(c.n) : `${num(c.n)} of ${num(rp.sample)}`}${c.second > 0 ? ` + ${num(c.second)} new` : ''}`;
  return (
    /* a click on another button in the row (the outcome's words), or inside words it floats above the page, is its own */
    <tr className="open-able" onClick={(e) => { if (e.currentTarget.contains(e.target) && !e.target.closest('button, a')) open(); }}>
      <td><span className="wp-no" style={{ background: toneColor(c.tone) }}>{i + 1}</span></td>
      <td className="wp-mdl">
        <a className="wp-mdlbtn" href={to} onClick={plainClick(open)} aria-label={`${c.label}: its own page, with each request it answered`}>
          <span>{c.label}</span>{I.chev}
        </a>
      </td>
      <td>{c.why ? <Help label={c.verdict} trigger={tag}><p>{c.why}</p></Help> : tag}</td>
      <td className={`r m${c.gap === null ? ' none' : ''}`} data-label={col}>{c.gap === null ? 'not judged' : pct1(c.gap)}</td>
      <td className="r m" data-label="Requests sampled">{sampled}</td>
      <td className={`r m${c.perCall === null ? ' none' : ''}`} data-label="Per 1,000 requests">{c.perCall === null ? 'not priced' : perK(c.perCall)}</td>
      <td className={`r m${!c.p50 ? ' none' : ''}`} data-label={time}>{c.p50 ? secs(c.p50) : 'not timed'}</td>
    </tr>
  );
}

/* 3. Recent requests: when, which model answered (the cheaper model in green, the original model in ink), how long it
   took, what it cost and how it went, ten at a time. A row opens to what was asked and what came back. */
function Calls({ w, pg }) {
  const [c, setC] = useState(pg.calls);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState(null);
  useEffect(() => { setC(pg.calls); }, [pg.calls]);
  const page = async (n) => {
    setBusy(true);
    try { setC(await api.workloadPageCalls(w.id, n)); setOpenId(null); } catch { /* the rows shown stay */ } finally { setBusy(false); }
  };
  const copiesOnly = !!w.traffic && !w.traffic.carries;
  const inMonth = `${num(c.total)} in 30 days, ${cents(c.cost)}`;
  const summary = !c.total ? 'none in 30 days'
    : w.promotedAt && copiesOnly ? `${inMonth}, copies the original model answered`
      : w.promotedAt ? `${inMonth}, ${pct0(c.cheapShare)} by the cheaper model${c.cheapSince ? ' since the switch' : ''}`
        : inMonth;
  return (
    <section className="wp-card" aria-labelledby="wp-calls-h">
      <div className="wp-cardhead"><h3 id="wp-calls-h">Requests</h3><span className="wp-s">{summary}</span></div>
      <div className="wp-cardbody">
        {!c.rows.length ? (
          <p className="wp-lead" style={{ margin: 0 }}>No requests yet.</p>
        ) : (
          <div className="wp-tablewrap">
            <table className="wp-calls">
              <thead><tr><th>Sent</th><th>Answered by</th><th className="r">Time</th><th className="r">Cost</th><th>Status</th></tr></thead>
              <tbody>
                {c.rows.map((x) => (
                  <CallRow key={x.id} w={w} x={x} open={openId === x.id} onToggle={() => setOpenId((o) => (o === x.id ? null : x.id))} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(c.page > 1 || c.more) && (
          <div className="wp-pager">
            {c.page > 1 && <button type="button" className="wp-textbtn" disabled={busy} onClick={() => page(c.page - 1)}>Newer requests</button>}
            {c.more && <button type="button" className="wp-textbtn" disabled={busy} onClick={() => page(c.page + 1)}>Older requests</button>}
          </div>
        )}
      </div>
    </section>
  );
}

function CallRow({ w, x, open, onToggle }) {
  const [said, setSaid] = useState(null);
  useEffect(() => {
    if (!open || said) return;
    Promise.all([api.callText(w.id, x.id, 'asked'), api.callText(w.id, x.id, 'answered')])
      .then(([a, b]) => setSaid({ asked: a.text, answered: b.text, purged: a.purged || b.purged }))
      .catch((e) => setSaid({ err: e.message }));
  }, [open, said, w.id, x.id]);
  // an error from the provider, or no answer at all (0: it never came back)
  const failed = x.status !== null && (x.status >= 400 || x.status === 0);
  const tag = failed ? ['bad', 'Failed'] : x.copy ? ['mut', 'Copy'] : ['ok', 'Answered'];
  const who = x.who === 'cheap' ? 'var(--ok)' : x.who === 'yours' ? 'var(--ink)' : 'var(--mut)';
  const how = x.sentOn ? ', sent on' : x.experiment ? ', an experiment' : '';
  return (
    <>
      <tr className="open-able" onClick={onToggle} aria-expanded={open} tabIndex={0}
        aria-label={`Request at ${timeIST(x.at)} IST, ${open ? 'showing' : 'show'} what was asked and answered`}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <td className="m">{timeIST(x.at)} IST</td>
        <td><span className="wp-srv"><i style={{ background: who }} /><span className="wp-mdl">{x.model || 'no model named'}{how}</span></span></td>
        <td className={`r m${x.ms === null ? ' none' : ''}`} data-label="Time">{x.ms === null ? 'not timed' : secs(x.ms)}</td>
        <td className="r m" data-label="Cost">{perCall(x.cost)}</td>
        <td><span className={`wp-tag is-${tag[0]}`} title={failed ? `The provider answered ${x.status}` : undefined}>{tag[1]}</span></td>
      </tr>
      {open && (
        <tr className="saidrow">
          <td className="said" colSpan={5}>
            {!said ? <span className="wp-loadline">Reading this request…</span>
              : said.err ? <span className="wp-loadline">This request could not be read: {said.err}</span>
                : said.purged && !said.asked && !said.answered ? <span className="wp-loadline">What was asked and answered is no longer kept, as your retention setting says.</span>
                  : (
                    <div className="wp-said">
                      <div><p className="wp-sub">Asked</p>{said.asked || 'nothing kept'}</div>
                      <div><p className="wp-sub">Answered</p>{said.answered || 'nothing kept'}</div>
                    </div>
                  )}
          </td>
        </tr>
      )}
    </>
  );
}

/* How long since a running test was last heard from, as the server measured it. */
const quietFor = (r) => Math.max(0, Number(r?.quietMs) || 0);

const stoppingLine = (r) => {
  const quiet = quietFor(r);
  if (quiet < 60000) return 'Stopping once the request in progress comes back';
  const mins = Math.max(1, Math.round(quiet / 60000));
  return `Stopping. It has not been heard from for ${num(mins)} ${mins === 1 ? 'minute' : 'minutes'}`;
};

/* About how long a running test has left, at the pace it has kept so far (leftOf in src/api.js). */
const leftLine = (ms) => {
  if (ms == null) return 'working out time left';
  if (ms < 60000) return 'under a minute left';
  const mins = Math.ceil(ms / 60000);
  return `about ${num(mins)} min left`;
};

/* A test waiting its turn; one held back for a while says until when, in IST. */
const waitingLine = (startsAt) => (startsAt && startsAt > Date.now() + 60000
  ? `Waiting until ${timeIST(startsAt)} IST to start`
  : 'Waiting for its turn to start');
