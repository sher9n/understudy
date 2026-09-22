import React, { useState } from 'react';
import { api, num } from '../api.js';
import '../picking.css';

/* How the models a measurement tries are chosen, said plainly, before anything is spent.
 *
 * Somebody paying for a measurement is entitled to know what it will spend their money on and
 * why. The old paragraph said "cheaper, spread across the price range", which chose four models
 * out of ten on the one real measurement that could never answer a single call. This says what
 * actually happens: what is ruled out and why, how the rest are ranked, where Jev comes in, how
 * the race drops the ones that cannot win, and what is remembered and for how long. */

const SPEED = [
  ['auto', 'Automatic'],
  ['same', 'As fast as now'],
  ['slower_ok', 'A little slower is fine'],
  ['any', 'Speed does not matter'],
];

const STEP_WORDS = {
  private: 'have no provider that keeps nothing, so every call to them would be refused',
  features: 'cannot handle your requests (tools, JSON, images or length)',
  thinking: 'think before answering and cannot be told not to, and your answers are capped short',
  retiring: 'are being retired soon',
  health: 'have not been answering reliably over the last day',
  price: 'would not save you anything on your calls',
  reverted: 'were switched to before on this workload and switched back',
  speed: 'are published as far slower than your model',
};

const SOURCE_WORDS = {
  before: 'on your calls before',
  elsewhere: 'on similar workloads',
  jev: 'Jev',
  arena: 'Arena',
  live: 'live calls elsewhere',
};

const short = (m) => String(m || '').split('/').pop();

/* How the models that think are asked to, for this workload, in one or two sentences. */
function thinkingText(s, w) {
  const yours = short(w.reference);
  if (s.outCap && s.outCap < 4000) {
    return `Your answers are capped at ${num(s.outCap)} tokens, and the notes count against that, so a model is asked not to think wherever it can be, and one that cannot is ruled out above.`;
  }
  if (s.reasoningSet) return 'Your requests say how much to think, and every model is sent them as they are.';
  if (s.refThinks === true) return `${yours} thinks too, so they are measured thinking the way they normally do: like for like.`;
  if (s.refThinks === false) {
    return `${yours} answers straight away, so they are asked not to think, or to think as little as they allow, and measured that way: like for like. If one wins, it is switched to working the same way.`;
  }
  return `We check how ${yours} works on the first calls of a measurement, and ask them to work the same way: like for like.`;
}
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const inTen = (p) => `${Math.max(0, Math.min(10, Math.round(p * 10)))} in 10`;

const ago = (at) => {
  if (!at) return null;
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
};

/* What a source said about a model, as a short tag. */
const tagOf = (part) => {
  if (part.source === 'jev') return `Jev: ${String(part.note || 'read it').toLowerCase()}`;
  if (part.source === 'arena') {
    const [mine, theirs] = String(part.note || '').split(' against ');
    return theirs ? `Arena ${mine}, yours ${theirs}` : 'Arena';
  }
  if (part.source === 'before') return part.note === 'cleared' ? 'cleared here before' : `${part.note} here before`;
  if (part.source === 'elsewhere') return `cleared ${part.note} similar workloads`;
  if (part.source === 'live') return `live results elsewhere: ${part.note}`;
  return SOURCE_WORDS[part.source] || part.source;
};

