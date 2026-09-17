# -*- coding: utf-8 -*-
import io, json, re, datetime
H = "/Applications/MAMP/htdocs/understudy/design/homepage/"
D = "/Applications/MAMP/htdocs/understudy/design/dash/"
TODAY = datetime.date(2026, 9, 17)
N = 30
DAYS = [TODAY - datetime.timedelta(days=N - 1 - i) for i in range(N)]

def dlab(d):
    return "%d %s" % (d.day, d.strftime("%b").replace("Sep", "Sept"))

def t(x, y, s, size=11, fill="var(--mut)", anchor=None, weight=None, mono=True):
    a = ' text-anchor="%s"' % anchor if anchor else ""
    w = ' font-weight="%s"' % weight if weight else ""
    c = ' class="m"' if mono else ""
    return '<text x="%.1f" y="%.1f"%s%s font-size="%s"%s fill="%s">%s</text>' % (x, y, a, c, size, w, fill, s)

CW, CH = 980, 408
L, R, T, Bm = 74, 22, 26, 62

def frame(n, ymax=None, ticks=()):
    """Gridlines, dollar labels and dated ticks for n days ending today."""
    px = lambda i: L + i * (CW - L - R) / max(1.0, n - 1.0)
    py = lambda v: CH - Bm - (v / float(ymax)) * (CH - Bm - T) if ymax else CH - Bm
    days = [TODAY - datetime.timedelta(days=n - 1 - i) for i in range(n)]
    g = []
    for v in ticks:
        g.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="var(--line)" stroke-width="1"></line>'
                 % (L, py(v), CW - R, py(v)))
        lab = ("$%.3f" % v) if ymax <= 0.05 else (("$%.2f" % v) if ymax <= 5 else ("$%d" % v))
        g.append(t(L - 11, py(v) + 3.5, lab, 10, "var(--mut)", "end"))
    if not ticks:
        for k in range(5):
            y = T + k * (CH - Bm - T) / 4.0
            g.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="var(--line)" stroke-width="1"></line>'
                     % (L, y, CW - R, y))
    g.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="var(--line-strong)" stroke-width="1.2"></line>'
             % (L, CH - Bm, CW - R, CH - Bm))
    marks = [0, n // 2, n - 1] if n < 12 else [0, n // 3, 2 * n // 3, n - 1]
    for j, i in enumerate(marks):
        anc = "start" if j == 0 else ("end" if j == len(marks) - 1 else "middle")
        g.append(t(px(i), CH - Bm + 22, dlab(days[i]), 10.5, "var(--mut)", anc))
    return g, px, py

def wrap(g, caption):
    g.append(t(CW / 2.0, CH - 12, caption, 10.5, "var(--mut)", "middle", "600"))
    return ('<svg viewBox="0 0 %d %d" width="100%%" role="img" aria-label="Daily spend. %s">%s</svg>'
            % (CW, CH, re.sub("&[a-z]+;", " ", caption), "".join(g)))

def chart(paid, would, ymax, ticks, caption):
    n = len(paid)
    g, px, py = frame(n, ymax, ticks)
    g.append('<path d="M%s" fill="none" stroke="var(--line-strong)" stroke-width="2" stroke-dasharray="6 5"></path>'
             % " L".join("%.1f %.1f" % (px(i), py(v)) for i, v in enumerate(would)))
    pts = [(px(i), py(v)) for i, v in enumerate(paid)]
    g.append('<path d="M%.1f %.1f L%s L%.1f %.1f Z" fill="var(--brand)" opacity="0.10"></path>'
             % (pts[0][0], py(0), " L".join("%.1f %.1f" % q for q in pts), pts[-1][0], py(0)))
    g.append('<path d="M%s" fill="none" stroke="var(--brand)" stroke-width="2.4" stroke-linejoin="round"></path>'
             % " L".join("%.1f %.1f" % q for q in pts))
    return wrap(g, caption)

def scatter(pts, bar, xmax, ymax, xticks, yticks):
    """Each model placed by what it costs and how far it drifted. Under the line passed."""
    W, Hh = 980, 400
    Lx, Rx, Tx, Bx = 64, 168, 34, 56
    px = lambda v: Lx + (v / float(xmax)) * (W - Lx - Rx)
    py = lambda v: Hh - Bx - (v / float(ymax)) * (Hh - Bx - Tx)
    g = []
    for v in yticks:
        g.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="var(--line)" stroke-width="1"></line>'
                 % (Lx, py(v), W - Rx, py(v)))
        g.append(t(Lx - 10, py(v) + 3.5, "%g%%" % v, 10, "var(--mut)", "end"))
    g.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="var(--brand)" opacity="0.07"></rect>'
             % (Lx, py(bar), W - Lx - Rx, py(0) - py(bar)))
    g.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="var(--brand)" stroke-width="1.6" '
             'stroke-dasharray="6 5"></line>' % (Lx, py(bar), W - Rx, py(bar)))
    g.append(t(W - Rx + 10, py(bar) + 3.5, "YOUR BAR &middot; %.2f%%" % bar, 10, "var(--brand)", "start", "700"))
    g.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="var(--line-strong)" stroke-width="1.2"></line>'
             % (Lx, py(0), W - Rx, py(0)))
    for v in xticks:
        g.append(t(px(v), Hh - Bx + 20, "$%d" % v, 10, "var(--mut)", "middle"))
    g.append(t(Lx, Tx - 12, "DISAGREEMENT WITH OPENAI/GPT-5.4, THE MODEL YOUR BAR CAME FROM", 10, "var(--mut)", "start", "700"))
    g.append(t(W - Rx, Hh - Bx + 42, "COST A MONTH", 10, "var(--mut)", "end", "700"))
    col = {"cur": "var(--mut)", "pass": "var(--brand)", "near": "var(--warn)", "fail": "var(--bad)"}
    for lab, x, y, kind, dy, anc in pts:
        if kind == "cur":
            g.append('<circle cx="%.1f" cy="%.1f" r="6.5" fill="var(--raise)" stroke="%s" stroke-width="2.2"></circle>'
                     % (px(x), py(y), col[kind]))
        else:
            g.append('<circle cx="%.1f" cy="%.1f" r="6" fill="%s"></circle>' % (px(x), py(y), col[kind]))
        g.append('<text x="%.1f" y="%.1f" class="m" text-anchor="%s" font-size="11"%s fill="%s" '
                 'stroke="var(--raise)" stroke-width="3.6" paint-order="stroke" stroke-linejoin="round">%s</text>'
                 % (px(x) + (12 if anc == "start" else -12), py(y) + 3.5 + dy, anc,
                    ' font-weight="600"' if kind == "pass" else "",
                    "var(--fg)" if kind == "pass" else "var(--mut-read)", lab))
    return ('<svg viewBox="0 0 %d %d" width="100%%" role="img" aria-label="Every model tested, placed by cost a month '
            'and how far it drifted from your current model. Anything below the dashed line cleared your bar.">%s</svg>'
            % (W, Hh, "".join(g)))

