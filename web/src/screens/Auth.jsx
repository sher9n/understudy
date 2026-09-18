import React, { useState } from 'react';
import { href } from '../router.js';
import { api } from '../api.js';
import Board from '../Board.jsx';
import signinHtml from './signin.html?raw';
import signupHtml from './signup.html?raw';
import CodeSignIn from './CodeSignIn.jsx';

/* The pitch panel is taken from the sign-in board rather than rewritten, so the code
   screen beside it cannot drift away from the password one. */
/* The INSIDE of the panel, not the panel itself. The two column layout wants the aside as
   its own direct child, so wrapping it in anything drops the form underneath instead of
   beside it. */
const PITCH = (() => {
  const open = signinHtml.indexOf('<aside class="pitch"');
  if (open < 0) return '';
  const start = signinHtml.indexOf('>', open) + 1;
  const end = signinHtml.indexOf('</aside>', start);
  return end < 0 ? '' : signinHtml.slice(start, end);
})();

/* The markup is the design board's. All this adds is what a real form needs: it submits,
   it says why it was refused, and it knows where to go next. */
export default function Auth({ mode, go, onDone, dark, setDark }) {
  const signUp = mode === 'signup';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [codeMode, setCodeMode] = useState(false);

  const submit = async (fields) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (signUp) {
        const r = await api.signUp(fields);
        onDone(true, r.key);
      } else {
        await api.signIn(fields);
        onDone(false);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (codeMode && !signUp) {
    return (
      <CodeSignIn
        pitchHtml={PITCH}
        onDone={() => onDone(false)}
        onBack={() => setCodeMode(false)}
      />
    );
  }

  return (
    <Board
      html={signUp ? signupHtml : signinHtml}
      vals={{ dark, light: !dark, error }}
      onSubmit={submit}
      hrefs={{ go_signup: href('signup'), go_signin: href('signin') }}
      on={{
        toggleTheme: () => setDark(!dark),
        go_signup: () => go('signup'),
        go_signin: () => go('signin'),
        want_code: () => { setError(''); setCodeMode(true); },
      }}
    />
  );
}
