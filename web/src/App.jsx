import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import Shell from './Shell.jsx';
import Auth from './screens/Auth.jsx';
import Dashboard from './screens/Dashboard.jsx';
import Workloads from './screens/Workloads.jsx';
import WorkloadDetail from './screens/WorkloadDetail.jsx';
import Models from './screens/Models.jsx';
import Settings from './screens/Settings.jsx';
import Connect from './screens/Connect.jsx';

const APP = new Set(['dash', 'work', 'models', 'settings', 'connect']);

export default function App() {
  const [me, setMe] = useState(null);
  const [screen, setScreen] = useState('dash');
  const [openId, setOpenId] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem('us_dark') === '1'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem('us_dark', dark ? '1' : '0'); } catch { /* private window */ }
  }, [dark]);

  useEffect(() => { api.me().then(setMe).catch(() => setMe({ signedIn: false })); }, []);

  const load = useCallback(async (which) => {
    setErr(null);
    try {
      if (which === 'dash' || which === 'work') setData(await api.overview());
      else if (which === 'models') setData(await api.models());
      else if (which === 'settings') setData(await api.settings());
      else if (which === 'connect') setData(await api.connect());
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => {
    if (me?.signedIn && APP.has(screen) && !openId) load(screen);
  }, [me, screen, openId, load]);

  const go = (next) => { setOpenId(null); setScreen(next); setData(null); };

  if (!me) return <div className="u" data-mode="light"><div className="loading">Loading…</div></div>;

  if (!me.signedIn || screen === 'signin' || screen === 'signup') {
    return (
      <div className="u" data-mode={dark ? 'dark' : 'light'}>
        <Auth
          mode={screen === 'signup' ? 'signup' : 'signin'}
          go={setScreen}
          dark={dark}
          setDark={setDark}
          onDone={async (fresh) => { setMe(await api.me()); go(fresh ? 'connect' : 'dash'); }}
        />
      </div>
    );
  }

  const here = openId ? 'work' : screen;
  const body = () => {
    if (openId) {
      return <WorkloadDetail id={openId} onBack={() => { setOpenId(null); load('work'); }}
        onChanged={() => load('work')} />;
    }
    if (err) return <div className="errbox">{err}</div>;
    if (!data) return <div className="loading">Loading…</div>;
    const open = (id) => setOpenId(id);
    if (screen === 'dash') return <Dashboard data={data} onOpen={open} />;
    if (screen === 'work') return <Workloads data={data} onOpen={open} />;
    if (screen === 'models') return <Models data={data} reload={() => load('models')} />;
    if (screen === 'settings') return <Settings data={data} reload={() => load('settings')} />;
    return <Connect data={data} reload={() => load('connect')} />;
  };

  return (
    <div className="u" data-mode={dark ? 'dark' : 'light'}>
      <Shell
        here={here}
        me={me}
        go={go}
        dark={dark}
        setDark={setDark}
        onSignOut={async () => { await api.signOut(); setMe({ signedIn: false }); setScreen('signin'); }}
      >
        {body()}
      </Shell>
    </div>
  );
}