def tri(x, y):
    return ('<path d="M%.1f %.1f L%.1f %.1f L%.1f %.1f Z" fill="var(--line-strong)"></path>'
            % (x, y - 4.5, x + 7, y, x, y + 4.5))

def box(x, y, w, h, title, sub, brand=False, big=False):
    g = ['<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="11" fill="%s" stroke="%s" stroke-width="1.2"></rect>'
         % (x, y, w, h, "var(--brandq)" if brand else "var(--panel)",
            "var(--brand)" if brand else "var(--line-strong)")]
    cx = x + w / 2.0
    g.append(t(cx, y + (h / 2.0) - (3 if sub else -4), title, 16 if big else 13,
               "var(--brand)" if brand else "var(--fg)", "middle", "700" if big else "600", big))
    if sub:
        g.append(t(cx, y + h - 16, sub, 10, "var(--brand)" if brand else "var(--mut)", "middle",
                   "700" if brand else None))
    return g

def bardiagram():
    """One call, run twice, and the gap between the two answers is the bar."""
    g = []
    g += box(4, 46, 152, 66, "120 of your calls", "YOURS, NOT A BENCHMARK")
    g.append('<line x1="160" y1="79" x2="184" y2="79" stroke="var(--line-strong)" stroke-width="1.4"></line>')
    g.append(tri(184, 79))
    g += box(198, 46, 160, 66, "openai/gpt-5.4", "YOUR CURRENT MODEL")
    for yy in (37, 121):
        g.append('<path d="M360 79 C380 79 380 %d 394 %d" fill="none" stroke="var(--line-strong)" '
                 'stroke-width="1.4"></path>' % (yy, yy))
        g.append(tri(394, yy))
    g += box(404, 20, 140, 34, "answer 1", None)
    g += box(404, 104, 140, 34, "answer 2", None)
    g.append(t(474, 83, "compared", 10, "var(--mut)", "middle", "700"))
    g.append('<line x1="548" y1="79" x2="572" y2="79" stroke="var(--line-strong)" stroke-width="1.4"></line>')
    g.append(tri(572, 79))
    g += box(586, 40, 200, 78, "3.00% differed", "THAT IS YOUR BAR", True, True)
    return ('<svg viewBox="0 0 800 158" width="100%%" role="img" aria-label="120 of your calls go to openai '
            'gpt-5.4 twice. The two answers are compared, and they differed on 3.00%% of calls. That 3.00%% '
            'is your bar.">%s</svg>' % "".join(g))

