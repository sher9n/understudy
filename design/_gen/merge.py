# -*- coding: utf-8 -*-
"""One artboard holding every finalised screen, wired so you can walk the whole product."""
import io, re, json

H = "/Applications/MAMP/htdocs/understudy/design/homepage/"
D = "/Applications/MAMP/htdocs/understudy/design/dash/"
OUT = "/Applications/MAMP/htdocs/understudy/design/final/"
import os
os.makedirs(OUT, exist_ok=True)

app = io.open(H + "App.dc.html", encoding="utf-8").read()

# ---- the CSS the new screens need, taken from the generator so it cannot drift
n2 = io.open("/Users/sherancorera/.claude/jobs/9826f4fb/tmp/narr2.py", encoding="utf-8").read()
CSS = n2[n2.index('CSS = """') + len('CSS = """'):]
CSS = CSS[:CSS.index('"""')]
assert ".split2 {" in CSS and ".acctpop {" in CSS and ".kpis {" in CSS, "CSS block looks wrong"

def page_of(f):
    s = io.open(D + f, encoding="utf-8").read()
    a = s.index('  <main class="page">\n') + len('  <main class="page">\n')
    b = s.index('  </main>\n', a)
    return s[a:b]

# ---- split the app board
i_dash = app.index('<sc-if value="{{is_dash}}"')
i_work = app.index('<sc-if value="{{is_work}}"')
i_end = app.index('\n</div>\n</x-dc>')
before = app[:i_dash]
tail = app[i_end:]
dash_block = app[i_dash:i_work]

opener, rest = dash_block.split('\n  <div class="shell">', 1)
shell_head, after_main = rest.split('  <main class="page">\n', 1)
closer = '  </main>\n    </div>\n  </div></div></sc-if>\n'

# ---- the sidebar: the signed-in person, their panel, and two more destinations
ACCT = ('<div class="acctwrap">'
        '<button class="acctbtn" onClick="{{toggleAcct}}" aria-label="Your account">'
        '<span class="av">S</span><span class="who">Sheran Corera</span></button>'
        '<sc-if value="{{acctOpen}}" hint-placeholder-val="{{true}}">'
        '<div class="acctpop">'
        '<div class="acctid"><span class="av avlg">S</span>'
        '<div><div class="acctn">Sheran Corera</div><div class="accte">sheran@understudy.dev</div></div></div>'
        '<a class="acctrow lnk" onClick="{{go_settings}}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" '
        'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">'
        '<circle cx="12" cy="8" r="3.4"></circle><path d="M5 20a7 7 0 0114 0"></path></svg>Account settings</a>'
        '<a class="acctrow lnk" onClick="{{go_settings}}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" '
        'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">'
        '<rect x="3" y="6" width="18" height="13" rx="2"></rect><path d="M3 10.5h18"></path></svg>Billing and balance</a>'
        '<div class="acctsep"></div>'
        '<button class="acctrow acctout" onClick="{{go_signin}}">'
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
        'stroke-linecap="round" aria-hidden="true"><path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4"></path>'
        '<path d="M16 15l4-3-4-3"></path><path d="M20 12H10"></path></svg>Sign out</button>'
        '</div></sc-if></div>')
foot = '<div class="sidefoot"><span class="av">S</span><span class="who">Your workspace</span>'
assert foot in shell_head, "sidebar footer not found"
shell_head = shell_head.replace(foot, '<div class="sidefoot">' + ACCT)
for cls, handler in (("nv_models", "go_models"), ("nv_settings", "go_settings")):
    a = '<a class="{{%s}}"' % cls
    assert a in shell_head, cls
    shell_head = shell_head.replace(a, '<a class="{{%s}} lnk" onClick="{{%s}}"' % (cls, handler))

def screen(key, minh, content):
    op = opener.replace("is_dash", "is_" + key).replace("min-height: 1460px", "min-height: %dpx" % minh)
    return op + '\n  <div class="shell">' + shell_head + '  <main class="page">\n' + content + closer

# ---- the finalised pages, with their links wired
dash = page_of("V10.dc.html").replace('<div class="optrow">', '<div class="optrow" onClick="{{go_wdetail}}">')
work = page_of("V7.dc.html").replace('<div class="optrow">', '<div class="optrow" onClick="{{go_wdetail}}">')
detail = page_of("V4.dc.html").replace('<span class="dback">', '<a class="dback lnk" onClick="{{go_work}}">') \
                              .replace('&#8592; Workloads</span>', '&#8592; Workloads</a>')
