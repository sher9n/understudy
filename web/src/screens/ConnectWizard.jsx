import React, { useCallback, useEffect, useRef, useState } from 'react';
import { href } from '../router.js';
import { api } from '../api.js';
import Board from '../Board.jsx';
import html from './connect.html?raw';

/* The board's own placeholders, swapped for this workspace's real ones. */
const SAMPLE_KEY = 'us_live_3f9c2a71b84e05d6c1af7be209438d5c';
const SAMPLE_BASE = 'https://api.understudy.dev/v1';
const SAMPLE_SUMMARY = '17 calls in, grouped into 2 workloads by the job they do. Nothing here was labelled by you.';

const LANGS = ['python', 'node', 'curl', 'claude'];

const summary = (d) => {
  const n = d.workloads.length;
  return `${d.calls} call${d.calls === 1 ? '' : 's'} in, grouped into ${n} workload${n === 1 ? '' : 's'}`
    + ' by the job they do. Nothing here was labelled by you.';
};

export default function ConnectWizard({ go, dark, setDark, freshKey, signedIn }) {
  const [data, setData] = useState(null);
  const [step, setStep] = useState(1);
  const [way, setWay] = useState('route');
  const [lang, setLang] = useState('python');
  const timer = useRef(null);

  const load = useCallback(() => api.connect().then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  /* Step two waits for a real call. Nothing here pretends one arrived. */
  useEffect(() => {
    if (step !== 2 || (data && data.calls > 0)) return undefined;
    timer.current = setInterval(load, 3000);
    return () => clearInterval(timer.current);
  }, [step, data, load]);

  if (!data) return <div className="loading">Loading…</div>;

  const calls = data.calls > 0;
  const vals = {
    dark, light: !dark,
    isStep1: step === 1, isStep2: step === 2,
    s1Cls: step === 1 ? 'st on' : 'st done',
    s2Cls: step === 1 ? 'st' : (calls ? 'st done' : 'st on'),
    s3Cls: (step === 2 && calls) ? 'st on done' : 'st',
    routeCls: way === 'route' ? 'way on' : 'way',
    copyCls: way === 'copy' ? 'way on' : 'way',
    is_route: way === 'route', is_copy: way === 'copy',
    noCalls: !calls, hasCalls: calls,
    keyState: calls ? 'in use' : freshKey ? 'not used yet' : 'shown once, when it was created',
  };
  for (const l of LANGS) {
    vals[`tab_${l}`] = lang === l ? 'tab on' : 'tab';
    for (const w of ['route', 'copy']) vals[`is_${w}_${l}`] = way === w && lang === l;
  }

  const on = {
    toggleTheme: () => setDark(!dark),
    next: () => { setStep(2); load(); },
    pick_route: () => setWay('route'),
    pick_copy: () => setWay('copy'),
    arrive: load,            // the board's "waiting" box: here it just checks again
    /* Until a call has arrived the dashboard is empty and the app sends you straight back
       here, so the wordmark and Back lead to Connect, which is this customer's home for
       now. The big "Go to your dashboard" button only appears once a call has landed. */
    go_dash: () => go(calls ? 'dash' : 'connect'),
    back: () => (step === 2 ? setStep(1) : go(calls ? 'dash' : 'connect')),
  };
  for (const l of LANGS) on[`pick_${l}`] = () => setLang(l);

  return (
    <Board
      html={html}
      vals={vals}
      on={on}
      hrefs={{ go_dash: href(calls ? 'dash' : 'connect') }}
      subs={{
        [SAMPLE_KEY]: freshKey || (data.keyPrefix ? `${data.keyPrefix}…` : SAMPLE_KEY),
        [SAMPLE_BASE]: data.baseUrl,
        [SAMPLE_SUMMARY]: summary(data),
      }}
      repeat={{ '.inbox .wrow': data.workloads.map((w) => ({
        nm: w.slug, md: w.reference_model || 'model not stated', ct: `${w.calls} call${w.calls === 1 ? '' : 's'}`,
      })) }}
    />
  );
}