export default function HowWePick({ w, m, onChanged }) {
  const s = m.selection;
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [speedErr, setSpeedErr] = useState(null);
  if (!s) return null;
  const want = s.want;
  const first = s.funnel[0]?.left ?? 0;
  const left = s.funnel[s.funnel.length - 1]?.left ?? 0;
  const ruledOut = s.ruledOut || [];
  const out = ruledOut.reduce((a, g) => a + g.count, 0);
  const tested = s.order.slice(0, want);
  const next = s.order.slice(want);
  const speedPref = w.speedPref || 'auto';
  const autoIs = s.speed?.auto ? (s.speed.pref === 'same' ? 'as fast as now' : s.speed.pref === 'any' ? 'any speed' : 'a little slower is fine') : null;
  const speedText = !s.speed || s.speed.pref === 'any' ? 'no speed limit'
    : s.speed.pref === 'same' ? 'taking no longer than your model, give or take a little'
      : 'taking at most one and a half times as long as your model';

  const setSpeed = async (pref) => {
    setSaving(true);
    setSpeedErr(null);
    try {
      await api.setSpeed(w.id, pref);
      if (onChanged) await onChanged();
    } catch (e) {
      setSpeedErr(`That did not save: ${e.message || 'the server did not answer'}. Try again.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mpick hwp">
      <div className="mpickh">How we pick the {num(want)} models to test</div>
      <p className="mpickp">
        Out of the {num(first)} models switched on in Models, we look for the ones most likely to
        save you money without changing your answers. Four steps, in this order.
      </p>

      <ol className="hwpsteps">
        <li>
          <div className="hwpt">Rule out what cannot do this job</div>
          <p>
            {num(out)} models are ruled out before anything is spent, each for a reason we can
            state, which leaves {num(left)}. Nothing here is a guess: it is read from each model&rsquo;s
            published facts and from your own requests.
          </p>
          <div className="hwpfun" role="img" aria-label={`How many models are left after each check: ${s.funnel.map((f) => `${f.left} ${f.label}`).join(', ')}`}>
            {s.funnel.map((f) => (
              <div className="hwpfr" key={f.step}>
                <span className="hwpfb"><i style={{ width: `${first ? (f.left / first) * 100 : 0}%` }} /></span>
                <span className="hwpfn m">{num(f.left)}</span>
                <span className="hwpfl">{f.label}</span>
              </div>
            ))}
          </div>
          {out > 0 && (
            <button className="plainb hwpmore" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? 'Hide what was ruled out' : `See the ${num(out)} ruled out, and why`}
            </button>
          )}
          {open && (
            <div className="hwpout">
              {ruledOut.map((g) => (
                <div className="hwpog" key={g.step}>
                  <div className="hwpoh"><b className="m">{num(g.count)}</b> {STEP_WORDS[g.step] || g.step}</div>
                  {new Set(g.examples.map((e) => e.reason)).size === 1 ? (
                    <p className="hwpnames">
                      <span className="m">{g.examples.map((e) => short(e.model)).join(', ')}</span>
                      {g.count > g.examples.length ? ` and ${num(g.count - g.examples.length)} more.` : '.'}
                    </p>
                  ) : (
                    <ul>
                      {g.examples.map((e) => (
                        <li key={e.model}><span className="m">{short(e.model)}</span> {e.reason}</li>
                      ))}
                      {g.count > g.examples.length && <li className="hwpmuted">and {num(g.count - g.examples.length)} more</li>}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </li>

        <li>
          <div className="hwpt">Rank the rest by what each is expected to save</div>
          <p>
            For every model that is left, we work out what it would save you each month if it could
            replace {short(w.reference)}, and multiply that by the chance that it can. Replacing it
            takes two things, and both have to be true: its answers match, and it is quick enough for
            the speed you choose below. A model that would save a lot but probably cannot do the job
            ranks below one that saves a little less and probably can.
          </p>
          <p>
            <b>Will its answers match?</b> Four things say, strongest first: how it did on your own
            calls before; <b>Jev</b>, a judging model from TypeSafe, which reads a few of your requests
            beside the model&rsquo;s own description and says how well it suits them; how people rate
            it against {short(w.reference)} on the public Arena leaderboard; and whether it comes from
            the same family as yours.
          </p>
          <p>
            <b>Will it be quick enough?</b> How fast it was, against models like yours, in our own
            recent measurements, and how fast its providers say it is. A model whose provider was too
            busy to answer in the last few hours waits at the back for a while.
          </p>
          <p>
            <b>Thinking.</b> Some models write hidden notes before they answer. That makes them slower,
            and the notes are paid for like the answer. {thinkingText(s, w)}
          </p>
          {tested.length > 0 && (
            <div className="hwprank">
              <div className="hwprh">Tested first</div>
              {tested.map((r, i) => <RankRow key={r.model} r={r} i={i} />)}
              {next.length > 0 && <div className="hwprh">Next in line, if one is dropped</div>}
              {next.map((r, i) => <RankRow key={r.model} r={r} i={tested.length + i} dim />)}
            </div>
          )}
        </li>

        <li>
          <div className="hwpt">Race them, and drop any that cannot win</div>
          <p>
            They are tried in that order, several at once, on the same {num(m.sample)} of your calls.
            {s.judge === 'jev'
              ? ' Jev compares each written answer with your model’s own two answers to the same call, and checks whether it refuses or stops mid-answer; where Jev is unsure, a language model is asked as well.'
              : ' A language model compares each written answer with your model’s own two answers to the same call.'}
            {' '}A model is dropped the moment it cannot reach your bar, is slower than your speed setting
            allows, or its provider refuses it, and the next in line takes its place, until {num(want)} have
            answered every call. A model that cannot win is never paid for on every call.
          </p>
          <div className="hwpspeed" role="group" aria-label="How fast a replacement must be">
            <span className="hwpsl">How fast a replacement must be</span>
            <div className="hwpseg">
              {SPEED.map(([k, label]) => (
                <button key={k} className={`hwpsb${speedPref === k ? ' on' : ''}`} disabled={saving}
                  aria-pressed={speedPref === k} onClick={() => setSpeed(k)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="hwpsn">
              {speedPref === 'auto' && autoIs
                ? `Automatic is ${autoIs} here, because your calls ${s.streamed ? 'are streamed and somebody watches the words appear' : 'are not streamed'}. `
                : ''}
              Right now: {speedText}{s.speed?.metric === 'ttft' ? ', timed to the first word' : ', timed to the whole answer'}.
              {m.running ? ' A measurement already running keeps the setting it started with.' : ''}
            </span>
            {speedErr && <span className="hwpserr" role="alert">{speedErr}</span>}
          </div>
        </li>

        <li>
          <div className="hwpt">Remember, but not for ever</div>
          <p>
            Answers you have already paid for are used again for up to 14 days, so measuring again on
            the same calls costs little{s.cachedBar > 0 ? `: ${pct(s.cachedBar)} of your model's answers for the next measurement are already paid for` : ''}.
            What we know about each model is read again every hour, and Jev&rsquo;s readings every two
            weeks, because models and the companies that run them keep changing, and what is true
            today is not true for ever.
            {s.factsAt?.zdr ? ` Model facts were last read ${ago(s.factsAt.zdr)}.` : ''}
          </p>
        </li>
      </ol>

      {s.jevResting && (
        <p className="hwpnote">
          Jev is unavailable right now. {s.jevResting} Until it is back, a language model compares the
          answers, and models are ranked without Jev&rsquo;s reading.
        </p>
      )}
      {!s.jevResting && s.pendingJev > 0 && (
        <p className="hwpnote">
          Jev is still reading {num(s.pendingJev)} models for this workload, so the order may shift a
          little before the measurement starts.
        </p>
      )}
      <p className="hwpfoot">
        You can change how many are tested in Settings. Arena ratings come from the Arena leaderboard
        (lmarena-ai/leaderboard-dataset, CC BY 4.0).
      </p>
    </div>
  );
}

function RankRow({ r, i, dim = false }) {
  return (
    <div className={`hwprr${dim ? ' dim' : ''}`}>
      <span className="mpickn">{i + 1}</span>
      <span className="hwprm m">{short(r.model)}</span>
      <span className="hwprs">saves about {pct(r.savingShare)}</span>
      <span className="hwprc">chance {inTen(r.chance)}</span>
      <span className="hwptags">
        {r.thinking === 'off' && <span className="hwptag">thinking off</span>}
        {r.thinking === 'light' && <span className="hwptag">thinking kept light</span>}
        {r.busy && <span className="hwptag warn">provider busy lately</span>}
        {r.speedChance !== null && r.speedChance !== undefined && r.speedChance < 0.45 && <span className="hwptag warn">may be too slow</span>}
        {r.speedMeasured !== null && r.speedMeasured !== undefined && r.speedChance >= 0.75 && <span className="hwptag">quick in past tests</span>}
        {r.family && <span className="hwptag">same family</span>}
        {(r.parts || []).map((p) => <span className="hwptag" key={p.source}>{tagOf(p)}</span>)}
      </span>
    </div>
  );
}
