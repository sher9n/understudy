import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, usd, num, timeIST } from '../api.js';
import HowWePick from './HowWePick.jsx';

/* Measuring, as its own thing on the page.
 *
 * It used to be a grey secondary button at the bottom of a paragraph about variance, and
 * pressing it appeared to do nothing at all: the workload was marked "Measuring" and a job
 * quietly declined a moment later for a reason nobody was told. So this section says three
 * things and nothing else: what a measurement would do and what it would cost, how far along
 * one is while it runs, and every measurement there has ever been. */

const fmtDays = (d) => (d === 0 ? 'only when you ask' : d === 1 ? 'every day' : `every ${d} days`);

/* What one past measurement did, in words, for its line in the history. */
const whatHappened = (r) => {
  if (r.status === 'running') return 'Running now';
  if (r.status === 'stopped') {
    return r.total ? `Stopped by you at ${num(r.done)} of ${num(r.total)} model calls` : 'Stopped by you';
  }
  if (r.status === 'failed') return 'Interrupted before it finished';
  if (r.error) return r.error;
  return r.floor != null ? `Bar set at ${r.floor.toFixed(2)}%, ${num(r.models)} models tried` : 'No bar could be set';
};

export default function Measurement({ w, busy, onRan, onOpenRun, openRunId, showingId }) {
  const m = w.measure || {};
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState('');
  const [live, setLive] = useState(m.running || null);
  const [runs, setRuns] = useState(null);
  const [showAll, setShowAll] = useState(false);
  /* Stopping is asked, then confirmed. The first press opens a line saying what stopping costs
     and what it keeps; only the second stops anything, because a stopped measurement cannot be
     picked up again and what it spent would have bought nothing. */
  const [asking, setAsking] = useState(false);
  const [halting, setHalting] = useState(false);
  // what the last stop did, said once the panel has gone, so a stop never ends in silence
  const [notice, setNotice] = useState('');
  /* Set the moment Stop is confirmed. A progress check sent just before the stop was written
     comes back saying nothing about it, and would otherwise put the Stop button back and lose
     the notice when the run ends. */
  const stopAsked = useRef(false);
  /* What the server said to the stop, and whether it has itself reported a stop in progress.
     A progress check leaves a notice only after one of those: a check sent just after Stop, for
     a measurement that was only waiting, finds nothing running before the stop's own answer
     arrives, and would otherwise put an earlier measurement's ending over "stopped before it
     started". */
  const stopReply = useRef(null);
  const sawStopping = useRef(false);
  const poll = useRef(null);

  const loadRuns = useCallback(() => {
    api.workloadRuns(w.id).then((d) => setRuns(d.runs)).catch(() => {});
  }, [w.id]);

  useEffect(() => { loadRuns(); }, [loadRuns, w.measure?.runs]);
  useEffect(() => { setLive(w.measure?.running || null); }, [w.measure?.running]);
  // a run that has ended takes its question with it
  useEffect(() => { if (!live) setAsking(false); }, [live]);

  /* While a run is going, ask how far along it is. It is the only way somebody knows the
     thing they are paying for is happening, and it stops the moment the run does. */
  useEffect(() => {
    if (!live) return undefined;
    poll.current = setInterval(async () => {
      try {
        const d = await api.workload(w.id);
        const now = d.measure?.running;
        if (now) {
          if (now.stopping) sawStopping.current = true;
          setLive(stopAsked.current ? { ...now, stopping: true } : now);
        } else {
          if (stopReply.current === 'stopping' || sawStopping.current) setNotice(await stopOutcome(w.id));
          stopAsked.current = false;
          stopReply.current = null;
          sawStopping.current = false;
          setLive(null); loadRuns(); if (onRan) onRan();
        }
      } catch { /* the next tick tries again */ }
    }, 2000);
    return () => clearInterval(poll.current);
  }, [live, w.id, loadRuns, onRan]);

  const start = async () => {
    setStarting(true); setErr(''); setNotice('');
    stopAsked.current = false;
    stopReply.current = null;
    sawStopping.current = false;
    try {
      await api.measure(w.id);
      const d = await api.workload(w.id);
      setLive(d.measure?.running || { total: 0, done: 0, phase: 'Starting…', spend: 0 });
      if (onRan) onRan();
    } catch (e) { setErr(e.message); } finally { setStarting(false); }
  };

  /* A running measurement stops at its next step, once the call in flight has come back, so
     the panel stays up saying so until it has. One that was only waiting in the queue, or that
     nothing was running any more, is over the moment the server answers. */
  const stop = async () => {
    setHalting(true); setErr('');
    stopAsked.current = true;
    try {
      const out = await api.stopMeasuring(w.id);
      setAsking(false);
      stopReply.current = out?.state ?? null;
      if (out?.state === 'stopping') setLive((l) => (l ? { ...l, stopping: true } : l));
      else {
        stopAsked.current = false;
        setNotice(AFTER_STOP[out?.state] ?? '');
        setLive(null); loadRuns(); if (onRan) onRan();
      }
    } catch (e) {
      stopAsked.current = false;
      stopReply.current = null;
      setErr(e.message);
    } finally { setHalting(false); }
  };

  const stopping = !!live?.stopping;
  const queued = !!live?.queued;
  const pct = live && live.total ? Math.min(100, Math.round((live.done / live.total) * 100)) : 0;
  const history = runs || [];
  const shown = showAll ? history : history.slice(0, 4);

  return (
    <section className="opt measure">
      <div className="opthead">
        <h2>Measuring this workload</h2>
        <span className="s">
          {m.last
            ? `Last measured ${timeIST(m.last.at)} IST.`
            : 'It has never been measured.'}
        </span>
      </div>

      <div className="cardpad">
        {live ? (
          <div className="mrun">
            <div className="mrunhead">
              <span className="mspin" aria-hidden="true" />
              <div>
                <div className="mrunt">
                  {stopping ? stoppingLine(live)
                    : queued ? waitingLine(live.startsAt)
                      : (live.phase || 'Measuring')}
                </div>
                <div className="mruns m">
                  {queued ? 'Nothing has been sent yet, so nothing has been spent.' : (
                    <>
                      {/* "model calls", not "replays": for written answers most of the count is
                          a judge comparing them, and calling those replays made 132 replays
                          read as 363 */}
                      {num(live.done)} of {num(live.total)} model calls
                      {live.spend ? ` · ${usd(live.spend)} spent so far` : ''}
                    </>
                  )}
                </div>
              </div>
              <div className="mpct m">{pct}%</div>
              {!stopping && !asking && (
                <button className="minig mstopb" onClick={() => setAsking(true)}>Stop</button>
              )}
            </div>
            <div className="mbar"><span style={{ width: `${pct}%` }} /></div>
            {asking && !stopping ? (
              <div className="mstopask" role="group" aria-label="Stop this measurement">
                <p>
                  {queued
                    ? `Stop measuring ${w.name}? It has not started, so nothing has been spent and nothing will be.`
                    : `Stop measuring ${w.name}? You are charged only for the calls it has already made. `
                      + 'Any model that has answered every call keeps its result, and nothing is switched.'}
                </p>
                <div className="mstopacts">
                  <button className="mini" disabled={halting} onClick={stop}>
                    {halting ? 'Stopping…' : 'Stop measuring'}
                  </button>
                  <button className="minig" disabled={halting} onClick={() => setAsking(false)}>Keep going</button>
                </div>
              </div>
            ) : (
              <p className="mnote">
                {stopping
                  ? 'Nothing more is sent after the call in flight. It is charged like the rest, and nothing is switched.'
                    + (quietFor(live) >= 60000
                      ? ` If nothing is running it any more, it is closed ${num(live.staleMin || 15)} minutes after it was last heard from.`
                      : '')
                  : `${whereTheCountComesFrom(live, w.shape === 'free text')} You can leave this page; it keeps going.`}
              </p>
            )}
          </div>
        ) : (
          <div className="mtop">
            <div>
              <button className="mini" disabled={!m.canRun || busy || starting} onClick={start}>
                {starting ? 'Starting…' : 'Measure now'}
              </button>
            </div>
            {m.canRun ? (
              <p className="mwhy">
                {num(m.sample)} of this workload&rsquo;s {num(m.pool)} calls are replayed:
                twice on {shortName(w.reference)} to set the bar, then on cheaper models until{' '}
                {num(m.models)} {m.models === 1 ? 'has' : 'have'} answered every call, dropping any that cannot win.
                {w.shape === 'free text'
                  ? ' Written answers cannot be compared word for word, so a judge also compares each pair.'
                  : ''}{' '}
                You are charged for the calls made, not for answers reused from earlier
                measurements{m.recordedShare > 0 ? ` or read from your own calls` : ''}{m.estimateUsd != null ? `, about ${usd(m.estimateUsd)} for this one, a second look at the winner included` : ''}.
                {' '}<WorthLine m={m} />
              </p>
            ) : (
              <p className="mwhy cannot">{m.reason}</p>
            )}
          </div>
        )}
        {notice && !live && <p className="mnote">{notice}</p>}
        {err && <div className="errbox" style={{ marginTop: 12 }}>{err}</div>}

        {/* How the models are chosen, and where Jev comes in. Somebody paying for a run is
            entitled to know what it will spend their money on, and why, before it spends it. */}
        <HowWePick w={w} m={m} onChanged={onRan} />

        {history.length > 0 && (
          <div className="mhist">
            <div className="mpickh">Every measurement</div>
            {/* The row being shown is marked with a class of its own. It was ".on", which the
                lifted stylesheet also styles on its own, as a workload name. */}
            {shown.map((r) => {
              const on = showingId === r.id;
              return (
                <button key={r.id} className={`mrow${on ? ' mshown' : ''}`}
                  aria-current={on ? 'true' : undefined}
                  onClick={() => onOpenRun(openRunId === r.id ? null : r.id)}>
                  <span className="mwhen m">{timeIST(r.at)} IST</span>
                  <span className="mwhat">{whatHappened(r)}</span>
                  <span className="mtrig m">{r.trigger === 'manual' ? 'asked for' : r.trigger === 'first' ? 'first, by itself' : 'on schedule'}</span>
                  <span className="mspend m">{r.spend ? usd(r.spend) : 'nothing spent'}</span>
                  <span className="mopen m">{on ? 'showing' : 'open'}</span>
                </button>
              );
            })}
            {history.length > shown.length && (
              <button className="plainb mmore" onClick={() => setShowAll(true)}>
                Show all {num(history.length)}
              </button>
            )}
            {showAll && history.length > 4 && (
              <button className="plainb mmore" onClick={() => setShowAll(false)}>Show fewer</button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const shortName = (m) => (m ? String(m).split('/').pop() : 'your model');

/* Whether measuring this workload pays for itself, said with its numbers, and what that means for
   the measurements nobody asks for. */
function WorthLine({ m }) {
  const w = m.worth;
  if (!w || m.estimateUsd == null) return null;
  const pays = w.worthIt !== false && m.estimateUsd <= w.budgetUsd;
  const parts = [];
  if (w.expectedMonthlyUsd > 0) parts.push(`It is expected to find about ${usd(w.expectedMonthlyUsd)} a month`);
  else parts.push('It is not expected to find a saving from what is known about these models');
  if (w.protectedMonthlyUsd > 0) parts.push(`and checks the ${usd(w.protectedMonthlyUsd)} a month the switch saves now`);
  const said = `${parts.join(' ')}.`;
  // said from the workspace's own schedule: one that measures only when asked never runs by itself
  const scheduled = m.everyDays === undefined || m.everyDays === null || m.everyDays > 0;
  const when = !scheduled
    ? ' Your workspace measures only when you ask, so it runs when you press Measure now.'
    : pays
      ? ` That pays for it within ${w.paybackMonths} months, so it also runs on its schedule.`
      : ` It would not pay for itself within ${w.paybackMonths} months, so it runs only when you ask; the schedule leaves it until it would.`;
  const budget = m.optimizeBudget
    ? ` ${usd(m.optimizeBudget.leftUsd)} of your ${usd(m.optimizeBudget.budgetUsd)} optimizing budget is left for the last thirty days.` : '';
  const next = scheduled && m.nextAt && m.nextAt > Date.now() ? ` Next looked at by itself around ${timeIST(m.nextAt)} IST.` : '';
  return <span className="mworth">{said}{when}{budget}{next}</span>;
}

const STOPPED = 'Stopped. You were charged only for the calls it made, and nothing was switched.';

/* What the count on a running measurement is made of, in numbers. Your own model answers each
   sampled call twice, each candidate answers it once, and for written answers a judge model
   compares the pairs: the count is all of those, and the judge is usually most of it. */
function whereTheCountComesFrom(live, freeText = false) {
  const sample = Number(live.sample) || 0;
  const models = Number(live.models) || 0;
  const replays = sample * (2 + models);
  const judged = (Number(live.total) || 0) - replays;
  const race = 'the models race on the same calls, several at once, and any that cannot win is dropped '
    + 'straight away, its place taken by the next in line';
  if (!sample) return `Your own model answers each sampled call twice to set the bar, then ${race}.`;
  const base = `Your own model answers each of ${num(sample)} sampled calls twice to set the bar, then ${race}, `
    + `until ${num(models)} ${models === 1 ? 'has' : 'have'} answered every call. The count grows by the calls a dropped model made.`;
  // only written answers are judged; a model dropped part way also adds calls to the count
  const judging = freeText && judged > 0
    ? ' Written answers cannot be compared word for word, so a judge also compares each pair, and each comparison counts as a call.'
    : '';
  return `${base}${judging} Answers already paid for are reused and cost nothing.`;
}
const FINISHED = 'It had already finished when the stop reached it, so it was not stopped. What it found is below.';

/* What each answer to a stop means, in the words the panel leaves behind. */
const AFTER_STOP = {
  stopped: STOPPED,
  cancelled: 'Stopped before it started, so nothing was spent.',
  finished: FINISHED,
  idle: '',
};

/* What a stop came to, read from the run itself rather than assumed: a measurement can finish
   in the moment between the press and the stop arriving, and then it was not stopped at all. */
async function stopOutcome(workloadId) {
  try {
    const { runs } = await api.workloadRuns(workloadId);
    if (runs?.[0]?.status === 'done') return FINISHED;
  } catch { /* say what was asked for */ }
  return STOPPED;
}

/* How long since a running measurement was last heard from. It writes a heartbeat before every
   call, so a long silence means a slow call or, rarely, a process that has gone: a stop then
   waits for the silence to run out rather than for a call, and the panel says so. Measured by
   the server as a duration; subtracting its time from this browser's clock was wrong by however
   far apart the two clocks are. */
const quietFor = (live) => Math.max(0, Number(live?.quietMs) || 0);

const stoppingLine = (live) => {
  const quiet = quietFor(live);
  if (quiet < 60000) return 'Stopping once the call in flight comes back';
  const mins = Math.max(1, Math.round(quiet / 60000));
  return `Stopping. It has not been heard from for ${num(mins)} ${mins === 1 ? 'minute' : 'minutes'}`;
};

/* A measurement waiting its turn. One held back for a while, usually until the balance allows
   it, says until when, in IST, rather than leaving somebody watching a panel that never moves. */
const waitingLine = (startsAt) => (startsAt && startsAt > Date.now() + 60000
  ? `Waiting until ${timeIST(startsAt)} IST to start`
  : 'Waiting for its turn to start');

export { fmtDays };
