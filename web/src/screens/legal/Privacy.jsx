import React from 'react';
import { Doc, Sec, To } from './Public.jsx';

/* Privacy, in plain words: what we collect, why, who else sees it, where it is, how long it is
   kept, and how to have it deleted. The same facts as the traffic page, arranged the way people
   look for them on a privacy page. */

const TOC = [
  ['collect', 'What we collect'],
  ['why', 'What we use it for'],
  ['share', 'Who else sees it'],
  ['where', 'Where it is processed'],
  ['how-long', 'How long we keep it'],
  ['cookies', 'Cookies'],
  ['choices', 'Your choices'],
  ['changes', 'Changes to this page'],
];

export default function Privacy({ go }) {
  return (
    <Doc eyebrow="Legal" title="Privacy"
      lead="What Understudy collects about you and your calls, what it is used for, who else sees it, and how long it is kept.">
      <nav className="doctoc" aria-label="On this page">
        <span className="pubcolh">On this page</span>
        <ol>{TOC.map(([id, t]) => <li key={id}><a href={`#${id}`}>{t}</a></li>)}</ol>
      </nav>

      <Sec id="collect" title="What we collect">
        <ul>
          <li><b>Your account:</b> your email address, your name, and your password, stored as a scrypt hash
            rather than the password itself.</li>
          <li><b>Your API keys:</b> a SHA-256 hash of each key, and an AES-256-GCM encrypted copy so you can see
            your key again.</li>
          <li><b>Your calls:</b> for each call, the request and the answer, and the numbers about it: which model
            answered, how many tokens, what it cost, how long it took and whether it went through.</li>
          <li><b>What we work out from them:</b> measurements and their results, the outcomes you report to us,
            and the activity feed.</li>
          <li><b>Money:</b> the ledger of money in and out of your balance. For payments we keep the Stripe
            customer id and your card&rsquo;s brand and last four digits, never card numbers.</li>
        </ul>
      </Sec>

      <Sec id="why" title="What we use it for">
        <p>
          To provide Understudy to you: to group your calls into workloads, to replay a sample of them on other
          models to measure them, to judge answers, to learn from how your calls turned out, and to show all of it
          back to you. Replays are charged to you, as on the <To to="pricing" go={go}>pricing</To> page.
        </p>
        <p><b>We do not sell your data, and we do not train models on it.</b></p>
      </Sec>

      <Sec id="share" title="Who else sees it">
        <p>
          Our subprocessors, each only for the part of the service it provides: Railway hosts the application and
          its database; OpenRouter routes every model call to providers that keep nothing; TypeSafe&rsquo;s Jev
          judges answers, reached through OpenRouter under the same rule; Stripe takes payments; Resend sends
          email. The <To to="subprocessors" go={go}>subprocessors</To> page lists what each one does.
        </p>
      </Sec>

      <Sec id="where" title="Where it is processed">
        <p>Your data may be processed in the United States, by us and through our subprocessors.</p>
      </Sec>

      <Sec id="how-long" title="How long we keep it">
        <p>
          The request and the answer of each call are kept for your workspace&rsquo;s retention window: 30, 60 or
          90 days, or indefinitely, as your workspace chooses in Settings. New workspaces start at 30 days. When
          the window passes, the content of calls, measurement replays and their cached answers is cleared, and
          only the numbers are kept.
        </p>
        <p>
          Your account and the rest of its data are kept while you have the account, and deleted when you ask
          through the <To to="contact" go={go} search="?topic=privacy">contact page</To>.
        </p>
      </Sec>

      <Sec id="cookies" title="Cookies">
        <p>
          We use one cookie, to keep you signed in. Signing out clears it. Whether you chose the light or the dark
          theme is remembered in your own browser, and is not sent to us.
        </p>
      </Sec>

      <Sec id="choices" title="Your choices">
        <ul>
          <li>Choose how long call content is kept, in Settings.</li>
          <li>Send us copies of your calls instead of routing them, so your own provider answers every call.</li>
          <li>Ask for your account and its data to be deleted, through the{' '}
            <To to="contact" go={go} search="?topic=privacy">contact page</To> with the topic Privacy.</li>
        </ul>
        <p>How to switch off measuring and experiments is on <To to="traffic" go={go} hash="off">what happens to your traffic</To>.</p>
      </Sec>

      <Sec id="changes" title="Changes to this page">
        <p>When this page changes, the date at the top changes with it.</p>
      </Sec>
    </Doc>
  );
}
