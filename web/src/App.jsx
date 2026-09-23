import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, onWorkloadName, onSignedOut, usd } from './api.js';
import { parse, go as navigate, onPop, PUBLIC, titleFor, safeNext, here as hereNow, signInHref,
  href } from './router.js';
import { plainClick } from './nav.jsx';
import Notice from './Notice.jsx';
import Shell from './Shell.jsx';
import Auth from './screens/Auth.jsx';
import Home from './screens/Home.jsx';
import Dashboard from './screens/Dashboard.jsx';
import Workloads from './screens/Workloads.jsx';
import WorkloadDetail from './screens/WorkloadDetail.jsx';
import Models from './screens/Models.jsx';
import Settings from './screens/Settings.jsx';
import ConnectWizard from './screens/ConnectWizard.jsx';
import ConnectPage from './screens/ConnectPage.jsx';
import { PublicPage } from './screens/legal/Public.jsx';
import Traffic from './screens/legal/Traffic.jsx';
import Pricing from './screens/legal/Pricing.jsx';
import Terms from './screens/legal/Terms.jsx';
import Privacy from './screens/legal/Privacy.jsx';
import Dpa from './screens/legal/Dpa.jsx';
import Subprocessors from './screens/legal/Subprocessors.jsx';
import Security from './screens/legal/Security.jsx';
import Contact from './screens/legal/Contact.jsx';
import Status from './screens/legal/Status.jsx';
import NotFound from './screens/NotFound.jsx';

const APP = new Set(['dash', 'work', 'models', 'settings', 'connect']);
const AUTH = new Set(['signin', 'signup', 'signincode']);

/* The pages anybody can read. Each is drawn inside the same public frame as the home page. */
const PAGES = { traffic: Traffic, pricing: Pricing, terms: Terms, privacy: Privacy, dpa: Dpa,
  subprocessors: Subprocessors, security: Security, contact: Contact, status: Status };

/* Every one of these screens is built out of the customer's own traffic, so before the guide
   is finished they are either empty or half a story. Settings is deliberately not on the
   list: your keys, your balance and the way out of the account are worth reaching on day
   one. The gate is finishing the GUIDE, not the first call arriving: a call landing while
   somebody is reading step two used to move the app out from under them. */
const NEEDS_TRAFFIC = new Set(['dash', 'work', 'models']);

/* A value that came back in the address, read once and then taken out of it, so a reload or a
   copied link does not say the same thing again. */
function takeParam(name) {
  try {
    const url = new URL(window.location.href);
    const v = url.searchParams.get(name);
    if (v === null) return null;
    url.searchParams.delete(name);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    return v;
  } catch { return null; }
}

/* What Stripe's payment page sent back: ?credit=20.00 after paying, ?credit=cancelled after
   turning back. Nothing was said about either before, so a payment ended in silence. */
function takeCredit() {
  const v = takeParam('credit');
  if (v === null) return null;
  if (v === 'cancelled') return { kind: 'cancelled' };
  const n = Number(v);
  return { kind: 'paid', amount: /^\d{1,6}(\.\d{1,2})?$/.test(v) && n > 0 ? n : null };
}

const nextFromUrl = () => {
  try { return safeNext(new URLSearchParams(window.location.search).get('next')); } catch { return null; }
};

/* How long to wait before asking again whether Understudy can be reached, try by try. */
const AGAIN_MS = [3000, 6000, 12000, 30000];

