import React, { useEffect } from 'react';
import { To } from './Public.jsx';
import { Drawing, Step } from './HowItWorks.jsx';
import '../../how.css';

/* How models are routed, for somebody who wants to know what a switch rests on: which of the setups that
 * could answer a workload is chosen, and how Understudy makes sure before it switches and after. The same
 * example runs through it as through How it works (an app that answers "where is my order?" with gpt-5.4),
 * and the drawings use the same pen, so the two pages read as one.
 *
 * Every number under "What our simulations show" comes from the simulations in src/eval/harness.js
 * (choiceSim and routerSim, printed by scripts/harness.mjs); test/harness.test.js keeps the ones that must
 * stay true, so a rule that changes them changes this page too. */

// the model the example app uses, kept on one line in the page's words: a line break after its hyphen read as two words
const M = () => <span className="hwnw">gpt-5.4</span>;

// the five steps, as places on the page the map can go straight to, and the parts after them
const STEPS = ['garden', 'testing', 'priority', 'second-look', 'after', 'kinds', 'jev', 'numbers'];

/* The map: the five things every workload goes through, left to right, with the two ways back: a setup
   that fails its second look hands over to the next in line, and one that slips after the switch goes back
   to the customer's own model. */
function RoutingMap() {
  const X = [5, 215, 425, 635, 845];
  const W = 150;
  return (
    <Drawing w={1000} h={316} links
      label="Five steps. Many setups compete. Each is tested on your own requests. The ones that pass are ranked by the saving Understudy is sure of. The first in line is tested again on requests it has never seen. Then it is switched to, and still checked every day. A setup that fails its second look hands over to the next in line, and one that gets worse after the switch goes back to your own model.">
      {(p) => (
        <>
          <a href="#garden" aria-label="Step 1: many setups compete">
            {p.box(X[0], 60, W, 100, [['Many setups'], ['compete'], ['for each workload', 'hws']])}
            {p.chip(X[0], 60, 1)}
          </a>
          <a href="#testing" aria-label="Step 2: each is tested on your own requests">
            {p.box(X[1], 60, W, 100, [['Each is tested'], ['on your requests'], ['Jev judges answers', 'hws']])}
            {p.chip(X[1], 60, 2)}
          </a>
          <a href="#priority" aria-label="Step 3: the ones that pass are ranked by the saving we are sure of">
            {p.box(X[2], 60, W, 100, [['Ranked by the'], ['saving we are'], ['sure of'], ['your priority decides', 'hws']])}
            {p.chip(X[2], 60, 3)}
          </a>
          <a href="#second-look" aria-label="Step 4: the first in line is tested again on new requests">
            {p.box(X[3], 60, W, 100, [['Tested again'], ['on requests it'], ['has never seen'], ['so luck can’t win', 'hws']])}
            {p.chip(X[3], 60, 4)}
          </a>
          <a href="#after" aria-label="Step 5: switched, and still checked every day">
            {p.box(X[4], 60, W, 100, [['Switched,'], ['and still'], ['checked'], ['every day', 'hws']], 'b')}
            {p.chip(X[4], 60, 5)}
          </a>
          {p.line(155, 110, 212, 110)}
          {p.line(365, 110, 422, 110, 'o')}{p.label(393, 100, 'pass', 'middle', 'o')}
          {p.line(575, 110, 632, 110)}{p.label(603, 100, 'first', 'middle')}
          {p.line(785, 110, 842, 110, 'o')}{p.label(813, 100, 'pass', 'middle', 'o')}
          {p.path('M710 160 V214 H500 V163', 'x', true)}
          {p.label(605, 232, 'fails: the next in line gets a look', 'middle', 'x')}
          {p.box(620, 250, 150, 44, [['gpt-5.4, yours']])}
          {p.path('M920 160 V272 H773', 'x', true)}
          {p.label(846, 262, 'clearly worse', 'middle', 'x')}
        </>
      )}
    </Drawing>
  );
}

