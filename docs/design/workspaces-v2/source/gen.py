"""Workspaces v2 design frames in Forge's current look (tokens from Sources/UI/Theme.swift). Writes html/<name>.html.
Render each at 1200 px wide in a headless browser (deviceScaleFactor 2), e.g. Chrome --headless --screenshot."""
import base64, os, pathlib

HERE = pathlib.Path(__file__).parent
FONTS = HERE.parents[3] / "Resources/Fonts"
OUT = pathlib.Path(os.environ.get("OUT", "/tmp/workspaces-v2-html"))
OUT.mkdir(exist_ok=True)


def b64(p):
    return base64.b64encode(pathlib.Path(p).read_bytes()).decode()


font_css = ""
for fam, file, weight, style in [
    ("Playfair", "PlayfairDisplay-Black.ttf", 900, "normal"),
    ("Playfair", "PlayfairDisplay-Italic.ttf", 400, "italic"),
    ("DM Sans", "DMSans-Regular.ttf", 400, "normal"),
    ("DM Sans", "DMSans-Medium.ttf", 500, "normal"),
    ("DM Sans", "DMSans-SemiBold.ttf", 600, "normal"),
    ("DM Sans", "DMSans-Bold.ttf", 700, "normal"),
    ("DM Mono", "DMMono-Regular.ttf", 400, "normal"),
    ("DM Mono", "DMMono-Medium.ttf", 500, "normal"),
]:
    font_css += f"@font-face{{font-family:'{fam}';src:url(data:font/ttf;base64,{b64(FONTS / file)});font-weight:{weight};font-style:{style}}}\n"

LOGO = "data:image/png;base64," + b64(HERE / "logo.png")

