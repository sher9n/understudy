import React, { useEffect, useId } from 'react';
import { To } from './Public.jsx';
import '../../how.css';

/* How Understudy works, for somebody meeting it for the first time, in the homepage's voice: the one thing you do
 * (change two lines), then the four things Understudy does, each told in two or three short sentences beside one
 * picture. The pictures follow one example (an app that answers "where is my order?"), and the figures in them are
 * said to be an example.
 *
 * Built from the "Step by step" artboard (option 1 of 3) the owner chose on 26 Sep 2026. The pictures are drawn
 * here rather than kept as images, so they take the page's colours in either theme. The sections keep the ids the
 * page had before, so an old link to /how-it-works#testing still lands on testing. */

// the parts of the page a link can go straight to
const STEPS = ['connect', 'workloads', 'testing', 'switching', 'learning'];

/* Each drawing carries its own arrowheads, one for each colour an arrow can be, under ids that no other drawing on
   the page shares. */
const HEADS = { a: '', b: 'b', o: 'o', x: 'x' };

/* What the drawings are made with: boxes with lines of text, arrows, labels that stand out from the lines they sit
   on, the numbered chips of a map, and the dots, ticks and crosses of a result. A tone is a letter: b the brand
   colour, o passing, x failing, d dashed. */
function pen(id) {
  const arrow = (k, dash) => `hwar${k === 'a' ? '' : ` ${k}`}${dash ? ' d' : ''}`;
  return {
    box: (x, y, bw, bh, lines, tone = '') => {
      const top = y + bh / 2 - ((lines.length - 1) * 17) / 2;
      return (
        <>
          <rect x={x} y={y} width={bw} height={bh} rx="10" className={`hwbx ${tone}`} />
          {lines.map(([t, c = 'hwt'], i) => (
            <text key={i} x={x + bw / 2} y={top + i * 17 + 4.5} textAnchor="middle" className={c}>{t}</text>
          ))}
        </>
      );
    },
    // a box whose lines start at its left edge: a request, or an answer
    lbox: (x, y, bw, bh, lines, tone = '') => {
      const top = y + bh / 2 - ((lines.length - 1) * 18) / 2;
      return (
        <>
          <rect x={x} y={y} width={bw} height={bh} rx="10" className={`hwbx ${tone}`} />
          {lines.map(([t, c = 'hws'], i) => (
            <text key={i} x={x + 14} y={top + i * 18 + 4.5} className={c}>{t}</text>
          ))}
        </>
      );
    },
    line: (x1, y1, x2, y2, k = 'a') => (
      <line x1={x1} y1={y1} x2={x2} y2={y2} className={arrow(k)} markerEnd={`url(#${id}${k})`} />
    ),
    path: (d, k = 'a', dash = false) => <path d={d} className={arrow(k, dash)} markerEnd={`url(#${id}${k})`} />,
    label: (x, y, t, anchor = 'middle', tone = '') => (
      <text x={x} y={y} textAnchor={anchor} className={`hwl ${tone}`}>{t}</text>
    ),
    text: (x, y, t, c = 'hws', anchor = 'start') => <text x={x} y={y} textAnchor={anchor} className={c}>{t}</text>,
    chip: (cx, cy, n) => (
      <>
        <circle cx={cx} cy={cy} r="11" className="hwchip" />
        <text x={cx} y={cy + 4} textAnchor="middle" className="hwchipt">{n}</text>
      </>
    ),
    dot: (cx, cy, tone = '', r = 9) => <circle cx={cx} cy={cy} r={r} className={`hwdot ${tone}`} />,
    tick: (cx, cy, s = 1) => (
      <path d={`M${cx - 3.6 * s} ${cy + 0.2 * s} L${cx - s} ${cy + 2.8 * s} L${cx + 3.8 * s} ${cy - 2.6 * s}`} className="hwtick" />
    ),
    cross: (cx, cy, s = 5) => (
      <>
        <line x1={cx - s} y1={cy - s} x2={cx + s} y2={cy + s} className="hwxs" />
        <line x1={cx + s} y1={cy - s} x2={cx - s} y2={cy + s} className="hwxs" />
      </>
    ),
  };
}