models = page_of("V8.dc.html")
settings = page_of("V9.dc.html")
for nm, c in (("dash", dash), ("work", work), ("detail", detail)):
    assert "{{go_" in c, nm + " has no wired link"

body = (before
        + screen("dash", 1080, dash)
        + screen("work", 780, work)
        + screen("wdetail", 1930, detail)
        + screen("models", 1280, models)
        + screen("settings", 1280, settings))

# ---- the component learns the new screens and the two panels
t = tail
def swap(a, b):
    global t
    assert a in t and t.count(a) == 1, "COMPONENT: " + a[:70]
    t = t.replace(a, b)

swap("    const navOpen = 'navOpen' in s ? s.navOpen : true;",
     "    const navOpen = 'navOpen' in s ? s.navOpen : true;\n"
     "    const acctOpen = 'acctOpen' in s ? s.acctOpen : false;\n"
     "    const barOpen = 'barOpen' in s ? s.barOpen : false;")
swap("    const keep = { dark, screen, step, way, lang, calls, navOpen };",
     "    const keep = { dark, screen, step, way, lang, calls, navOpen, acctOpen, barOpen };\n"
     "    const here = { dash: 'dash', work: 'work', wdetail: 'work', models: 'models',\n"
     "                   settings: 'settings', connect: 'connect' }[screen] || '';")
swap("      is_connect: screen === 'connect', is_dash: screen === 'dash', is_work: screen === 'work',",
     "      is_connect: screen === 'connect', is_dash: screen === 'dash', is_work: screen === 'work',\n"
     "      is_wdetail: screen === 'wdetail', is_models: screen === 'models', is_settings: screen === 'settings',")
swap("      go_dash: put({ screen: 'dash' }), go_work: put({ screen: 'work' }),",
     "      go_dash: put({ screen: 'dash', acctOpen: false }), go_work: put({ screen: 'work', acctOpen: false }),\n"
     "      go_wdetail: put({ screen: 'wdetail', acctOpen: false, barOpen: false }),\n"
     "      go_models: put({ screen: 'models', acctOpen: false }),\n"
     "      go_settings: put({ screen: 'settings', acctOpen: false }),\n"
     "      acctOpen, toggleAcct: put({ acctOpen: !acctOpen }),\n"
     "      barOpen, toggleBar: put({ barOpen: !barOpen }),")
swap("go_signin: put({ screen: 'signin' }),", "go_signin: put({ screen: 'signin', acctOpen: false }),")
swap("    for (const k of ['dash', 'work', 'models', 'connect', 'settings'])\n"
     "      vals['nv_' + k] = (k === screen || (k === 'work' && screen === 'work')) ? 'nv on' : 'nv';",
     "    for (const k of ['dash', 'work', 'models', 'connect', 'settings'])\n"
     "      vals['nv_' + k] = k === here ? 'nv on' : 'nv';")

# ---- anything wired to a handler must also look clickable
out = body + t
n_click = 0
def mark(m):
    global n_click
    n_click += 1
    return m.group(0)[:-1] + ' data-clickable="1">'
out = re.sub(r'<(?:a|div|span|button|li)\b[^>]*onClick="\{\{[a-zA-Z_]+\}\}"[^>]*>', mark, out)
assert n_click > 20, "only %d wired elements found" % n_click
print("   %d wired elements marked" % n_click)

# ---- the new screens' CSS
assert "\n  </style>" in out
out = out.replace("\n  </style>", "\n" + CSS + "    [data-clickable] { cursor: pointer; }\n  </style>", 1)
io.open(OUT + "Main.dc.html", "w", encoding="utf-8").write(out)
io.open(OUT + "canvas.json", "w", encoding="utf-8").write(json.dumps({
    "artboards": [{"file": "Main.dc.html", "x": 0, "y": 0, "w": 1440, "h": 2000,
                   "title": "Understudy, every screen", "expand": "fill", "is_interactive": True}],
    "launch": {"view": "canvas"},
}, indent=2) + "\n")
print("ok: one board, %d screens, %d KB" % (out.count('<sc-if value="{{is_'), len(out) // 1024))