CSS = font_css + """
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#1C1A17;--surface:#2E2B27;--hover:#38342F;--raised:#4A4640;--border:#3B3833;--borderH:#4A4640;
--text:#F7F5F1;--silver:#EDE9E3;--sec:#B0A99F;--muted:#7A7470;--heat:#C47F2A;--heatB:#E59B47;--heatD:#8A5519;
--good:#5C8A3A;--bad:#9B2B2B}
html,body{width:1200px;height:var(--h,800px);background:var(--bg);color:var(--text);font-family:'DM Sans';font-size:13px;overflow:hidden}
body{position:relative;background:radial-gradient(ellipse 60% 40% at 50% 105%,rgba(196,127,42,.10),transparent 70%),var(--bg)}
.mono{font-family:'DM Mono'}
.top{height:56px;border-bottom:1px solid var(--border);display:flex;align-items:center;padding-right:24px;gap:14px}
.top img{height:56px;width:200px;object-fit:cover;object-position:left}
.chip{display:flex;align-items:center;gap:8px;border:1px solid var(--borderH);border-radius:4px;padding:4px 8px;font-weight:500;margin-left:-6px}
.tile{width:22px;height:22px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-family:'DM Mono';font-size:9px;font-weight:500;
 color:var(--heat);background:rgba(196,127,42,.16);border:1px solid rgba(196,127,42,.5)}
.tile.g{color:#7FAE5B;background:rgba(92,138,58,.16);border-color:rgba(92,138,58,.5)}
.tile.s{color:var(--silver);background:rgba(237,233,227,.10);border-color:rgba(237,233,227,.4)}
.tile.big{width:30px;height:30px;font-size:12px}
.chev{font-size:9px;color:var(--sec)}
.crumb{font-family:'DM Mono';font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--sec)}
.seg{display:flex;border:1px solid var(--borderH);border-radius:4px;overflow:hidden}
.seg span{font-family:'DM Mono';font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:6px 9px;color:var(--muted)}
.seg span.on{background:var(--hover);color:var(--text)}
.seg span.off{color:#57524c}
.sp{flex:1}
.ghost{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:500;color:var(--silver);white-space:nowrap}
.ghost i{font-style:normal;color:var(--sec);font-size:13px}
.key{font-family:'DM Mono';font-size:9px;border:1px solid var(--borderH);border-radius:3px;padding:1px 4px;color:var(--sec)}
.page{padding:32px 40px}
.eyebrow{font-family:'DM Mono';font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
h1{font-family:'Playfair';font-weight:900;font-size:40px;line-height:1.1;letter-spacing:-.01em}
h2{font-family:'Playfair';font-weight:900;font-size:24px;line-height:1.15}
.lead{font-size:13px;color:var(--sec);margin-top:10px;max-width:640px;line-height:1.5}
.rule{height:1px;background:var(--border);margin:22px 0}
.label{font-family:'DM Mono';font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.panel{background:rgba(46,43,39,.55);border:1px solid var(--border);border-radius:8px;padding:20px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:0}
.row .t{font-size:13px;font-weight:500}
.row .s{font-size:11px;color:var(--muted);margin-top:2px}
.row .s.m{font-family:'DM Mono'}
.act{font-size:12px;font-weight:500;color:var(--silver);white-space:nowrap}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:500;padding:3px 9px;border-radius:999px;border:1px solid}
.pill.good{color:#8DBA6A;border-color:rgba(92,138,58,.45);background:rgba(92,138,58,.12)}
.pill.heat{color:var(--heatB);border-color:rgba(196,127,42,.4);background:rgba(196,127,42,.10)}
.pill.info{color:var(--sec);border-color:rgba(176,169,159,.3);background:rgba(176,169,159,.08)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--heat);color:#1C1A17;font-weight:600;font-size:13px;padding:9px 16px;border-radius:4px;white-space:nowrap}
.btn.sec{background:transparent;color:var(--silver);border:1px solid var(--borderH)}
.field{border:1px solid var(--borderH);background:#161412;border-radius:6px;padding:10px 12px;color:var(--muted);font-size:13px;display:flex;gap:8px;align-items:center}
.note{font-size:11px;color:var(--muted);line-height:1.5}
.callout{border:1px solid rgba(196,127,42,.34);background:rgba(196,127,42,.07);border-radius:8px;padding:16px 18px}
.callout .label{color:var(--heatB)}
.avatar{width:28px;height:28px;border-radius:50%;background:var(--raised);font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;color:var(--silver);flex:none}
.scrim{position:absolute;inset:56px 0 0 0;background:rgba(28,26,23,.72)}
.sheet{position:absolute;left:50%;transform:translateX(-50%);width:560px;background:var(--surface);border:1px solid var(--borderH);border-radius:14px;box-shadow:0 4px 32px rgba(0,0,0,.5);overflow:hidden}
.sheet .hd{padding:20px 24px;border-bottom:1px solid var(--borderH)}
.sheet .bd{padding:18px 24px}
.sheet .ft{padding:16px 24px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--borderH)}
.opt{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px}
.opt.on{border-color:rgba(196,127,42,.6);background:rgba(196,127,42,.08)}
.radio{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--muted);flex:none}
.opt.on .radio{border:4px solid var(--heat)}
.check{width:14px;height:14px;border-radius:3px;border:1.5px solid var(--muted);flex:none}
.check.on{background:var(--heat);border-color:var(--heat)}
.toggle{width:34px;height:18px;border-radius:9px;background:rgba(196,127,42,.35);position:relative;flex:none}
.toggle:after{content:'';position:absolute;right:3px;top:3px;width:12px;height:12px;border-radius:50%;background:var(--heatB)}
.toggle.off{background:var(--raised)}.toggle.off:after{left:3px;right:auto;background:var(--muted)}
.stage{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:500;padding:6px 9px;border-radius:4px;border:1px solid var(--border);background:rgba(46,43,39,.6);white-space:nowrap}
.stage.off{opacity:.38;text-decoration:line-through}
.arrow{color:var(--muted);font-size:11px}
.side{position:absolute;top:56px;bottom:0;left:0;width:256px;border-right:1px solid var(--border);padding:12px 8px}
.grp{font-family:'DM Mono';font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);padding:14px 4px 6px}
.srow{padding:8px 10px;border-radius:6px}
.srow.on{background:var(--hover);border:1px solid var(--borderH)}
.srow .t{font-size:13px;font-weight:600;display:flex;gap:8px;align-items:center;white-space:nowrap;overflow:hidden}
.srow .s{font-family:'DM Mono';font-size:10px;color:var(--muted);margin:2px 0 0 14px;white-space:nowrap;overflow:hidden}
.repoh{display:flex;align-items:center;gap:8px;padding:10px 6px 4px;font-size:12px;font-weight:600;color:var(--silver)}
.repoh .plus{margin-left:auto;color:var(--muted);font-size:14px}
.ann{position:absolute;font-family:'DM Sans';font-size:11px;font-weight:600;color:#1C1A17;background:var(--heatB);border-radius:999px;width:20px;height:20px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 3px rgba(229,155,71,.25)}
"""


