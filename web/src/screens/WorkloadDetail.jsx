import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { href } from '../router.js';
import { plainClick } from '../nav.jsx';
import { api, num, timeIST } from '../api.js';
import { more } from '../moreApi.js';
import { dayIST } from '../dates.js';
import { I, dayLabel, toneColor, plotted, DailyChart, Meter, CompareChart, FlowSvg, CostBars, QualitySpark, SelfPic } from '../WorkloadCharts.jsx';
import '../workload-page.css';

/* A workload's page, as the design artboard draws it: four answers at a glance, and once it is switched, what
 * Understudy is doing for it and what that saves.
 *   1. Is there enough of its traffic to optimize it? Counted the way a test counts it, and if not yet, how the
 *      rest can arrive and so the earliest a test can start (it starts by itself).
 *   2. What the workspace has chosen should happen when a cheaper setup passes, as a chip that opens Settings.
 *   3. Every measurement, each opening to the chart of how its candidates compared and the list of them.
 *   4. The calls, and who answered each.
 * Its actions: measuring now, with its progress and a way to stop; approving a switch a person has to say yes to;
 * switching back; giving a switch still taking over every request; and for a workload whose requests reach us only
 * as copies, the way to route them. The figures come from GET /api/workloads/:id/page (src/workloadPage.js); the
 * actions from the workload itself. Amounts are written as the design writes them: what a measurement or a month
 * cost to the cent, what one request costs to a hundredth of a cent. */

const KIND = {
  json: ['braces', 'Structured answers'],
  free_text: ['text', 'Written answers'],
  tool_call: ['tools', 'Tool calls'],
  enum: ['choice', 'Fixed choices'],
};
const MODE = { auto: 'Automatic', ask: 'Ask me first', off: 'Never switch' };

