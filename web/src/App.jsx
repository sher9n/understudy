import React, { useCallback, useEffect, useState } from 'react';
import { api, onWorkloadName } from './api.js';
import { parse, go as navigate, onPop, PUBLIC, titleFor } from './router.js';
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

  useEffect(() => {
    try { localStorage.setItem('us_dark', dark ? '1' : '0'); } catch { /* private window */ }
  }, [dark]);

  useEffect(() => { api.me().then(setMe).catch(() => setMe({ signedIn: false })); }, []);

  // the back and forward buttons walk the app, and a typed URL lands on the right screen
  useEffect(() => onPop(() => { setWhere(parse()); setData(null); }), []);

  // someone already signed in has no business on the sign in screen
  useEffect(() => {
    if (me?.signedIn && (screen === 'signin' || screen === 'signup' || screen === 'signincode')) {
      const home = me.onboarded ? 'dash' : 'connect';
      navigate(home, null, { replace: true });
      setWhere({ screen: home, openId: null });
    }
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

  const load = useCallback(async (which, over = days) => {
    setErr(null);
    try {
      if (which === 'dash' || which === 'work') setData(await api.overview(over));
      else if (which === 'models') setData(await api.models());
      else if (which === 'settings') setData(await api.settings());
      else if (which === 'connect') setData(await api.connect());
    } catch (e) { setErr(e.message); }
  }, [days]);

  useEffect(() => {
    if (me?.signedIn && APP.has(screen) && !openId && !data) load(screen);
  }, [me, screen, openId, data, load]);

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
    : me && !me.signedIn ? (AUTH.has(screen) ? screen : 'signin')
      : openId ? 'workload' : screen;
  useEffect(() => {
    document.title = titleFor(shown, openId ? names[openId] : null);
  }, [shown, openId, names]);

  /* Going somewhere starts at the top of it, the way following a link does. The page used to
     keep the scroll position of the one before, so a link at the foot of a long page opened the
     next one scrolled to its foot too. A place on a page (#how) is scrolled to instead. */
  const go = (next, id = null, opts = {}) => {
    navigate(next, id, opts);
    setWhere({ screen: next, openId: id });
    setData(null);
    if (opts.hash) {
      setTimeout(() => document.getElementById(opts.hash)?.scrollIntoView({ block: 'start' }), 0);
    } else {
      window.scrollTo(0, 0);
    }
  };

  /* The public pages do not wait for the account check. The status page most of all: somebody
     opens it when something is wrong, and it must not sit on "Loading" because the thing it
     reports on is slow to answer. The header simply leaves out the sign-in buttons until it
     knows whether they apply. */
  if (PUBLIC.has(screen)) {
    const Page = PAGES[screen];
    return (
      <div className="u" data-mode={dark ? 'dark' : 'light'}>
        <PublicPage me={me} go={go} dark={dark} setDark={setDark} here={screen}>
          <Page me={me} go={go} />
        </PublicPage>
      </div>
    );
  }

  if (!me) return <div className="u" data-mode={dark ? 'dark' : 'light'}><div className="loading">Loading…</div></div>;

  if (screen === 'home') {
    return (
      <div className="u" data-mode={dark ? 'dark' : 'light'}>
        <Home me={me} go={go} dark={dark} setDark={setDark} />
      </div>
    );
  }

  const signOut = async () => { await api.signOut(); setMe({ signedIn: false }); go('home'); };

  /* An address that leads nowhere. Somebody signed in keeps their own frame around it, with the
     menu still there to leave by; anybody else gets the public frame. */
  if (screen === 'notfound') {
    return (
      <div className="u" data-mode={dark ? 'dark' : 'light'}>
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
    return (
      <div className="u" data-mode={dark ? 'dark' : 'light'}>
        <Auth
          mode={screen === 'signup' ? 'signup' : (screen === 'signincode' ? 'code' : 'signin')}
          go={(where) => go(where)}
          dark={dark}
          setDark={setDark}
          onDone={async (fresh, key) => {
            if (key) setFreshKey(key);
            const who = await api.me();
            setMe(who);
            go(fresh || !who.onboarded ? 'connect' : 'dash');
          }}
        />
      </div>
    );
  }

  /* The guide lives INSIDE the app, in the same frame the customer will use afterwards. The
     screens they cannot use yet are shown but not live, so they can see what they are
     setting up, and so that nothing moves the moment they finish: the navigation, the
     wordmark and their own account are in the same places before and after. Only the middle
     of the screen changes, from a three step guide to the ordinary Connect page. */
  if (screen === 'connect' && !me.onboarded) {
    return (
      <div className="u" data-mode={dark ? 'dark' : 'light'}>
        <Shell here="connect" me={me} go={go} dark={dark} setDark={setDark}
          locked onSignOut={signOut}>
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
    if (err) return <div className="errbox">{err}</div>;
    if (!data) return <div className="loading">Loading…</div>;
    if (screen === 'connect') {
      return <ConnectPage data={data} reload={() => load('connect')}
        freshKey={freshKey} onFreshKey={setFreshKey} />;
    }
    const open = (id) => go('work', id);
    const pick = async (d) => { setDays(d); setBusy(true); await load(screen, d); setBusy(false); };
    if (screen === 'dash') {
      return <Dashboard data={data} onOpen={open} onPeriod={pick} busy={busy}
        onTick={() => load('dash')} />;
    }
    if (screen === 'work') return <Workloads data={data} onOpen={open} onPeriod={pick} busy={busy} />;
    if (screen === 'models') return <Models data={data} reload={() => load('models')} />;
    if (screen === 'settings') return <Settings data={data} reload={() => load('settings')} />;
    return null;
  };

  return (
    <div className="u" data-mode={dark ? 'dark' : 'light'}>
      <Shell
        here={here}
        me={me}
        go={go}
        dark={dark}
        setDark={setDark}
        onSignOut={signOut}
      >
        {body()}
      </Shell>
    </div>
  );
}
