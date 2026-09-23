import React from 'react';
import { Doc, Sec, To } from './Public.jsx';

/* Everybody who handles a customer's data on our behalf, what each one does, and what it sees.
   A new one is added here before it is used, which is why the page carries a date. */

const LIST = [
  ['Railway', 'Hosting and database',
    'Runs the application and its Postgres database, so everything we store is stored there. Data may be processed in the United States.'],
  ['OpenRouter', 'Routes every model call',
    'Receives each call we route, and each replay a measurement makes, and passes it to a model provider. Every call asks for providers that keep nothing: zero data retention, and data collection denied.'],
  ['Model providers', 'Answer the calls',
    'The providers OpenRouter reaches for a call. Only providers that keep nothing are used.'],
  ['TypeSafe', 'Judges answers',
    'Its judging model, Jev, reads requests and answers to judge whether two answers mean the same thing and how well a model suits a task. Jev is reached through OpenRouter, under the same zero retention rule.'],
  ['Stripe', 'Payments',
    'Takes payments when you add credit. We keep the Stripe customer id and your card’s brand and last four digits, never card numbers.'],
  ['Resend', 'Email',
    'Sends sign-in and notification email.'],
];

export default function Subprocessors({ go }) {
  return (
    <Doc eyebrow="Your data" title="Subprocessors"
      lead="The companies that handle data on our behalf to provide Understudy, and what each one does. We add a new one to this page before we use it.">
      <Sec id="list" title="Who they are">
        <div className="klist">
          {LIST.map(([name, role, what]) => (
            <div className="klrow" key={name}>
              <div className="klk">{name}<small>{role}</small></div>
              <div className="klv">{what}</div>
            </div>
          ))}
        </div>
      </Sec>
      <Sec id="more" title="More">
        <p>
          What each of them sees, and for how long we keep what we store, is on{' '}
          <To to="traffic" go={go}>what happens to your traffic</To>. The{' '}
          <To to="dpa" go={go}>data processing terms</To> say how changes to this list are made.
        </p>
      </Sec>
    </Doc>
  );
}
