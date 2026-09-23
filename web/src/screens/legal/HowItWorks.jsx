import React, { useEffect, useId } from 'react';
import { To } from './Public.jsx';
import '../../how.css';

/* How Understudy works, for somebody meeting it for the first time: the trip every request makes,
 * and the four things Understudy does behind the scenes, each told in a few sentences and one
 * picture. One example runs through the whole page (an app that answers "where is my order?" with
 * gpt-5.4), so every picture is about the same app.
 *
 * The pictures are drawn here rather than kept as images, so they take the page's colours in either
 * theme, and the numbered boxes on the map are links to the steps they stand for. */

// the four steps, as places on the page the map, and a shared link, can go straight to
const STEPS = ['connect', 'workloads', 'testing', 'switching'];

/* Each drawing carries its own arrowheads, one for each colour an arrow can be, under ids that no
   other drawing on the page shares. */
const HEADS = { a: '', b: 'b', o: 'o', w: 'w', x: 'x' };

/* What the drawings are made with: boxes with centred lines of text, arrows, labels that stand out
   from the lines they sit on, and the numbered chips that match the steps. A tone is a letter:
   b the brand colour, o passing, w a copy on the side, x failing, d dashed. */
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
    line: (x1, y1, x2, y2, k = 'a') => (
      <line x1={x1} y1={y1} x2={x2} y2={y2} className={arrow(k)} markerEnd={`url(#${id}${k})`} />
    ),
    path: (d, k = 'a', dash = false) => <path d={d} className={arrow(k, dash)} markerEnd={`url(#${id}${k})`} />,
    label: (x, y, t, anchor = 'middle', tone = '') => (
      <text x={x} y={y} textAnchor={anchor} className={`hwl ${tone}`}>{t}</text>
    ),
    chip: (cx, cy, n) => (
      <>
        <circle cx={cx} cy={cy} r="11" className="hwchip" />
        <text x={cx} y={cy + 4} textAnchor="middle" className="hwchipt">{n}</text>
      </>
    ),
  };
}

