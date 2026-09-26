import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { href, modelHref } from '../router.js';
import { plainClick } from '../nav.jsx';
import { api, num, timeIST } from '../api.js';
import { more } from '../moreApi.js';
import { dayIST } from '../dates.js';
import { I, dayLabel, toneColor, plotted, DailyChart, Meter, CompareChart, FlowSvg, CostBars, QualitySpark, SelfPic } from '../WorkloadCharts.jsx';
import '../workload-page.css';

/* A workload's page, as the design artboard draws it: four answers at a glance, and once it is switched, what
 * Understudy is doing for it and what that saves.
 *   1. Are there enough requests to test models? Counted the way a test counts them, by count alone however many
 *      arrive in a day, and if not yet, how many more a test needs (it starts by itself once they are in).
 *   2. What the workspace has chosen should happen when a cheaper model passes, as a chip that opens Settings; and for
 *      written answers, how another model's are judged against the original model's, as a chip that opens the choices.
 *   3. Every model test, each opening to the chart of how its models compared and the list of them.
 *   4. The recent requests, and which model answered each.
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

  // nothing is wrong with a workload still on its own model, so that is said as a fact, not a warning
  const pill = running ? { tone: 'brand', text: live.run.queued ? 'Starting a test' : 'Testing now' }
    : switched && copiesOnly ? { tone: 'warn', text: 'Switched, waiting for requests' }
      : switched ? { tone: 'ok', text: d?.less > 0 ? `Optimized, saving ${Math.round(d.less * 100)}%` : 'Optimized' }
        : waitsForPerson ? { tone: 'brand', text: 'A cheaper model passed' }
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
                  Original model: <span className="m">{w.reference || 'none named yet'}</span>
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
              {waitsForPerson && (
                <button type="button" className="wp-btn pri" disabled={busy} onClick={act(() => more.promote(w.id, cand.model))}>Switch to it</button>
              )}
              <button type="button" className="wp-btn" disabled={!m.canRun || busy || live.starting || running} onClick={live.start}>
                {live.starting ? 'Starting…' : 'Test now'}
              </button>
            </div>
          </div>
          {/* why Test now cannot run, unless it is that there are too few requests yet, which card 1 shows */}
          {!running && !m.canRun && m.reason && pg.enough.yes && <p className="wp-why">{m.reason}</p>}
        </div>

        {judgingOpen && w.judgeChoice && <Judging w={w} busy={busy} act={act} onClose={() => setJudgingOpen(false)} />}

        {(actErr || live.err) && (
          <div className="wp-err" role="alert">
            <span>{actErr || live.err}</span>
            <button type="button" className="wp-textbtn" onClick={() => { setActErr(null); live.setErr(''); }}>Close</button>
          </div>
        )}

        {switched && d && <Doing w={w} d={d} busy={busy} copiesOnly={copiesOnly} act={act} go={go} />}
        {waitsForPerson && <Ready w={w} cand={cand} busy={busy} copiesOnly={copiesOnly} act={act} go={go} />}

        <Enough e={pg.enough} />
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

/* What Understudy is doing, once a workload is switched: its requests flowing live, and five tiles of what that
   means. A switch still taking over says so, with the way to give it every request; one waiting for its first
   request through Understudy says that instead of drawing a flow that is not happening. */
function Doing({ w, d, busy, copiesOnly, act, go }) {
  const waiting = d.waiting || copiesOnly;
  const refShort = short(d.reference);
  const c = d.checks;
  const worseWord = c.yardstick === 'quality' ? 'Worse than original model' : 'Different from original model';
  const checked = c.share !== null && c.share >= 0.01 ? `checked daily on ${pct0(c.share)} of requests`
    : c.perDay > 0 ? `checked on about ${num(Math.round(c.perDay))} requests a day` : 'checked daily';
  const allowed = `allowed ${Math.round(c.bar * 1000) / 10}%`;
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
              ? <span><b>Set to take over step by step, starting with {pct0(rollout.share)} of requests.</b> The rest stay on {rollout.from || `the original model, ${refShort}`}, so the two can be compared fairly.</span>
              : <span><b>Taking over step by step: {pct0(rollout.share)} of requests now.</b> The rest stay on {rollout.from || `the original model, ${refShort}`}, so the two can be compared fairly.</span>}
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
            <span className="wp-k">Cost per request</span>
            {d.before > 0 && d.after > 0 ? <CostBars before={d.before} after={d.after} fmt={perCall} /> : <span className="wp-v">not yet</span>}
            <span className="wp-n">{d.less !== null ? `${Math.round(d.less * 100)}% less` : 'shown once requests have come through'}</span>
          </div>
          <div className="wp-tile">
            <span className="wp-k">{worseWord}</span>
            <span className="wp-v">{c.n > 0 && c.rate !== null ? pct1(c.rate) : 'none yet'}</span>
            {c.daily.length > 0 && <QualitySpark daily={c.daily} bar={c.bar} />}
            <span className="wp-n">{c.n > 0 ? `${checked}, ${allowed}` : `checked daily once requests come through, ${allowed}`}</span>
          </div>
          <div className="wp-tile">
            <span className="wp-k">{d.speed.metric === 'ttft' ? 'Time to first word' : 'Typical time'}</span>
            <span className="wp-v">{d.speed.now ? secs(d.speed.now) : 'not timed yet'}</span>
            <span className="wp-n">{waiting ? `on the original model, ${refShort}, until requests come through` : d.speed.before ? `was ${secs(d.speed.before)} on ${refShort}` : `on ${d.cheap}`}</span>
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