const short = (m) => (m ? String(m).split('/').pop() : 'your model');
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
const pct0 = (x) => `${Math.round(x * 100)}%`;
// a time in seconds to a tenth, and a quick one in milliseconds, which to a tenth of a second reads as nothing
const secs = (ms) => (ms < 95 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const withFee = (v, feePct) => (Number(v) || 0) * (1 + (Number(feePct) || 0) / 100);
// a date as India tells it, without its year: "24 Oct"
const dateShort = dayIST;
/* Money to the cent: what a measurement, a month or thirty days of calls cost, "$0.14". A charge too small to reach a
   cent says so rather than reading as nothing. */
const cents = (v) => {
  const x = Number(v) || 0;
  if (x !== 0 && Math.abs(x) < 0.005) return x < 0 ? 'under -$0.01' : 'under $0.01';
  return `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
// a whole-dollar figure where it is large enough to read that way
const money = (v) => (Math.abs(v) >= 10 ? `${v < 0 ? '-' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-US')}` : cents(v));
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

export default function WorkloadDetail({ id, onBack, onChanged, go }) {
  const [w, setW] = useState(null);
  const [pg, setPg] = useState(null);
  const [err, setErr] = useState(null);
  // what went wrong with something pressed on the page, said beside it; the page itself stays
  const [actErr, setActErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => Promise.all([
    api.workload(id).then((x) => { setW(x); setErr(null); }).catch((e) => setErr(e.message)),
    api.workloadPage(id).then(setPg).catch((e) => setErr(e.message)),
  ]), [id]);
  // another workload's figures are never shown under this one's name while its own are read
  useEffect(() => { setW(null); setPg(null); load(); }, [id, load]);

  const live = useLive(w, async () => { await load(); onChanged?.(); });

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
  const d = pg.doing;
  const running = !!live.run;

  const pill = running ? { tone: 'brand', text: live.run.queued ? 'Starting a measurement' : 'Measuring now' }
    : switched && copiesOnly ? { tone: 'warn', text: 'Waiting for routing' }
      : switched ? { tone: 'ok', text: d?.less > 0 ? `Optimized, saving ${Math.round(d.less * 100)}%` : 'Optimized' }
        : waitsForPerson ? { tone: 'brand', text: 'A cheaper setup passed' }
          : { tone: 'warn', text: 'Not optimized yet' };
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
                <span className="wp-chip m" title="Your own model, which every cheaper setup is held to">{w.reference || 'no model named'}</span>
                <a className="wp-chip set" href={href('settings', null, 'optimize')} onClick={toSettings}
                  title="The workspace's choice, in Settings">{I.gear}Optimizing: {MODE[w.optimizeMode] || MODE.auto}</a>
              </div>
            </div>
            <div className="wp-headacts">
              <span className={`wp-pill is-${pill.tone}`}><span className="wp-pd" />{pill.text}</span>
              {waitsForPerson && (
                <button type="button" className="wp-btn pri" disabled={busy} onClick={act(() => more.promote(w.id, cand.model))}>Switch to it</button>
              )}
              <button type="button" className="wp-btn" disabled={!m.canRun || busy || live.starting || running} onClick={live.start}>
                {live.starting ? 'Starting…' : 'Measure now'}
              </button>
            </div>
          </div>
          {/* why Measure now cannot run, unless it is that there are too few requests yet, which card 1 shows */}
          {!running && !m.canRun && m.reason && pg.enough.yes && <p className="wp-why">{m.reason}</p>}
        </div>

        {(actErr || live.err) && (
          <div className="wp-err" role="alert">
            <span>{actErr || live.err}</span>
            <button type="button" className="wp-textbtn" onClick={() => { setActErr(null); live.setErr(''); }}>Close</button>
          </div>
        )}

        {switched && d && <Doing w={w} d={d} busy={busy} copiesOnly={copiesOnly} act={act} go={go} />}
        {waitsForPerson && <Ready w={w} cand={cand} busy={busy} copiesOnly={copiesOnly} act={act} go={go} />}

        <Enough e={pg.enough} />
        <Measurements w={w} pg={pg} live={live} />
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

const STOPPED = 'Stopped. You were charged only for the calls it made, and nothing was switched.';
const FINISHED = 'It had already finished when the stop reached it, so it was not stopped. What it found is below.';
const AFTER_STOP = { stopped: STOPPED, cancelled: 'Stopped before it started, so nothing was spent.', finished: FINISHED, idle: '' };

/* What a stop came to, read from the run itself: a measurement can finish between the press and the stop arriving. */
async function stopOutcome(workloadId) {
  try {
    const { runs } = await api.workloadRuns(workloadId);
    if (runs?.[0]?.status === 'done') return FINISHED;
  } catch { /* say what was asked for */ }
  return STOPPED;
}

/* What Understudy is doing, once a workload is switched: its requests flowing live, and five tiles of what that
   means. A switch still taking over says so, with the way to give it every request; one waiting for its first
   request through Understudy says that instead of drawing a flow that is not happening. */
function Doing({ w, d, busy, copiesOnly, act, go }) {
  const waiting = d.waiting || copiesOnly;
  const refShort = short(d.reference);
  const c = d.checks;
  const worseWord = c.yardstick === 'quality' ? 'Answers worse than yours' : 'Answers that differ from yours';
  const checked = c.share !== null && c.share >= 0.01 ? `checked daily on ${pct0(c.share)} of calls`
    : c.perDay > 0 ? `checked on about ${num(Math.round(c.perDay))} calls a day` : 'checked daily';
  const rollout = w.rollout;
  return (
    <section className="wp-card" aria-labelledby="wp-doing-h">
      <div className="wp-cardhead">
        <h3 id="wp-doing-h">What Understudy is doing</h3>
        {d.switchedAt && <span className="wp-s">switched {timeIST(d.switchedAt)} IST</span>}
      </div>
      <div className="wp-cardbody wp-doing">
        <div className="wp-flowwrap">
          <div className="wp-flowcap">
            <span className={`wp-live${waiting ? ' idle' : ''}`} aria-hidden="true" />
            {waiting ? 'Set up, and waiting: your requests reach Understudy only as copies, so nothing is answered here yet' : 'Live: every request, as it arrives'}
          </div>
          <FlowSvg d={d} still={waiting} waiting={waiting} />
        </div>
        {waiting && (
          <p className="wp-lead" style={{ margin: 0 }}>
            The switch starts with the first request your code sends through Understudy, which is one change of base URL.{' '}
            <a className="wp-link" href={href('connect')} onClick={go ? plainClick(() => go('connect')) : undefined}>Send requests through Understudy</a>
          </p>
        )}
        {rollout && (
          <div className="wp-rollout" role="status">
            {waiting
              ? <span><b>Set to take over step by step, starting with {pct0(rollout.share)} of requests.</b> The rest stay on {rollout.from || `${refShort}, your own model`}, so the two can be compared fairly.</span>
              : <span><b>Taking over step by step: {pct0(rollout.share)} of requests now.</b> The rest stay on {rollout.from || `${refShort}, your own model`}, so the two can be compared fairly.</span>}
            <span className="wp-rollmeter" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.round(rollout.share * 100))}%` }} /></span>
            <button type="button" className="wp-btn small" disabled={busy} onClick={act(() => more.finishRollout(w.id))}>Give it every request now</button>
          </div>
        )}
        <div className="wp-tiles">
          {/* green only when it is a saving: testing that cost more than the switch saved is said plainly, in ink */}
          <div className={`wp-tile${d.savedMonth > 0 ? ' hero' : ''}`}>
            <span className="wp-k">Saved this month</span>
            <span className="wp-v">{cents(d.savedMonth)}</span>
            <span className="wp-n">{waiting ? 'starts once requests come through Understudy'
              : d.onTrack > 0 ? `on track for ${money(d.onTrack)} a month` : 'at this pace, testing costs more than it saves'}</span>
          </div>
          <div className="wp-tile">
            <span className="wp-k">Cost per call</span>
            {d.before > 0 && d.after > 0 ? <CostBars before={d.before} after={d.after} fmt={perCall} /> : <span className="wp-v">not yet</span>}
            <span className="wp-n">{d.less !== null ? `${Math.round(d.less * 100)}% less` : 'shown once requests have come through'}</span>
          </div>
          <div className="wp-tile">
            <span className="wp-k">{worseWord}</span>
            <span className="wp-v">{c.n > 0 && c.rate !== null ? pct1(c.rate) : 'none yet'}</span>
            {c.daily.length > 0 && <QualitySpark daily={c.daily} bar={c.bar} />}
            <span className="wp-n">{c.n > 0 ? `${checked}, bar ${Math.round(c.bar * 1000) / 10}%` : `checked daily once requests come through, bar ${Math.round(c.bar * 1000) / 10}%`}</span>
          </div>
          <div className="wp-tile">
            <span className="wp-k">{d.speed.metric === 'ttft' ? 'Time to first word' : 'Typical time'}</span>
            <span className="wp-v">{d.speed.now ? secs(d.speed.now) : 'not timed yet'}</span>
            <span className="wp-n">{waiting ? `on ${refShort}, yours, until requests come through` : d.speed.before ? `was ${secs(d.speed.before)} on ${refShort}` : `on ${d.cheap}`}</span>
          </div>
          <div className="wp-tile">
            <span className="wp-k">If it slips</span>
            <span className="wp-v words">Back to {refShort}</span>
            <span className="wp-n">at once, by itself.{' '}
              <button type="button" className="wp-textbtn" disabled={busy} onClick={act(() => api.revert(w.id))}>Switch back now</button>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* A cheaper setup that passed and is waiting for a person's yes: what it is, what a request would cost on it, how
   often it answered differently, how fast it is, why it has not switched by itself, and the two ways to say yes. */
function Ready({ w, cand, busy, copiesOnly, act, go }) {
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
  const why = w.optimizeMode === 'ask' ? 'Your workspace asks first, so nothing switches until you say yes. It starts on a small share of requests and takes more while they hold up.'
    : w.optimizeMode === 'off' ? 'Your workspace never switches by itself. You can still switch to it here.'
      : cand.heldBack ? 'It was switched back from before, so it does not switch by itself again. You can still switch to it here.'
        : 'It cleared once, and has not yet held up on requests it had never seen, so it does not switch by itself. The next measurement looks again.';
  return (
    <section className="wp-card" aria-labelledby="wp-ready-h">
      <div className="wp-cardhead">
        <h3 id="wp-ready-h">A cheaper setup passed</h3>
        <span className="wp-s">{confirmedLook(cand.confirm) ? 'passed twice, waiting for your yes' : 'passed once, waiting for your yes'}</span>
      </div>
      <div className="wp-cardbody wp-doing">
        <div className="wp-tiles">
          <div className="wp-tile">
            <span className="wp-k">The setup</span>
            <span className="wp-v words wp-mdl" style={{ fontSize: 13.5 }}>{name}</span>
            <span className="wp-n">instead of {short(w.reference)}</span>
          </div>
          <div className="wp-tile">
            <span className="wp-k">Cost per call</span>
            {before > 0 && after > 0 ? <CostBars before={before} after={after} fmt={perCall} /> : <span className="wp-v">{cand.costMonth ? cents(cand.costMonth) : 'not priced'}</span>}
            <span className="wp-n">{before > 0 && after > 0 ? `${Math.round(Math.max(0, 1 - after / before) * 100)}% less` : cand.costMonth ? 'a month at your volume' : ''}</span>
          </div>
          <div className="wp-tile">
            <span className="wp-k">{rp?.yardstick === 'quality' ? 'Answers worse than yours' : 'Answers that differed from yours'}</span>
            <span className="wp-v">{cand.gap !== null && cand.gap !== undefined ? `${Number(cand.gap).toFixed(1)}%` : 'not judged'}</span>
            <span className="wp-n">{rp?.bar ? `bar ${Math.round(rp.bar * 1000) / 10}%` : ''}</span>
          </div>
          {row?.p50 && (
            <div className="wp-tile">
              <span className="wp-k">{rp.metric === 'ttft' ? 'Time to first word' : 'Typical time'}</span>
              <span className="wp-v">{secs(row.p50)}</span>
              <span className="wp-n">{rp.yours?.p50 ? `${secs(rp.yours.p50)} on ${short(w.reference)}` : ''}</span>
            </div>
          )}
        </div>
        <p className="wp-lead" style={{ margin: 0 }}>{why}</p>
        {copiesOnly && (
          <p className="wp-lead" style={{ margin: 0 }}>
            Your requests reach Understudy only as copies, so a switch here is set up and waits for the first request sent through Understudy.{' '}
            <a className="wp-link" href={href('connect')} onClick={go ? plainClick(() => go('connect')) : undefined}>Send requests through Understudy</a>
          </p>
        )}
        <div className="wp-acts">
          <button type="button" className="wp-btn pri" disabled={busy} onClick={act(() => more.promote(w.id, cand.model))}>Switch to it</button>
          <button type="button" className="wp-btn" disabled={busy} onClick={act(() => more.promote(w.id, cand.model, { rollout: false }))}>Switch every request at once</button>
          {copiesOnly && (!cand.name || cand.name.kind === 'model') && (
            <button type="button" className="wp-btn" onClick={() => { navigator.clipboard?.writeText(cand.model).catch(() => {}); }}>Copy the model name</button>
          )}
        </div>
      </div>
    </section>
  );
}

/* 1. Enough data to optimize? */
function Enough({ e }) {
  const daily = e.daily || [];
  const busyDays = daily.filter((x) => x.n > 0);
  const past = daily.some((x) => x.n > x.counted);
  let arrived = '';
  if (!busyDays.length) arrived = 'None have arrived in the last 30 days.';
  else if (busyDays.length === 1) {
    const one = busyDays[0];
    arrived = one.n > e.perDay ? `All ${num(one.n)} arrived on ${dayLabel(one.d)}, and ${e.perDay} of them count.` : `All ${num(one.n)} arrived on ${dayLabel(one.d)}.`;
  } else arrived = `${num(e.total)} arrived on ${busyDays.length} of the last 30 days.`;
  if (past && busyDays.length > 1) arrived += ' The faint part of a bar arrived but does not count.';

  if (e.yes) {
    const next = e.nextAt ? (e.nextAt <= Date.now() ? 'next re-test soon' : `next re-test ${dateShort(e.nextAt)}`) : 're-tested when you ask';
    return (
      <section className="wp-card" aria-labelledby="wp-enough-h">
        <div className="wp-cardhead"><h3 id="wp-enough-h"><span className="wp-q">1</span>Enough data to optimize?</h3><span className="wp-s">{next}</span></div>
        <div className="wp-cardbody wp-enough">
          <div>
            <div className="wp-answer"><span className="wp-big">{num(e.total)}<small>requests, 30 days</small></span><span className="wp-pill is-ok"><span className="wp-pd" />Yes</span></div>
            <p className="wp-lead">
              A test uses <b>{num(e.sample)}</b>.{' '}
              {e.everyDays > 0
                ? <>Re-tested every <b>{e.everyDays === 1 ? 'day' : `${e.everyDays} days`}</b>, and sooner when a new model could matter.</>
                : <>Your workspace tests <b>only when you ask</b>: press Measure now.</>}
            </p>
          </div>
          <div><DailyChart days={daily} /></div>
        </div>
      </section>
    );
  }
  const auto = e.everyDays > 0;
  return (
    <section className="wp-card" aria-labelledby="wp-enough-h">
      <div className="wp-cardhead"><h3 id="wp-enough-h"><span className="wp-q">1</span>Enough data to optimize?</h3><span className="wp-s">counted the way the test counts them</span></div>
      <div className="wp-cardbody wp-enough">
        <div>
          <div className="wp-answer"><span className="wp-big">{num(e.have)}<small>of {num(e.need)}</small></span><span className="wp-pill is-warn"><span className="wp-pd" />Not yet</span></div>
          <Meter have={e.have} need={e.need} perDay={e.perDay} steps={e.steps} auto={auto} />
          <p className="wp-lead">
            At most <b>{e.perDay} a day</b> count, so the earliest {auto ? 'start' : 'a full test can run'} is{' '}
            <b>{e.earliest === null ? 'soon' : e.steps.length === 1 && e.steps[0].today ? 'today' : dayLabel(e.earliest)}</b>.{' '}
            {auto ? 'It starts by itself, no need to wait here.' : 'Your workspace tests only when you ask: press Measure now once they are in.'}
          </p>
        </div>
        <div><DailyChart days={daily} cap={e.perDay} /><p className="wp-lead">{arrived}</p></div>
      </div>
    </section>
  );
}

/* 2. Every measurement: a measurement running now first, with its progress and Stop, then each one there has been,
   newest first, the newest open. */
function Measurements({ w, pg, live }) {
  const rows = pg.measurements.filter((r) => !r.live);
  const [open, setOpen] = useState(() => new Set(rows.length ? [rows[0].id] : []));
  // a measurement that has just finished opens, as the newest one does when the page is first read
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
        <h3 id="wp-runs-h"><span className="wp-q">2</span>Every measurement</h3>
        <span className="wp-s">{count ? `${count} so far, click one to open it` : 'none yet'}</span>
      </div>
      {live.notice && !live.run && <p className="wp-empty" style={{ paddingTop: 10, paddingBottom: 0 }}>{live.notice}</p>}
      {!count ? (
        <p className="wp-empty" style={{ paddingTop: 12 }}>
          {pg.enough.everyDays > 0
            ? 'The first starts by itself once there are enough requests. You can also press Measure now.'
            : 'Your workspace tests only when you ask. Press Measure now to run the first.'}
        </p>
      ) : (
        <div className="wp-runs">
          {live.run && <LiveRun w={w} live={live} feePct={pg.feePct} />}
          {rows.map((r) => <RunRow key={r.id} w={w} r={r} open={open.has(r.id)} onToggle={() => toggle(r.id)} />)}
        </div>
      )}
    </section>
  );
}

/* The measurement running now, as the first line of the list. */
function LiveRun({ w, live, feePct }) {
  const r = live.run;
  const stopping = !!r.stopping;
  const queued = !!r.queued;
  const pct = r.total ? Math.min(100, Math.round((r.done / r.total) * 100)) : 0;
  /* The bar never goes back while a run lasts: the calls still to come are counted afresh as models are dropped
     and replaced, and grow when the second look starts. The time left says what is coming. */
  const most = useRef({ id: null, pct: 0 });
  if (most.current.id !== (r.id ?? null)) most.current = { id: r.id ?? null, pct: 0 };
  most.current.pct = Math.max(most.current.pct, pct);
  const title = stopping ? stoppingLine(r) : queued ? (r.planning ? 'Choosing which models to try' : waitingLine(r.startsAt)) : (r.phase || 'Measuring');
  const sub = queued ? (r.planning ? 'Asking which of the models switched on fit your requests. None tried yet.' : 'Nothing has been sent yet, so nothing has been spent.')
    : `${num(r.done)} of ${num(r.total)} model calls`;
  return (
    <div className="wp-run">
      <div className="wp-runbtn">
        <span className="wp-spin" aria-hidden="true" />
        <span className="wp-ww"><span className="wp-when">{title}</span><span className="wp-what">{sub}</span></span>
        <span className="wp-num">{r.sample ? `${num(r.sample)} requests` : ''}</span>
        <span className="wp-num">{queued ? '' : leftLine(r.leftMs)}</span>
        <span className="wp-num">{queued ? '' : cents(withFee(r.spend, feePct))}</span>
        <span className={`wp-tag ${stopping ? 'is-mut' : 'is-brand'}`}>{stopping ? 'Stopping' : queued ? 'Waiting to start' : 'Measuring now'}</span>
      </div>
      <div className="wp-liverow">
        <div className="wp-livebar" aria-hidden="true"><i style={{ width: `${most.current.pct}%` }} /></div>
        {live.asking && !stopping ? (
          <div className="wp-take" role="group" aria-label="Stop this measurement" style={{ display: 'grid', gap: 10 }}>
            <span>
              {queued
                ? `Stop measuring ${w.name}? It has not started, so nothing has been spent and nothing will be.`
                : `Stop measuring ${w.name}? You are charged only for the calls it has already made. Any setup that has answered every request keeps its result, and nothing is switched.`}
            </span>
            <span className="wp-acts">
              <button type="button" className="wp-btn pri small" disabled={live.halting} onClick={live.stop}>{live.halting ? 'Stopping…' : 'Stop measuring'}</button>
              <button type="button" className="wp-btn small" disabled={live.halting} onClick={() => live.setAsking(false)}>Keep going</button>
            </span>
          </div>
        ) : (
          <div className="wp-acts" style={{ justifyContent: 'space-between' }}>
            <p className="wp-livenote">
              {stopping
                ? `Nothing more is sent after the call in flight. It is charged like the rest, and nothing is switched.${quietFor(r) >= 60000 ? ` If nothing is running it any more, it is closed ${num(r.staleMin || 15)} minutes after it was last heard from.` : ''}`
                : 'You can leave this page, it keeps going.'}
            </p>
            {!stopping && <button type="button" className="wp-btn small" onClick={() => live.setAsking(true)}>Stop</button>}
          </div>
        )}
      </div>
    </div>
  );
}

/* One measurement: its line, and opened, what it found and every setup it tried. */
function RunRow({ w, r, open, onToggle }) {
  const [rp, setRp] = useState(null);
  const [err, setErr] = useState(null);
  const read = useCallback(() => {
    setErr(null);
    api.workloadRunPage(w.id, r.id).then(setRp).catch((e) => setErr(e.message));
  }, [w.id, r.id]);
  useEffect(() => { if (open && !rp) read(); }, [open, rp, read]);
  const did = `wp-rd-${r.id}`;
  return (
    <div className="wp-run">
      <button type="button" className="wp-runbtn" aria-expanded={open} aria-controls={did} onClick={onToggle}>
        {I.chev}
        <span className="wp-ww">
          <span className="wp-when">{timeIST(r.at)} IST</span><span className="wp-what">{r.what}</span>
          {/* on a narrow screen the figures beside it have no room, so they are a line under it instead */}
          <span className="wp-what narrow">{`${num(r.n)} requests${r.mins ? `, ${num(r.mins)} min` : ''}, ${cents(r.usd)}`}</span>
        </span>
        <span className="wp-num">{num(r.n)} requests</span>
        <span className="wp-num">{r.mins ? `${num(r.mins)} min` : ''}</span>
        <span className="wp-num">{cents(r.usd)}</span>
        <span className={`wp-tag is-${r.tag.tone}`}>{r.tag.text}</span>
      </button>
      <div className="wp-rundetail" id={did} hidden={!open}>
        {open && (err ? (
          <p className="wp-loadline">This measurement could not be read: {err}{' '}<button type="button" className="wp-textbtn" onClick={read}>Try again</button></p>
        ) : !rp ? (
          <p className="wp-loadline">Reading this measurement…</p>
        ) : (
          <>
            <div className="wp-take">{I.info}<span>{rp.take}</span></div>
            {rp.cands.length > 0 ? <RunDetail rp={rp} /> : rp.self && (
              <div className="wp-chartbox wp-selfbox">
                <p className="wp-sub">{rp.self.noise !== null ? `${short(rp.reference)} against itself` : 'How far it got'}</p>
                <SelfPic self={rp.self} yardstick={rp.yardstick} />
              </div>
            )}
          </>
        ))}
      </div>
    </div>
  );
}

/* What the first figure in a measurement's table means, in the words its information bubble says (see Help). */
function ColumnWords({ rp }) {
  return rp.yardstick === 'quality'
    ? <p>How often this model gave a clearly worse answer than the original model.</p>
    : <p>How often this model answered differently from the original model.</p>;
}

/* A small "i" beside a name that says what it means: shown while the pointer or the keyboard is on it, and on a tap,
   which is all a phone has, until a tap elsewhere or Escape. The words float above the page rather than inside the
   table, whose sideways-scrolling box would cut them off, or grow a scrollbar, on a measurement with a row or two. */
function Help({ label, children }) {
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
      <button ref={btn} type="button" className="wp-help" aria-label={`What ${label} means`} aria-expanded={pinned}
        aria-describedby={shown ? id : undefined}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHover(true); }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(false); }}
        onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) setHover(true); }}
        onBlur={() => setHover(false)}
        onClick={() => setPinned((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Escape') { setHover(false); setPinned(false); } }}>
        {I.info}
      </button>
      {/* inside the app's own box, which carries the colours of the light or dark theme; the page's body has none */}
      {shown && at && createPortal(
        <div ref={box} id={id} role="tooltip" className="wp-tipbox" style={{ top: at.top, left: at.left, width: at.width }}>{children}</div>,
        btn.current?.closest('[data-mode]') ?? document.body,
      )}
    </>
  );
}

function RunDetail({ rp }) {
  const axis = rp.yardstick === 'quality' ? 'Worse than yours' : 'Differed from yours';
  const run = { ...rp, axis };
  const chart = rp.cands.some(plotted);
  return (
    <div className="wp-detailgrid">
      {chart && (
        <div className="wp-chartbox">
          <p className="wp-sub">How the candidates compare</p>
          <CompareChart run={run} />
          <div className="wp-legend">
            <span><i style={{ background: 'var(--ok)' }} />passed</span>
            <span><i style={{ background: 'var(--warn)' }} />close, or too few to be sure</span>
            <span><i style={{ background: 'var(--bad)' }} />missed</span>
            <span><i style={{ background: 'var(--mut)' }} />stopped early</span>
          </div>
        </div>
      )}
      <div>
        <p className="wp-sub">
          Candidates tested
          {/* a phone shows no column names, so the first figure is explained here instead */}
          <span className="wp-phonehelp"><Help label={axis.split(' ')[0]}><ColumnWords rp={rp} /></Help></span>
        </p>
        <div className="wp-tablewrap">
          <table className="wp-cands">
            <thead>
              <tr>
                <th aria-label="Number" />
                <th>Setup</th>
                <th>Result</th>
                <th className="r">{axis.split(' ')[0]}<Help label={axis.split(' ')[0]}><ColumnWords rp={rp} /></Help></th>
                <th className="r">Per call</th>
                <th className="r">{rp.metric === 'ttft' ? 'First word' : 'Typical'}</th>
              </tr>
            </thead>
            <tbody>
              {rp.cands.map((c, i) => (
                <tr key={c.key}>
                  <td><span className="wp-no" style={{ background: toneColor(c.tone) }}>{i + 1}</span></td>
                  <td className="wp-mdl">{c.label}</td>
                  <td><span className={`wp-tag is-${c.tone}`}>{c.verdict}</span></td>
                  <td className={`r m${c.gap === null ? ' none' : ''}`} data-label={axis.split(' ')[0]}>{c.gap === null ? 'not judged' : pct1(c.gap)}</td>
                  <td className={`r m${c.perCall === null ? ' none' : ''}`} data-label="Per call">{c.perCall === null ? 'not priced' : perCall(c.perCall)}</td>
                  <td className={`r m${!c.p50 ? ' none' : ''}`} data-label={rp.metric === 'ttft' ? 'First word' : 'Typical'}>{c.p50 ? secs(c.p50) : 'not timed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* 3. The calls: when, who answered (the cheaper setup in green, the customer's own model in ink), how long it took,
   what it cost and how it went, ten at a time. A row opens to what was asked and what came back. */
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
  const summary = !c.total ? 'none in the last 30 days'
    : w.promotedAt && copiesOnly ? `${num(c.total)} calls in 30 days, copies your own model answered`
      : w.promotedAt ? `${num(c.total)} calls in 30 days, ${pct0(c.cheapShare)} answered by the cheaper setup${c.cheapSince ? ' since the switch' : ''}`
        : `${num(c.total)} calls in 30 days, ${cents(c.cost)}${c.ownOnly ? ', all on your own model' : ''}`;
  return (
    <section className="wp-card" aria-labelledby="wp-calls-h">
      <div className="wp-cardhead"><h3 id="wp-calls-h"><span className="wp-q">3</span>The calls</h3><span className="wp-s">{summary}</span></div>
      <div className="wp-cardbody">
        {!c.rows.length ? (
          <p className="wp-lead" style={{ margin: 0 }}>No calls yet.</p>
        ) : (
          <div className="wp-tablewrap">
            <table className="wp-calls">
              <thead><tr><th>When</th><th>Answered by</th><th className="r">Took</th><th className="r">Cost</th><th>Result</th></tr></thead>
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
            {c.page > 1 && <button type="button" className="wp-textbtn" disabled={busy} onClick={() => page(c.page - 1)}>Newer calls</button>}
            {c.more && <button type="button" className="wp-textbtn" disabled={busy} onClick={() => page(c.page + 1)}>Older calls</button>}
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
        aria-label={`Call at ${timeIST(x.at)} IST, ${open ? 'showing' : 'show'} what was asked and answered`}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <td className="m">{timeIST(x.at)} IST</td>
        <td><span className="wp-srv"><i style={{ background: who }} /><span className="wp-mdl">{x.model || 'no model named'}{how}</span></span></td>
        <td className={`r m${x.ms === null ? ' none' : ''}`} data-label="Took">{x.ms === null ? 'not timed' : secs(x.ms)}</td>
        <td className="r m" data-label="Cost">{perCall(x.cost)}</td>
        <td><span className={`wp-tag is-${tag[0]}`} title={failed ? `The provider answered ${x.status}` : undefined}>{tag[1]}</span></td>
      </tr>
      {open && (
        <tr className="saidrow">
          <td className="said" colSpan={5}>
            {!said ? <span className="wp-loadline">Reading this call…</span>
              : said.err ? <span className="wp-loadline">This call could not be read: {said.err}</span>
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

/* How long since a running measurement was last heard from, as the server measured it. */
const quietFor = (r) => Math.max(0, Number(r?.quietMs) || 0);

const stoppingLine = (r) => {
  const quiet = quietFor(r);
  if (quiet < 60000) return 'Stopping once the call in flight comes back';
  const mins = Math.max(1, Math.round(quiet / 60000));
  return `Stopping. It has not been heard from for ${num(mins)} ${mins === 1 ? 'minute' : 'minutes'}`;
};

/* About how long a running measurement has left, at the pace it has kept so far (leftOf in src/api.js). */
const leftLine = (ms) => {
  if (ms == null) return 'working out time left';
  if (ms < 60000) return 'under a minute left';
  const mins = Math.ceil(ms / 60000);
  return `about ${num(mins)} min left`;
};

/* A measurement waiting its turn; one held back for a while says until when, in IST. */
const waitingLine = (startsAt) => (startsAt && startsAt > Date.now() + 60000
  ? `Waiting until ${timeIST(startsAt)} IST to start`
  : 'Waiting for its turn to start');
