# -*- coding: utf-8 -*-
import io, json, re, os
H = "/Applications/MAMP/htdocs/understudy/design/homepage/"
D = "/Applications/MAMP/htdocs/understudy/design/dash/"
B = json.load(io.open("/Users/sherancorera/.claude/jobs/9826f4fb/tmp/boards.json"))

src = io.open(H + "Dashboard.dc.html", encoding="utf-8").read()
head = src[:src.index('<div class="u"')]
utag = re.search(r'<div class="u"[^>]*>', src).group(0)
shell = src[src.index('  <div class="shell">'):src.index('    <div class="phead">')]
ACCT = ('<div class="acctwrap">'
        '<button class="acctbtn" onClick="{{toggleAcct}}" aria-label="Your account">'
        '<span class="av">S</span><span class="who">Sheran Corera</span></button>'
        '<sc-if value="{{acctOpen}}" hint-placeholder-val="{{true}}">'
        '<div class="acctpop">'
        '<div class="acctid"><span class="av avlg">S</span>'
        '<div><div class="acctn">Sheran Corera</div><div class="accte">sheran@understudy.dev</div></div></div>'
        '<a class="acctrow lnk"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        'stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.4"></circle>'
        '<path d="M5 20a7 7 0 0114 0"></path></svg>Account settings</a>'
        '<a class="acctrow lnk"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        'stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2">'
        '</rect><path d="M3 10.5h18"></path></svg>Billing and balance</a>'
        '<div class="acctsep"></div>'
        '<button class="acctrow acctout" onClick="{{toggleAcct}}">'
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
        'stroke-linecap="round" aria-hidden="true"><path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4"></path>'
        '<path d="M16 15l4-3-4-3"></path><path d="M20 12H10"></path></svg>Sign out</button>'
        '</div></sc-if></div>')
old_foot = '<div class="sidefoot"><span class="av">S</span><span class="who">Your workspace</span>'
assert old_foot in shell, "sidebar footer not found"
shell = shell.replace(old_foot, '<div class="sidefoot">' + ACCT)
tail = src[src.index('  </main>\n    </div>'):]

