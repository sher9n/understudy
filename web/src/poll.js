import { useEffect, useRef, useState } from 'react';

/* Asking again on a timer, without falling over when an answer does not come.
 *
 * The dashboard reads itself every few seconds so a call sent from another window shows up
 * without a reload. One failed read used to replace the whole page with "Failed to fetch", and
 * because the page that owned the timer had gone, it never asked again: a laptop waking from
 * sleep, a deploy, a train going into a tunnel, and the dashboard was dead until reloaded.
 *
 * Now a failed read changes nothing on the screen but a small note. The figures stay as they
 * last were, and the next try waits longer each time (10 seconds, then 20, 40, and then once a
 * minute), with a little jitter so a room full of open tabs does not all knock at once. Coming
 * back to the tab, or the connection coming back, tries straight away. A session that has
 * ended stops it: asking again cannot help, and the frame is already offering to sign in.
 *
 * Returns { trouble, retry }: trouble is null while answers are arriving, and otherwise says how
 * many tries have failed and when the next one is. */
export function usePoll(fn, { every = 5000, most = 60000, enabled = true } = {}) {
  const [trouble, setTrouble] = useState(null);
  const call = useRef(fn);
  call.current = fn;
  const now = useRef(() => {});

  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    let timer = null;
    let fails = 0;
    let running = false;
    const later = (ms) => { clearTimeout(timer); timer = setTimeout(tick, ms); };
    async function tick() {
      if (stopped || running) return;
      // a hidden tab costs nothing; it is read again the moment it is looked at
      if (document.hidden) { later(every); return; }
      running = true;
      try {
        await call.current();
        if (stopped) return;
        fails = 0;
        setTrouble(null);
        later(every);
      } catch (e) {
        if (stopped) return;
        if (e?.signedOut) { setTrouble(null); return; }
        fails += 1;
        const wait = Math.round(Math.min(most, every * 2 ** fails) * (0.85 + Math.random() * 0.3));
        setTrouble({ tries: fails, next: Date.now() + wait, why: e?.message || '' });
        later(wait);
      } finally {
        running = false;
      }
    }
    now.current = () => later(0);
    const back = () => { if (!document.hidden) later(0); };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('online', back);
    later(every);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('online', back);
    };
  }, [every, most, enabled]);

  return { trouble, retry: () => now.current() };
}