def top(crumb="", chip=("AC", "Acme", ""), right="", seg=None):
    t, name, cls = chip
    segh = ""
    if seg:
        segh = '<div class="seg">' + "".join(f'<span class="{c}">{n}</span>' for n, c in seg) + "</div>"
    return f"""<div class="top"><img src="{LOGO}"><div class="chip"><div class="tile {cls}">{t}</div>{name}<span class="chev">▾</span></div>
    {segh}<span class="crumb">{crumb}</span><div class="sp"></div>{right}</div>"""


def page(name, body, h=800):
    (OUT / f"{name}.html").write_text(
        f"<!doctype html><html><head><meta charset=utf-8><style>{CSS}</style></head><body style='--h:{h}px'>{body}</body></html>")


def ann(n, x, y):
    return ""
    return f'<div class="ann" style="left:{x}px;top:{y}px">{n}</div>'


GEAR = '<span class="ghost"><i>⚙</i>Orchestrator settings <span class="key">⌘,</span></span>'
WS_SET = '<span class="ghost"><i>▤</i>Workspace settings</span>'
STUDIO = '<span class="ghost"><i>⌥</i>Workflow Studio</span>'

# ---------------------------------------------------------------- Direction A: one repo, one workspace
AP = ("AY", "apply-yourself", "g")


def repo_pick(multi):
    rows = [
        ("@donnadieu-andela", [("woven-teams/apply-yourself", "Andela · pushed 2 h ago", True),
                                ("andela-technology/andela-pay", "Andela · pushed today", False),
                                ("andela-technology/andela", "Andela · pushed yesterday", False)]),
        ("@Donnadieu", [("ConstructEase/constructease", "Already a workspace", None),
                        ("Donnadieu/forge-desktop", "pushed 1 h ago", False)]),
    ]
    h = ""
    for acct, items in rows:
        h += f'<div class="label" style="margin:12px 0 6px">GitHub · {acct}</div>'
        for repo, sub, on in items:
            mark = f'<div class="{"check" if multi else "radio"}{" on" if on and multi else ""}"></div>'
            dim = ' style="opacity:.45"' if on is None else ""
            h += f'<div class="opt{" on" if on else ""}"{dim}>{mark}<div><div class="mono" style="font-size:12px">{repo}</div><div class="note">{sub}</div></div></div>'
    return h


page("a1-add-workspace", top("Orchestrator", ("CE", "ConstructEase", "")) + '<div class="scrim"></div>' + f"""
<div class="sheet" style="top:66px">
 <div class="hd"><h2>Add a workspace</h2><div class="lead" style="margin-top:6px">A workspace is one repo, like in Conductor. Pick it; its sessions,
 cards and settings live under it. A board is optional.</div></div>
 <div class="bd"><div class="field">⌕ <span>apply</span></div>{repo_pick(False)}
  <div class="label" style="margin:16px 0 6px">Board · optional</div>
  <div class="opt on"><div class="radio"></div><div><div class="t" style="font-weight:500">No board for now</div><div class="note">Start sessions right away. Connect Linear, Basecamp or GitHub Issues later in Workspace settings.</div></div></div>
 </div>
 <div class="ft"><span class="btn sec">Cancel</span><span class="btn">Add apply-yourself</span></div>
</div>""" + ann(1, 300, 104) + ann(2, 300, 640))

# switcher with repo workspaces
page("a2-switcher", top("", AP, STUDIO + WS_SET + GEAR, seg=[("Orchestrator", "off"), ("Sessions", "on")]) + f"""
<div class="sheet" style="top:62px;left:420px;width:440px;transform:none;border-radius:8px">
 <div style="padding:14px 16px 6px" class="label">Workspaces · one per repo</div>
 {''.join(f'''<div class="row" style="padding:10px 16px"><div class="tile big {c}">{t}</div><div style="flex:1"><div class="t">{n}</div><div class="s m">{r}</div></div>{p}</div>''' for t,n,r,p,c in [
  ("AY","apply-yourself","woven-teams/apply-yourself · no board",'<span class="pill info">2 sessions</span>',"g"),
  ("CE","constructease","ConstructEase/constructease · Basecamp",'<span class="pill good"><span class="dot"></span>Running · 3 agents</span>',""),
  ("FD","forge-desktop","Donnadieu/forge-desktop · GitHub Issues",'<span class="pill info">Stopped</span>',"s")])}
 <div style="border-top:1px solid var(--borderH);padding:12px 16px;display:flex;gap:18px"><span class="ghost"><i>＋</i>Add a workspace (pick a repo)</span><span class="ghost"><i>▣</i>All workspaces</span></div>
</div>
<div class="page" style="opacity:.25"><h1>Sessions</h1></div>""" + ann(3, 400, 108))