CSS = """
    .split2 { display: grid; grid-template-columns: minmax(0, 1.85fr) minmax(0, 1fr); gap: 14px; margin-top: 20px; align-items: stretch; }
    .panel2 { border: 1px solid var(--line); border-radius: 14px; background: var(--raise); display: flex; flex-direction: column; }
    .p2head { display: flex; align-items: center; gap: 14px; padding: 17px 20px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .p2head h2, .p2head h3 { font-size: 15.5px; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
    .p2body { padding: 14px 16px 6px; }
    .lgd { margin-left: auto; display: flex; gap: 18px; align-items: center; font-size: 12.5px; color: var(--mut-read); }
    .lgd span { display: inline-flex; align-items: center; gap: 8px; }
    .lgd .ln { width: 22px; height: 0; border-top: 2.4px solid var(--brand); border-radius: 2px; }
    .lgd .ln.dash { border-top: 2px dashed var(--line-strong); }
    .feedhead { display: flex; align-items: center; gap: 12px; padding: 17px 18px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .feed { display: grid; }
    .fr { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; gap: 11px; align-items: start;
          padding: 13px 18px; border-top: 1px solid var(--line); }
    .fr:first-child { border-top: 0; }
    .fd { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; background: var(--line-strong); }
    .fd.ok { background: var(--ok); } .fd.on { background: var(--brand); } .fd.bad { background: var(--bad); }
    .ft { font-size: 13px; line-height: 1.5; }
    .fw { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; color: var(--mut);
          white-space: nowrap; padding-top: 2px; }
    .opt { margin-top: 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--raise); overflow: hidden; }
    .opthead { display: flex; align-items: baseline; gap: 16px; padding: 17px 20px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .opthead h2 { font-size: 15.5px; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
    .opthead .s { margin-left: auto; font-size: 13px; color: var(--mut); }
    .opthrow, .optrow { display: grid;
        grid-template-columns: minmax(0, 1.1fr) 74px 90px 104px minmax(0, 1fr) 158px 16px;
        gap: 20px; align-items: center; padding: 15px 20px; }
    .opthrow { background: var(--panel); border-bottom: 1px solid var(--line); }
    .opthrow span { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; letter-spacing: 0.1em;
                    text-transform: uppercase; color: var(--mut); font-weight: 700; }
    .optrow { border-top: 1px solid var(--line); cursor: pointer; }
    .optrow:first-of-type { border-top: 0; }
    .optrow:hover { background: var(--panel); }
    .on { font-size: 14.5px; font-weight: 600; letter-spacing: -0.015em; }
    .num { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 13.5px; text-align: right; }
    .shp { font-size: 13px; color: var(--mut-read); }
    .mdl { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12.5px; }
    .chev { color: var(--mut); display: flex; }
    .optrow .pill, .cdrow .pill { white-space: nowrap; }
    .mini { font: inherit; font-size: 13px; font-weight: 600; line-height: 1; padding: 11px 15px; border-radius: 9px;
            border: 1px solid var(--brand); background: var(--brand); color: #fff; cursor: pointer; white-space: nowrap; }
    .minig { font: inherit; font-size: 13px; font-weight: 600; line-height: 1; padding: 11px 15px; border-radius: 9px;
             border: 1px solid var(--line-strong); background: transparent; color: var(--mut-read); cursor: pointer; white-space: nowrap; }
    .facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-top: 20px; }
    .dhead { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .dback { font-size: 13px; color: var(--mut); display: block; margin-bottom: 10px; }
    .dcard { margin-top: 20px; border: 1px solid var(--line); border-radius: 14px; background: var(--raise); padding: 22px 22px 24px; }
    .dcard h2 { font-size: 19px; font-weight: 700; letter-spacing: -0.025em; margin: 0 0 8px; }
    .dcard p { font-size: 14.5px; line-height: 1.6; color: var(--mut-read); margin: 0; max-width: 62ch; }
    .dacts { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
    .choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 20px; }
    .choicebox { text-align: left; border: 1px solid var(--line); border-radius: 12px; background: var(--panel);
                 padding: 15px 16px; cursor: pointer; font: inherit; color: var(--fg); }
    .cbt { color: var(--fg); }
    .choicebox.picked { border-color: var(--brand); background: var(--brandq); }
    .cbt { font-size: 14px; font-weight: 600; letter-spacing: -0.015em; display: block; }
    .cbs { font-size: 12.5px; line-height: 1.5; color: var(--mut-read); display: block; margin-top: 5px; }
    .dcard.hot { border-color: var(--brand); background: var(--brandq); }
    .dcard.done { border-color: var(--ok); background: var(--okq); }
    .dcard.done .choicebox { background: var(--raise); }
    .kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 20px; max-width: 640px; }
    .kpi { border: 1px solid var(--line); border-radius: 12px; background: var(--raise); padding: 15px 17px 16px; }
    .kk { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; letter-spacing: 0.11em;
          text-transform: uppercase; font-weight: 700; color: var(--mut); }
    .kv { font-size: 30px; font-weight: 700; letter-spacing: -0.035em; margin-top: 7px; line-height: 1.05; }
    .dcard.hot .kv { color: var(--brand); }
    .dcard.done .kv { color: var(--ok); }
    .ks { font-size: 12.5px; line-height: 1.5; color: var(--mut-read); margin-top: 7px; }
    .side { overflow: visible; }
    .acctwrap { position: relative; display: flex; align-items: center; min-width: 0; }
    .acctbtn { display: flex; align-items: center; gap: 10px; background: none; border: 0; padding: 5px 6px;
               margin: -5px -6px; border-radius: 9px; cursor: pointer; color: var(--fg); font: inherit;
               min-width: 0; }
    .acctbtn:hover { background: var(--grid); }
    .acctpop { position: absolute; bottom: calc(100% + 12px); left: 0; width: 246px; z-index: 60;
               border: 1px solid var(--line); border-radius: 13px; background: var(--raise);
               box-shadow: 0 18px 44px rgba(0, 0, 0, 0.2); padding: 7px; }
    .acctid { display: flex; align-items: center; gap: 11px; padding: 10px 10px 12px; }
    .avlg { width: 34px; height: 34px; font-size: 14px; flex: 0 0 auto; }
    .acctn { font-size: 13.5px; font-weight: 600; letter-spacing: -0.015em; }
    .accte { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; color: var(--mut);
             margin-top: 2px; }
    .acctrow { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border-radius: 8px;
               font: inherit; font-size: 13.5px; color: var(--fg); background: none; border: 0; cursor: pointer;
               text-align: left; }
    .acctrow:hover { background: var(--grid); }
    .acctrow svg { color: var(--mut); flex: 0 0 auto; }
    .acctrow.acctout { color: var(--bad); }
    .acctrow.acctout svg { color: var(--bad); }
    .acctsep { height: 1px; background: var(--line); margin: 7px 4px; }
    .gthead, .gtrow { display: grid; gap: 20px; align-items: center; padding: 14px 20px; }
    .gthead { background: var(--panel); border-bottom: 1px solid var(--line); }
    .gthead span { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; letter-spacing: 0.1em;
                   text-transform: uppercase; color: var(--mut); font-weight: 700; }
    .gtrow { border-top: 1px solid var(--line); }
    .gtrow:first-of-type { border-top: 0; }
    .kvrow { display: flex; align-items: baseline; gap: 18px; padding: 15px 20px; border-top: 1px solid var(--line);
             flex-wrap: wrap; }
    .kvrow:first-of-type { border-top: 0; }
    .kvk { font-size: 13.5px; color: var(--mut); flex: 0 0 168px; }
    .kvv { font-size: 14px; }
    .kvm { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 13px; }
    .kvs { font-size: 12.5px; color: var(--mut); }
    .kva { margin-left: auto; display: flex; align-items: center; gap: 12px; }
    .sw { width: 38px; height: 22px; border-radius: 11px; background: var(--grid); border: 1px solid var(--line);
          position: relative; cursor: pointer; padding: 0; flex: 0 0 auto; }
    .sw.swon { background: var(--brand); border-color: var(--brand); }
    .sw i { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
            background: var(--raise); display: block; }
    .sw.swon i { left: 18px; background: #fff; }
    .eyebrow { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; letter-spacing: 0.11em;
               text-transform: uppercase; font-weight: 700; color: var(--brand); display: block; margin-bottom: 9px; }
    .dcard.hot .choicebox { background: var(--raise); }
    .cbody { padding: 18px 20px 10px; }
    .eyebrow.eyeok { color: var(--ok); }
    .barcard { margin-top: 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--raise); overflow: hidden; }
    .barlead { padding: 20px 22px 0; font-size: 14.5px; line-height: 1.6; color: var(--mut-read); max-width: 74ch; }
    .steps { display: grid; gap: 16px; padding: 18px 22px 22px; }
    .stp { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 14px; align-items: start; }
    .stpn { width: 26px; height: 26px; border-radius: 50%; background: var(--brandq); color: var(--brand);
            font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; font-weight: 700;
            display: flex; align-items: center; justify-content: center; }
    .stpt { font-size: 14.5px; line-height: 1.6; color: var(--mut-read); max-width: 72ch; }
    .stpt b { color: var(--fg); font-weight: 600; }
    .sheetwrap { display: grid; gap: 32px; margin-top: 26px; }
    .vhead { display: flex; align-items: baseline; gap: 12px; margin-bottom: 11px; flex-wrap: wrap; }
    .vkey { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; letter-spacing: 0.11em;
            text-transform: uppercase; font-weight: 700; color: var(--brand); }
    .vkey.was { color: var(--mut); }
    .vdesc { font-size: 13px; color: var(--mut); }
    .sheetlead { font-size: 14.5px; line-height: 1.6; color: var(--mut-read); max-width: 70ch; margin: 0 0 4px; }
    .oneline { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; font-size: 13.5px;
               line-height: 1.6; color: var(--mut-read); padding: 15px 2px; border-top: 1px solid var(--line);
               border-bottom: 1px solid var(--line); }
    .oneline b { color: var(--fg); font-weight: 600; }
    .oneline a { color: var(--brand); font-weight: 600; cursor: pointer; white-space: nowrap; }
    .trigrow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .whyb { font: inherit; font-size: 13px; color: var(--mut-read); background: none; border: 0; cursor: pointer;
            display: inline-flex; align-items: center; gap: 7px; padding: 4px 2px; }
    .whyi { width: 17px; height: 17px; border-radius: 50%; border: 1px solid var(--line-strong); color: var(--mut);
            font-size: 10.5px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
    .pop { margin-top: 12px; max-width: 430px; border: 1px solid var(--line); border-radius: 13px;
           background: var(--raise); box-shadow: 0 14px 34px rgba(0, 0, 0, 0.13); padding: 17px 19px 19px; }
    .pophead { display: flex; align-items: baseline; gap: 12px; margin-bottom: 9px; }
    .pophead h3 { font-size: 14.5px; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
    .popx { margin-left: auto; color: var(--mut); font-size: 16px; line-height: 1; cursor: pointer;
             background: none; border: 0; padding: 0 2px; font-family: inherit; }
    .trigwrap { margin-left: auto; align-self: center; position: relative; }
    .ovis { overflow: visible; }
    .popover { position: absolute; right: 0; top: calc(100% + 11px); width: 404px; z-index: 40;
               box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18); }
    .pop p { font-size: 13px; line-height: 1.6; color: var(--mut-read); margin: 0 0 8px; }
    .pop p:last-child { margin-bottom: 0; }
    .pop b { color: var(--fg); font-weight: 600; }
    .fstrip { display: flex; align-items: center; gap: 16px; padding: 22px; flex-wrap: wrap; }
    .ftile { flex: 1; min-width: 146px; border: 1px solid var(--line); border-radius: 12px; padding: 15px 17px;
             background: var(--panel); }
    .ftile.hot { border-color: var(--brand); background: var(--brandq); }
    .fv { font-size: 25px; font-weight: 700; letter-spacing: -0.03em; }
    .ftile.hot .fv { color: var(--brand); }
    .fk { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; letter-spacing: 0.08em;
          text-transform: uppercase; color: var(--mut); margin-top: 6px; }
    .farr { color: var(--mut); font-size: 17px; }
    .cdhrow, .cdrow { display: grid; grid-template-columns: minmax(0, 1.55fr) 74px 124px 118px 150px;
                      gap: 20px; align-items: center; padding: 14px 20px; }
    .cdrow.cur { background: var(--panel); }
    .cdhrow { background: var(--panel); border-bottom: 1px solid var(--line); }
    .cdhrow span { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; letter-spacing: 0.1em;
                   text-transform: uppercase; color: var(--mut); font-weight: 700; }
    .cdrow { border-top: 1px solid var(--line); }
    .cdrow:first-of-type { border-top: 0; }
    .barnote { font-size: 13px; line-height: 1.6; color: var(--mut); padding: 16px 20px 18px; border-top: 1px solid var(--line); }
    .optempty { padding: 26px 20px 30px; text-align: center; font-size: 14px; color: var(--mut-read); line-height: 1.6; }
    @media (max-width: 1100px) { .split2 { grid-template-columns: minmax(0, 1fr); }
                                 .facts, .choices { grid-template-columns: minmax(0, 1fr); }
                                 .opthrow, .optrow { grid-template-columns: minmax(0, 1fr) 128px; }
                                 .cdhrow, .cdrow { grid-template-columns: minmax(0, 1fr) 128px; }
                                 .opthrow span:nth-child(n+2):not(:nth-child(6)),
                                 .optrow > :nth-child(n+2):not(:nth-child(6)),
                                 .cdhrow span:nth-child(n+2):not(:last-child),
                                 .cdrow > :nth-child(n+2):not(:last-child) { display: none; } }
"""
LEG = ('<div class="lgd"><span><i class="ln"></i>What you paid</span>'
       '<span><i class="ln dash"></i>On your own models</span></div>')