/** One drawing. A drawing with links in it is a group of them; any other is a single picture. */
export function Drawing({ w, h, label, links = false, children }) {
  const id = `hw${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  return (
    <svg className="hwdg" viewBox={`0 0 ${w} ${h}`} role={links ? 'group' : 'img'} aria-label={label}>
      <defs>
        {Object.entries(HEADS).map(([k, tone]) => (
          <marker key={k} id={`${id}${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7"
            markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className={`hwmk ${tone}`} />
          </marker>
        ))}
      </defs>
      {children(pen(id))}
    </svg>
  );
}

/* The two lines of a client that change, lit the way the homepage lights them. The spaces that indent them are
   written as strings, since JSX would drop them. */
function CodeBox() {
  return (
    <div className="hwcode">
      <div className="hwcodebar"><span>Two lines change</span></div>
      <pre className="m hwcodepre">
        <span>client = OpenAI(</span>
        <span><span className="hwhl">{'  base_url="https://api.understudy.dev/v1",'}</span></span>
        <span><span className="hwhl">{'  api_key=os.environ["UNDERSTUDY_KEY"],'}</span></span>
        <span>)</span>
      </pre>
    </div>
  );
}

/* One request, the way the picture of sorting shows it: the instruction that stays the same, and the detail that
   changes. */
const card = (y, instruction, detail) => (
  <>
    <rect x="2" y={y} width="232" height="62" rx="10" className="hwbx" />
    <text x="14" y={y + 25} className="hws ins">{instruction}</text>
    <text x="14" y={y + 46} className="hws">{detail}</text>
  </>
);

function Sorting() {
  return (
    <Drawing w={400} h={236}
      label="Two requests with the same instructions and different details go to one workload, order questions. A request with different instructions goes to another workload, ticket summaries.">
      {(p) => (
        <>
          {card(6, 'Reply in one short sentence.', 'Where is order 2061?')}
          {card(84, 'Reply in one short sentence.', 'Has order 2062 shipped?')}
          {card(162, 'Summarize this ticket.', 'My printer won’t connect.')}
          {p.box(284, 22, 114, 104, [['WORKLOAD', 'hwe b'], ['Order'], ['questions'], ['2 requests', 'hws']], 'b')}
          {p.box(284, 146, 114, 84, [['WORKLOAD', 'hwe'], ['Ticket'], ['summaries'], ['1 request', 'hws']])}
          {p.line(234, 37, 281, 60)}{p.line(234, 115, 281, 92)}{p.line(234, 193, 281, 190)}
        </>
      )}
    </Drawing>
  );
}

/* How often each model's answers differed from your model's, per 100 requests, against the quality bar: what your
   model differs from itself, plus a quarter (src/eval/compare.js floorFrom). The one that passes is well under the
   bar, so the example never shows a model passing on the line. */
const TRIED = [
  ['Your model, asked twice', 4, 'b', 'sets the bar'],
  ['Gemini 2.5 Flash Lite', 1, 'o', 'passes'],
  ['Claude Haiku 4.5', 6, 'x', 'just misses'],
  ['Mistral Small 3.2', 12, 'x', 'fails'],
];
const MARK = 5;
// the tracks run from 0 to 15 in 100, 11 units to each, from x 156
const PER = 11;
const X0 = 156;

function QualityBar() {
  return (
    <Drawing w={400} h={212}
      label="Your model gives a slightly different answer 4 times in 100 when asked the same thing twice, so the quality bar is 5 in 100. Gemini 2.5 Flash Lite differs once in 100 and passes. Claude Haiku 4.5 differs 6 times in 100 and just misses. Mistral Small 3.2 differs 12 times in 100 and fails.">
      {(p) => (
        <>
          {TRIED.map(([name, n, tone, verdict], i) => {
            const y = 26 + i * 46;
            return (
              <g key={name}>
                {p.text(0, y, name, 'hws ink')}
                {p.label(0, y + 17, verdict, 'start', tone)}
                <rect x={X0} y={y - 11} width={15 * PER} height="14" rx="4" className="hwtrack" />
                <rect x={X0} y={y - 11} width={n * PER} height="14" rx="4" className={`hwbar ${tone}`} />
                {p.label(X0 + 15 * PER + 8, y, `${n} in 100`, 'start')}
              </g>
            );
          })}
          <line x1={X0 + MARK * PER} y1="6" x2={X0 + MARK * PER} y2="180" className="hwpmk" />
          {p.label(X0 + MARK * PER, 202, `quality bar: ${MARK} in 100`, 'middle', 'b')}
        </>
      )}
    </Drawing>
  );
}

