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

const APP = new Set(['dash', 'work', 'models', 'settings']);

export default function App() {
  const [me, setMe] = useState(null);
  const [{ screen, openId }, setWhere] = useState(() => parse());
  const [freshKey, setFreshKey] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
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
    if (me?.signedIn && (screen === 'signin' || screen === 'signup')) {
      const home = me.connected ? 'dash' : 'connect';
      navigate(home, null, { replace: true });
      setWhere({ screen: home, openId: null });
    }
  }, [me, screen]);

  const load = useCallback(async (which) => {
    setErr(null);
    try {
      if (which === 'dash' || which === 'work') setData(await api.overview());
      else if (which === 'models') setData(await api.models());
      else if (which === 'settings') setData(await api.settings());
    } catch (e) { setErr(e.message); }
  }, []);

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

  if (!me.signedIn || screen === 'signin' || screen === 'signup') {
    return (
      <div className="u" data-mode={dark ? 'dark' : 'light'}>
        <Auth
          mode={screen === 'signup' ? 'signup' : 'signin'}
          go={(where) => go(where)}
          dark={dark}
          setDark={setDark}
          onDone={async (fresh, key) => {
            if (key) setFreshKey(key);
            const who = await api.me();
            setMe(who);
            go(fresh || !who.connected ? 'connect' : 'dash');
          }}
        />
      </div>
    );
  }

  if (screen === 'connect') {
    return (
      <div className="u" data-mode={dark ? 'dark' : 'light'}>
        <ConnectWizard go={go} dark={dark} setDark={setDark} freshKey={freshKey} />
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
    const open = (id) => go('work', id);
    if (screen === 'dash') return <Dashboard data={data} onOpen={open} />;
    if (screen === 'work') return <Workloads data={data} onOpen={open} />;
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
