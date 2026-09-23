import React from 'react';
import { Doc, Sec, To } from './Public.jsx';

/* How Understudy protects what it holds, stated as what it actually does, and how to tell us
   about a problem. No badges and no certificates: only measures a reader can check against the
   product itself. */

export default function Security({ go }) {
  return (
    <Doc eyebrow="Your data" title="Security"
      lead="The measures that protect your account, your keys and your calls, and how to report a problem.">

      <Sec id="transport" title="In transit">
        <p>Every connection to Understudy uses HTTPS.</p>
      </Sec>

      <Sec id="secrets" title="Passwords and keys">
        <ul>
          <li><b>Passwords</b> are stored as scrypt hashes, never as the password itself.</li>
          <li><b>API keys</b> are stored as a SHA-256 hash, plus an AES-256-GCM encrypted copy so the owner can see
            their own key again.</li>
        </ul>
      </Sec>

      <Sec id="signin" title="Signing in">
        <p>
          A sign-in code is six digits, works once, and expires after 10 minutes. How many codes can be asked for
          is limited for each email address and for each internet address.
        </p>
      </Sec>

      <Sec id="providers" title="Model providers">
        <p>
          Every call to a model provider asks for zero data retention, and for data collection to be denied. How
          long we keep what we store ourselves is up to your workspace: see{' '}
          <To to="traffic" go={go} hash="kept">what happens to your traffic</To>.
        </p>
      </Sec>

      <Sec id="report" title="Reporting a problem">
        <p>
          If you find a security problem, tell us through the{' '}
          <To to="contact" go={go} search="?topic=security">contact page</To>, with the topic Security.
        </p>
      </Sec>
    </Doc>
  );
}