/* The switch, stage by stage: how much of the traffic the new model answers, and for how long at least
   (ROLLOUT_STAGES in src/config.js). */
function Rollout() {
  return (
    <Drawing w={400} h={226}
      label="The new model answers 5 in 100 requests for at least 2 hours, then 25 in 100 for at least 12 hours, then all requests. If answers get worse at any step, requests go back.">
      {(p) => (
        <>
          <line x1="30" y1="160" x2="392" y2="160" className="hwbase" />
          <line x1="150" y1="160" x2="150" y2="167" className="hwbase" />
          <line x1="270" y1="160" x2="270" y2="167" className="hwbase" />
          <path d="M40 153 H150 V127 H270 V28 H392 V160 H40 Z" className="hwarea" />
          <path d="M40 153 H150 V127 H270 V28 H392" className="hwstepline" />
          {p.label(95, 143, '5 in 100', 'middle', 'b')}
          {p.label(210, 117, '25 in 100', 'middle', 'b')}
          {p.label(331, 20, 'all requests', 'middle', 'b')}
          {p.label(95, 183, 'at least')}{p.label(95, 198, '2 hours')}
          {p.label(210, 183, 'at least')}{p.label(210, 198, '12 hours')}
          {p.label(331, 183, 'from then on')}
          {p.label(200, 222, 'worse at any step? requests go back', 'middle', 'x')}
        </>
      )}
    </Drawing>
  );
}

/* After a switch: about 20 of the new model's answers a day are also sent to your model and compared
   (src/learn/control.js), and here the difference stays well under the bar. The line is an example. */
const DAYS = [1.5, 2.2, 1.2, 1.8, 1.4, 1.1, 1.6, 1.3, 1.0, 1.5, 1.2, 1.4, 1.1, 1.3, 1.0, 1.2, 1.4, 1.1, 1.2, 1.0,
  1.3, 1.1, 1.2, 1.0, 1.1, 1.2, 1.0, 1.1];

export function DailyChecks() {
  const Y = (r) => 150 - r * 20;
  const X = (d) => 44 + d * 12.2;
  const line = DAYS.map((r, i) => `${X(i).toFixed(1)} ${Y(r).toFixed(1)}`).join(' L');
  return (
    <Drawing w={400} h={214}
      label="After a switch, about 20 answers a day are also sent to your model and compared. Over four weeks the new model differs from your model about once in 100, under the quality bar of 5 in 100. If it got clearly worse, requests would go back to your model.">
      {(p) => (
        <>
          <line x1="40" y1="150" x2="380" y2="150" className="hwbase" />
          <line x1="40" y1={Y(5)} x2="380" y2={Y(5)} className="hwpmk" />
          {p.label(380, Y(5) - 9, 'quality bar: 5 in 100', 'end', 'b')}
          <path d={`M${line}`} className="hwline" />
          {p.label(46, 84, 'differs about 1 in 100', 'start', 'o')}
          {p.label(40, 170, 'day 1', 'start')}
          {p.label(380, 170, 'day 28', 'end')}
          {p.label(210, 196, 'about 20 answers compared each day', 'middle')}
        </>
      )}
    </Drawing>
  );
}

/** One step: its number and title over the few sentences that say what it is, with its picture beside them. */
export function Step({ n, id, title, figure, top = false, children }) {
  return (
    <section className={`hwstep${top ? ' hwtop' : ''}`} id={id} aria-labelledby={`${id}-h`}>
      <div className="hwwords">
        <div className="hwhead">
          <span className="hwnum" aria-hidden="true">{n}</span>
          <h2 id={`${id}-h`}><span className="hwsr">Step {n}: </span>{title}</h2>
        </div>
        {children}
      </div>
      {figure}
    </section>
  );
}

