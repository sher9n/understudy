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

export default function Measurement({ w, busy, onRan, onOpenRun, openRunId }) {
  const m = w.measure || {};
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState('');
  const [live, setLive] = useState(m.running || null);
  const [runs, setRuns] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const poll = useRef(null);

  const loadRuns = useCallback(() => {
    api.workloadRuns(w.id).then((d) => setRuns(d.runs)).catch(() => {});
  }, [w.id]);

  useEffect(() => { loadRuns(); }, [loadRuns, w.measure?.runs]);
  useEffect(() => { setLive(w.measure?.running || null); }, [w.measure?.running]);

  /* While a run is going, ask how far along it is. It is the only way somebody knows the
     thing they are paying for is happening, and it stops the moment the run does. */
  useEffect(() => {
    if (!live) return undefined;
    poll.current = setInterval(async () => {
      try {
        const d = await api.workload(w.id);
        if (d.measure?.running) setLive(d.measure.running);
        else { setLive(null); loadRuns(); if (onRan) onRan(); }
      } catch { /* the next tick tries again */ }
    }, 2000);
    return () => clearInterval(poll.current);
  }, [live, w.id, loadRuns, onRan]);

  const start = async () => {
    setStarting(true); setErr('');
    try {
      await api.measure(w.id);
      const d = await api.workload(w.id);
      setLive(d.measure?.running || { total: 0, done: 0, phase: 'Starting…', spend: 0 });
      if (onRan) onRan();
    } catch (e) { setErr(e.message); } finally { setStarting(false); }
  };

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
                <div className="mrunt">{live.phase || 'Measuring'}</div>
                <div className="mruns m">
                  {num(live.done)} of {num(live.total)} replays
                  {live.spend ? ` · ${usd(live.spend)} spent so far` : ''}
                </div>
              </div>
              <div className="mpct m">{pct}%</div>
            </div>
            <div className="mbar"><span style={{ width: `${pct}%` }} /></div>
            <p className="mnote">
              Your own model answers each sampled call twice to set the bar, then every
              candidate answers the same calls once. You can leave this page; it keeps going.
            </p>
          </div>
        ) : (
          <>
            <div className="mtop">
              <div>
                <button className="mini" disabled={!m.canRun || busy || starting} onClick={start}>
                  {starting ? 'Starting…' : m.estimateUsd != null && m.canRun
                    ? `Measure now, about ${usd(m.estimateUsd)}`
                    : 'Measure now'}
                </button>
              </div>
              {m.canRun ? (
                <p className="mwhy">
                  {num(m.sample)} of this workload&rsquo;s {num(m.pool)} calls are replayed:
                  twice on {shortName(w.reference)} to set the bar, then once on each of{' '}
                  {num(m.models)} cheaper models. You are charged for every one of those
                  calls, which is what the figure on the button is.
                </p>
              ) : (
                <p className="mwhy cannot">{m.reason}</p>
              )}
            </div>
            {err && <div className="errbox" style={{ marginTop: 12 }}>{err}</div>}
          </>
        )}

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
            {shown.map((r) => (
              <button key={r.id} className={`mrow${openRunId === r.id ? ' on' : ''}`}
                onClick={() => onOpenRun(openRunId === r.id ? null : r.id)}>
                <span className="mwhen m">{timeIST(r.at)}</span>
                <span className="mwhat">
                  {r.status === 'running' ? 'Running now'
                    : r.error ? r.error
                      : r.floor != null
                        ? `Bar set at ${r.floor.toFixed(2)}%, ${num(r.models)} models tried`
                        : 'No bar could be set'}
                </span>
                <span className="mtrig m">{r.trigger === 'automatic' ? 'on schedule' : 'asked for'}</span>
                <span className="mspend m">{r.spend ? usd(r.spend) : '—'}</span>
                <span className="mopen m">{openRunId === r.id ? 'showing' : 'open'}</span>
              </button>
            ))}
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
export { fmtDays };