# Workspace settings
page("a3-workspace-settings", top("Workspace settings", AP, STUDIO + GEAR) + f"""
<div class="page"><div class="eyebrow">Workspace · woven-teams/apply-yourself</div>
<div style="display:flex;align-items:flex-end"><div style="flex:1"><h1>apply-yourself</h1>
<div class="lead">Only this repo. Sign-ins, intelligence provider accounts and how many agents run on this Mac are in
<span style="color:var(--heatB)">Orchestrator settings ↗</span>.</div></div><span class="ghost" style="margin-right:22px">Rename</span><span class="ghost"><i>🗑</i>Delete workspace</span></div>
<div class="rule"></div>
<div class="grid">
 <div class="panel"><div class="label">Repo</div>
  <div class="row"><div style="flex:1"><div class="t mono">woven-teams/apply-yourself</div><div class="s">Base branch master · your checkout ~/Repos/apply-yourself</div></div><span class="pill good"><span class="dot"></span>Pushes as @donnadieu-andela</span></div>
  <div class="row"><div style="flex:1"><div class="t">Harness engineering</div><div class="s">Not done yet · 4 guardrails suggested</div></div><span class="act">Get it ready</span></div></div>
 <div class="panel" style="border-style:dashed"><div class="label">Board · optional</div>
  <div class="row"><div style="flex:1"><div class="t">No board</div><div class="s">Sessions work without one. With a board, Forge also picks up cards on its own and runs them through Workflow Studio.</div></div></div>
  <div style="margin-top:8px"><span class="btn sec">Connect a board</span></div></div>
 <div class="panel"><div class="label">Who works here</div>
  <div class="row"><div style="flex:1"><div class="t">Claude Code · Andela</div><div class="s m">opus-5.5 · 1M · high</div></div><span class="act">Change</span></div>
  <div class="row"><div style="flex:1"><div class="t">New sessions start from</div><div class="s m">master · branch donnadieu/&lt;name&gt;</div></div><span class="act">Change</span></div></div>
 <div class="panel"><div class="label">What others see</div>
  <div class="row"><div style="flex:1"><div class="t">Keep Forge invisible</div><div class="s">No Forge label, branch prefix or wording in pull requests.</div></div><div class="toggle"></div></div></div>
</div></div>""" + ann(4, 36, 84) + ann(5, 626, 268))

# Orchestrator settings (global)
page("a4-orchestrator-settings", top("Orchestrator settings", ("◫", "All workspaces", "s"), STUDIO) + f"""
<div class="page"><div class="eyebrow">Forge · Orchestrator settings</div><h1>Orchestrator settings</h1>
<div class="lead">For every workspace on this Mac. A workspace's own repo, board and who works on it are in its Workspace settings.</div>
<div class="rule"></div>
<div class="grid">
 <div class="panel"><div class="label">Sign-ins on this Mac</div>
  {''.join(f'<div class="row"><div class="avatar">{a}</div><div style="flex:1"><div class="t">{t}</div><div class="s">{s}</div></div><span class="act">{x}</span></div>' for a,t,s,x in [
   ("GH","GitHub · @Donnadieu, @donnadieu-andela","2 accounts · each workspace pushes as one","Add"),
   ("BC","Basecamp · ConstructEase","Used by constructease","Change"),
   ("LN","Linear · not connected","Connect when a workspace needs it","Connect")])}</div>
 <div class="panel"><div class="label">Intelligence providers</div>
  {''.join(f'<div class="row"><div style="flex:1"><div class="t">{t}</div><div class="s">{s}</div></div><span class="act">{x}</span></div>' for t,s,x in [
   ("Claude Code","3 accounts · Andela, ConstructEase, Personal","Accounts"),
   ("Codex","1 account · ChatGPT Pro","Accounts"),
   ("New workspaces start with","Claude Code · opus-5.5","Change")])}</div>
 <div class="panel"><div class="label">This Mac</div>
  <div class="row"><div style="flex:1"><div class="t">Agents at once, across all workspaces</div><div class="s">Cards wait until an agent is free.</div></div><div class="field mono" style="width:70px;color:var(--text)">6</div></div>
  <div class="row"><div style="flex:1"><div class="t">Commits are signed</div><div class="s">With a key Forge made, in your Keychain</div></div><span class="act">Change</span></div></div>
 <div class="panel"><div class="label">Forge</div>
  <div class="row"><div style="flex:1"><div class="t">Version 0.2.27</div><div class="s">Up to date · checks every day</div></div></div>
  <div class="row"><div style="flex:1"><div class="t">Start from zero</div><div class="s">Delete every workspace. Sign-ins stay unless you clear them.</div></div><span class="act">Delete all</span></div></div>
</div></div>""" + ann(6, 36, 84))