/* The same map for a narrow screen, as a list, so its words keep their size. */
function PhoneMap() {
  const rows = [
    ['garden', 1, 'Many setups compete for each workload'],
    ['testing', 2, 'Each is tested on your own requests'],
    ['priority', 3, 'The ones that pass are ranked by the saving we are sure of'],
    ['second-look', 4, 'The first in line is tested again on requests it has never seen'],
    ['after', 5, 'It is switched to, and still checked every day'],
  ];
  return (
    <div className="hwmapphone">
      <ol className="hwloop">
        {rows.map(([id, n, words]) => (
          <li key={id}><a href={`#${id}`}><span className="hwnum">{n}</span>{words}</a></li>
        ))}
      </ol>
      <p className="hwhpnote">A setup that fails its second look hands over to the next in line. One that gets clearly worse after the switch goes back to your own model.</p>
    </div>
  );
}

/* Step 1: the kinds of setup there are, all tested on the same requests. */
const SETUPS = [
  ['A cheaper model on its own', ''],
  ['gpt-5.4, thinking less', ''],
  ['gpt-5.4, from its cheapest company', ''],
  ['A cheaper model, checked by Jev', 'b'],
  ['Sorted by kind of request', 'b'],
];

function Garden() {
  return (
    <Drawing w={400} h={250}
      label="Five kinds of setup: a cheaper model on its own; gpt-5.4 thinking less; gpt-5.4 from its cheapest company; a cheaper model checked by Jev; and requests sorted by kind. All are tested on the same requests.">
      {(p) => (
        <>
          {SETUPS.map(([name, tone], i) => (
            <g key={name}>
              {p.box(2, 8 + i * 48, 236, 38, [[name, 'hws']], tone)}
              {p.line(238, 27 + i * 48, 287, 125 + (i - 2) * 14)}
            </g>
          ))}
          {p.box(290, 78, 108, 96, [['TESTED ON', 'hwe'], ['the same'], ['requests']], 'b')}
        </>
      )}
    </Drawing>
  );
}

/* Step 2: Jev reads the two answers twice, in both orders, and a difference is let through only when both
   readings agree it is wording. */
function Judging() {
  return (
    <Drawing w={400} h={236}
      label="gpt-5.4 answers: it shipped today. The setup answers: it shipped today, and gives a tracking link. Jev reads the two answers twice, in both orders. Both readings say the setup's answer is at least as good, so it counts as a match. A different fact or figure would always count as worse.">
      {(p) => (
        <>
          {p.box(2, 8, 170, 62, [['gpt-5.4’s answer'], ['“It shipped today.”', 'hws']])}
          {p.box(2, 88, 170, 62, [['The setup’s answer'], ['“It shipped today.', 'hws'], ['Track it here.”', 'hws']])}
          {p.box(214, 30, 88, 96, [['Jev'], ['reads both,', 'hws'], ['in both', 'hws'], ['orders', 'hws']], 'b')}
          {p.line(172, 39, 211, 62)}{p.line(172, 119, 211, 96)}
          {p.line(302, 50, 336, 30, 'x')}{p.label(340, 34, 'worse', 'start', 'x')}
          {p.line(302, 78, 336, 78, 'o')}{p.label(340, 82, 'as good', 'start', 'o')}
          {p.line(302, 106, 336, 126, 'o')}{p.label(340, 130, 'better', 'start', 'o')}
          {p.box(2, 170, 396, 58, [['Let through only when both readings say it is wording.', 'hws'],
            ['A different fact or figure always counts as worse.', 'hws']])}
        </>
      )}
    </Drawing>
  );
}

/* Step 3: three setups that passed, what each saves and the saving we are sure of, and which each priority
   picks. The scale is 2.2 units to a percent from x 120. */
