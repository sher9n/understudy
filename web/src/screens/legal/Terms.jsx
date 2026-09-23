import React from 'react';
import { Doc, Sec, To } from './Public.jsx';

/* The terms, in plain words. Short on purpose: each section says one thing, and says it the
   way somebody would explain it across a table. */

const TOC = [
  ['agreement', 'These terms'],
  ['use', 'Using Understudy'],
  ['yours', 'Your account, your keys and what you send'],
  ['fees', 'Fees'],
  ['data', 'Your data'],
  ['warranty', 'No warranties'],
  ['liability', 'Liability'],
  ['stopping', 'Stopping'],
  ['changes', 'Changes to these terms'],
  ['law', 'Governing law'],
  ['contact', 'Contact'],
];

export default function Terms({ go }) {
  return (
    <Doc eyebrow="Legal" title="Terms of service"
      lead="These are the terms for using Understudy. In them, “we” and “us” mean Understudy, and “you” means the person or organisation using it.">
      <nav className="doctoc" aria-label="On this page">
        <span className="pubcolh">On this page</span>
        <ol>{TOC.map(([id, t]) => <li key={id}><a href={`#${id}`}>{t}</a></li>)}</ol>
      </nav>

      <Sec id="agreement" title="These terms">
        <p>By creating an account or sending calls to Understudy, you agree to these terms.</p>
      </Sec>

      <Sec id="use" title="Using Understudy">
        <p>When you use Understudy, you may not:</p>
        <ul>
          <li>send anything illegal through it;</li>
          <li>use it to abuse anyone, or abuse the service itself;</li>
          <li>try to get around its limits, or to break its security.</li>
        </ul>
        <p>If you find a security problem, please tell us through the{' '}
          <To to="contact" go={go} search="?topic=security">contact page</To> rather than testing it further.</p>
      </Sec>

      <Sec id="yours" title="Your account, your keys and what you send">
        <p>
          You are responsible for your account, for keeping your API keys safe, and for what you send through
          Understudy. If you think a key has been exposed, revoke it in Settings and make a new one.
        </p>
      </Sec>

      <Sec id="fees" title="Fees">
        <p>
          The fees are the ones on the <To to="pricing" go={go}>pricing</To> page. They are charged from a
          prepaid balance that you add credit to.
        </p>
      </Sec>

      <Sec id="data" title="Your data">
        <p>
          What we keep, for how long, and who else touches it is set out in <To to="traffic" go={go}>what
          happens to your traffic</To>, the <To to="privacy" go={go}>privacy</To> page and the{' '}
          <To to="dpa" go={go}>data processing terms</To>.
        </p>
      </Sec>

      <Sec id="warranty" title="No warranties">
        <p>Understudy is provided as it is, without warranties of any kind.</p>
      </Sec>

      <Sec id="liability" title="Liability">
        <p>Our liability to you is limited to the fees you paid us in the three months before the claim.</p>
      </Sec>

      <Sec id="stopping" title="Stopping">
        <p>
          Either of us may stop at any time. You can stop by no longer sending calls, and ask for your account and
          its data to be deleted through the <To to="contact" go={go} search="?topic=privacy">contact page</To>.
        </p>
      </Sec>

      <Sec id="changes" title="Changes to these terms">
        <p>We may change these terms. When we do, we say so on this page and change the date at the top of it.</p>
      </Sec>

      <Sec id="law" title="Governing law">
        <p>These terms are governed by the law of England and Wales.</p>
      </Sec>

      <Sec id="contact" title="Contact">
        <p>Questions about these terms can go through the <To to="contact" go={go}>contact page</To>.</p>
      </Sec>
    </Doc>
  );
}