def waiting(n, msg, caption):
    g, px, py = frame(n)
    g.append(t(CW / 2.0, (T + CH - Bm) / 2.0 + 4, msg, 13, "var(--mut-read)", "middle", None, False))
    return wrap(g, caption)

def ser(pairs, base=0.0):
    s = [base] * N
    for i, v in enumerate(pairs):
        s[N - len(pairs) + i] = v
    return s

def usd(x):
    return "$%s" % ("{:,.2f}".format(round(x + 1e-9, 2)))

def spent(p):
    return usd(sum(p))

def saved(p, w):
    return usd(sum(w) - sum(p))

B = []
# 1 ------------------------------------------------------------------ minute one
p1 = [0.006, 0.008]
B.append(dict(
  kind="dash", tag="1", title="Minute one", h=990, chip="Last 30 days", legend=False,
  tiles=[("Spend &middot; today", spent(p1), "6 calls so far"),
         ("Saved &middot; so far", "&mdash;", "nothing optimized yet"),
         ("Workloads", "2", "found in your first minute"),
         ("Calls", "6", "since you connected")],
  chart=waiting(7, "Your first full day of spend appears here tomorrow.", ""),
  feed=[("on",  "Grouping calls by their system prompt, tools and response format", "just now"),
        ("ok",  "Found a new workload: support-reply, free text requests on gpt-5.4", "18 seconds ago"),
        ("ok",  "Found a new workload: invoice-extract, json requests on openai/gpt-5.4", "22 seconds ago"),
        ("mut", "Key us_live_a3f2 sent its first call", "1 minute ago")],
  rows=[dict(name="invoice-extract", calls="4", shape="json", cost="$0.01",
             model="openai/gpt-5.4", status="Not optimized yet", pill="q"),
        dict(name="support-reply", calls="2", shape="free text", cost="$0.00",
             model="openai/gpt-5.4", status="Not optimized yet", pill="q")]))
# 2 -------------------------------------------------------------------- week one
p2 = [10.10, 10.40, 9.80, 10.30, 10.00, 3.51, 3.47]
w2 = [10.10, 10.40, 9.80, 10.30, 10.00, 10.27, 10.27]
B.append(dict(
  kind="dash", tag="2", title="Week one", h=1030, chip="Last 30 days",
  tiles=[("Spend &middot; last 30 days", spent(p2), "on track for $104.04 a month"),
         ("Saved &middot; so far", saved(p2, w2), "since the first switch"),
         ("Workloads", "3", "1 optimized, 1 ready, 1 measuring"),
         ("Calls", "4,820", "since you connected")],
  chart=chart(p2, w2, 12, [0, 3, 6, 9, 12], "1 WORKLOAD SWITCHED &middot; 16 SEPT"),
  feed=[("ok",  "mistral-small clears the floor on support-reply, 1.80% against a 3.00% floor", "3 hours ago"),
        ("ok",  "invoice-extract now runs on mistral-small, about $204.00 a month less", "yesterday"),
        ("bad", "gemini-flash-lite missed on doc-classify, 11.20% against a 3.00% floor", "2 days ago"),
        ("ok",  "Floor set for doc-classify at 3.00%, how much gpt-5.4 varies from itself", "3 days ago")],
  rows=[dict(name="invoice-extract", calls="2,910", shape="json", cost="$35.44",
             model="mistralai/mistral-small", status="Optimized", pill="ok"),
        dict(name="support-reply", calls="1,240", shape="free text", cost="$9.49",
             model="openai/gpt-5.4", status="Ready to optimize", pill="go"),
        dict(name="doc-classify", calls="670", shape="enum", cost="$12.65",
             model="openai/gpt-5.4", status="Measuring", pill="wait")]))
