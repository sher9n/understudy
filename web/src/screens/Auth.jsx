import React, { useState } from 'react';
import { api } from '../api.js';
import Board from '../Board.jsx';
import signinHtml from './signin.html?raw';
import signupHtml from './signup.html?raw';

/* The markup is the design board's. All this adds is what a real form needs: it submits,
   it says why it was refused, and it knows where to go next. */
export default function Auth({ mode, go, onDone, dark, setDark }) {
  const signUp = mode === 'signup';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  return (
    <Board
      html={signUp ? signupHtml : signinHtml}
      vals={{ dark, light: !dark, error }}
      onSubmit={submit}
      on={{
        toggleTheme: () => setDark(!dark),
        go_signup: () => go('signup'),
        go_signin: () => go('signin'),
      }}
    />
  );
}