# Workflow Studio with its purpose
STAGES = [("Backlog", "you", 0), ("Triage", "Claude", 1), ("Todo", "", 0), ("In Progress", "Codex", 0), ("AI Review", "Claude", 0),
          ("QA", "off", 2), ("Human Review", "you", 0), ("Merging", "Claude", 0), ("Done", "", 0)]


def strip():
    h = ""
    for i, (n, who, flag) in enumerate(STAGES):
        cls = " off" if flag == 2 else ""
        w = f'<span class="mono" style="font-size:9px;color:var(--muted)">{who}</span>' if who and who != "off" else ""
        h += f'<span class="stage{cls}">{n} {w}</span>' + ('<span class="arrow">→</span>' if i < len(STAGES) - 1 else "")
    return f'<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">{h}</div>'


page("a5-workflow-studio", top("Workflow Studio", ("CE", "constructease", ""), WS_SET + GEAR) + f"""
<div class="page"><div class="eyebrow">constructease · Workflow Studio</div><h1>Workflow Studio</h1>
<div class="lead">How Forge works this workspace's board on its own: which stages a card goes through on its way to a merged pull
request, and who does each one. Sessions you start yourself don't use it.</div>
<div class="callout" style="margin-top:20px"><div class="label">Use it to</div>
 <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;margin-top:10px">
  <div><div class="t" style="font-weight:600">Skip a stage</div><div class="note">Small repo? Turn QA off and cards go from AI Review straight to you.</div></div>
  <div><div class="t" style="font-weight:600">Pick who works each stage</div><div class="note">Codex builds, Claude reviews and merges.</div></div>
  <div><div class="t" style="font-weight:600">Stay out of sight</div><div class="note">No Forge label or wording in your client's pull requests.</div></div>
 </div></div>
<div class="label" style="margin:22px 0 10px">A card's path in constructease, as set now</div>
{strip()}
<div class="panel" style="margin-top:18px;padding:0 20px">
 {''.join(f'<div class="row" style="padding:12px 0"><span class="dot" style="color:{c}"></span><div style="flex:1"><div class="t">{n}</div><div class="s">{d}</div></div><div class="field" style="width:250px;padding:6px 10px;color:var(--text);font-size:12px">{p}</div><div class="toggle{o}"></div></div>' for n,d,p,c,o in [
  ("In Progress","An agent writes the code and opens a pull request.","Codex · ChatGPT Pro","#C47F2A",""),
  ("AI Review","Another agent reviews the pull request and fixes what it finds.","Claude Code · ConstructEase","#B0A99F",""),
  ("QA","An agent tests the change the way a person would.","Default provider","#5C8A3A"," off")])}
</div></div>""", h=800)
# annotate (after write) – add numbers by rewriting
p = OUT / "a5-workflow-studio.html"
p.write_text(p.read_text().replace("</body>", ann(7, 36, 152) + ann(8, 36, 260) + "</body>"))

# Sessions inside a repo workspace
SESS = [("Needs you", [("Fix the resume parser on PDFs", "PR #412", "heat", True)]),
        ("Working", [("QUAL-88 Score breakdown page", "qual-88 · Started by Forge", "heat", False),
                     ("Upgrade Rails to 8.1", "donnadieu/rails-8-1", "heat", False)]),
        ("Ready for review", [("Flaky invite spec", "PR #409", "sec", False)])]