STEPS_KNOWN = [('We sample your real calls.', '120 of them, spread evenly across short and long answers, because answer length is what breaks a model first.'), ('We run each one twice on openai/gpt-5.4.', 'Your own model does not give the same answer every time. On support-reply the two runs differed on 3.00% of the calls.'), ('That 3.00% is your bar.', 'Every candidate is measured the same way on the same calls. If it differs from your model by less than your model differs from itself, your quality has not moved.')]
STEPS_SOON = [('We sample your real calls.', '120 of them, spread evenly across short and long answers, because answer length is what breaks a model first.'), ('We run each one twice on openai/gpt-5.4.', 'Your own model does not give the same answer every time. However often those two runs differ is the number we are after.'), ('That figure becomes your bar.', 'Every candidate is then measured the same way on the same calls. If it differs from your model by less than your model differs from itself, your quality has not moved.')]
BARLEAD = 'Your bar is how much your own model disagrees with itself. Nothing here is judged against a public benchmark, only against what you already run.'
BARFOOT = 'No model is judged on fewer than 100 runs, and a model we switch to is re-tested every day on fresh calls. If it stops clearing, it goes back.'
TRIGGER = ('<div class="trigwrap">'
           '<div class="trigrow"><span class="pill go">Your bar &middot; 3.00%</span>'
           '<button class="whyb" onClick="{{toggleBar}}"><span class="whyi">?</span> How is this set?</button></div>'
           '<sc-if value="{{barOpen}}" hint-placeholder-val="{{true}}">'
           '<div class="pop popover">'
           '<div class="pophead"><h3>How your bar is set</h3>'
           '<button class="popx" onClick="{{toggleBar}}" aria-label="Close">&times;</button></div>'
           '<p>We take 120 of your real calls and run each one twice on openai/gpt-5.4.</p>'
           '<p>Your own model did not give the same answer both times on 3.00% of them.</p>'
           '<p><b>That 3.00% is your bar.</b> A candidate is measured the same way on the same calls, '
           'and has to stay inside it.</p>'
           '<p>No model is judged on fewer than 100 runs.</p>'
           '</div></sc-if></div>')
CHARTNOTE = 'Cost against quality. Anything inside the shaded band cleared your bar. Models with fewer than 100 runs are not plotted.'
TABLENOTE = '4 rounds since 28 Aug, at least 120 of your own calls replayed on every model.'
CANDS = [('openai/gpt-5.4', '960', 'baseline', '$41.20', 'Current model', 'q'), ('mistralai/mistral-small', '480', '1.80%', '$9.16', 'Cleared', 'ok'), ('deepseek/deepseek-chat-v3.1', '360', '2.60%', '$11.40', 'Cleared', 'ok'), ('openai/gpt-5.6-luna', '240', '4.10%', '$8.90', 'Needs review', 'wait'), ('google/gemini-2.5-flash-lite', '360', '9.40%', '$6.80', 'Missed the bar', 'q'), ('qwen/qwen3-235b-a22b-2507', '120', '&mdash;', '$5.90', 'Still running', 'wait')]
CHOICES = [('Optimize automatically', 'We switch as soon as a candidate clears your bar, and switch back if it slips.'), ('Ask me first', 'We test and recommend. Nothing changes until you approve it.')]
CHARTC = scatter([("gpt-5.4", 41.20, 0.00, "cur", -14, "start"),
                  ("mistral-small", 9.16, 1.80, "pass", 0, "end"),
                  ("deepseek-chat-v3.1", 11.40, 2.60, "pass", 14, "start"),
                  ("gpt-5.6-luna", 8.90, 4.10, "near", 0, "start"),
                  ("gemini-flash-lite", 6.80, 9.40, "fail", 0, "start")],
                 3.00, 45, 12, [0, 10, 20, 30, 40], [0, 3, 6, 9, 12])