/* A cheaper model that passed and is waiting for a person's yes: what it is, what a request would cost on it, how
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
        : "It passed once, but hasn't yet passed again on new requests it had never seen, so it doesn't switch by itself. The next test checks again.";
  return (
    <section className="wp-card" aria-labelledby="wp-ready-h">
      <div className="wp-cardhead">
        <h3 id="wp-ready-h">A cheaper model passed</h3>
        <span className="wp-s">{confirmedLook(cand.confirm) ? 'passed twice, waiting for your yes' : 'passed once, waiting for your yes'}</span>
      </div>
      <div className="wp-cardbody wp-doing">
        <div className="wp-tiles">
          <div className="wp-tile">
            <span className="wp-k">The model</span>
            <span className="wp-v words wp-mdl" style={{ fontSize: 13.5 }}>{name}</span>
            <span className="wp-n">instead of {short(w.reference)}</span>
          </div>
          <div className="wp-tile">
            <span className="wp-k">Cost per request</span>
            {before > 0 && after > 0 ? <CostBars before={before} after={after} fmt={perCall} /> : <span className="wp-v">{cand.costMonth ? cents(cand.costMonth) : 'not priced'}</span>}
            <span className="wp-n">{before > 0 && after > 0 ? `${Math.round(Math.max(0, 1 - after / before) * 100)}% less` : cand.costMonth ? 'a month at your volume' : ''}</span>
          </div>
          <div className="wp-tile">
            <span className="wp-k">{rp?.yardstick === 'quality' ? 'Worse than original model' : 'Different from original model'}</span>
            <span className="wp-v">{cand.gap !== null && cand.gap !== undefined ? `${Number(cand.gap).toFixed(1)}%` : 'not judged'}</span>
            <span className="wp-n">{rp?.bar ? `allowed ${Math.round(rp.bar * 1000) / 10}%` : ''}</span>
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

/* 1. Enough requests to test models? */
function Enough({ e }) {
  const daily = e.daily || [];
  const busyDays = daily.filter((x) => x.n > 0);
  // what arrived but no test can use: it failed, or its text was not kept (every other request counts, whatever the day)
  const unusable = daily.some((x) => x.n > x.counted);
  let arrived = '';
  if (!busyDays.length) arrived = 'None have arrived in the last 30 days.';
  else if (busyDays.length === 1) arrived = `All ${num(busyDays[0].n)} arrived on ${dayLabel(busyDays[0].d)}.`;
  else arrived = `${num(e.total)} arrived on ${busyDays.length} of the last 30 days.`;
  if (unusable) arrived += " The faint part of a bar arrived but can't be used in a test: it failed, or its text wasn't kept.";

  if (e.yes) {
    const next = e.nextAt ? (e.nextAt <= Date.now() ? 'next test soon' : `next test ${dateShort(e.nextAt)}`) : 'tested when you ask';
    return (
      <section className="wp-card" aria-labelledby="wp-enough-h">
        <div className="wp-cardhead"><h3 id="wp-enough-h"><span className="wp-q">1</span>Enough requests to test models?</h3><span className="wp-s">{next}</span></div>
        <div className="wp-cardbody wp-enough">
          <div>
            <div className="wp-answer"><span className="wp-big">{num(e.total)}<small>requests in the last 30 days</small></span><span className="wp-pill is-ok">{I.check}Enough</span></div>
            <p className="wp-lead">
              Each test uses <b>{num(e.sample)}</b> recent requests.{' '}
              {e.everyDays > 0
                /* At most this often (see src/eval/schedule.js): tests that keep finding the same thing are spaced out,
                   and a relevant new model or price change brings a spaced-out one back, never sooner than this. */
                ? <>We test again at most every <b>{e.everyDays === 1 ? 'day' : `${e.everyDays} days`}</b>, and a relevant new model or price change brings the next test forward.</>
                : <>Your workspace tests <b>only when you ask</b>: press Test now.</>}
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
      <div className="wp-cardhead"><h3 id="wp-enough-h"><span className="wp-q">1</span>Enough requests to test models?</h3><span className="wp-s">counted the way a test counts them</span></div>
      <div className="wp-cardbody wp-enough">
        <div>
          <div className="wp-answer"><span className="wp-big">{num(e.have)}<small>of {num(e.need)} requests</small></span><span className="wp-pill is-warn"><span className="wp-pd" />Not enough yet</span></div>
          <Meter have={e.have} need={e.need} auto={auto} />
          <p className="wp-lead">
            A test needs <b>{num(e.need - e.have)} more {e.need - e.have === 1 ? 'request' : 'requests'}</b>, however many arrive in a day.{' '}
            {auto ? "It starts by itself as soon as they're in, so there's no need to wait here." : 'Your workspace tests only when you ask: press Test now once they are in.'}
          </p>
        </div>
        <div><DailyChart days={daily} /><p className="wp-lead">{arrived}</p></div>
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
        <h3 id="wp-runs-h"><span className="wp-q">2</span>Model tests</h3>
        <span className="wp-s">{count ? `${count} ${count === 1 ? 'test' : 'tests'} so far` : 'none yet'}</span>
      </div>
      {live.notice && !live.run && <p className="wp-empty" style={{ paddingTop: 10, paddingBottom: 0 }}>{live.notice}</p>}
      {!count ? (
        <p className="wp-empty" style={{ paddingTop: 12 }}>
          {pg.enough.everyDays > 0
            ? 'The first test starts by itself once there are enough requests. You can also press Test now.'
            : 'Your workspace tests only when you ask. Press Test now to run the first test.'}
        </p>
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
        <span className="wp-num">{queued ? '' : cents(withFee(r.spend, feePct))}</span>
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
          <span className="wp-when">{timeIST(r.at)} IST</span><span className="wp-what">{r.what}</span>
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
  const vs = !(ref.perCall > 0) ? '' : Math.abs(c.perCall / ref.perCall - 1) < 0.005 ? `, about the same as the original model's ${perCall(ref.perCall)}`
    : `, ${c.perCall < ref.perCall ? `${less(1 - c.perCall / ref.perCall)} less` : `${pct0(c.perCall / ref.perCall - 1)} more`} than the original model's ${perCall(ref.perCall)}`;
  return (
    <>
      <p className="wp-dt-head"><span className="wp-dt-no" style={{ background: toneColor(c.tone) }}>{c.no}</span><span>{c.label}</span></p>
      <p className="wp-dt-out" style={{ color: toneColor(c.tone) }}>{c.verdict}</p>
      <dl>
        <div><dt>{quality ? 'Worse than original model' : 'Different from original model'}</dt>
          <dd>{pct1(c.gap)} of requests{rp.bar > 0 ? `, at most ${pct1(rp.bar)} allowed` : ''}</dd></div>
        <div><dt>Cost per request</dt><dd>{perCall(c.perCall)}{vs}</dd></div>
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
        <p className="wp-loadline wp-candhint">Select a model to open its page, with each request it answered beside the original model's answer.</p>
        <table className="wp-cands">
          <thead>
            <tr>
              <th aria-label="Number" />
              <th>Model</th>
              <th>Outcome</th>
              <th className="r">{col}<Help label={axis}><ColumnWords rp={rp} /></Help></th>
              <th className="r">Requests sampled<Help label="Requests sampled"><SampledWords /></Help></th>
              <th className="r">Cost / request</th>
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
      <td className={`r m${c.perCall === null ? ' none' : ''}`} data-label="Cost / request">{c.perCall === null ? 'not priced' : perCall(c.perCall)}</td>
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
  const inMonth = `${num(c.total)} ${c.total === 1 ? 'request' : 'requests'} in the last 30 days`;
  const summary = !c.total ? 'none in the last 30 days'
    : w.promotedAt && copiesOnly ? `${inMonth} · copies the original model answered`
      : w.promotedAt ? `${inMonth} · ${pct0(c.cheapShare)} answered by the cheaper model${c.cheapSince ? ' since the switch' : ''}`
        : `${inMonth} · ${cents(c.cost)} total${c.ownOnly ? ' · all answered by the original model' : ''}`;
  return (
    <section className="wp-card" aria-labelledby="wp-calls-h">
      <div className="wp-cardhead"><h3 id="wp-calls-h"><span className="wp-q">3</span>Recent requests</h3><span className="wp-s">{summary}</span></div>
      <div className="wp-cardbody">
        {!c.rows.length ? (
          <p className="wp-lead" style={{ margin: 0 }}>No requests yet.</p>
        ) : (
          <div className="wp-tablewrap">
            <table className="wp-calls">
              <thead><tr><th>When</th><th>Model</th><th className="r">Response time</th><th className="r">Cost</th><th>Status</th></tr></thead>
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
        <td className={`r m${x.ms === null ? ' none' : ''}`} data-label="Response time">{x.ms === null ? 'not timed' : secs(x.ms)}</td>
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