def sess_list(repo_lines=False):
    h = '<div class="field" style="padding:8px 10px">⌕ Search sessions</div><div class="btn" style="width:100%;justify-content:center;margin:8px 0 2px">＋ New session <span class="key" style="border-color:#8A5519;color:#5a3a12">⌘N</span></div>'
    for g, items in SESS:
        h += f'<div class="grp">{g}</div>'
        for t, s, c, on in items:
            col = "var(--heat)" if c == "heat" else "var(--sec)"
            h += f'<div class="srow{" on" if t.startswith("QUAL") else ""}"><div class="t"><span class="dot" style="color:{col}"></span>{t}</div><div class="s">{s}</div></div>'
    return h


page("a6-sessions", top("", AP, STUDIO + WS_SET + GEAR, seg=[("Orchestrator", "on"), ("Sessions", "on")]).replace('<span class="on">Orchestrator', '<span class="off">Orchestrator') + f"""
<div class="side">{sess_list()}</div>
<div style="position:absolute;left:256px;top:56px;right:0;bottom:0;padding:22px 28px">
 <div style="display:flex;align-items:center;gap:12px"><h2 style="font-size:28px">QUAL-88 Score breakdown page</h2><span class="pill heat"><span class="dot"></span>Working</span></div>
 <div class="mono note" style="margin-top:6px">qual-88-score-breakdown · from card QUAL-88 · Started by Forge</div>
 <div class="callout" style="margin-top:18px;max-width:700px"><div class="label">One repo, so nothing to pick</div>
  <div class="note" style="margin-top:6px;color:var(--sec)">Every session here is on woven-teams/apply-yourself. New session asks only for the branch it starts from and
  your first message. Cards from a board show up here too, marked Started by Forge, and you can steer them.</div></div>
 <div style="margin-top:22px;max-width:700px">
  <div class="note mono">› Read app/models/score.rb<br>› Edited app/views/scores/show.html.erb +88 -4<br>› Ran bin/rspec spec/system/scores_spec.rb</div>
  <div style="margin-top:12px;line-height:1.6;color:var(--silver)">The breakdown page is in and its system spec passes. Next I'm adding the empty state for candidates with no scores yet.</div>
 </div>
 <div class="field" style="position:absolute;left:28px;right:28px;bottom:22px;height:96px;align-items:flex-start">Message the agent… Enter steers · ⌥Enter queues</div>
</div>""" + ann(9, 60, 18) + ann(10, 268, 120))

# ---------------------------------------------------------------- Direction B: a workspace holds repos
CEB = ("CE", "ConstructEase", "")
page("b1-add-workspace", top("Orchestrator", CEB) + '<div class="scrim"></div>' + f"""
<div class="sheet" style="top:64px">
 <div class="hd"><h2>New workspace</h2><div class="lead" style="margin-top:6px">A workspace is a client or a part of your work. It holds one or more repos;
 each repo gets its own sessions. A board is optional.</div></div>
 <div class="bd"><div class="label" style="margin-bottom:6px">Name</div><div class="field" style="color:var(--text)">Andela</div>
  <div class="label" style="margin:14px 0 0">Its repos · pick one or more</div>{repo_pick(True).replace('class="opt"><div class="check"></div><div><div class="mono" style="font-size:12px">andela-technology/andela-pay','class="opt on"><div class="check on"></div><div><div class="mono" style="font-size:12px">andela-technology/andela-pay')}
  <div class="label" style="margin:12px 0 6px">Board · optional</div>
  <div class="opt on"><div class="radio"></div><div><div class="t" style="font-weight:500">No board for now</div></div></div>
 </div>
 <div class="ft"><span class="btn sec">Cancel</span><span class="btn">Create Andela with 2 repos</span></div>
</div>""" + ann(1, 300, 92))

BSIDE = [("woven-teams/apply-yourself", [("Fix the resume parser on PDFs", "Needs you · PR #412", "heat", False), ("Flaky invite spec", "Ready for review", "sec", False)]),
         ("andela-technology/andela-pay", [("ATC-334 Cut over to GCloud", "Working · Started by Forge", "heat", True), ("Payout export CSV", "Working", "heat", False)])]


def bside():
    h = '<div class="field" style="padding:8px 10px">⌕ Search sessions</div>'
    for repo, items in BSIDE:
        h += f'<div class="repoh"><span class="mono" style="font-size:11px">{repo}</span><span class="plus">＋</span></div>'
        for t, s, c, on in items:
            col = "var(--heat)" if c == "heat" else "var(--sec)"
            h += f'<div class="srow{" on" if on else ""}"><div class="t"><span class="dot" style="color:{col}"></span>{t}</div><div class="s">{s}</div></div>'
    h += '<div class="repoh" style="color:var(--muted);margin-top:8px">＋ Add a repo to Andela</div>'
    return h