# 3 ---------------------------------------------------- a workload on day one
B.append(dict(
  kind="detail", tag="3", title="Workload, day one", h=1220, name="invoice-extract",
  status="Not optimized yet", pill="q", tone="", eyebrow=None, eyeok=False, kpis=None,
  tiles=[("Calls", "84", "since you connected"), ("Shape", "json", "1 tool, 14 field schema"),
         ("Current model", "gpt-5.4", "openai, your own choice"), ("Current cost", "$0.18", "last 24 hours")],
  head="We are still learning your bar",
  body="We need about 120 calls before your bar can be trusted, and you have 84. Nothing is tested against your "
       "traffic until then.",
  acts=None, picked=0, choices=CHOICES,
  chartc=None, chartaside=None, barcard=True, candnote=None, cands=None,
  empty="Candidates appear here after the first run, once your bar is set.",
  barlead=BARLEAD, steps=STEPS_SOON, barfoot=BARFOOT))
# 4 ------------------------------------- week three, left to optimize on its own
B.append(dict(
  kind="detail", tag="4", title="Workload, week three, automatic", h=1865, name="support-reply",
  status="Optimized", pill="ok", tone=" done", eyebrow="Switched automatically", eyeok=True,
  kpis=[("Accuracy", "98.2%", "of answers matched openai/gpt-5.4. Your bar is 97.0%."),
        ("Cost", "78% lower", "$41.20 a month down to $9.16. You keep $32.04.")],
  tiles=[("Calls", "5,120", "since you connected"), ("Shape", "free text", "1 tool, no schema"),
         ("Current model", "mistral-small", "mistralai, switched 9 Sept"), ("Current cost", "$28.84", "last 21 days")],
  head="mistral-small is serving support-reply",
  body="We switched it on 9 Sept without asking, because it cleared your bar. We re-test it every day on fresh "
       "calls and put you back on openai/gpt-5.4 the moment it stops clearing.",
  acts=[("Switch back to gpt-5.4", False)], picked=0, choices=CHOICES,
  chartc=CHARTC, chartaside=TRIGGER, barcard=False, candnote=TABLENOTE,
  cands=[("openai/gpt-5.4", "960", "baseline", "$41.20", "Previous model", "q"),
         ("mistralai/mistral-small", "480", "1.80%", "$9.16", "Serving now", "ok")] + CANDS[2:],
  empty=None, barlead=BARLEAD, steps=STEPS_KNOWN, barfoot=BARFOOT))
# 5 ---------------------------------------- week three, set to ask you first
B.append(dict(
  kind="detail", tag="5", title="Workload, week three, ask me first", h=1840, name="support-reply",
  status="Ready to optimize", pill="go", tone=" hot", eyebrow="A candidate is ready", eyeok=False,
  kpis=[("Accuracy", "98.2%", "of answers matched openai/gpt-5.4. Your bar is 97.0%."),
        ("Cost", "78% lower", "$41.20 a month would become $9.16. You keep $32.04.")],
  tiles=[("Calls", "5,120", "since you connected"), ("Shape", "free text", "1 tool, no schema"),
         ("Current model", "gpt-5.4", "openai, your own choice"), ("Current cost", "$28.84", "last 21 days")],
  head="mistral-small cleared your bar",
  body="It stayed inside your bar across 120 of your own calls, replayed and compared answer by answer. "
       "Nothing changes until you approve it.",
  acts=[("Approve switch", True), ("Keep testing", False)], picked=1, choices=CHOICES,
  chartc=CHARTC, chartaside=TRIGGER, barcard=False,
  candnote=TABLENOTE, cands=CANDS,
  empty=None, barlead=BARLEAD, steps=STEPS_KNOWN, barfoot=BARFOOT))
# 6 ------------------------------------------ four shorter ways to say it
B.append(dict(kind="sheet", tag="6", title="How your bar is set, 4 ways", h=1840, diagram=bardiagram(),
              lead="The version on the workload screens is a lead paragraph and three numbered steps. "
                   "Four shorter ways to carry the same idea.",
              steps=STEPS_KNOWN, barlead=BARLEAD, barfoot=BARFOOT))