const PASSED = [
  { name: 'Setup A', saves: 81, sure: 99.9, speed: '2.4 s' },
  { name: 'Setup B', saves: 80.5, sure: 99.9, speed: '0.9 s' },
  { name: 'Setup C', saves: 84, sure: 93, speed: '1.2 s' },
];
const S = 2.2;

function Priority() {
  return (
    <Drawing w={400} h={262}
      label="Three setups passed. Setup A saves 81% and takes 2.4 seconds. Setup B saves 80.5% and takes 0.9 seconds. Both are almost certain. Setup C saves 84% but only just passed, so the saving we are sure of is 78%. Most savings picks C. Balanced picks B, which saves about the same as A and is faster. Cautious also picks B, and leaves C out.">
      {(p) => (
        <>
          {p.label(120, 12, 'saves', 'start')}
          {p.label(396, 12, 'speed', 'end')}
          {PASSED.map((s, i) => {
            const y = 40 + i * 52;
            const safe = (s.saves * s.sure) / 100;
            return (
              <g key={s.name}>
                <text x="0" y={y + 4} className="hws">{s.name}</text>
                <rect x="120" y={y - 9} width={s.saves * S} height="16" rx="4" className="hwtrack" />
                <rect x="120" y={y - 9} width={safe * S} height="16" rx="4" className={`hwbar ${s.sure < 99 ? 'x' : 'b'}`} />
                {p.label(120 + s.saves * S + 6, y + 4, `${s.saves}%`, 'start')}
                {p.label(396, y + 4, s.speed, 'end')}
                {p.label(120, y + 25, s.sure < 99 ? `only just passed: ${Math.round(safe)}% we are sure of` : `almost certain: ${Math.round(safe * 10) / 10}% we are sure of`, 'start', s.sure < 99 ? 'x' : '')}
              </g>
            );
          })}
          {p.box(2, 196, 128, 58, [['MOST SAVINGS', 'hwe'], ['picks C']])}
          {p.box(136, 196, 128, 58, [['BALANCED', 'hwe'], ['picks B']], 'b')}
          {p.box(270, 196, 128, 58, [['CAUTIOUS', 'hwe'], ['picks B']])}
        </>
      )}
    </Drawing>
  );
}

/* Step 4: six setups tested once and three pass. The first in line only passed by luck, and the second
   look on new requests catches it; the next in line passes it and is switched to; the third never needs one. */
function SecondLook() {
  const dot = (cx, cy, tone) => <circle cx={cx} cy={cy} r="9" className={`hwdot ${tone}`} />;
  const tested = [40, 66, 92, 118, 144, 170];
  // the ones that pass the first look, and where each goes next
  const passed = [[1, 64, 'w'], [3, 110, 'o'], [4, 156, 'o']];
  return (
    <Drawing w={400} h={236}
      label="Six setups are tested and three pass the first look. The first in line only passed by luck: tested again on requests it has never seen, it fails. The next in line passes its second look and is switched to. The third never needs one.">
      {(p) => (
        <>
          {p.label(40, 18, 'tested')}
          {p.label(170, 18, 'passed once')}
          {p.label(318, 18, 'second look')}
          {tested.map((y, i) => <g key={y}>{dot(40, y, passed.some(([j]) => j === i) ? 'o' : 'x')}</g>)}
          {passed.map(([i, y]) => <g key={i}>{p.line(52, tested[i], 157, y)}</g>)}
          {passed.map(([i, y, tone]) => <g key={`d${i}`}>{dot(170, y, tone)}</g>)}
          {p.label(170, 88, 'first in line: lucky', 'middle', 'w')}
          {p.path('M182 64 H286', 'x', true)}
          <line x1="292" y1="56" x2="306" y2="72" className="hwxs" />
          <line x1="306" y1="56" x2="292" y2="72" className="hwxs" />
          {p.label(316, 68, 'fails', 'start', 'x')}
          {p.line(182, 110, 285, 110, 'o')}
          {dot(299, 110, 'o')}
          {p.label(316, 106, 'passes:', 'start', 'o')}
          {p.label(316, 121, 'switched to', 'start', 'o')}
          {p.label(186, 160, 'third: never needs a look', 'start')}
          {p.box(2, 194, 396, 36, [['The second look uses requests none of them has seen.', 'hws']])}
        </>
      )}
    </Drawing>
  );
}

