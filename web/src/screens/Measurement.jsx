import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, usd, num, timeIST } from '../api.js';

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
    return r.total ? `Stopped by you at ${num(r.done)} of ${num(r.total)} replays` : 'Stopped by you';
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
        if (d.measure?.running) setLive(d.measure.running);
        else {
          if (live?.stopping) setNotice(STOPPED);
          setLive(null); loadRuns(); if (onRan) onRan();
        }
      } catch { /* the next tick tries again */ }
    }, 2000);
    return () => clearInterval(poll.current);
  }, [live, w.id, loadRuns, onRan]);

  const start = async () => {
    setStarting(true); setErr(''); setNotice('');
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
    try {
      const out = await api.stopMeasuring(w.id);
      setAsking(false);
      if (out?.state === 'stopping') setLive((l) => (l ? { ...l, stopping: true } : l));
      else {
        setNotice(out?.state === 'stopped' ? STOPPED : 'Stopped before it started, so nothing was spent.');
        setLive(null); loadRuns(); if (onRan) onRan();
      }
    } catch (e) { setErr(e.message); } finally { setHalting(false); }
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
                  {stopping ? 'Stopping once the call in flight comes back'
                    : queued ? waitingLine(live.startsAt)
                      : (live.phase || 'Measuring')}
                </div>
                <div className="mruns m">
                  {queued ? 'Nothing has been sent yet, so nothing has been spent.' : (
                    <>
                      {num(live.done)} of {num(live.total)} replays
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
                  : 'Your own model answers each sampled call twice to set the bar, then every candidate '
                    + 'answers the same calls once. You can leave this page; it keeps going.'}
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
                twice on {shortName(w.reference)} to set the bar, then once on each of{' '}
                {num(m.models)} cheaper models. You are charged for every one of those
                calls{m.estimateUsd != null ? `, about ${usd(m.estimateUsd)} for this measurement` : ''}.
              </p>
            ) : (
              <p className="mwhy cannot">{m.reason}</p>
            )}
          </div>
        )}
        {notice && !live && <p className="mnote">{notice}</p>}
        {err && <div className="errbox" style={{ marginTop: 12 }}>{err}</div>}

        {/* Why these models and not others. Somebody paying for a run is entitled to know
            what it decided to spend their money on before it spends it. */}
        {m.picked && m.picked.length > 0 && (
          <div className="mpick">
            <div className="mpickh">
              How the {num(m.picked.length)} models were chosen
            </div>
            <p className="mpickp">
              Every model you have switched on in Models, priced on this workload&rsquo;s own
              average call rather than on a headline rate, keeping only the ones that cost
              less than {shortName(w.reference)} does here. Anything dearer cannot save you
              anything, so it is not worth paying to test. Those are then spread evenly across
              the price range instead of taking the cheapest few, so a run shows you where
              quality falls away as the price does rather than confirming that the bottom of
              the catalogue is the bottom of the catalogue.
              {m.modelsWanted > m.picked.length
                ? ` You asked for ${num(m.modelsWanted)}; only ${num(m.picked.length)} enabled models are cheaper than this one.`
                : ' You can change how many are tried in Settings.'}
            </p>
            <div className="mpicks">
              {m.picked.map((id, i) => (
                <span className="mpickm m" key={id}>
                  <span className="mpickn">{i + 1}</span>{shortName(id)}
                </span>
              ))}
            </div>
          </div>
        )}

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
                  <span className="mwhen m">{timeIST(r.at)}</span>
                  <span className="mwhat">{whatHappened(r)}</span>
                  <span className="mtrig m">{r.trigger === 'automatic' ? 'on schedule' : 'asked for'}</span>
                  <span className="mspend m">{r.spend ? usd(r.spend) : '—'}</span>
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

const STOPPED = 'Stopped. You were charged only for the calls it made, and nothing was switched.';

/* A measurement waiting its turn. One held back for a while, usually until the balance allows
   it, says until when, in IST, rather than leaving somebody watching a panel that never moves. */
const waitingLine = (startsAt) => (startsAt && startsAt > Date.now() + 60000
  ? `Waiting until ${timeIST(startsAt)} IST to start`
  : 'Waiting for its turn to start');

export { fmtDays };