# 7 ---------------------------------------------------------- the workloads page
WL = [("invoice-extract", "12,480", "json", "$22.40", "mistralai/mistral-small", "Optimized", "ok"),
      ("support-reply", "5,120", "free text", "$28.84", "mistralai/mistral-small", "Optimized", "ok"),
      ("doc-classify", "2,940", "enum", "$38.30", "openai/gpt-5.4", "Measuring", "wait"),
      ("summarize-thread", "840", "free text", "$5.26", "openai/gpt-5.4", "Ready to optimize", "go")]
B.append(dict(
  kind="page", tag="7", title="Workloads", h=690, name="Workloads", chip="Last 30 days", here="work", acct=False,
  tiles=[("Workloads", "4", "found automatically"), ("Optimized", "2", "1 more ready to switch"),
         ("Saved &middot; last 30 days", "$85.80", "against your own models"),
         ("Spend &middot; last 30 days", "$94.80", "on track for $79.50 a month")],
  rows=[dict(name=w[0], calls=w[1], shape=w[2], cost=w[3], model=w[4], status=w[5], pill=w[6]) for w in WL]))
# 8 ------------------------------------------------------------- the models page
MODELS = [("openai/gpt-5.4", "$2.50 / $15.00", "no", "doc-classify, summarize-thread", True),
          ("mistralai/mistral-small", "$0.20 / $0.60", "yes", "support-reply, invoice-extract", True),
          ("deepseek/deepseek-chat-v3.1", "$0.25 / $0.95", "yes", "candidate", True),
          ("openai/gpt-5.6-luna", "$0.20 / $1.20", "no", "candidate", True),
          ("google/gemini-2.5-flash-lite", "$0.10 / $0.40", "no", "candidate", True),
          ("qwen/qwen3-235b-a22b-2507", "$0.13 / $0.60", "yes", "candidate", True),
          ("meta-llama/llama-4-maverick", "$0.19 / $0.65", "yes", "not enabled", False),
          ("anthropic/claude-haiku-4.5", "$1.00 / $5.00", "no", "not enabled", False)]
B.append(dict(
  kind="page", tag="8", title="Models", h=1215, name="Models", chip="8 available", here="models", acct=False,
  tiles=[("Enabled", "6", "of 8 available"), ("Serving your traffic", "2", "gpt-5.4 and mistral-small"),
         ("Open weights", "4", "enabled"), ("Cheapest enabled", "$0.10", "per 1M input tokens")],
  models=MODELS))
# 9 ----------------------------------------------- settings, with the account panel open
B.append(dict(
  kind="page", tag="9", title="Settings, account open", h=1210, name="Settings", chip=None,
  here="settings", acct=True, tiles=None,
  keys=[("production", "us_live_a3f2", "28 Aug 2026", "4 minutes ago"),
        ("staging", "us_live_7c19", "2 Sept 2026", "yesterday")]))
# 10 ------------------------------------- the finalised dashboard, week three
p3 = [8.60] * 6 + [3.20] * 7 + [2.60] * 8
w3 = [8.60] * 21
B.append(dict(
  kind="dash", tag="10", title="Dashboard, week three", h=1090, chip="Last 30 days",
  tiles=[("Spend &middot; last 30 days", spent(p3), "on track for $79.50 a month"),
         ("Saved &middot; last 30 days", saved(p3, w3), "against your own models"),
         ("Workloads", "4", "2 optimized, 1 ready, 1 measuring"),
         ("Calls", "21,380", "since you connected")],
  chart=chart(p3, w3, 12, [0, 3, 6, 9, 12], "2 WORKLOADS SWITCHED &middot; 2 AND 9 SEPT"),
  feed=[("ok",  "summarize-thread has a candidate: mistral-small cleared at 2.10%", "40 minutes ago"),
        ("ok",  "support-reply switched to mistral-small, about $32.04 a month less", "8 days ago"),
        ("bad", "gemini-flash-lite missed on doc-classify, 11.20% against a 3.00% floor", "10 days ago"),
        ("ok",  "invoice-extract re-tested on 120 fresh calls, still clears at 1.40%", "11 days ago")],
  rows=[dict(name=w[0], calls=w[1], shape=w[2], cost=w[3], model=w[4], status=w[5], pill=w[6]) for w in WL]))
io.open("/Users/sherancorera/.claude/jobs/9826f4fb/tmp/boards.json", "w").write(json.dumps(B))
print("ok: " + str(len(B)) + " boards of data")
