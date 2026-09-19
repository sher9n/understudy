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

/* How long the button says "Copied". The in-app Connect page waits the same, because the
   two screens show the same row and a different pause reads as a different product. */
export const COPIED_MS = 1600;

/** Put text on the clipboard and say so on the button that asked for it. */
async function flash(button, text) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch { return; }
  const was = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = was; }, COPIED_MS);
}

export default function ConnectWizard({ go, dark, setDark, freshKey, onFreshKey, signedIn, onDone }) {
  /* The key exists in full only while we are holding it. Regenerating is the way to get
     one back, because only a hash of it is stored, so a key that has been lost cannot be
     shown again. Without this the screen offered a truncated key and a Copy button that
     handed over something which could never authenticate. */
  const [ownKey, setOwnKey] = useState(null);
  const [rotating, setRotating] = useState(false);
  const key = freshKey || ownKey || null;
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
  /* The whole key: the one just made, or the one the server could decrypt. Only a key from
     before they were kept recoverable comes back empty, and the prefix stands in for it. */
  const shownKey = key || data.key || null;
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
    regenLabel: rotating ? 'working…' : (shownKey ? 'Replace' : 'Regenerate'),
    /* Nothing beside the key. The row is the key, a way to copy it and a way to replace it,
       and any line of commentary next to all three only competed with them. */
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
    /* Copy whatever box the button sits in, so what lands on the clipboard is exactly what
       is on the screen rather than a second copy of it that can drift. */
    copy_code: async (e) => {
      const box = e.target.closest('.codebox');
      const text = box?.querySelector('.code')?.textContent ?? '';
      await flash(e.target, text);
    },
    copy_key: async (e) => {
      const text = e.target.closest('.keyrow')?.querySelector('.keyval')?.textContent ?? '';
      await flash(e.target, text);
    },
    regen_key: async () => {
      if (rotating) return;
      setRotating(true);
      try {
        const r = await api.regenerateKey();
        setOwnKey(r.key);
        if (onFreshKey) onFreshKey(r.key);
        await load();
      } catch { /* the label goes back and the old key is still on screen */ }
      setRotating(false);
    },
    /* The guide is this customer's home until they say they are done with it, so the
       wordmark and Back stay inside it. Only the button on the last step leaves, and that
       button is what MARKS the guide finished: a call arriving no longer ends it, because
       somebody reading step two should not have the app move under them. */
    go_home: () => go('connect'),
    finish: async () => {
      if (!calls) { go('connect'); return; }
      if (onDone) await onDone();
      go('dash');
    },
    back: () => (step === 2 ? setStep(1) : go('connect')),
  };
  for (const l of LANGS) on[`pick_${l}`] = () => setLang(l);

  return (
    <Board
      html={html}
      vals={vals}
      on={on}
      hrefs={{ go_home: href('connect'), finish: href(calls ? 'dash' : 'connect') }}
      subs={{
        [SAMPLE_KEY]: shownKey || (data.keyPrefix ? `${data.keyPrefix}…` : SAMPLE_KEY),
        [SAMPLE_BASE]: data.baseUrl,
        [SAMPLE_SUMMARY]: summary(data),
      }}
      repeat={{ '.inbox .wrow': data.workloads.map((w) => ({
        nm: w.slug, md: w.reference_model || 'model not stated', ct: `${w.calls} call${w.calls === 1 ? '' : 's'}`,
      })) }}
    />
  );
}
