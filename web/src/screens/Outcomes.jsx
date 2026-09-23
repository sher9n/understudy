import React, { useEffect, useState } from 'react';
import { api, num, usd, timeIST } from '../api.js';
import { OutcomeBars, OUTCOME_PARTS, StepsBars, TaskChain, pct } from '../LearnCharts.jsx';

/* How a workload's calls turned out, and the tasks they were steps in.
 *
 * Four groups, the same everywhere: a problem was seen, it was confirmed to have worked, nothing
 * went wrong that anything could see, or it is too recent to say. What counts as a problem is the
 * customer's to set, and the way to tell us how a call turned out in their own systems is here,
 * written out, ready to paste. */

const SIGNAL_WORDS = [
  ['broken', 'The answer was not the JSON the request asked for'],
  ['cut_off', 'The answer was cut off at the length limit'],
  ['refused', 'The model refused to answer'],
  ['tool', 'A tool the model called then failed, or worked'],
  ['retry', 'The same call was sent again straight away'],
  ['correction', 'The next message said the answer was wrong'],
];

/* A count of one signal, as a sentence that agrees with its number. */
const plural = (n, one, many) => (n === 1 ? one : many);
const SIGNAL_LINES = {
  broken: (n) => `${n} ${plural(n, 'answer was', 'answers were')} not the JSON the request asked for`,
  cut_off: (n) => `${n} ${plural(n, 'answer was', 'answers were')} cut off at the length limit`,
  refused: (n) => `${n} ${plural(n, 'time', 'times')} the model refused to answer`,
  tool_error: (n) => `${n} ${plural(n, 'tool', 'tools')} failed on what the model gave ${plural(n, 'it', 'them')}`,
  tool_ok: (n) => `${n} ${plural(n, 'tool', 'tools')} worked on what the model gave ${plural(n, 'it', 'them')}`,
  retry: (n) => `${n} ${plural(n, 'call was', 'calls were')} sent again straight away`,
  correction: (n) => `${n} ${plural(n, 'time', 'times')} the next message said the answer was wrong`,
  continued: (n) => `${n} ${plural(n, 'time', 'times')} the conversation moved on`,
};
// which setting in "what counts as working" a signal answers to
const SETTING_OF = { tool_error: 'tool', tool_ok: 'tool', continued: 'correction' };

const Tile = ({ k, v, s, tone = '' }) => (
  <div className={`tile ${tone}`}><div className="k">{k}</div><div className="v">{v}</div><div className="s">{s}</div></div>
);