/* Step 5: the range of how often what serves is worse, narrowing as background checks add up, against the
   pass mark. The rate axis runs 0 to 10 in 100, 15 units to each. */
function After() {
  const Y = (r) => 170 - r * 15;
  const X = (d) => 40 + (d - 1) * 12;
  const lo = [0, 0, 0, 0, 0.1, 0.2, 0.2, 0.3, 0.3, 0.3, 0.4, 0.4, 0.4, 0.5, 0.5, 0.5, 0.5, 0.5, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.7, 0.7];
  const hi = [9.5, 7.2, 5.9, 5.0, 4.4, 4.0, 3.6, 3.3, 3.1, 2.9, 2.8, 2.7, 2.6, 2.5, 2.4, 2.3, 2.3, 2.2, 2.2, 2.1, 2.1, 2.0, 2.0, 2.0, 1.9, 1.9, 1.9, 1.8];
  const band = `M${hi.map((h, i) => `${X(i + 1)} ${Y(h)}`).join(' L')} L${lo.map((l, i) => `${X(lo.length - i)} ${Y(lo[lo.length - 1 - i])}`).join(' L')} Z`;
  return (
    <Drawing w={400} h={214}
      label="Each day about 20 of the new setup's answers are also sent to gpt-5.4 and compared. The range for how often its answers are worse starts wide and narrows as checks add up. Here it settles around 1 in 100, inside the pass mark of 3 in 100. If the whole range were past the pass mark, the workload would go back to gpt-5.4.">
      {(p) => (
        <>
          <line x1="40" y1="170" x2="370" y2="170" className="hwbase" />
          <path d={band} className="hwband" />
          <line x1="40" y1={Y(3)} x2="370" y2={Y(3)} className="hwpmk" />
          {p.label(370, Y(3) - 8, 'pass mark: 3 in 100', 'end', 'b')}
          {p.label(150, 40, 'the range for how often', 'start')}
          {p.label(150, 55, 'its answers are worse', 'start')}
          {p.line(148, 60, 118, 100)}
          {p.label(40, 190, 'day 1', 'start')}
          {p.label(370, 190, '4 weeks', 'end')}
          {p.label(205, 207, 'about 20 answers checked each day', 'middle')}
        </>
      )}
    </Drawing>
  );
}

/* Sorting by kind: three requests, what kind each is, and where each kind goes. */
function Kinds() {
  return (
    <Drawing w={400} h={270}
      label="Three requests: where is order 2061; I was charged twice for one order; write me a poem. Each is matched to a kind before it is sent. Order questions go to a cheaper model that answers them as well as gpt-5.4. Refund complaints go to gpt-5.4, because the cheaper model gets them wrong. A request like none it learned from, such as the poem, goes to gpt-5.4.">
      {(p) => (
        <>
          {p.box(2, 4, 124, 56, [['“Where is', 'hws ins'], ['order 2061?”', 'hws ins']])}
          {p.box(138, 4, 124, 56, [['“Charged twice', 'hws ins'], ['for one order…”', 'hws ins']])}
          {p.box(274, 4, 124, 56, [['“Write me', 'hws ins'], ['a poem.”', 'hws ins']])}
          {p.line(64, 60, 160, 101)}{p.line(200, 60, 200, 101)}{p.line(336, 60, 240, 101)}
          {p.box(110, 104, 180, 44, [['What kind is it?']], 'b')}
          {p.line(160, 148, 64, 197, 'o')}{p.line(200, 148, 200, 197)}{p.line(240, 148, 336, 197)}
          {p.box(2, 200, 124, 62, [['ORDER QUESTIONS', 'hwe'], ['a cheaper'], ['model']], 'b')}
          {p.box(138, 200, 124, 62, [['REFUNDS', 'hwe'], ['gpt-5.4'], ['your own model', 'hws']])}
          {p.box(274, 200, 124, 62, [['NEW TO IT', 'hwe'], ['gpt-5.4'], ['your own model', 'hws']])}
        </>
      )}
    </Drawing>
  );
}