export default function App() {
  const [me, setMe] = useState(null);
  const [{ screen, openId }, setWhere] = useState(() => parse());
  const [freshKey, setFreshKey] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  /* The window the dashboard and the workload list are read over. Kept here so switching
     between the two screens does not silently put it back to thirty days. */
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem('us_dark') === '1'; } catch { return false; }
  });
  // said once at the top of the app: a payment back from Stripe, and a session that has ended
  const [credit, setCredit] = useState(takeCredit);
  const [ended, setEnded] = useState(false);
  const [linkExpired, setLinkExpired] = useState(() => takeParam('link') === 'expired');
  // where to go after signing in, when the sign-in screen was reached from a page that needed it
  const nextRef = useRef(nextFromUrl());
  /* Every read of a screen's data carries a number, and only the newest may land. Without it a
     slow answer for the dashboard could arrive after somebody had moved to Models, and draw
     Models from the dashboard's data. */
  const seq = useRef(0);
  const whereRef = useRef({ screen, openId });
  whereRef.current = { screen, openId };

  useEffect(() => {
    try { localStorage.setItem('us_dark', dark ? '1' : '0'); } catch { /* private window */ }
  }, [dark]);

  /* Who is looking. A failure to ask is not the same as being signed out: telling somebody who
     is signed in to sign in, because the server could not be reached for a moment, sends them
     to a form that cannot work either. So it is said as what it is, and asked again. */
  const [tries, setTries] = useState(0);
  const askWho = useCallback(() => api.me()
    .then((who) => { setMe(who); setTries(0); })
    .catch((e) => { setMe({ signedIn: false, offline: true, why: e?.message }); setTries((n) => n + 1); }), []);
  useEffect(() => { askWho(); }, [askWho]);
  useEffect(() => {
    if (!me?.offline) return undefined;
    const t = setTimeout(askWho, AGAIN_MS[Math.min(tries - 1, AGAIN_MS.length - 1)] ?? 3000);
    return () => clearTimeout(t);
  }, [me, tries, askWho]);

  // the back and forward buttons walk the app, and a typed URL lands on the right screen
  useEffect(() => onPop(() => {
    seq.current += 1;
    setWhere(parse());
    setData(null);
    const n = nextFromUrl();
    if (n) nextRef.current = n;
  }), []);

  // a session that ends while the app is open is said once, with a way back in
  useEffect(() => onSignedOut(() => setEnded(true)), []);

  /* Going somewhere starts at the top of it, the way following a link does. The page used to
     keep the scroll position of the one before, so a link at the foot of a long page opened the
     next one scrolled to its foot too. A place on a page (#how) is scrolled to instead. */
  const go = (next, id = null, opts = {}) => {
    navigate(next, id, opts);
    seq.current += 1;
    setWhere({ screen: next, openId: id });
    setData(null);
    if (opts.hash) {
      setTimeout(() => document.getElementById(opts.hash)?.scrollIntoView({ block: 'start' }), 0);
    } else {
      window.scrollTo(0, 0);
    }
  };

  /** Going to an address rather than to a screen: where a sign-in was asked to come back to. */
  const goTo = (path, { replace = false } = {}) => {
    const url = new URL(path, window.location.origin);
    window.history[replace ? 'replaceState' : 'pushState']({}, '', `${url.pathname}${url.search}${url.hash}`);
    seq.current += 1;
    setWhere(parse(url.pathname));
    setData(null);
    window.scrollTo(0, 0);
  };

  /* Where somebody lands once they are signed in: back where they were asked to sign in from,
     or else their dashboard, or Connect while their guide is unfinished. */
  const landAfterSignIn = (who, fresh = false) => {
    const target = nextRef.current;
    nextRef.current = null;
    setEnded(false);
    setLinkExpired(false);
    if (target && !fresh) { goTo(target, { replace: true }); return; }
    go(fresh || !who.onboarded ? 'connect' : 'dash', null, { replace: true });
  };

  // someone already signed in has no business on the sign in screen
  useEffect(() => {
    if (me?.signedIn && AUTH.has(screen)) landAfterSignIn(me);
  }, [me, screen]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Nor on the home page: it is where a sign-in link lands, and it used to leave somebody who had
     just signed in looking at the marketing page with "Sign in" still at the top of it. */
  useEffect(() => {
    if (!me?.signedIn || screen !== 'home') return;
    const to = me.onboarded ? 'dash' : 'connect';
    navigate(to, null, { replace: true });
    setWhere({ screen: to, openId: null });
  }, [me, screen]);

  /* Somebody who has never sent us a call belongs on Connect, however they reached an empty
     dashboard: a typed address, an old bookmark, a reopened tab. The check asks the server
     rather than trusting what was true when the page loaded, so the moment their first call
     lands the wizard's own way out stops being a bounce. */
  useEffect(() => {
    if (!me?.signedIn || me.onboarded) return undefined;
    if (!NEEDS_TRAFFIC.has(screen)) return undefined;
    let live = true;
    api.me().then((who) => {
      if (!live) return;
      if (who.onboarded) { setMe(who); return; }
      navigate('connect', null, { replace: true });
      setWhere({ screen: 'connect', openId: null });
    }).catch(() => {});
    return () => { live = false; };
  }, [me, screen]);

  const read = (which, over) => {
    if (which === 'dash' || which === 'work') return api.overview(over);
    if (which === 'models') return api.models();
    if (which === 'settings') return api.settings();
    if (which === 'connect') return api.connect();
    return Promise.resolve(null);
  };

  const load = useCallback(async (which, over = days) => {
    const mine = ++seq.current;
    setErr(null);
    try {
      const got = await read(which, over);
      if (mine === seq.current) setData(got);
    } catch (e) {
      if (mine === seq.current) setErr(e);
    }
  }, [days]);

  /* Reading a screen again in place, for the dashboard's live figures. A failure is thrown back
     to the caller and leaves the screen as it was: the figures already on it stay. */
  const refresh = useCallback(async (which) => {
    const mine = seq.current;
    const got = await read(which, days);
    if (mine === seq.current && got) setData(got);
  }, [days]);

  useEffect(() => {
    if (me?.signedIn && APP.has(screen) && !openId && !data) load(screen);
  }, [me, screen, openId, data, load]);

  /* A payment is added to the balance by Stripe's own message to the server, which can land a
     moment after somebody is sent back here. So Settings is read again a few times, and the new
     balance appears without a reload. A test payment on a deployment that does not add those to
     balances is said to be one, rather than promised. */
  useEffect(() => {
    if (credit?.kind !== 'paid') return undefined;
    let live = true;
    api.status().then((s) => {
      if (live && s?.payments === 'test_refused') setCredit((c) => (c ? { ...c, test: true } : c));
    }).catch(() => {});
    const timers = [4000, 12000, 30000].map((ms) => setTimeout(() => {
      const w = whereRef.current;
      if (w.screen === 'settings' && !w.openId) refresh('settings').catch(() => {});
    }, ms));
    return () => { live = false; timers.forEach(clearTimeout); };
  }, [credit?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Workload names, for the title of a workload's page: from the list whenever it is read, and
     from the workload itself when its page is opened straight from a link. */
  const [names, setNames] = useState({});
  useEffect(() => onWorkloadName((id, name) => setNames((m) => (m[id] === name ? m : { ...m, [id]: name }))), []);
  useEffect(() => {
    if (!data?.rows) return;
    setNames((m) => {
      const fresh = data.rows.filter((r) => m[r.id] !== r.name);
      return fresh.length ? { ...m, ...Object.fromEntries(fresh.map((r) => [r.id, r.name])) } : m;
    });
  }, [data]);

  /* The title names the screen actually on show: somebody signed out who follows a link to the
     dashboard is looking at the sign-in form, and the tab says so. */
  const shown = PUBLIC.has(screen) || screen === 'home' || screen === 'notfound' ? screen
    : me && !me.signedIn && !me.offline ? (AUTH.has(screen) ? screen : 'signin')
      : openId ? 'workload' : screen;
  useEffect(() => {
    document.title = titleFor(shown, openId ? names[openId] : null);
  }, [shown, openId, names]);

  const mode = dark ? 'dark' : 'light';

  /* The public pages do not wait for the account check. The status page most of all: somebody
     opens it when something is wrong, and it must not sit on "Loading" because the thing it
     reports on is slow to answer. The header simply leaves out the sign-in buttons until it
     knows whether they apply. */
  if (PUBLIC.has(screen)) {
    const Page = PAGES[screen];
    return (
      <div className="u" data-mode={mode}>
        <PublicPage me={me} go={go} dark={dark} setDark={setDark} here={screen}>
          <Page me={me} go={go} />
        </PublicPage>
      </div>
    );
  }

  // a signed-in visitor to the home page is on the way to their dashboard, not reading it
  if (!me || (screen === 'home' && me.signedIn)) {
    return <div className="u" data-mode={mode}><div className="loading">Loading…</div></div>;
  }

  if (screen === 'home') {
    return (
      <div className="u" data-mode={mode}>
        <Home me={me} go={go} dark={dark} setDark={setDark} />
      </div>
    );
  }

  /* The server could not be reached to ask who this is. Said plainly, with the way to check
     whether it is us, and asked again on its own. */
  if (me.offline && !AUTH.has(screen)) {
    return (
      <div className="u" data-mode={mode}>
        <main className="docpage" id="main">
          <div className="dochead">
            <div className="eyeb doceyeb">Not connected</div>
            <h1>Understudy could not be reached</h1>
            <p className="doclead">
              This page could not ask the server who you are, so it cannot show your workspace yet.
              It is trying again on its own. If it keeps failing, the status page says whether the
              problem is on our side.
            </p>
            <div className="lostacts">
              <button type="button" className="btn" onClick={askWho}>Try again now</button>
              <a className="btn sec" href={href('status')} onClick={plainClick(() => go('status'))}>Open the status page</a>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const signOut = async () => {
    try { await api.signOut(); } catch { /* signed out here either way */ }
    setEnded(false);
    setMe({ signedIn: false });
    go('home');
  };

  /* Signing in again after a session ended, and coming back to the page it ended on. */
  const signInAgain = () => {
    const back = hereNow();
    nextRef.current = safeNext(back);
    setEnded(false);
    setMe({ signedIn: false });
    go('signin', null, { search: `?next=${encodeURIComponent(back)}` });
  };

  const creditNote = credit && (
    <Notice key="credit" tone={credit.kind === 'cancelled' || credit.test ? 'warn' : 'ok'} onClose={() => setCredit(null)}>
      {credit.kind === 'cancelled' ? (
        <><b>Payment cancelled.</b> Nothing was charged, and your balance has not changed.</>
      ) : credit.test ? (
        <><b>That was a test payment.</b> Test payments are not added to balances on this deployment, so your balance has not changed.</>
      ) : (
        <>
          <b>Thank you. Your payment{credit.amount ? ` of ${usd(credit.amount)}` : ''} is with Stripe.</b>{' '}
          It is added to your balance as soon as Stripe confirms it, usually within a minute.
        </>
      )}
    </Notice>
  );

  /* An address that leads nowhere. Somebody signed in keeps their own frame around it, with the
     menu still there to leave by; anybody else gets the public frame. */
  if (screen === 'notfound') {
    return (
      <div className="u" data-mode={mode}>
        {me.signedIn ? (
          <Shell here={null} me={me} go={go} dark={dark} setDark={setDark} onSignOut={signOut}
            locked={!me.onboarded}>
            <NotFound me={me} go={go} inApp />
          </Shell>
        ) : (
          <PublicPage me={me} go={go} dark={dark} setDark={setDark} here="notfound">
            <NotFound me={me} go={go} />
          </PublicPage>
        )}
      </div>
    );
  }

  if (!me.signedIn || AUTH.has(screen)) {
    // the way between the sign-in screens keeps where somebody was going
    const keep = nextRef.current ? `?next=${encodeURIComponent(nextRef.current)}` : '';
    return (
      <div className="u" data-mode={mode}>
        {creditNote}
        {linkExpired && (screen === 'signin' || screen === 'signincode') && (
          <Notice tone="warn" onClose={() => setLinkExpired(false)}>
            <b>That sign-in link has expired, or it has already been used.</b> Sign in below, or ask for a new code.
          </Notice>
        )}
        <Auth
          mode={screen === 'signup' ? 'signup' : (screen === 'signincode' ? 'code' : 'signin')}
          go={(where) => go(where, null, { search: AUTH.has(where) ? keep : '' })}
          dark={dark}
          setDark={setDark}
          onDone={async (fresh, key) => {
            if (key) setFreshKey(key);
            const who = await api.me();
            setMe(who);
            landAfterSignIn(who, fresh);
          }}
        />
      </div>
    );
  }

  const endedNote = ended && (
    <Notice key="ended" tone="warn">
      <b>Your session has ended.</b> Nothing on this page can be saved or read again until you sign in.{' '}
      <a href={signInHref(hereNow())} onClick={plainClick(signInAgain)}>Sign in again</a> to come back to this page.
    </Notice>
  );

  /* The guide lives INSIDE the app, in the same frame the customer will use afterwards. The
     screens they cannot use yet are shown but not live, so they can see what they are
     setting up, and so that nothing moves the moment they finish: the navigation, the
     wordmark and their own account are in the same places before and after. Only the middle
     of the screen changes, from a three step guide to the ordinary Connect page. */
  if (screen === 'connect' && !me.onboarded) {
    return (
      <div className="u" data-mode={mode}>
        <Shell here="connect" me={me} go={go} dark={dark} setDark={setDark}
          locked onSignOut={signOut}>
          {endedNote}
          {creditNote}
          <ConnectWizard go={go} freshKey={freshKey} onFreshKey={setFreshKey}
            onDone={async () => { await api.finishOnboarding(); setMe(await api.me()); }} />
        </Shell>
      </div>
    );
  }

  const here = openId ? 'work' : screen;
  const body = () => {
    if (openId) {
      return <WorkloadDetail id={openId} onBack={() => go('work')}
        onChanged={() => load('work')} />;
    }
    if (err) {
      /* A screen that could not be read says why, and offers the one thing that will help: to
         sign in again when the session has ended, to try again otherwise. */
      return (
        <div className="loadfail" role="alert">
          <p>{err.message}</p>
          <div className="loadfailacts">
            {err.signedOut ? (
              <a className="btn" href={signInHref(hereNow())} onClick={plainClick(signInAgain)}>Sign in again</a>
            ) : (
              <button type="button" className="minig" onClick={() => load(screen)}>Try again</button>
            )}
            {err.network && (
              <a className="minig lnk" href={href('status')} onClick={plainClick(() => go('status'))}>Check the status page</a>
            )}
          </div>
        </div>
      );
    }
    if (!data) return <div className="loading">Loading…</div>;
    if (screen === 'connect') {
      return <ConnectPage data={data} reload={() => load('connect')}
        freshKey={freshKey} onFreshKey={setFreshKey} />;
    }
    const open = (id) => go('work', id);
    const pick = async (d) => { setDays(d); setBusy(true); await load(screen, d); setBusy(false); };
    if (screen === 'dash') {
      return <Dashboard data={data} onOpen={open} onPeriod={pick} busy={busy}
        onTick={() => refresh('dash')} />;
    }
    if (screen === 'work') return <Workloads data={data} onOpen={open} onPeriod={pick} busy={busy} />;
    if (screen === 'models') return <Models data={data} reload={() => load('models')} />;
    if (screen === 'settings') return <Settings data={data} reload={() => load('settings')} />;
    return null;
  };

  return (
    <div className="u" data-mode={mode}>
      <Shell
        here={here}
        me={me}
        go={go}
        dark={dark}
        setDark={setDark}
        onSignOut={signOut}
      >
        {endedNote}
        {creditNote}
        {body()}
      </Shell>
    </div>
  );
}