/** One drawing. A drawing with links in it is a group of them; any other is a single picture. */
function Drawing({ w, h, label, links = false, children }) {
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

/* The map: the trip every request makes, along the top, and the work behind the scenes under it.
   Two straight connectors join them: requests go down to be sorted, and a switch goes up to change
   what answers. */
function HeroMap() {
  return (
    <Drawing w={1000} h={400} links
      label="Every request goes from your app through Understudy to one AI model and back. Behind the scenes, Understudy sorts requests into workloads, tests smarter, cheaper setups, switches when one passes, and keeps optimizing.">
      {(p) => (
        <>
          <a href="#connect" aria-label="Step 1: you connect your app">
            {p.box(20, 40, 180, 80, [['Your app'], ['asks for gpt-5.4', 'hws']])}
            {p.chip(200, 40, 1)}
          </a>
          <rect x="300" y="18" width="400" height="124" rx="16" className="hwbx b" />
          <text x="320" y="44" className="hwt">Understudy</text>
          {p.box(320, 56, 360, 70, [['sends each request to the setup', 'hws'], ['that answers this workload now']])}
          {p.box(800, 40, 180, 80, [['AI companies'], ['run the models', 'hws']])}
          {p.line(200, 68, 297, 68)}{p.label(250, 60, 'request')}
          {p.line(300, 98, 203, 98)}{p.label(250, 116, 'answer')}
          {p.line(700, 68, 797, 68)}{p.label(750, 60, 'request')}
          {p.line(800, 98, 703, 98)}{p.label(750, 116, 'answer')}
          <a href="#workloads" aria-label="Step 2: it sorts your requests into workloads">
            {p.box(150, 250, 190, 60, [['Sort into workloads']])}
            {p.chip(150, 250, 2)}
          </a>
          <a href="#testing" aria-label="Step 3: it tests smarter, cheaper setups">
            {p.box(400, 250, 190, 60, [['Test smarter,'], ['cheaper setups']])}
            {p.chip(400, 250, 3)}
          </a>
          <a href="#switching" aria-label="Step 4: it switches, and continues to optimize">
            {p.box(650, 250, 190, 60, [['Switch, then keep'], ['optimizing']], 'b')}
            {p.chip(650, 250, 4)}
          </a>
          {p.line(340, 280, 397, 280)}
          {p.line(590, 280, 647, 280, 'o')}{p.label(618, 271, 'passes', 'middle', 'o')}
          {p.line(330, 128, 330, 247)}{p.label(320, 196, 'each request is sorted', 'end')}
          {p.line(665, 248, 665, 129, 'b')}{p.label(677, 196, 'changes what answers', 'start', 'b')}
          {p.path('M745 310 V360 H495 V313', 'a', true)}
          {p.label(620, 382, 'keeps watching, trying runners-up and re-testing')}
        </>
      )}
    </Drawing>
  );
}

/* The same map for a narrow screen, as boxes and a list, so its words keep their size. */
function PhoneMap() {
  return (
    <div className="hwmapphone">
      <a className="hwhp" href="#connect">
        <span className="hwhprow"><span className="hwnum">1</span>Your app</span>
        <small>asks for gpt-5.4</small>
      </a>
      <span className="hwhpar">requests go down, answers come back up</span>
      <div className="hwhp b">Understudy<small>sends each request to the setup that answers this workload now</small></div>
      <span className="hwhpar">requests go down, answers come back up</span>
      <div className="hwhp">AI companies<small>run the models</small></div>
      <p className="hwhpnote">Behind the scenes, all the time:</p>
      <ol className="hwloop">
        <li><a href="#workloads"><span className="hwnum">2</span>Sort requests into workloads</a></li>
        <li><a href="#testing"><span className="hwnum">3</span>Test smarter, cheaper setups</a></li>
        <li><a href="#switching"><span className="hwnum">4</span>Switch when one passes, then keep optimizing</a></li>
      </ol>
    </div>
  );
}

function ConnectThrough() {
  return (
    <Drawing w={400} h={130}
      label="Your app sends requests to Understudy, which sends them to an AI company. Answers come back the same way.">
      {(p) => (
        <>
          {p.box(2, 35, 90, 60, [['Your app']])}
          {p.box(155, 35, 90, 60, [['Understudy']], 'b')}
          {p.box(308, 35, 90, 60, [['AI company']])}
          {p.line(92, 55, 152, 55)}{p.label(123, 47, 'request')}
          {p.line(155, 77, 95, 77)}{p.label(123, 93, 'answer')}
          {p.line(245, 55, 305, 55)}{p.label(276, 47, 'request')}
          {p.line(308, 77, 248, 77)}{p.label(276, 93, 'answer')}
        </>
      )}
    </Drawing>
  );
}

function ConnectCopies() {
  return (
    <Drawing w={400} h={185}
      label="Your app sends requests straight to your own AI company and gets answers back. Afterwards it sends Understudy a copy.">
      {(p) => (
        <>
          {p.box(2, 16, 90, 60, [['Your app']])}
          {p.box(308, 16, 90, 60, [['Your AI'], ['company']])}
          {p.line(92, 36, 305, 36)}{p.label(200, 29, 'request')}
          {p.line(308, 58, 95, 58)}{p.label(200, 72, 'answer')}
          {p.box(155, 118, 90, 56, [['Understudy']], 'b d')}
          {p.path('M47 76 V146 H152', 'w')}
          {p.label(100, 164, 'a copy, later', 'middle', 'w')}
        </>
      )}
    </Drawing>
  );
}

/* One request, the way the picture of sorting shows it: the instruction that stays the same, and
   the detail that changes. */
const card = (y, instruction, detail) => (
  <>
    <rect x="2" y={y} width="236" height="62" rx="10" className="hwbx" />
    <text x="14" y={y + 25} className="hws ins">{instruction}</text>
    <text x="14" y={y + 46} className="hws">{detail}</text>
  </>
);

function Sorting() {
  return (
    <Drawing w={400} h={236}
      label="Two requests with the same instruction and different details go to one workload. A request with a different instruction goes to another.">
      {(p) => (
        <>
          {card(6, 'Reply in one short sentence.', 'Where is order 2061?')}
          {card(84, 'Reply in one short sentence.', 'Has order 2062 shipped?')}
          {card(162, 'Summarize this ticket.', 'My printer won’t connect.')}
          {p.box(286, 22, 112, 104, [['WORKLOAD', 'hwe'], ['order-status'], ['replies'], ['2 requests', 'hws']], 'b')}
          {p.box(286, 146, 112, 84, [['WORKLOAD', 'hwe'], ['ticket'], ['summaries'], ['1 request', 'hws']])}
          {p.line(238, 37, 283, 60)}{p.line(238, 115, 283, 92)}{p.line(238, 193, 283, 190)}
        </>
      )}
    </Drawing>
  );
}

/* How often each setup's answers disagreed with gpt-5.4's, per 100 requests, against the pass mark:
   what gpt-5.4 disagrees with itself, plus a quarter (src/eval/compare.js floorFrom). A setup passes
   only when a sample makes Understudy sure it is under the mark, so the one that passes here is well
   under it, and the example never shows a setup passing on the line. */
const TRIED = [
  ['gpt-5.4, against itself', 4, 'b', 'sets the pass mark'],
  ['gemini-2.5-flash-lite', 1, 'o', 'passes'],
  ['claude-haiku-4.5', 6, 'x', 'just over the mark'],
  ['mistral-small-3.2', 12, 'x', 'doesn’t pass'],
];
const MARK = 5;
// the tracks run from 0 to 15 in 100, 12 units to each
const PER = 12;

function PassMark() {
  return (
    <Drawing w={400} h={206}
      label="gpt-5.4 disagrees with itself 4 times in 100, which with a small allowance sets the pass mark at 5 in 100. gemini-2.5-flash-lite disagrees once in 100 and passes. claude-haiku-4.5 disagrees 6 times and mistral-small-3.2 12 times, so neither passes.">
      {(p) => (
        <>
          {TRIED.map(([name, n, tone, verdict], i) => {
            const y = 24 + i * 46;
            return (
              <g key={name}>
                <text x="0" y={y} className="hws">{name}</text>
                {p.label(0, y + 17, verdict, 'start', tone)}
                <rect x="150" y={y - 11} width={15 * PER} height="14" rx="4" className="hwtrack" />
                <rect x="150" y={y - 11} width={n * PER} height="14" rx="4" className={`hwbar ${tone}`} />
                {p.label(338, y, `${n} in 100`, 'start')}
              </g>
            );
          })}
          <line x1={150 + MARK * PER} y1="4" x2={150 + MARK * PER} y2="176" className="hwpmk" />
          {p.label(150 + MARK * PER, 196, `pass mark: ${MARK} in 100`, 'middle', 'b')}
        </>
      )}
    </Drawing>
  );
}

/* The switch, stage by stage: how much of the traffic the new setup answers, and for how long at
   least. How long each stage lasts is set two lines high, under a tick where the stage ends, so the
   three never read as one run of words. */
function Rollout() {
  return (
    <Drawing w={400} h={206}
      label="The new setup answers 5 in 100 requests for at least 2 hours, then 25 in 100 for at least 12 hours, then all requests.">
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
          {p.label(95, 183, '2 hours')}{p.label(95, 198, 'or more')}
          {p.label(210, 183, '12 hours')}{p.label(210, 198, 'or more')}
          {p.label(331, 183, 'from then on')}
        </>
      )}
    </Drawing>
  );
}