/** A picture on its panel, with an optional line under it. */
export function Figure({ caption, children }) {
  return (
    <figure>
      <div className="hwfig">{children}</div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** The way on from a guide, at its foot: signing up, or back into the app, and the other guide. */
export function End({ me, go, title, line, other }) {
  return (
    <section className="hwend" aria-labelledby="hwend-h">
      <h2 id="hwend-h">{title}</h2>
      <p>{line}</p>
      {/* until the account check answers, neither way in is offered, as in the header */}
      {me && (
        <div className="lp-cta">
          {me.signedIn ? (
            <To to={me.onboarded ? 'dash' : 'connect'} go={go} className="btn big">
              {me.onboarded ? 'Open the dashboard' : 'Finish connecting'}
            </To>
          ) : (
            <To to="signup" go={go} className="btn big">Get an API key</To>
          )}
          <To to={other[0]} go={go} className="btn sec big">{other[1]}</To>
        </div>
      )}
    </section>
  );
}

export default function HowItWorks({ me, go, inApp = false }) {
  // inside the app, whose frame already holds the page's <main>, a plain container (see App.jsx)
  const Root = inApp ? 'div' : 'main';
  // arriving from a link to one step (/how-it-works#testing) lands on that step
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (STEPS.includes(id)) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, []);

  return (
    <Root className="hw hwhow" id={inApp ? undefined : 'main'}>
      <header className="hwopen">
        <div>
          <div className="eyeb doceyeb">How it works</div>
          <h1>How Understudy works</h1>
          <p className="hwlede">
            Understudy sits between your app and the AI models it uses. It tests other models on your own requests,
            and moves a job to a better one only when your answers stay as good.
          </p>
        </div>
        <aside className="hwexample" aria-label="Why the name">
          <span className="hwkick">Why the name?</span>
          <p>In a theater, an understudy learns the lead actor’s part, so they can step in when needed.</p>
        </aside>
      </header>

      <section className="hwstart" id="connect" aria-labelledby="connect-h">
        <div>
          <span className="hwkick">You do this once</span>
          <h2 id="connect-h">Change two lines of code</h2>
          <p>
            Give your app Understudy’s address and your Understudy key. Your app keeps asking for the same model, and
            every request goes to it until a better one is proven.
          </p>
        </div>
        <CodeBox />
      </section>

      <div className="hwthen"><span className="hwkick">Then Understudy does four things</span></div>

      <div className="hwsteps">
        <Step n={1} id="workloads" title="Understand your workloads" figure={<Figure><Sorting /></Figure>}>
          <p>
            Understudy groups your requests by the job they do, like answering order questions or summarizing support
            tickets. Each job is called a <b className="hwterm">workload</b>.
          </p>
          <p className="hwsoft">
            Each workload gets its own best model, because a model that is good at one job can be poor at another.
          </p>
        </Step>

        <Step n={2} id="testing" title="Find better model options"
          figure={<Figure caption="An example with four models."><QualityBar /></Figure>}>
          <p>Other models answer a sample of your real requests, and each answer is compared with your model’s answer.</p>
          <p>
            Your model sets the <b className="hwterm">quality bar</b>. Ask it the same thing twice and its answers differ
            a little. Another model passes only if it differs from your model no more than that, plus a small margin.
          </p>
          {/* open-ended writing, and answers too varied to match, are judged "at least as good" (judgeMode in src/eval/run.js) */}
          <p className="hwsoft">
            For open-ended writing like poems, or answers that vary a lot, a different answer is fine if it is at least
            as good. A model has to pass twice, on different requests.
          </p>
        </Step>

        <Step n={3} id="switching" title="Shift traffic gradually" figure={<Figure><Rollout /></Figure>}>
          <p>
            A model that passes starts with 5 in every 100 requests, then 25, then all of them. If answers get worse at
            any step, requests go back.
          </p>
          <p className="hwsoft">
            You choose what happens when a model passes: switch automatically (the default), ask you first, or never
            switch.
          </p>
        </Step>

        <Step n={4} id="learning" title="Learn from real outcomes" figure={<Figure><DailyChecks /></Figure>}>
          <p>
            After a switch, Understudy keeps checking. Every day it compares some answers with your model’s, and it
            notices when an answer didn’t work, like a request sent again or a tool that failed.
          </p>
          <p className="hwsoft">
            If quality slips, requests go back to your model. By default, it tests again after 30 days, looking for newer,
            cheaper models.
          </p>
        </Step>
      </div>

      <End me={me} go={go} title="Try it on your own requests"
        line="Nothing changes until a better model is proven on your requests." other={['routing', 'How models are routed']} />
    </Root>
  );
}
