import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { parse, go as navigate, onPop, href } from './router.js';
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

const APP = new Set(['dash', 'work', 'models', 'settings', 'connect']);

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

  const go = (next, id = null) => {
    navigate(next, id);
    setWhere({ screen: next, openId: id });
    setData(null);
  };

  if (!me) return <div className="u" data-mode="light"><div className="loading">Loading…</div></div>;

  if (screen === 'home') {
    return (
      <div className="u" data-mode={dark ? 'dark' : 'light'}>
        <Home
          go={(where) => go(me.signedIn ? (me.connected ? 'dash' : 'connect') : where)}
          dark={dark}
          setDark={setDark}
        />
      </div>
    );
  }

  if (!me.signedIn || screen === 'signin' || screen === 'signup' || screen === 'signincode') {
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

  /* Before any traffic has arrived Connect is the whole app: a three step guide on its own
     page, with nothing beside it to wander off into. Once a customer is connected the same
     screen becomes an ordinary page inside the app, showing the endpoint, the key and the
     snippets, so they can come back to look something up or wire a second service without
     being walked through getting started all over again. */
  if (screen === 'connect' && !me.onboarded) {
    return (
      <div className="u" data-mode={dark ? 'dark' : 'light'}>
        <ConnectWizard go={go} dark={dark} setDark={setDark}
          freshKey={freshKey} onFreshKey={setFreshKey}
          onDone={async () => { await api.finishOnboarding(); setMe(await api.me()); }} />
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
        onSignOut={async () => { await api.signOut(); setMe({ signedIn: false }); go('home'); }}
      >
        {body()}
      </Shell>
    </div>
  );
}
