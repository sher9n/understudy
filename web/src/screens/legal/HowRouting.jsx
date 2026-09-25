import React, { useEffect } from 'react';
import { Drawing, Step, Figure, End, DailyChecks } from './HowItWorks.jsx';
import '../../how.css';

/* How models are routed, for somebody who wants to know what a switch rests on, in the homepage's voice: a funnel of
 * the five steps every workload goes through, then each step in two short paragraphs beside one picture. The same
 * pen draws its pictures as How it works, so the two pages read as one.
 *
 * Built from the "Five steps" artboard (option 1 of 3) the owner chose on 26 Sep 2026. The steps keep the ids the
 * page had before, and the parts it no longer has (sorting by kind, Jev, the simulations) send an old link to the
 * step that now covers them. The simulation figures were left out on purpose: test/harness.test.js pins only loose
 * limits, not the numbers the old page quoted. */

// the five steps, as places a link can go straight to (/how-models-are-routed#second-look)
const STEPS = ['garden', 'testing', 'priority', 'second-look', 'after'];
// parts the page used to have, and the step that now says what they said
const MOVED = { kinds: 'garden', jev: 'testing', numbers: 'second-look' };

/* The funnel: ten options tried, three pass, the first in line is tested again and fails, the second passes and is
   switched to. Each box is a link to its step. */
const X = [10, 210, 410, 610, 810];
const W = 170;
// the three that pass the first test, among the ten
const PASSED = [1, 5, 8];

function Funnel() {
  const grid = (x0, fn) => Array.from({ length: 10 }, (_, i) => (
    <g key={i}>{fn(i, x0 + 29 + (i % 5) * 28, 132 + Math.floor(i / 5) * 30)}</g>
  ));
  return (
    <Drawing w={1000} h={270} links
      label="Five steps. Ten options are tried. Each is tested on your own requests, and three pass. They are put in order for your priority. The first in line is tested again on requests it has never seen; here it fails, and the second in line passes. It is switched to in steps and checked every day, and it goes back to your model if it gets worse.">
      {(p) => {
        /* A box and everything drawn in it sit inside its link, so a click anywhere in the box, on a dot as much as
           on a word, goes to the step. */
        const col = (i, id, t1, t2, foot1, foot2, inner) => (
          <a href={`#${id}`} aria-label={`Step ${i + 1}: ${t1} ${t2}`}>
            <rect x={X[i]} y="30" width={W} height="218" rx="12" className={`hwbx${i === 4 ? ' b' : ''}`} />
            {p.text(X[i] + W / 2, 70, t1, 'hwt', 'middle')}
            {p.text(X[i] + W / 2, 88, t2, 'hwt', 'middle')}
            {inner}
            {p.text(X[i] + W / 2, 218, foot1, 'hws', 'middle')}
            {foot2 && p.text(X[i] + W / 2, 234, foot2, 'hws', 'middle')}
            {p.chip(X[i] + 4, 34, i + 1)}
          </a>
        );
        return (
          <>
            {col(0, 'garden', 'Many options', 'are tried', '10 options', '',
              grid(X[0], (i, cx, cy) => p.dot(cx, cy, 'm')))}
            {col(1, 'testing', 'Each is tested', 'on your requests', '3 pass the test', '',
              grid(X[1], (i, cx, cy) => (PASSED.includes(i) ? <>{p.dot(cx, cy, 'o')}{p.tick(cx, cy)}</> : p.dot(cx, cy, 'x'))))}
            {col(2, 'priority', 'The best are', 'put in order', 'for your priority', '',
              [['1st', 125], ['2nd', 155], ['3rd', 185]].map(([t, cy]) => (
                <g key={t}>{p.dot(X[2] + 62, cy - 8, 'o')}{p.tick(X[2] + 62, cy - 8)}{p.text(X[2] + 80, cy - 4, t, 'hws ink')}</g>
              )))}
            {col(3, 'second-look', 'The first is', 'tested again', 'on requests it', 'has never seen', (
              <>
                {p.dot(X[3] + 46, 128, 'x')}{p.cross(X[3] + 46, 128, 4)}{p.label(X[3] + 64, 132, '1st: fails', 'start', 'x')}
                {p.dot(X[3] + 46, 170, 'o')}{p.tick(X[3] + 46, 170)}{p.label(X[3] + 64, 174, '2nd: passes', 'start', 'o')}
              </>
            ))}
            {col(4, 'after', 'Switched, then', 'checked daily', 'goes back to', 'your model if worse', (
              <>
                <circle cx={X[4] + 85} cy="148" r="30" className="hwring" />
                <circle cx={X[4] + 85} cy="148" r="20" className="hwring" />
                {p.dot(X[4] + 85, 148, 'b', 11)}{p.tick(X[4] + 85, 148, 1.1)}
              </>
            ))}
            {[0, 1, 2, 3].map((i) => <g key={i}>{p.line(X[i] + W, 140, X[i + 1] - 3, 140)}</g>)}
          </>
        );
      }}
    </Drawing>
  );
}