page("b2-settings", top("Settings", ("AN", "Andela", "g"), STUDIO) + f"""
<div class="page"><div class="eyebrow">Settings</div>
<div style="display:flex;align-items:flex-end;gap:16px"><h1 style="flex:1">Settings</h1>
<div class="seg" style="margin-bottom:6px"><span class="on" style="padding:8px 14px">Andela workspace</span><span style="padding:8px 14px">Orchestrator · all workspaces</span></div></div>
<div class="lead">Two tabs, one screen: what this workspace holds, and what every workspace on this Mac shares.</div>
<div class="rule"></div>
<div class="panel" style="padding:0 20px"><div class="label" style="padding-top:16px">Repos in Andela</div>
 {''.join(f'<div class="row" style="padding:12px 0"><div style="flex:1.3"><div class="t mono">{r}</div><div class="s">{l}</div></div><div style="flex:1"><div class="s">Board</div><div class="t" style="font-size:12px">{b}</div></div><div style="flex:1"><div class="s">Harness engineering</div><div class="t" style="font-size:12px">{hh}</div></div><span class="act">Change</span></div>' for r,l,b,hh in [
  ("woven-teams/apply-yourself","~/Repos/apply-yourself · master","None","Not done yet"),
  ("andela-technology/andela-pay","~/Repos/andela-pay · main","Linear · ATC Rewrite","Done")])}
 <div style="padding:12px 0 16px"><span class="btn sec">＋ Add a repo</span></div></div>
<div class="grid" style="margin-top:16px">
 <div class="panel"><div class="label">Who works here</div><div class="row"><div style="flex:1"><div class="t">Claude Code · Andela</div><div class="s m">opus-5.5 · 1M · high</div></div><span class="act">Change</span></div></div>
 <div class="panel"><div class="label">What others see</div><div class="row"><div style="flex:1"><div class="t">Keep Forge invisible</div><div class="s">For every repo in Andela.</div></div><div class="toggle"></div></div></div>
</div></div>""" + ann(4, 970, 112) + ann(5, 36, 262))

page("b3-orchestrator-tab", top("Settings", ("AN", "Andela", "g"), STUDIO) + f"""
<div class="page"><div class="eyebrow">Settings</div>
<div style="display:flex;align-items:flex-end;gap:16px"><h1 style="flex:1">Settings</h1>
<div class="seg" style="margin-bottom:6px"><span style="padding:8px 14px">Andela workspace</span><span class="on" style="padding:8px 14px">Orchestrator · all workspaces</span></div></div>
<div class="lead">Shared by every workspace on this Mac.</div>
<div class="rule"></div>
<div class="grid">
 <div class="panel"><div class="label">Sign-ins on this Mac</div>
  {''.join(f'<div class="row"><div class="avatar">{a}</div><div style="flex:1"><div class="t">{t}</div><div class="s">{s}</div></div><span class="act">{x}</span></div>' for a,t,s,x in [
   ("GH","GitHub","@Donnadieu, @donnadieu-andela","Add"),("BC","Basecamp","ConstructEase","Change"),("LN","Linear","Andela · ATC Rewrite","Change")])}</div>
 <div class="panel"><div class="label">Intelligence providers</div>
  {''.join(f'<div class="row"><div style="flex:1"><div class="t">{t}</div><div class="s">{s}</div></div><span class="act">Accounts</span></div>' for t,s in [("Claude Code","3 accounts"),("Codex","1 account")])}</div>
 <div class="panel"><div class="label">This Mac</div>
  <div class="row"><div style="flex:1"><div class="t">Agents at once, across all workspaces</div></div><div class="field mono" style="width:70px;color:var(--text)">6</div></div>
  <div class="row"><div style="flex:1"><div class="t">Commits are signed</div><div class="s">With a key Forge made</div></div><span class="act">Change</span></div></div>
 <div class="panel"><div class="label">Forge</div>
  <div class="row"><div style="flex:1"><div class="t">Start from zero</div><div class="s">Delete every workspace. Sign-ins stay.</div></div><span class="act">Delete all</span></div></div>
</div></div>""" + ann(6, 1150, 112))

