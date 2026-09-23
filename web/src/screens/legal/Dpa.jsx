import React from 'react';
import { Doc, Sec, To } from './Public.jsx';

/* The data processing terms, in plain words: who decides what, what we may do with the data,
   who helps us, how it is protected, what happens if something goes wrong, when it is deleted,
   and where it may go. */

export default function Dpa({ go }) {
  return (
    <Doc eyebrow="Legal" title="Data processing terms"
      lead="How we handle the personal data that may be inside the calls you send us.">

      <Sec id="roles" title="Who decides what">
        <p>
          <b>You decide what to send us.</b> For the personal data in it, you are the controller: you choose what
          it is and why it is processed.
        </p>
        <p>
          <b>We process it only to provide Understudy to you.</b> We are the processor, and we do not use it for
          anything else.
        </p>
      </Sec>

      <Sec id="confidential" title="Confidentiality">
        <p>We keep your data confidential.</p>
      </Sec>

      <Sec id="subprocessors" title="Subprocessors">
        <p>
          We use the subprocessors on the <To to="subprocessors" go={go}>subprocessors</To> page: Railway,
          OpenRouter, the model providers OpenRouter reaches for a call (only ones that keep nothing), TypeSafe,
          Stripe and Resend. Before we use a new one, we add it to that page.
        </p>
      </Sec>

      <Sec id="security" title="Security">
        <p>
          The measures are the ones on the <To to="security" go={go}>security</To> page: HTTPS everywhere, keys
          hashed and encrypted, passwords stored as hashes, single use sign-in codes that expire, and zero data
          retention asked for on every call to a model provider.
        </p>
      </Sec>

      <Sec id="breach" title="If something goes wrong">
        <p>If your data is involved in a breach, we tell you without undue delay.</p>
      </Sec>

      <Sec id="deletion" title="Deletion">
        <p>
          The content of your calls is deleted when your workspace&rsquo;s retention window passes: after 30, 60
          or 90 days, or kept indefinitely, as your workspace chooses. Your account and its data are deleted when
          you ask, through
          the <To to="contact" go={go} search="?topic=privacy">contact page</To>.
        </p>
      </Sec>

      <Sec id="transfers" title="Transfers">
        <p>Your data may be transferred to the United States through our subprocessors.</p>
      </Sec>
    </Doc>
  );
}