/* The same funnel for a narrow screen, as a list, so its words keep their size. */
function PhoneMap() {
  const rows = [
    ['garden', 1, 'Many options are tried'],
    ['testing', 2, 'Each is tested on your requests'],
    ['priority', 3, 'The best are put in order'],
    ['second-look', 4, 'The first is tested again'],
    ['after', 5, 'Switched, then checked every day'],
  ];
  return (
    <div className="hwmapphone">
      <ol className="hwloop">
        {rows.map(([id, n, words]) => (
          <li key={id}><a href={`#${id}`}><span className="hwnum">{n}</span>{words}</a></li>
        ))}
      </ol>
    </div>
  );
}

// small line icons for the five kinds of option, drawn in the text colour
const Icon = ({ children }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

/* Step 1: every kind of option there is, each tried only where it fits (src/eval/select.js, src/eval/run.js). */
const OPTIONS = [
  ['A cheaper model', 'A less expensive model answers on its own.',
    <><path d="M3.5 12.2 11.8 3.9h7.6v7.6l-8.3 8.3a1.6 1.6 0 0 1-2.3 0l-5.3-5.3a1.6 1.6 0 0 1 0-2.3z" /><circle cx="15.6" cy="7.7" r="1.4" /></>],
  ['Your model, thinking less', 'Some models think before answering, and you pay for that thinking.',
    <><path d="M4 16a8 8 0 1 1 16 0" /><path d="M12 16 7.6 11.4" /><circle cx="12" cy="16" r="1.3" /></>],
  ['Your model, from a cheaper provider', 'The same model, sold for less by another company.',
    <><path d="M4 9.5 5.6 4.5h12.8L20 9.5" /><path d="M4 9.5c0 1.5 1.2 2.5 2.7 2.5s2.6-1 2.6-2.5c0 1.5 1.2 2.5 2.7 2.5s2.7-1 2.7-2.5c0 1.5 1.1 2.5 2.6 2.5S20 11 20 9.5" /><path d="M5.5 12v7.5h13V12" /><path d="M10 19.5v-4h4v4" /></>],
  ['A cheap model with a checker', 'When the checker is unsure, your model answers instead.',
    <><path d="M12 3.2 19 6v5.4c0 4.3-2.9 7.6-7 9.4-4.1-1.8-7-5.1-7-9.4V6z" /><path d="m8.8 12.1 2.2 2.2 4.3-4.4" /></>],
  ['A model for each kind of request', 'Kinds a cheap model handles well go to it. Everything else goes to yours.',
    <><path d="M4 12h6" /><path d="M10 12c3 0 3.5-6 7.5-6H20" /><path d="M10 12c3 0 3.5 6 7.5 6H20" /><path d="m17.8 3.8 2.3 2.2-2.3 2.2" /><path d="m17.8 15.8 2.3 2.2-2.3 2.2" /></>],
];

function Options() {
  return (
    <ul className="hwopts">
      {OPTIONS.map(([title, words, icon]) => (
        <li key={title}>
          <span className="hwic"><Icon>{icon}</Icon></span>
          <div><b>{title}</b><span className="hwoptd">{words}</span></div>
        </li>
      ))}
    </ul>
  );
}

/* Step 2: two pairs of answers. The same facts with a helpful extra line count as just as good; a changed fact counts
   as worse. Only a difference in wording is read again in both orders (judgeBarPair in src/eval/judge.js). */
function Judge() {
  return (
    <Drawing w={400} h={244}
      label="Your model answers: it shipped today. Another model answers: it shipped today, track it here. Same facts, so it counts as just as good. In a second pair, the other model says it ships on Friday: a changed fact, so it counts as worse. When only the wording differs, the judge reads the pair in both orders.">
      {(p) => (
        <>
          {p.text(2, 12, 'YOUR MODEL', 'hwe')}{p.text(152, 12, 'ANOTHER MODEL', 'hwe')}{p.text(310, 12, 'VERDICT', 'hwe')}
          {p.lbox(2, 22, 140, 62, [['“It shipped', 'hws ink'], ['today.”', 'hws ink']])}
          {p.lbox(152, 22, 150, 62, [['“It shipped today.', 'hws ink'], ['Track it here.”', 'hws ink']])}
          {p.box(310, 22, 88, 62, [['as good', 'hwt o'], ['same facts', 'hws']], 'o')}
          {p.lbox(2, 100, 140, 62, [['“It shipped', 'hws ink'], ['today.”', 'hws ink']])}
          {p.lbox(152, 100, 150, 62, [['“It ships', 'hws ink'], ['on Friday.”', 'hws ink']])}
          {p.box(310, 100, 88, 62, [['worse', 'hwt x'], ['a new fact', 'hws']], 'x')}
          {p.box(2, 180, 396, 58, [['When only the wording differs, the judge reads the', 'hws'],
            ['pair in both orders, so neither wins by going first.', 'hws']])}
        </>
      )}
    </Drawing>
  );
}

/* Step 3: what each routing priority puts first (src/eval/confidence.js). Set for the whole workspace in Settings. */
const PRIORITIES = [
  ['Balanced', true, 'The biggest saving it can count on. When two are close, the faster one.'],
  ['Cautious', false, 'Only options it is almost certain about, with a stricter second test.'],
  ['Most savings', false, 'The cheapest option that passed.'],
];

function Priorities() {
  return (
    <div className="hwprio">
      {PRIORITIES.map(([name, isDefault, words]) => (
        <div key={name} className={isDefault ? 'hwprioon' : undefined}>
          <b>{name}{isDefault && <small>The default</small>}</b>
          <span>{words}</span>
        </div>
      ))}
    </div>
  );
}

/* Step 4: of three that passed once, the first in line fails on requests it has never seen, and the second passes and
   is switched to (EVAL_CONFIRM_TRIES in src/config.js). */
function SecondTest() {
  return (
    <Drawing w={400} h={236}
      label="Three options passed the first test. The first in line is tested again on requests it has never seen, and fails: its first result was luck. The second in line passes again and is switched to. The third is not needed.">
      {(p) => (
        <>
          {p.text(20, 14, 'PASSED ONCE', 'hwe')}{p.text(196, 14, 'TESTED AGAIN', 'hwe')}
          {[['1st', 52], ['2nd', 102], ['3rd', 152]].map(([t, y]) => (
            <g key={t}>{p.dot(32, y, 'o', 10)}{p.tick(32, y)}{p.text(50, y + 4, t, 'hws ink')}</g>
          ))}
          {p.line(80, 52, 192, 52)}
          {p.dot(208, 52, 'x', 10)}{p.cross(208, 52, 4)}
          {p.label(226, 48, 'fails:', 'start', 'x')}{p.label(226, 63, 'it was luck', 'start', 'x')}
          {p.line(80, 102, 192, 102, 'o')}
          {p.dot(208, 102, 'o', 10)}{p.tick(208, 102)}
          {p.label(226, 98, 'passes:', 'start', 'o')}{p.label(226, 113, 'switched to', 'start', 'o')}
          {p.label(196, 156, 'not needed', 'start')}
          {p.box(2, 184, 396, 44, [['The second test uses requests none of them has seen.', 'hws']])}
        </>
      )}
    </Drawing>
  );
}

export default function HowRouting({ me, go, inApp = false }) {
  // inside the app, whose frame already holds the page's <main>, a plain container (see App.jsx)
  const Root = inApp ? 'div' : 'main';
  // arriving from a link to one step (/how-models-are-routed#second-look) lands on that step, or on the one that took its place
  useEffect(() => {
    const asked = window.location.hash.slice(1);
    const id = MOVED[asked] ?? asked;
    if (STEPS.includes(id)) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, []);

  return (
    <Root className="hw hwroute" id={inApp ? undefined : 'main'}>
      <header className="hwopen hwsolo">
        <div>
          <div className="eyeb doceyeb">Model routing</div>
          <h1>How models are routed</h1>
          <p className="hwlede">
            <b>Routing</b> means choosing which AI model answers each request. Understudy makes two promises, in this
            order. Your answers stay as good as the ones your model gives today. Within that, you save as much as
            possible.
          </p>
        </div>
      </header>

      <figure>
        <div className="hwfig">
          <div className="hwmapwide"><Funnel /></div>
          <PhoneMap />
        </div>
        <figcaption>Every workload goes through these five steps.</figcaption>
      </figure>

      <div className="hwsteps">
        <Step n={1} id="garden" title="Many options are tried" top figure={<Options />}>
          <p>Understudy tries cheaper models. Where they fit, it also tries smarter ways to use the model you already have.</p>
          <p className="hwsoft">Each way of answering is called an <b className="hwterm">option</b>.</p>
        </Step>

        <Step n={2} id="testing" title="Each is tested on your requests" figure={<Figure><Judge /></Figure>}>
          <p>Every option answers the same sample of your real requests, and each answer is compared with your model’s.</p>
          <p className="hwsoft">
            Numbers and data fields are checked exactly. Written words are read by an AI judge called Jev, made by
            TypeSafe. A changed fact always counts as worse.
          </p>
        </Step>

        <Step n={3} id="priority" title="The best are put in order" figure={<Priorities />}>
          <p>
            Several options can pass. Understudy puts the biggest saving it can count on first, so a clear pass beats a
            narrow one.
          </p>
          <p className="hwsoft">Your <b className="hwterm">routing priority</b>, set in Settings, decides how careful it is.</p>
        </Step>

        <Step n={4} id="second-look" title="The first is tested again" figure={<Figure><SecondTest /></Figure>}>
          <p>When many options are tried, one can pass by luck, the way a coin can land heads five times in a row.</p>
          <p className="hwsoft">
            So before anything switches, the first in line is tested again on requests it has never seen. If it fails,
            the next in line gets its turn.
          </p>
        </Step>

        <Step n={5} id="after" title="Switched, then checked every day" figure={<Figure><DailyChecks /></Figure>}>
          <p>The new option answers 5 in 100 requests, then 25, then all of them.</p>
          <p className="hwsoft">
            Every day after, about 20 of its answers are also sent to your model and compared. If it gets clearly worse,
            requests go back to your model by themselves.
          </p>
        </Step>
      </div>

      <End me={me} go={go} title="See it on your own requests"
        line="Nothing switches until an option passes two tests on your own requests." other={['how', 'How it works']} />
    </Root>
  );
}