export default function Outcomes({ w }) {
  const [o, setO] = useState(null);
  const [t, setT] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => Promise.all([api.outcomes(w.id), api.tasks(w.id)])
    .then(([a, b]) => { setO(a); setT(b); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [w.id]);

  if (err) return <section className="opt"><div className="opthead"><h2>How calls turned out</h2></div><div className="errbox" style={{ margin: 16 }}>{err}</div></section>;
  if (!o) return <section className="opt"><div className="opthead"><h2>How calls turned out</h2></div><div className="loading">Reading how calls went…</div></section>;

  const judged = o.calls - o.recent;
  return (
    <>
      <section className="opt outc">
        <div className="opthead">
          <h2>How calls turned out</h2>
          <span className="s">Last {o.days} days</span>
        </div>
        <div className="cbody">
          <div className="tiles otiles">
            <Tile k="Worked" v={o.rate === null ? '–' : pct(o.rate, 1)}
              s={judged ? `of ${num(judged)} calls old enough to tell` : 'no calls old enough yet'} tone="good" />
            <Tile k="A problem was seen" v={num(o.problem)} s={o.problem ? 'the latest are listed below, with why' : 'none in this window'} tone={o.problem ? 'bad' : ''} />
            <Tile k="Confirmed as working" v={num(o.confirmed)} s="a tool that worked, a conversation that moved on, or your report" />
            <Tile k="Too recent to tell" v={num(o.recent)} s={`calls from the last ${o.settleMin} minutes`} />
          </div>

          {o.calls > 0 ? (
            <>
              <div className="olegend">
                {OUTCOME_PARTS.map(([k, label, tone]) => <span key={k}><i className={`osw ${tone}`} />{label}</span>)}
              </div>
              <OutcomeBars series={o.series} />
              <p className="lsmall">
                A call with <b>no sign of a problem</b> counts as having worked: it was not sent again, no tool
                failed on it, nobody corrected it and it came back whole. That is a good sign rather than proof,
                which is why results you report yourself count for more.
              </p>
            </>
          ) : (
            <div className="optempty">Calls appear here as they arrive, with how each one turned out.</div>
          )}

          {(o.signals.length > 0 || o.failures.length > 0) && (
            <div className="ocols">
              {o.signals.length > 0 && (
                <div>
                  <div className="kk">What we noticed</div>
                  <ul className="osig">
                    {o.signals.map((sg) => {
                      const counted = o.def.signals[SETTING_OF[sg.kind] || sg.kind] !== false;
                      return (
                        <li key={sg.kind} className={counted ? '' : 'off'}><i className={`osw ${!counted ? 'recent' : sg.worked ? 'good' : 'bad'}`} />
                          <span>{(SIGNAL_LINES[sg.kind] || ((n) => `${n} × ${sg.words}`))(sg.n)}{counted ? '' : ' (not counted)'}</span></li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {o.failures.length > 0 && (
                <div>
                  <div className="kk">Latest problems</div>
                  <ul className="osig">
                    {o.failures.map((f) => (
                      <li key={f.id}><i className="osw bad" />
                        <span><b>{timeIST(f.at)} IST</b> on {String(f.model || '').split('/').pop()}: {(Array.isArray(f.why) ? f.why : [f.why].filter(Boolean)).join('; ') || 'a problem'}</span></li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        <Definition w={w} o={o} onSaved={load} />
        <Report o={o} />
      </section>
      {t && t.overall.tasks > 0 && <Tasks t={t} />}
    </>
  );
}

/* What counts as working on this workload: which signals from the traffic count, and what each
   event the customer reports means. Saving reads every call it touches again. */
function Definition({ w, o, onSaved }) {
  const [open, setOpen] = useState(false);
  const [signals, setSignals] = useState(o.def.signals);
  const [events, setEvents] = useState(() => {
    const known = new Map(o.def.events.map((e) => [e.event, e.means]));
    for (const e of o.events) if (!known.has(e.event)) known.set(e.event, null);
    return [...known].map(([event, means]) => ({ event, means }));
  });
  const [add, setAdd] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const waiting = o.events.filter((e) => e.means === null && e.waiting > 0);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.saveOutcomeDef(w.id, { signals, events: events.filter((e) => e.means).map((e) => ({ event: e.event, means: e.means })) });
      setMsg('Saved. The calls it touches are being read again now, so the figures above may take a minute to move.');
      await onSaved();
    } catch (x) { setMsg(x.message); } finally { setBusy(false); }
  };

  return (
    <div className="odef">
      <button className="odeft" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="kk">What counts as working</span>
        <span className="odefs">{o.def.custom ? 'Set by you' : 'The defaults'}{waiting.length ? `, ${waiting.length} reported ${waiting.length === 1 ? 'event needs' : 'events need'} a meaning` : ''}</span>
        <span className="chev2" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="odefb">
          <p className="lsmall">Signals we read from your traffic. Switch one off if it does not mean a problem for this workload: a chat where people often ask again on purpose, say.</p>
          <div className="osigs">
            {SIGNAL_WORDS.map(([k, words]) => (
              <label key={k} className="ochk">
                <input type="checkbox" checked={signals[k] !== false} onChange={(x) => setSignals({ ...signals, [k]: x.target.checked })} />
                <span>{words}</span>
              </label>
            ))}
          </div>
          <p className="lsmall">Events your system reports, and what each one means. A reported result always outweighs what we read from the traffic.</p>
          <div className="oevents">
            {events.length === 0 && <p className="lsmall">None reported yet. Add the names your system will send, or just send them: any new name shows up here to be given a meaning.</p>}
            {events.map((e, i) => (
              <div className="oevent" key={e.event}>
                <code>{e.event}</code>
                <div className="seg">
                  {[['worked', 'means it worked'], ['failed', 'means it did not'], [null, 'no meaning yet']].map(([m, label]) => (
                    <button key={String(m)} className={`segb${e.means === m ? ' on' : ''}`} aria-pressed={e.means === m}
                      onClick={() => setEvents(events.map((x, k) => (k === i ? { ...x, means: m } : x)))}>{label}</button>
                  ))}
                </div>
              </div>
            ))}
            <div className="oadd">
              <input className="inp" aria-label="A new event name" placeholder="an event name, like ticket_resolved" value={add} onChange={(x) => setAdd(x.target.value)} />
              <button className="minig" disabled={!add.trim() || events.some((e) => e.event === add.trim())}
                onClick={() => { setEvents([...events, { event: add.trim().slice(0, 80), means: 'worked' }]); setAdd(''); }}>Add</button>
            </div>
          </div>
          <div className="oacts">
            <button className="mini" disabled={busy} onClick={save}>Save what counts</button>
            {msg && <span className="lsmall">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/* How to tell us how a call turned out, written out with this deployment's own address. */
function Report({ o }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('curl');
  const curl = `# every answer through us carries its call id in a header:
#   ${o.callIdHeader}: call_...
# or send your own id with the request, as the header ${o.refHeader},
# and report with "ref": "<your id>" instead of "call_id" (copies can carry one too)

curl ${o.endpoint} \\
  -H "Authorization: Bearer $UNDERSTUDY_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"call_id": "call_...", "event": "ticket_resolved"}'`;
  const js = `const { data, response } = await client.chat.completions.create({ ... }).withResponse();
const callId = response.headers.get('${o.callIdHeader}');

// later, when you know how it went
await fetch('${o.endpoint}', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${process.env.UNDERSTUDY_KEY}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ call_id: callId, event: 'ticket_resolved' }),
});`;
  const py = `raw = client.chat.completions.with_raw_response.create(...)
call_id = raw.headers.get("${o.callIdHeader}")

# later, when you know how it went
requests.post("${o.endpoint}",
    headers={"Authorization": f"Bearer {UNDERSTUDY_KEY}"},
    json={"call_id": call_id, "event": "ticket_resolved"})`;
  const code = { curl, js, py }[tab];
  return (
    <div className="odef">
      <button className="odeft" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="kk">Tell us how calls turned out</span>
        <span className="odefs">One request per result, from your own system, whenever you know</span>
        <span className="chev2" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="odefb">
          <p className="lsmall">
            Only your system knows whether a ticket was resolved, a form was accepted or an email was answered. Send
            that with the call&rsquo;s id and an event name. Give the name a meaning above, or send <code>&quot;value&quot;: 1</code> for
            worked and <code>0</code> for not. Up to 500 at once under <code>&quot;outcomes&quot;</code>.
          </p>
          <div className="tabs otabs">
            {[['curl', 'curl'], ['js', 'JavaScript'], ['py', 'Python']].map(([k, label]) => (
              <button key={k} className={`segb${tab === k ? ' on' : ''}`} aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>
            ))}
            <button className="minig ocopy" onClick={() => navigator.clipboard?.writeText(code).catch(() => {})}>Copy</button>
          </div>
          <pre className="ocode" tabIndex={0} aria-label="Code to copy"><code>{code}</code></pre>
        </div>
      )}
    </div>
  );
}

/* Tasks: conversations and agent loops that took more than one call. */
function Tasks({ t }) {
  const ov = t.overall;
  return (
    <section className="opt tasks">
      <div className="opthead">
        <h2>Tasks these calls were part of</h2>
        <span className="s">A conversation or an agent&rsquo;s loop that took more than one call</span>
      </div>
      <div className="cbody">
        <div className="tiles otiles">
          <Tile k="Tasks" v={num(ov.tasks)} s="in the last 30 days" />
          <Tile k="Steps, typically" v={ov.avgSteps === null ? '–' : ov.avgSteps.toFixed(1)} s="calls per task" />
          <Tile k="A whole task costs" v={ov.avgCost === null ? '–' : usd(ov.avgCost)} s="on average, every step" />
          <Tile k="Worked" v={ov.rate === null ? '–' : pct(ov.rate, 0)} s={ov.known ? `of ${num(ov.known)} tasks, judged by how each one ended` : 'judged by how each task ended'} />
        </div>
        <div className="tgrid">
          <div>
            <div className="kk">How many steps tasks take</div>
            <StepsBars steps={ov.steps} />
          </div>
          <div>
            <div className="kk">Latest tasks, step by step</div>
            <div className="chains">
              {t.recent.map((task) => (
                <div className="chainrow" key={task.id}>
                  <TaskChain task={task} />
                  <span className="chainm">{usd(task.cost)}{task.toolErrors ? `, ${task.toolErrors} tool ${task.toolErrors === 1 ? 'error' : 'errors'}` : ''}</span>
                </div>
              ))}
            </div>
            <p className="lsmall">Each circle is one call, in order. Green worked, red had a problem, grey showed no sign of one. Faded steps belong to another workload.</p>
          </div>
        </div>
        {ov.withToolErrors > 0 && (
          <p className="lsmall">{num(ov.withToolErrors)} of {num(ov.tasks)} tasks had a tool fail on a step. A failed tool counts against the call that asked for it, so a model that calls tools wrongly shows it in its own record.</p>
        )}
      </div>
    </section>
  );
}