/* Jev's three jobs. */
function JevJobs() {
  return (
    <Drawing w={400} h={230}
      label="Jev does three jobs: it judges written answers in tests, it checks answers as they are served in the checked setup, and it reads the background checks after a switch.">
      {(p) => (
        <>
          {p.box(2, 70, 92, 90, [['Jev'], ['a fast AI', 'hws'], ['judge', 'hws']], 'b')}
          {p.line(94, 96, 140, 38)}{p.line(94, 115, 140, 115)}{p.line(94, 134, 140, 192)}
          {p.box(142, 6, 256, 64, [['Judges written answers'], ['worse, as good or better, both orders', 'hws']])}
          {p.box(142, 83, 256, 64, [['Checks answers as served'], ['doubtful ones go to your model', 'hws']])}
          {p.box(142, 160, 256, 64, [['Reads checks after a switch'], ['about 20 answers a day', 'hws']])}
        </>
      )}
    </Drawing>
  );
}

/* What the simulations showed, as bars: the share of made-up workloads each rule gave each outcome, the
   figure beside its name and the bar after it. The bars run from 0 to 100, 1.8 units to each. */
const SIM = [
  ['Near ties: picked the faster setup', 'more is better', [['cheapest first', 11, 'x'], ['Balanced', 86, 'o']]],
  ['Lucky passes: switched past the mark', 'fewer is better', [['tested once', 9.2, 'x'], ['with the second look', 0, 'o']]],
];

function SimBars() {
  return (
    <Drawing w={400} h={218}
      label="Near ties, where more is better: choosing the cheapest picked the faster of two setups that save about the same in 11 of 100 workloads; Balanced picked it in 86. Lucky passes, where fewer is better: testing once switched to a setup past the pass mark in 9 of 100 workloads; with the second look, none of 3,000.">
      {(p) => (
        <>
          {SIM.map(([title, better, rows], g) => (
            <g key={title}>
              <text x="0" y={16 + g * 104} className="hwt">{title}</text>
              {p.label(400, 16 + g * 104, better, 'end')}
              {rows.map(([name, v, tone], i) => {
                const y = 42 + g * 104 + i * 30;
                return (
                  <g key={name}>
                    <text x="0" y={y + 4} className="hws">{name}</text>
                    {p.label(212, y + 4, v === 0 ? 'none' : `${v < 10 ? v.toFixed(1).replace('.0', '') : v} in 100`, 'end', tone)}
                    <rect x="220" y={y - 8} width={100 * 1.8} height="14" rx="4" className="hwtrack" />
                    {v > 0 && <rect x="220" y={y - 8} width={Math.max(3, v * 1.8)} height="14" rx="4" className={`hwbar ${tone}`} />}
                  </g>
                );
              })}
            </g>
          ))}
        </>
      )}
    </Drawing>
  );
}