/** One step: its number, its title and the one line that says what it is, then the rest of it. */
function Step({ n, id, title, intro, children }) {
  return (
    <section className="hwstep" id={id} aria-labelledby={`${id}-h`}>
      <div className="hwstephead">
        <span className="hwnum" aria-hidden="true">{n}</span>
        <div className="hwcol">
          <h2 id={`${id}-h`}><span className="hwsr">Step {n}: </span>{title}</h2>
          <p className="hwintro">{intro}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export default function HowItWorks({ me, go }) {
  // arriving from a link to one step (/how-it-works#testing) lands on that step
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (STEPS.includes(id)) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, []);

  return (
    <main className="hw" id="main">
      <header className="hwopen">
        <div>
          <div className="eyeb doceyeb">How it works</div>
          <h1>How Understudy works</h1>
          <p className="hwlede">
            Understudy is a stand-in for the AI model your app uses. For each job your app gives that model,
            Understudy tests smarter, cheaper ways to do it, using your own real requests. It switches only when
            one answers as well as your model does, and it keeps optimizing after that.
          </p>
        </div>
        <aside className="hwexample" aria-label="The example on this page">
          <span className="hwkick">The example on this page</span>
          <p>Your app uses <b>gpt-5.4</b> to answer customers who ask where their order is.</p>
          <div className="hwnums"><span className="m">1,400 requests a day</span><span className="m">about $310 a month</span></div>
          <p>Why the name? In a theater, an understudy learns the lead actor&rsquo;s part, ready to step in.</p>
        </aside>
      </header>

      <figure>
        <div className="hwfig">
          <div className="hwmapwide"><HeroMap /></div>
          <PhoneMap />
        </div>
        <figcaption>
          <b>Two things happen at the same time.</b> Every request makes the same trip, from your app through
          Understudy to one AI model and back. Behind the scenes, Understudy sorts your requests into workloads,
          tests smarter, cheaper setups, switches when one passes, and keeps optimizing. Only a switch changes
          which setup answers your requests. Click or tap a numbered box to go to that step.
        </figcaption>
      </figure>

      <Step n={1} id="connect" title="You connect your app"
        intro="There are two ways to connect. The difference is whether your requests pass through Understudy.">
        <div className="hwtwo">
          <figure>
            <div className="hwfig"><h3>Through Understudy</h3><ConnectThrough /></div>
            <figcaption>
              You change two lines in your code: the address your requests go to, and the key. Your app still asks
              for gpt-5.4 and gets answers in the same format. From then on, Understudy can choose which setup
              answers.
            </figcaption>
          </figure>
          <figure>
            <div className="hwfig"><h3>Copies only</h3><ConnectCopies /></div>
            <figcaption>
              Your app keeps sending requests to your own AI company and sends Understudy a copy afterwards.
              Understudy tests on the copies and shows you what you&rsquo;d save, but nothing changes for your
              app until its requests go through Understudy.
            </figcaption>
          </figure>
        </div>
      </Step>

      <Step n={2} id="workloads" title="It sorts your requests into workloads"
        intro="A workload is one kind of job your app does, such as answering order-status questions or summarizing support tickets.">
        <div className="hwtwo hwwords">
          <div className="hwcol">
            <p>
              Understudy recognizes a job by the parts of a request that stay the same every time: the
              instructions, the model it asks for, the tools the model may use, and the format of the answer. It
              ignores the parts that change, like a customer&rsquo;s name or an order number. This sorting uses
              simple rules, not AI.
            </p>
            <p>
              Each workload is tested and switched on its own, because a model that does one job well can do
              another badly.
            </p>
          </div>
          <figure>
            <div className="hwfig"><Sorting /></div>
            <figcaption>
              The same instructions with different details are the same job. Different instructions are a
              different job.
            </figcaption>
          </figure>
        </div>
      </Step>

      <Step n={3} id="testing" title="It tests smarter, cheaper setups on your own requests"
        intro="Once a workload has enough requests to test fairly, and a test would soon pay for itself, Understudy tests it on its own. You can also start a test yourself.">
        <div className="hwtwo hwwords">
          <div className="hwcol">
            <p>
              First, gpt-5.4 answers a sample of your real requests a second time. The same model doesn&rsquo;t
              always answer the same way, so Understudy counts how often its two answers disagree. For written
              answers, another AI model does the judging. That rate, plus a small allowance, is the pass mark.
            </p>
            <p>
              Then the most promising setups answer the same requests, including smarter ones such as your own
              model asked to think less, or a cheap model whose answers are checked, with doubtful ones sent to
              your own model. A setup passes only if Understudy is confident it disagrees with gpt-5.4 no more
              often than the pass mark. Setups that can&rsquo;t pass are stopped early to save money, and the
              winner is tested again on new requests before it counts.
            </p>
          </div>
          <figure>
            <div className="hwfig"><PassMark /></div>
            <figcaption>
              How often each setup&rsquo;s answers disagreed with gpt-5.4&rsquo;s, per 100 requests. The dashed
              line is the pass mark. The models and numbers are an example.
            </figcaption>
          </figure>
        </div>
      </Step>

      <Step n={4} id="switching" title="It switches, and continues to optimize"
        intro="For each workload, you choose whether it switches on its own, asks you first, or never switches. It asks you first unless you choose otherwise.">
        <div className="hwtwo hwwords">
          <div className="hwcol">
            <p>
              A switch starts small. The new setup answers 5 in every 100 requests, then 25, then all of them. If
              its answers get clearly worse at any step, the workload goes back to what it used before.
            </p>
            <p>
              After that, Understudy keeps optimizing. It watches every answer and keeps trying the runners-up on
              a few requests. It also re-tests the workload every 30 days. Each time a re-test finds nothing
              better, the wait before the next one doubles, and a cheaper new model or a price change brings it
              back to 30 days.
            </p>
          </div>
          <figure>
            <div className="hwfig"><Rollout /></div>
            <figcaption>
              The share of requests the new setup answers over time. Each step also waits until enough requests
              have been answered to judge it.
            </figcaption>
          </figure>
        </div>
      </Step>

      <section className="hwend" aria-labelledby="hwend-h">
        <h2 id="hwend-h">Try it on your own requests</h2>
        <p>
          Every request keeps going to the model your app asks for until a smarter, cheaper setup passes on your
          own requests.
        </p>
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
            <To to="pricing" go={go} className="btn sec big">See pricing</To>
          </div>
        )}
      </section>
    </main>
  );
}