def tiles(rows):
    return "\n".join(['    <div class="tiles">'] +
        ['      <div class="tile"><div class="k">%s</div><div class="v">%s</div><div class="s">%s</div></div>' % tuple(r)
         for r in rows] + ['    </div>'])

def feed(rows):
    out = ['        <div class="feedhead"><h3>Live activity</h3></div>', '        <div class="feed">']
    for kind, txt, when in rows:
        out.append('          <div class="fr"><span class="fd %s"></span><div class="ft">%s</div>'
                   '<div class="fw">%s</div></div>' % (kind, txt, when))
    return "\n".join(out + ['        </div>'])

CHEV = ('<span class="chev"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        'stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></span>')

def workloads(rows):
    out = ['    <section class="opt">',
           '      <div class="opthead"><h2>Your workloads</h2></div>',
           '      <div class="opthrow"><span>Workload</span><span style="text-align:right;">Calls</span><span>Shape</span>'
           '<span style="text-align:right;">Current cost</span><span>Current model</span><span>Status</span><span></span></div>']
    for r in rows:
        out.append('      <div class="optrow"><div class="on">%s</div><div class="num">%s</div><div class="shp">%s</div>'
                   '<div class="num">%s</div><div class="mdl">%s</div>'
                   '<div><span class="pill %s">%s</span></div>%s</div>'
                   % (r["name"], r["calls"], r["shape"], r["cost"], r["model"], r["pill"], r["status"], CHEV))
    return "\n".join(out + ['    </section>'])

def words(html):
    """Words a reader actually sees, so the counts on the sheet are not guesses."""
    txt = re.sub(r"<[^>]+>", " ", html)
    for ent, rep in (("&middot;", " "), ("&mdash;", " "), ("&times;", "x"), ("&#8594;", " ")):
        txt = txt.replace(ent, rep)
    return len([w for w in re.split(r"\s+", txt) if w.strip(".,")])

def block(key, desc, body, was=False):
    return ("\n".join(['    <section>',
                       '      <div class="vhead"><span class="vkey%s">%s</span>'
                       '<span class="vdesc">%s</span></div>' % (" was" if was else "", key, desc)])
            + "\n" + body + "\n    </section>")

def sheet(b):
    cur = ["      <div class=\"opthead\"><h2>How your bar is set</h2></div>",
           '      <p class="barlead">%s</p>' % b["barlead"], '      <div class="steps">']
    for i, (lead, rest) in enumerate(b["steps"]):
        cur.append('        <div class="stp"><span class="stpn">%d</span>'
                   '<span class="stpt"><b>%s</b> %s</span></div>' % (i + 1, lead, rest))
    cur += ['      </div>', '      <div class="barnote">%s</div>' % b["barfoot"]]
    current = '    <section class="barcard">\n' + "\n".join(cur) + '\n    </section>'

    a = ('    <section class="barcard">\n'
         '      <div class="opthead"><h2>How your bar is set</h2></div>\n'
         '      <div style="padding: 20px 22px 10px;">%s</div>\n'
         '      <div class="barnote">Your bar is how much your own model disagrees with itself. A candidate is '
         'measured the same way on the same calls and has to stay inside it.</div>\n'
         '    </section>' % b["diagram"])

    bb = ('    <div class="oneline"><span>Your bar is <b>3.00%</b>, how often openai/gpt-5.4 disagreed with '
          'itself across 120 of your own calls, each one run twice.</span>'
          '<a class="lnk">How this works &#8594;</a></div>')

    trig = ('    <div class="trigrow"><span class="pill go">Your bar &middot; 3.00%</span>'
         '<button class="whyb"><span class="whyi">?</span> How is this set?</button></div>')
    c = (trig + '\n'
         '    <div class="pop">\n'
         '      <div class="pophead"><h3>How your bar is set</h3><span class="popx">&times;</span></div>\n'
         '      <p>We take 120 of your real calls and run each one twice on openai/gpt-5.4.</p>\n'
         '      <p>Your own model did not give the same answer both times on 3.00% of them.</p>\n'
         '      <p><b>That 3.00% is your bar.</b> A candidate is measured the same way on the same calls, '
         'and has to stay inside it.</p>\n'
         '    </div>')

    d = ('    <section class="barcard">\n'
         '      <div class="fstrip">\n'
         '        <div class="ftile"><div class="fv">120</div><div class="fk">of your own calls</div></div>\n'
         '        <span class="farr">&#8594;</span>\n'
         '        <div class="ftile"><div class="fv">2&times;</div><div class="fk">each, on gpt-5.4</div></div>\n'
         '        <span class="farr">&#8594;</span>\n'
         '        <div class="ftile hot"><div class="fv">3.00%</div>'
         '<div class="fk">differed &middot; your bar</div></div>\n'
         '      </div>\n'
         '      <div class="barnote">Your own model does not always agree with itself. Whatever that gap is, '
         'a candidate has to stay inside it.</div>\n'
         '    </section>')

    return "\n".join([
        '    <div class="phead" style="display: block;">',
        '      <h1 style="margin: 0 0 10px;">How your bar is set</h1>',
        '      <p class="sheetlead">%s</p>' % b["lead"], '    </div>',
        '    <div class="sheetwrap">',
        block("Now", "Lead paragraph and three numbered steps. %d words on the page." % words(current),
              current, True),
        block("A &middot; diagram", "The picture carries it, with one sentence underneath. %d words." % words(a), a),
        block("B &middot; one line", "No card at all. Sits under the chart, with a link for the rest. %d words."
              % words(bb), bb),
        block("C &middot; on request", "A chip and a question, %d words, until someone asks. Then the popup."
              % words(trig), c),
        block("D &middot; formula", "Three numbers that read as a sentence. %d words." % words(d), d),
        '    </div>'])

def gtable(title, note, cols, rows):
    """cols: (label, width, align). rows: list of cell HTML, already aligned."""
    grid = " ".join(w for _, w, _ in cols)
    st = 'style="grid-template-columns: %s;"' % grid
    out = ['    <section class="opt">',
           '      <div class="opthead"><h2>%s</h2>%s</div>'
           % (title, '<span class="s">%s</span>' % note if note else ""),
           '      <div class="gthead" %s>%s</div>'
           % (st, "".join('<span style="text-align: %s;">%s</span>' % (a, c) for c, _, a in cols))]
    for r in rows:
        out.append('      <div class="gtrow" %s>%s</div>' % (st, "".join(r)))
    return "\n".join(out + ['    </section>'])

def kvcard(title, rows, note=None):
    """rows: (label, value HTML, action HTML or None)."""
    out = ['    <section class="opt">',
           '      <div class="opthead"><h2>%s</h2>%s</div>'
           % (title, '<span class="s">%s</span>' % note if note else "")]
    for k, v, act in rows:
        out.append('      <div class="kvrow"><span class="kvk">%s</span><span class="kvv">%s</span>%s</div>'
                   % (k, v, '<span class="kva">%s</span>' % act if act else ""))
    return "\n".join(out + ['    </section>'])

def sw(on):
    return '<button class="sw%s" aria-label="%s"><i></i></button>' % (
        " swon" if on else "", "Turn off" if on else "Turn on")

def page(b):
    out = ['    <div class="phead"><h1>%s</h1>%s</div>'
           % (b["name"], '<button class="chip">%s</button>' % b["chip"] if b.get("chip") else "")]
    if b.get("tiles"):
        out.append(tiles(b["tiles"]))
    if b.get("rows"):
        out.append(workloads(b["rows"]))
    if b.get("models"):
        cols = [("Model", "minmax(0, 1.5fr)", "left"), ("Price per 1M", "128px", "right"),
                ("Open weights", "104px", "center"), ("Where it runs", "minmax(0, 1.2fr)", "left"),
                ("Enabled", "78px", "right")]
        rows = []
        for m, price, open_w, where, on in b["models"]:
            rows.append(['<div class="mdl">%s</div>' % m,
                         '<div class="num">%s</div>' % price,
                         '<div class="shp" style="text-align: center;">%s</div>' % open_w,
                         '<div class="shp">%s</div>' % where,
                         '<div style="text-align: right;">%s</div>' % sw(on)])
        out.append(gtable("Candidate models",
                          "We only try what you enable here, and every one is measured on your own calls "
                          "before anything switches.", cols, rows))
        out.append(kvcard("Provider rules", [
            ("Zero data retention only", "Calls only go to providers that keep nothing.", sw(True)),
            ("Skip preview and alias models", "An alias can change model under you, so a result would not hold.",
             sw(True)),
            ("Try new models automatically", "We add a model to your candidates when one lands that could win.",
             sw(True))]))
    if b.get("keys"):
        out.append(kvcard("Account", [
            ("Name", "Sheran Corera", '<button class="minig">Edit</button>'),
            ("Email", '<span class="kvm">sheran@understudy.dev</span>', '<button class="minig">Change</button>'),
            ("Workspace", "Understudy", '<button class="minig">Rename</button>')]))
        cols = [("Name", "minmax(0, 1fr)", "left"), ("Prefix", "148px", "left"),
                ("Created", "138px", "left"), ("Last used", "138px", "left"), ("", "92px", "right")]
        rows = [['<div class="on">%s</div>' % k[0], '<div class="mdl">%s</div>' % k[1],
                 '<div class="shp">%s</div>' % k[2], '<div class="shp">%s</div>' % k[3],
                 '<div style="text-align: right;"><button class="minig">Revoke</button></div>'] for k in b["keys"]]
        out.append(gtable("API keys", "A key is shown once, when it is created.", cols, rows))
        out.append(kvcard("Money", [
            ("Balance", '<span class="kvm">$42.18</span>', '<button class="mini">Add credit</button>'),
            ("Automatic top up", "Charge $20.00 when the balance falls below $5.00.", sw(True)),
            ("Card", '<span class="kvm">Visa &middot;&middot;&middot;&middot; 4242</span>',
             '<button class="minig">Replace</button>')]))
        out.append(kvcard("Data", [
            ("Keep call content for", '<span class="kvm">30 days</span>',
             '<button class="minig">Change</button>'),
            ("Zero data retention", "Every routed call goes only to providers that keep nothing.", sw(True))]))
    return "\n".join(out)

def detail(b):
    out = ['    <div class="phead" style="display: block;">',
           '      <span class="dback">&#8592; Workloads</span>',
           '      <div class="dhead"><h1 style="margin: 0;">%s</h1><span class="pill %s">%s</span></div>'
           % (b["name"], b["pill"], b["status"]), '    </div>',
           '    <div class="facts">']
    for k, v, sub in b["tiles"]:
        out.append('      <div class="tile"><div class="k">%s</div><div class="v">%s</div><div class="s">%s</div></div>'
                   % (k, v, sub))
    out += ['    </div>', '    <section class="dcard%s">' % b["tone"]]
    if b["eyebrow"]:
        out.append('      <span class="eyebrow%s">%s</span>' % (" eyeok" if b["eyeok"] else "", b["eyebrow"]))
    out += ['      <h2>%s</h2>' % b["head"], '      <p>%s</p>' % b["body"]]
    if b.get("kpis"):
        out.append('      <div class="kpis">')
        for k, v, sub in b["kpis"]:
            out.append('        <div class="kpi"><div class="kk">%s</div><div class="kv">%s</div>'
                       '<div class="ks">%s</div></div>' % (k, v, sub))
        out.append('      </div>')
    if b["acts"]:
        out.append('      <div class="dacts">%s</div>'
                   % "".join('<button class="%s">%s</button>' % ("mini" if pri else "minig", lab)
                             for lab, pri in b["acts"]))
    out.append('      <div class="choices">')
    for i, (t_, sub) in enumerate(b["choices"]):
        out.append('        <button class="choicebox%s"><span class="cbt">%s</span><span class="cbs">%s</span></button>'
                   % (" picked" if i == b["picked"] else "", t_, sub))
    out += ['      </div>', '    </section>']
    if b["cands"] is None:
        out += ['    <section class="opt">',
                '      <div class="opthead"><h2>Candidates tested</h2></div>',
                '      <div class="optempty">%s</div>' % b["empty"], '    </section>']
    else:
        out += ['    <section class="opt%s">' % (" ovis" if "trigwrap" in b["chartaside"] else ""),
                '      <div class="opthead"><h2>How the candidates compare</h2>%s</div>'
                % b["chartaside"],
                '      <div class="cbody">%s</div>' % b["chartc"], '    </section>',
                '    <section class="opt">',
                '      <div class="opthead"><h2>Candidates tested</h2>'
                '<span class="s">%s</span></div>' % b["candnote"],
                '      <div class="cdhrow"><span>Model</span><span style="text-align:right;">Runs</span>'
                '<span style="text-align:right;">Disagreement</span>'
                '<span style="text-align:right;">Cost a month</span><span>Verdict</span></div>']
        for m, runs, gap, cost, verdict, pill in b["cands"]:
            cur = " cur" if verdict in ("Current model", "Previous model") else ""
            out.append('      <div class="cdrow%s"><div class="mdl">%s</div><div class="num">%s</div>'
                       '<div class="num">%s</div><div class="num">%s</div>'
                       '<div><span class="pill %s">%s</span></div></div>'
                       % (cur, m, runs, gap, cost, pill, verdict))
        out.append('    </section>')
    if not b["barcard"]:
        return "\n".join(out)
    out += ['    <section class="barcard">',
            '      <div class="opthead"><h2>How your bar is set</h2></div>',
            '      <p class="barlead">%s</p>' % b["barlead"], '      <div class="steps">']
    for i, (lead, rest) in enumerate(b["steps"]):
        out.append('        <div class="stp"><span class="stpn">%d</span>'
                   '<span class="stpt"><b>%s</b> %s</span></div>' % (i + 1, lead, rest))
    out += ['      </div>', '      <div class="barnote">%s</div>' % b["barfoot"], '    </section>']
    return "\n".join(out)

for i, b in enumerate(B):
    if b["kind"] == "page":
        content, phead = page(b), ""
    elif b["kind"] == "sheet":
        content, phead = sheet(b), ""
    elif b["kind"] == "detail":
        content, phead = detail(b), ""
    else:
        content = "\n".join([
            tiles(b["tiles"]),
            '    <div class="split2">',
            '      <section class="panel2">',
            '        <div class="p2head"><h2>Daily spend</h2>%s</div>' % (LEG if b.get("legend", True) else ""),
            '        <div class="p2body">%s</div>' % b["chart"],
            '      </section>',
            '      <section class="panel2">',
            feed(b["feed"]),
            '      </section>',
            '    </div>',
            workloads(b["rows"]),
        ])
        phead = '    <div class="phead"><h1>Dashboard</h1><button class="chip">%s</button></div>\n' % b["chip"]
    h = head if ".split2 {" in head else head.replace("\n  </style>", CSS + "  </style>")
    if b["kind"] == "sheet":
        h = h.replace("\n  </style>", "    aside.side { display: none; }\n"
                                       "    .page { max-width: 1180px; }\n  </style>")
    h = h.replace("min-height: 1460px", "min-height: %dpx" % b["h"])
    name = "Main.dc.html" if i == 0 else "V%s.dc.html" % b["tag"]
    t2 = (tail.replace("const navOpen = 'navOpen' in s ? s.navOpen : true;",
                       "const navOpen = 'navOpen' in s ? s.navOpen : true;\n"
                       "    const acctOpen = 'acctOpen' in s ? s.acctOpen : %s;" % ("true" if b.get("acct") else "false"))
              .replace("toggleTheme: () => this.setState({ dark: !dark, navOpen }),",
                       "toggleTheme: () => this.setState({ dark: !dark, navOpen, acctOpen }),")
              .replace("toggleNav: () => this.setState({ dark, navOpen: !navOpen }),",
                       "toggleNav: () => this.setState({ dark, navOpen: !navOpen, acctOpen }),\n"
                       "      acctOpen, toggleAcct: () => this.setState({ dark, navOpen, acctOpen: !acctOpen }),"))
    assert "toggleAcct:" in t2, "account not wired"
    if "{{toggleBar}}" in content:
        t2 = (t2.replace("const navOpen = 'navOpen' in s ? s.navOpen : true;",
                           "const navOpen = 'navOpen' in s ? s.navOpen : true;\n"
                           "    const barOpen = 'barOpen' in s ? s.barOpen : false;")
                  .replace("toggleTheme: () => this.setState({ dark: !dark, navOpen, acctOpen }),",
                           "toggleTheme: () => this.setState({ dark: !dark, navOpen, acctOpen, barOpen }),")
                  .replace("acctOpen, toggleAcct: () => this.setState({ dark, navOpen, acctOpen: !acctOpen }),",
                           "acctOpen, toggleAcct: () => this.setState({ dark, navOpen, acctOpen: !acctOpen, barOpen }),\n"
                           "      barOpen, toggleBar: () => this.setState({ dark, navOpen, acctOpen, barOpen: !barOpen }),"))
        assert "toggleBar:" in t2 and "const barOpen" in t2, "bar not wired"
    if b.get("here"):
        t2 = t2.replace("const here = 'dash';", "const here = '%s';" % b["here"])
        assert "const here = '%s';" % b["here"] in t2, "nav highlight not set"
    io.open(D + name, "w", encoding="utf-8").write(
        h + utag.replace("min-height: 1460px", "min-height: %dpx" % b["h"]) + "\n" + shell +
        phead + content + "\n" + t2)
keep = set(["Main.dc.html"] + ["V%s.dc.html" % b["tag"] for b in B[1:]])
for stale in os.listdir(D):
    if stale.endswith(".dc.html") and stale not in keep:
        os.remove(D + stale)
ROW = {"dash": 0, "detail": 1, "page": 2, "sheet": 3}
seen = {}
arts = []
for i, b in enumerate(B):
    r = ROW[b["kind"]]
    c = seen.get(r, 0)
    seen[r] = c + 1
    arts.append({"file": "Main.dc.html" if i == 0 else "V%s.dc.html" % b["tag"],
                 "x": c * 1560, "y": [0, 1290, 3550, 5000][r],
                 "w": 1440, "h": b["h"], "title": "%s  %s" % (b["tag"], b["title"]),
                 "expand": "fill", "is_interactive": True})
io.open(D + "canvas.json", "w", encoding="utf-8").write(json.dumps(
    {"artboards": arts, "launch": {"view": "canvas"}}, indent=2) + "\n")
print("ok: %d boards written" % len(B))