export default function HowRouting({ me, go }) {
  // arriving from a link to one part (/how-models-are-routed#second-look) lands on that part
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (STEPS.includes(id)) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, []);

  return (
    <main className="hw" id="main">
      <header className="hwopen">
        <div>
          <div className="eyeb doceyeb">Model routing</div>
          <h1>How models are routed</h1>
          <p className="hwlede">
            Understudy makes two promises about every switch, in this order. First, your answers stay as good as
            the ones your own model gives. Second, you save as much as that first promise allows. This page
            explains how Understudy chooses what answers your requests, and how it makes sure before it switches
            and after.
          </p>
        </div>
        <aside className="hwexample" aria-label="The example on this page">
          <span className="hwkick">The example on this page</span>
          <p>Your app uses <b>gpt-5.4</b> to answer customers who ask where their order is.</p>
          <div className="hwnums"><span className="m">1,400 requests a day</span><span className="m">about $310 a month</span></div>
          <p>A <b>setup</b> is one way of answering a request: a cheaper model, your own model asked to think less, or a few models working together.</p>
        </aside>
      </header>

      <figure>
        <div className="hwfig">
          <div className="hwmapwide"><RoutingMap /></div>
          <PhoneMap />
        </div>
        <figcaption>
          <b>Every workload goes through these five steps, and the last one never stops.</b> Nothing is switched
          until a setup has passed two tests on your own requests. Click or tap a numbered box to go to that step.
        </figcaption>
      </figure>

      <Step n={1} id="garden" title="Many setups compete for each workload"
        intro="Understudy doesn’t only try cheaper models. It also tries your own model used differently, and a few models working together.">
        <div className="hwtwo hwwords">
          <div className="hwcol">
            <p>
              For the order-status workload, the setups include cheaper models on their own; <M /> asked to think
              less before it answers, since thinking is billed; and <M /> bought from whichever company runs it
              most cheaply.
            </p>
            <p>
              Two setups are combinations. In the first, a cheaper model answers and Jev, a fast AI judge made by
              TypeSafe, checks each answer; when Jev is unsure, <M /> answers instead. In the second, requests are
              sorted by kind, and each kind goes to a setup that handles it as well as <M />. Sorting is explained{' '}
              <a href="#kinds">further down</a>.
            </p>
          </div>
          <figure>
            <div className="hwfig"><Garden /></div>
            <figcaption>Every setup is tested on the same requests, so they can be compared fairly.</figcaption>
          </figure>
        </div>
      </Step>

      <Step n={2} id="testing" title="Each one is tested on your own requests"
        intro="The test uses real requests your app has sent, so a setup is judged on your work, not on a benchmark.">
        <div className="hwtwo hwwords">
          <div className="hwcol">
            <p>
              <M /> answers a sample of your requests twice. The same model doesn’t always answer the same way, so
              how often its two answers differ sets the pass mark. A setup passes only if Understudy is confident its
              answers differ from <M />’s no more often than that. <To to="how" go={go} hash="testing">How it
              works</To> explains the pass mark in more detail.
            </p>
            <p>
              Written answers can’t be compared word for word, so Jev reads them. It is asked whether the setup’s
              answer is worse than <M />’s, just as good, or better. It is asked twice, with the two answers in
              swapped order, because any judge can favor whichever answer it reads first. A difference is only let
              through when both readings agree it is just wording. A different fact, figure or decision always
              counts against the setup.
            </p>
          </div>
          <figure>
            <div className="hwfig"><Judging /></div>
            <figcaption>
              Here the setup’s answer adds a helpful tracking link, so both readings say it is at least as good.
            </figcaption>
          </figure>
        </div>
      </Step>

      <Step n={3} id="priority" title="The ones that pass are ranked by the saving we are sure of"
        intro="A test uses a sample of your requests, so passing is never a certainty. Understudy works out how sure it is, and ranks by that.">
        <div className="hwtwo hwwords">
          <div className="hwcol">
            <p>
              For each setup that passed, Understudy asks: given the answers we saw, how likely is it that this
              setup truly stays inside the pass mark? A setup that matched on every one of 120 requests is more
              convincing than one that only just passed. What a setup saves, multiplied by how sure we are, is the
              saving we are sure of.
            </p>
            <p>
              Most of the time the setup that saves the most is also one we are sure of, and it comes first either
              way. Your <b>routing priority</b> decides the rest:
            </p>
            <ul className="hwlist">
              <li><b>Balanced</b>, the default: the biggest saving we are sure of. When two setups save about the same, within one point, the faster one comes first.</li>
              <li><b>Cautious</b>: only setups we are at least 99 in 100 sure of, and the second look in step 4 is held to a stricter standard.</li>
              <li><b>Most savings</b>: the cheapest setup that passed.</li>
            </ul>
            <p>You can choose a priority for your whole workspace in Settings, or for one workload on its own page.</p>
          </div>
          <figure>
            <div className="hwfig"><Priority /></div>
            <figcaption>
              Three setups that passed. The pale bar is what each saves, and the solid bar is the saving we are sure
              of. The setups and numbers are an example.
            </figcaption>
          </figure>
        </div>
      </Step>

      <Step n={4} id="second-look" title="The first in line is tested again on requests it has never seen"
        intro="When many setups are tested, one can pass by luck. A second test on fresh requests catches it.">
        <div className="hwtwo hwwords">
          <div className="hwcol">
            <p>
              Picture ten cheap setups that are each a little worse than the pass mark allows. Tested once, one of
              them will sometimes look good by chance, the way a coin can land heads five times in a row. So before
              anything is switched, the setup that comes first is tested again on requests it has never seen, held
              to the same pass mark and to your speed setting. If it fails, the next in line gets its own second
              look.
            </p>
            <p>
              In our simulations of exactly that case, testing once switched about 9 in 100 of those workloads to a
              setup worse than the pass mark allowed. With the second look, none of 3,000 were.
            </p>
          </div>
          <figure>
            <div className="hwfig"><SecondLook /></div>
            <figcaption>
              Six setups are tested and three pass, but one of those only passed by luck, and it fails the second look.
            </figcaption>
          </figure>
        </div>
      </Step>

      <Step n={5} id="after" title="After the switch, it keeps checking"
        intro="A switch is not the end. Models change, and so do your requests.">
        <div className="hwtwo hwwords">
          <div className="hwcol">
            <p>
              Every day, about 20 of the new setup’s answers are also sent to <M /> in the background, and the two
              answers are compared the same way as in a test. Your users never see the background answer, and you
              pay for it like a test.
            </p>
            <p>
              Understudy keeps a range for how often the new setup’s answers are worse, which narrows as checks add
              up. Once at least 30 have been checked, if the whole range is past the pass mark, the workload goes
              back to <M /> by itself. It also watches every answer for failures and slowdowns, and tests the
              workload again every 30 days.
            </p>
          </div>
          <figure>
            <div className="hwfig"><After /></div>
            <figcaption>
              It only switches back when the whole range is past the pass mark, so chance alone almost never triggers it.
            </figcaption>
          </figure>
        </div>
      </Step>

      <section className="hwstep" id="kinds" aria-labelledby="kinds-h">
        <div className="hwstephead">
          <div className="hwcol">
            <h2 id="kinds-h">Sorting requests by kind</h2>
            <p className="hwintro">One workload can hold different kinds of request, and a cheaper model can be good at some and bad at others.</p>
          </div>
        </div>
        <div className="hwtwo hwwords">
          <div className="hwcol">
            <p>
              Say most order-status requests are short questions like “Where is order 2061?”, and a few are long
              complaints about a double charge. A cheap model might answer every short question as well as <M />{' '}
              but get a third of the complaints wrong. Switched as a whole, the workload would either keep paying for{' '}
              <M /> on every request, or take the cheap model’s mistakes too.
            </p>
            <p>
              So Understudy groups the tested requests by the words they use, and tests every setup on each group.
              Then it builds a sorting table. A setup may only take a kind it answers as well as <M />, and of all
              the tables that could be made that way, it keeps the one with the biggest saving we are sure of. A
              request unlike any it learned from goes to <M />. It keeps only a few averages to do this, never your
              requests.
            </p>
            <p>
              The sorting has to earn its place. If a cheap model’s mistakes are spread evenly over every kind,
              sorting would only hide them among its good answers, so no sorting table is used. And a sorting table
              has to pass the same test and second look as any other setup.
            </p>
          </div>
          <figure>
            <div className="hwfig"><Kinds /></div>
            <figcaption>
              Each request is matched to a kind before it is sent. Nothing is checked afterwards, so no request waits
              for two answers.
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="hwstep" id="jev" aria-labelledby="jev-h">
        <div className="hwstephead">
          <div className="hwcol">
            <h2 id="jev-h">Where Jev comes in</h2>
            <p className="hwintro">
              Jev is an AI model made by TypeSafe. It answers precise questions, and says how sure it is, in a
              fraction of a second and for a small fraction of what a language model costs.
            </p>
          </div>
        </div>
        <div className="hwtwo hwwords">
          <div className="hwcol">
            <p>
              Understudy gives Jev three jobs. In tests, it judges written answers, reading each pair in both
              orders. In the checked setup, it reads every answer as it is served and sends the doubtful ones to your
              own model; a check that lets through more than 2 in 10 of the wrong answers it is shown is not
              trusted. And after a switch, it reads the background checks.
            </p>
            <p>
              Jev is good at judging meaning, and less reliable with exact numbers and dates. So numbers, dates and
              the fields of structured answers are compared in code, and Jev is only asked about wording. When Jev is
              unavailable, a language model judges tests instead, and the checked setup sends every request to your
              own model rather than serve an answer nobody checked.
            </p>
          </div>
          <figure>
            <div className="hwfig"><JevJobs /></div>
            <figcaption>Jev’s three jobs. Each one is a question with a short, fixed set of answers.</figcaption>
          </figure>
        </div>
      </section>

      <section className="hwstep" id="numbers" aria-labelledby="numbers-h">
        <div className="hwstephead">
          <div className="hwcol">
            <h2 id="numbers-h">What our simulations show</h2>
            <p className="hwintro">
              Every rule on this page was checked on thousands of made-up workloads where we knew the right answer,
              before it was used on real ones.
            </p>
          </div>
        </div>
        <div className="hwtwo hwwords">
          <div className="hwcol">
            <p>
              <b>Near ties.</b> With two setups that save about the same, one of them much faster, Balanced chose the
              faster one in 86 of 100 workloads. Choosing the cheapest, as Understudy used to, chose it in 11. It
              cost less than half a point of saving, and answers came about two and a half times faster.
            </p>
            <p>
              <b>Lucky passes.</b> Where ten setups were each a quarter worse than the pass mark allowed, testing once
              switched to one of them in about 9 of 100 workloads. With the second look, none of 3,000 were.
            </p>
            <p>
              <b>Cautious.</b> It never switched to a setup worse than the pass mark in any of our scenarios. It
              switches less often, so it saves less: in one typical mix of setups it switched 38 of 100 workloads,
              where Balanced switched 52.
            </p>
            <p>
              <b>Sorting by kind.</b> Where a cheap model was only wrong on one kind of request, a sorting table was
              switched to in about half of the workloads, saving about 80%, and none broke the promise. Where a
              cheap model’s mistakes were spread evenly, the check that sorting must earn its place stopped the
              table that would have broken the promise.
            </p>
          </div>
          <figure>
            <div className="hwfig"><SimBars /></div>
            <figcaption>
              Out of 100 made-up workloads. In a near tie, picking the faster setup is what we want; in the lucky
              case, switching to a setup past the pass mark is what we don’t.
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="hwend" aria-labelledby="hwend-h">
        <h2 id="hwend-h">See it on your own requests</h2>
        <p>
          Every request keeps going to the model your app asks for until a setup passes both tests on your own
          requests.
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
            <To to="how" go={go} className="btn sec big">How it works</To>
          </div>
        )}
      </section>
    </main>
  );
}
