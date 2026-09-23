import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Doc, To } from './Public.jsx';

/* The one way to reach us.
 *
 * What somebody writes is emailed to us and a reply goes back to the address they give; the
 * address it goes to is never on the page. The form says exactly what went wrong when it does:
 * the server's own reason for anything it refuses, and plain words when it could not be reached
 * at all. A field nobody can see catches the scripts that fill in every box they find. */

const TOPICS = [
  ['question', 'A question'],
  ['support', 'Help with my account'],
  ['sales', 'Pricing or buying'],
  ['privacy', 'Privacy, or deleting my data'],
  ['security', 'Reporting a security problem'],
  ['other', 'Something else'],
];
const MIN = 10;
const MAX = 5000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const topicFromUrl = () => {
  try {
    const t = new URLSearchParams(window.location.search).get('topic');
    return TOPICS.some(([k]) => k === t) ? t : 'question';
  } catch { return 'question'; }
};

/* What a failed send says, in words somebody can act on. The server words its own refusals
   (a bad address, a message too short, too many messages from one place), so those are shown as
   they are; only a request that never arrived needs words of its own. */
const reasonOf = (e) => {
  if (e instanceof TypeError) return 'We could not reach Understudy just now. Check your connection, then send it again.';
  return e?.message || 'That did not send. Try again in a minute.';
};

export default function Contact({ me, go }) {
  const [name, setName] = useState(me?.signedIn ? me.name || '' : '');
  const [email, setEmail] = useState(me?.signedIn ? me.email || '' : '');
  const [topic, setTopic] = useState(topicFromUrl);
  const [message, setMessage] = useState('');
  const [trap, setTrap] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sentTo, setSentTo] = useState(null);
  const doneHead = useRef(null);
  const errBox = useRef(null);

  // somebody who signs in while the page is open does not have to type their own address
  useEffect(() => {
    if (!me?.signedIn) return;
    setName((n) => n || me.name || '');
    setEmail((m) => m || me.email || '');
  }, [me]);

  useEffect(() => { if (sentTo) doneHead.current?.focus(); }, [sentTo]);
  useEffect(() => { if (err) errBox.current?.focus(); }, [err]);

  const tooShort = message.trim().length < MIN;
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!EMAIL.test(email.trim())) { setErr('That does not look like an email address.'); return; }
    if (tooShort) { setErr(`Say a little more, so we can answer properly: at least ${MIN} characters.`); return; }
    setBusy(true); setErr('');
    try {
      await api.contact({ name: name.trim(), email: email.trim(), topic, message: message.trim(), website: trap });
      setSentTo(email.trim());
      setMessage('');
    } catch (x) {
      setErr(reasonOf(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Doc eyebrow="Contact" title="Contact us" dated={false}
      lead="Questions, help with your account, privacy requests and security reports all come here. Choose a topic, so we know what it is about before we open it.">
      {sentTo ? (
        <div className="cdone" role="status">
          <h2 ref={doneHead} tabIndex={-1}>Thank you. Your message has been sent.</h2>
          <p>We reply to <b>{sentTo}</b>. If that address is wrong, send it again with the right one.</p>
          <p><button type="button" className="minig" onClick={() => setSentTo(null)}>Send another message</button></p>
        </div>
      ) : (
        <form className="cform" onSubmit={submit} noValidate>
          <div className="cfrow">
            <div>
              <label htmlFor="cf-name">Your name <span className="cfopt">(optional)</span></label>
              <input id="cf-name" className="field" type="text" autoComplete="name" maxLength={120}
                value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label htmlFor="cf-email">Your email</label>
              <input id="cf-email" className="field" type="email" autoComplete="email" required
                aria-describedby="cf-email-hint" value={email} onChange={(e) => setEmail(e.target.value)} />
              <span className="cfhint" id="cf-email-hint">Where we send our reply.</span>
            </div>
          </div>
          <div>
            <label htmlFor="cf-topic">What it is about</label>
            <select id="cf-topic" className="field" value={topic} onChange={(e) => setTopic(e.target.value)}>
              {TOPICS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            {topic === 'privacy' && (
              <span className="cfhint">To have your account and its data deleted, say so here, and give the email address the account uses.</span>
            )}
            {topic === 'security' && (
              <span className="cfhint">Please describe what you found and how to see it. Thank you for telling us first.</span>
            )}
          </div>
          <div>
            <label htmlFor="cf-message">Your message</label>
            <textarea id="cf-message" className="field" required minLength={MIN} maxLength={MAX}
              aria-describedby="cf-message-hint" value={message} onChange={(e) => setMessage(e.target.value)} />
            <span className="cfhint" id="cf-message-hint">
              {message.length > MAX - 500
                ? `${(MAX - message.length).toLocaleString('en-US')} characters left.`
                : `At least ${MIN} characters, and at most ${MAX.toLocaleString('en-US')}.`}
            </span>
          </div>
          {/* Hidden from people and from the keyboard. Only a script fills it in. */}
          <div className="hpot" aria-hidden="true">
            <label htmlFor="cf-leave">Leave this empty</label>
            <input id="cf-leave" name="leave_empty" type="text" tabIndex={-1} autoComplete="off"
              value={trap} onChange={(e) => setTrap(e.target.value)} />
          </div>
          {err && <div className="errbox" role="alert" tabIndex={-1} ref={errBox}>{err}</div>}
          <div className="cfacts">
            <button type="submit" className="btn" disabled={busy}>{busy ? 'Sending…' : 'Send message'}</button>
          </div>
          <p className="cfhint">
            Before writing, the answer may already be on <To to="pricing" go={go}>pricing</To>,{' '}
            <To to="traffic" go={go}>what happens to your traffic</To> or <To to="status" go={go}>status</To>.
          </p>
        </form>
      )}
    </Doc>
  );
}