# B workflow studio: purpose as a card's trip, vertical
TRIP = [("Backlog", "You add ideas. Agents leave them alone.", "you", " always"),
        ("Todo → In Progress", "An agent builds it and opens a pull request.", "Codex · ChatGPT Pro", ""),
        ("AI Review", "Another agent reviews and fixes what it finds.", "Claude Code · Andela", ""),
        ("QA", "Off for this workspace: cards skip it.", "", " off"),
        ("Human Review", "Your turn: merge or ask for changes.", "you", ""),
        ("Merging → Done", "An agent merges once checks pass.", "Claude Code · Andela", "")]
page("b4-workflow-studio", top("Workflow Studio", ("AN", "Andela", "g"), '<span class="ghost"><i>⚙</i>Settings</span>') + f"""
<div class="page" style="display:grid;grid-template-columns:1fr 330px;gap:28px">
<div><div class="eyebrow">Andela · Workflow Studio</div><h1>Workflow Studio</h1>
<div class="lead">The rules Forge follows when it takes a card from your board and works it without you. One set for every repo in Andela.</div>
<div class="label" style="margin:22px 0 10px">A card's trip, as set now</div>
<div class="panel" style="padding:4px 20px">
 {''.join(f'<div class="row" style="padding:12px 0"><span class="mono" style="color:var(--muted);width:18px">{i+1}</span><div style="flex:1"><div class="t">{n}</div><div class="s">{d}</div></div><div class="mono" style="font-size:11px;color:var(--sec);width:170px;text-align:right">{w}</div>{"<span class=label style=width:34px>always</span>" if o==" always" else f"<div class=\'toggle{o}\'></div>"}</div>' for i,(n,d,w,o) in enumerate(TRIP))}
</div></div>
<div style="padding-top:28px"><div class="callout"><div class="label">What it's for</div>
 <div class="note" style="color:var(--sec);margin-top:8px;font-size:12px;line-height:1.6">Sessions are you and an agent, chatting. Workflow Studio is for the work you hand off:
 cards on a board that Forge plans, builds, reviews, tests and merges by itself.<br><br>Change it when a stage isn't worth it, when a different provider should do a stage, or when a client mustn't see Forge.</div></div>
 <div class="panel" style="margin-top:14px"><div class="label">Applies to</div><div class="note mono" style="margin-top:8px">andela-technology/andela-pay · Linear</div>
 <div class="note" style="margin-top:8px">apply-yourself has no board, so nothing here runs for it.</div></div></div>
</div>""", h=860)
p = OUT / "b4-workflow-studio.html"
p.write_text(p.read_text().replace("</body>", ann(7, 876, 132) + ann(8, 36, 262) + "</body>"))

page("b5-sessions", top("", ("AN", "Andela", "g"), STUDIO + '<span class="ghost"><i>⚙</i>Settings <span class="key">⌘,</span></span>', seg=[("Orchestrator", "off"), ("Sessions", "on")]) + f"""
<div class="side">{bside()}</div>
<div style="position:absolute;left:256px;top:56px;right:0;bottom:0;padding:22px 28px">
 <div style="display:flex;align-items:center;gap:12px"><h2 style="font-size:28px">ATC-334 Cut over to GCloud</h2><span class="pill heat"><span class="dot"></span>Working</span></div>
 <div class="mono note" style="margin-top:6px">andela-technology/andela-pay · atc-334-gcloud · Started by Forge</div>
 <div class="callout" style="margin-top:18px;max-width:700px"><div class="label">Repos group the sessions, like Conductor's sidebar</div>
  <div class="note" style="margin-top:6px;color:var(--sec)">The ＋ next to a repo starts a session on it. A workspace with several repos keeps them in one place;
  the Orchestrator shows every repo's cards together.</div></div>
 <div style="margin-top:22px;max-width:700px">
  <div class="note mono">› Read infra/terraform/main.tf<br>› Ran bin/rails db:migrate:status</div>
  <div style="margin-top:12px;line-height:1.6;color:var(--silver)">The staging database is on GCloud and the app boots against it. Next: the cutover checklist.</div>
 </div>
 <div class="field" style="position:absolute;left:28px;right:28px;bottom:22px;height:96px;align-items:flex-start">Message the agent… Enter steers · ⌥Enter queues</div>
</div>""" + ann(9, 228, 112))

print(sorted(os.listdir(OUT)))
