"""Generates docs/architecture.svg, the Daedalus system diagram.

Run: python3 scripts/diagram.py && node scripts/render-diagram.mjs
"""
from html import escape

W, H = 1680, 1090
FONT = "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif"
MONO = "'JetBrains Mono', Menlo, Consolas, monospace"
C = {
    "ink": "#16181D", "muted": "#5D636E", "line": "#D3D3CC", "bg": "#FBFBF9",
    "blue": "#1D4ED8", "blueSoft": "#E7EEFC",
    "teal": "#0F766E", "tealSoft": "#E3F2EF",
    "amber": "#9A4507", "amberSoft": "#FBF0E2",
    "green": "#126B33", "greenSoft": "#E6F4EA",
    "violet": "#6D28D9", "violetSoft": "#EFEAFE",
    "gray": "#4B5563", "graySoft": "#F1F1EE",
}
COLORS = ["ink", "blue", "teal", "amber", "green", "violet", "gray"]
out: list[str] = []


def text(x, y, s, size=13, weight=400, color=None, anchor="start", family=FONT):
    out.append(
        f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" '
        f'fill="{color or C["ink"]}" text-anchor="{anchor}">{escape(s)}</text>'
    )


def group(x, y, w, h, title, sub, color, dashed=False):
    dash = ' stroke-dasharray="7 5"' if dashed else ""
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="{C[color + "Soft"] if color != "ink" else C["graySoft"]}" fill-opacity="0.5" stroke="{C[color]}" stroke-width="1.6"{dash}/>')
    text(x + 18, y + 28, title.upper(), 12.5, 700, C[color])
    if sub:
        text(x + 18, y + 47, sub, 12, 400, C["muted"])


def box(x, y, w, h, title, lines, color):
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="#FFFFFF" stroke="{C[color]}" stroke-width="1.4"/>')
    out.append(f'<rect x="{x}" y="{y + 1}" width="5" height="{h - 2}" rx="2" fill="{C[color]}"/>')
    text(x + 16, y + 24, title, 14.5, 650)
    for i, line in enumerate(lines):
        text(x + 16, y + 45 + i * 17, line, 12, 400, C["muted"])


def label(x, y, s, color):
    lines = s.split("\n")
    w = max(len(l) for l in lines) * 6.5 + 14
    h = 19 + (len(lines) - 1) * 15
    out.append(f'<rect x="{x - w / 2}" y="{y - h / 2}" width="{w}" height="{h}" rx="9" fill="#FFFFFF" stroke="{C["line"]}" stroke-width="0.8"/>')
    for i, l in enumerate(lines):
        text(x, y + 4 - (len(lines) - 1) * 7.5 + i * 15, l, 11.5, 500, C[color], anchor="middle")


def arrow(points, color, dashed=False, lab=None, at=None, both=False):
    d = "M " + " L ".join(f"{x} {y}" for x, y in points)
    dash = ' stroke-dasharray="6 5"' if dashed else ""
    start = f' marker-start="url(#m-{color})"' if both else ""
    out.append(f'<path d="{d}" fill="none" stroke="{C[color]}" stroke-width="1.7"{dash}{start} marker-end="url(#m-{color})"/>')
    if lab:
        label(at[0], at[1], lab, color)


def badge(x, y, n):
    out.append(f'<circle cx="{x}" cy="{y}" r="11" fill="{C["teal"]}"/>')
    text(x, y + 4.5, str(n), 12, 700, "#FFFFFF", anchor="middle")


markers = "".join(
    f'<marker id="m-{n}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{C[n]}"/></marker>'
    for n in COLORS
)

# ── Title ───────────────────────────────────────────────────────────────────────
text(40, 50, "Daedalus · system architecture", 26, 700)
text(40, 76, "Durable agent runs on Vercel Workflow · bring-your-own-key LLM gateway · one Firecracker microVM per project · Supabase for auth and data", 14, 400, C["muted"])

# ── Column 1: browser + sandbox ─────────────────────────────────────────────────
group(40, 110, 300, 360, "Browser", "Next.js client · React 19", "blue")
box(60, 172, 260, 132, "Workspace UI", ["chat · plan · trace · code · versions", "sign-in + connect-a-model on Send", "WorkflowChatTransport: resumable", "SSE, reconnects to live runs"], "blue")
box(60, 328, 260, 120, "Live preview (iframe)", ["the user's app, hot-reloading", "bridge script → postMessage", "runtime errors to the workspace"], "blue")
arrow([(285, 328), (285, 304)], "blue", dashed=True)

group(40, 525, 300, 495, "Vercel Sandbox", "Firecracker microVM · untrusted code", "amber", dashed=True)
box(60, 590, 260, 110, "Vite dev server :5173", ["public HTTPS URL per port", "restarted after npm install", "supervised: logs, health probe"], "amber")
box(60, 720, 260, 110, "Tool execution", ["bash with hard timeouts", "tsc · vite build · module probe", "ripgrep · npm · git"], "amber")
box(60, 850, 260, 110, "Project repo (git)", ["a commit per run = a version", "restore = a new commit", "source for GitHub and deploys"], "amber")
text(60, 985, "Snapshots on idle, resumes on use.", 12, 600, C["amber"])
text(60, 1003, "No keys or tokens ever enter the VM.", 12, 400, C["muted"])

# preview → dev server (direct)
arrow([(296, 448), (296, 590)], "blue", lab="HTTPS + HMR websocket\n(direct, no proxy)", at=(296, 498))

# ── Column 2: Vercel ────────────────────────────────────────────────────────────
group(400, 110, 600, 660, "Vercel · Fluid compute", "stateless functions · OIDC to Sandbox · Queues under Workflow", "ink")
box(420, 172, 270, 150, "Next.js app (API routes)", ["/api/chat: start a run, stream SSE", "/api/chat/:run/stream: replay", "/api/projects · files · restore", "/api/credentials: check + encrypt", "/api/github · /api/deploy"], "ink")
box(710, 172, 270, 150, "LLM gateway (the proxy)", ["/api/gateway/{provider}/{path}", "verify run token (JWT, 6 h)", "stopped run → 410, not retried", "decrypt user key for this call", "stream through · meter · llm span"], "violet")

group(420, 362, 560, 390, "Vercel Workflow · durable runs", None, "teal")
box(440, 425, 250, 128, "agentRun (one per turn)", ["WorkflowAgent tool loop", "plan mode or build mode", "prune · loop guard · step budget", "≤ 3 automatic-check rounds"], "teal")
box(710, 425, 250, 128, "Durable steps", ["model calls via the gateway", "files · edit · shell · verify", "check_preview · update_todos", "start · final check · finish"], "teal")
box(440, 584, 250, 106, "Durable run stream", ["written by the loop and steps", "replay from any chunk index", "closed by the finish step"], "teal")
box(710, 584, 250, 106, "Sub-agents", ["research: web search + fetch", "explore: read-only code map", "own context · model calls nest"], "teal")
text(440, 714, "Every model call and tool call is a retried step · tool-call repair", 12, 500, C["teal"])
text(440, 732, "Per-file write ordering · steps saved as they finish", 12, 400, C["muted"])

# app → agentRun
arrow([(680, 322), (680, 425)], "teal", lab="start(agentRun)", at=(655, 342))
# agentRun → steps
arrow([(690, 489), (710, 489)], "teal")
# agentRun → stream
# stream → app (replay to browser)
arrow([(440, 637), (430, 637), (430, 322)], "teal", lab="replay to browser", at=(470, 342))
# steps → gateway
arrow([(835, 425), (835, 322)], "violet", lab="model call + run token", at=(835, 342))
# sub-agents → gateway (child token)
arrow([(960, 612), (970, 612), (970, 322)], "violet", dashed=True)
# browser → app
arrow([(320, 238), (420, 238)], "blue", lab="SSE + REST", at=(370, 222))

# steps → sandbox tool execution
arrow([(760, 553), (760, 568), (372, 568), (372, 775), (320, 775)], "amber", lab="exec · files · probe", at=(600, 568))

# ── Column 3: providers, web, GitHub, Vercel deployments ───────────────────────
group(1090, 110, 260, 380, "Model providers", "the user's own keys (BYOK)", "violet")
for i, (name, sub) in enumerate([
    ("NVIDIA NIM", "Kimi · GLM · Nemotron"),
    ("Anthropic", "Claude Sonnet · Opus · Haiku"),
    ("OpenAI", "GPT-6 · GPT-5 (Responses)"),
    ("DeepSeek", "V4 Pro · V4 Flash"),
]):
    box(1108, 172 + i * 76, 224, 62, name, [sub], "violet")
# gateway → providers
arrow([(980, 205), (1090, 205)], "violet", lab="user key,\nper call", at=(1045, 250))

box(1090, 520, 260, 84, "The web", ["search + page fetch for research", "SSRF-guarded, on the server"], "gray")
arrow([(960, 660), (1045, 660), (1045, 562), (1090, 562)], "gray", lab="search · fetch", at=(1045, 620))

box(1090, 850, 260, 80, "GitHub REST API", ["trees · commits · refs from the server", "OAuth token never in the sandbox"], "gray")
box(1090, 950, 260, 80, "Vercel Deployments API", ["build in sandbox, upload dist/ by SHA", "→ https://<app>.vercel.app"], "gray")
arrow([(1000, 740), (1045, 740), (1045, 890), (1090, 890)], "gray", lab="push", at=(1045, 815))
arrow([(1045, 890), (1045, 990), (1090, 990)], "gray", lab="deploy", at=(1045, 945))

# ── Supabase ────────────────────────────────────────────────────────────────────
group(400, 820, 600, 210, "Supabase", "Auth · Postgres with row-level security · Realtime", "green")
box(420, 885, 175, 120, "Auth", ["GitHub · Google · email", "httpOnly cookie sessions", "refreshed by proxy.ts"], "green")
box(612, 885, 368, 120, "Postgres + RLS", ["projects · messages (UI message parts) · runs", "spans (trace tree) · checkpoints · deployments", "credentials: AES-256-GCM, no client access"], "green")
arrow([(800, 752), (800, 885)], "green", lab="messages · spans · checkpoints · usage", at=(800, 795))
# browser → auth (sign in)
arrow([(340, 316), (386, 316), (386, 945), (420, 945)], "blue", dashed=True, lab="sign in", at=(386, 860))

# ── Column 4: prompt → live app, guarantees ────────────────────────────────────
out.append(f'<rect x="1385" y="110" width="265" height="560" rx="16" fill="#FFFFFF" stroke="{C["line"]}" stroke-width="1.2"/>')
text(1405, 140, "PROMPT → LIVE APP", 12.5, 700)
steps = [
    ("Send", "sign in, connect a model; key checked, then encrypted"),
    ("Start", "message saved, run token minted, workflow started"),
    ("Sandbox", "microVM up, starter app, dev server; preview loads"),
    ("Build", "model calls via the gateway, tools in the sandbox"),
    ("Delegate", "sub-agents research or explore in their own context"),
    ("Check", "tsc + build + preview probe; failures go back"),
    ("Save", "git checkpoint; message and trace stored"),
    ("Ship", "push to GitHub; deploy to a public URL"),
]
for i, (head, body) in enumerate(steps):
    y = 180 + i * 61
    badge(1413, y - 4, i + 1)
    text(1433, y, head, 13, 650)
    words, line, lines = body.split(), "", []
    for word in words:
        if len(line) + len(word) + 1 > 30:
            lines.append(line.strip())
            line = word
        else:
            line += " " + word
    lines.append(line.strip())
    for j, l in enumerate(lines[:2]):
        text(1433, y + 17 + j * 15, l, 12, 400, C["muted"])

out.append(f'<rect x="1385" y="690" width="265" height="340" rx="16" fill="#FFFFFF" stroke="{C["line"]}" stroke-width="1.2"/>')
text(1405, 720, "GUARANTEES", 12.5, 700)
guarantees = [
    ("Keys stay behind the gateway", "never in the browser or the sandbox"),
    ("Runs survive", "timeouts, redeploys and crashes"),
    ("Done means working", "it compiles, builds and renders"),
    ("Everything is traced", "model calls, tools, sub-agents"),
    ("Every run is a version", "restore any; push it to GitHub"),
]
for i, (head, body) in enumerate(guarantees):
    y = 754 + i * 55
    out.append(f'<circle cx="{1409}" cy="{y - 4}" r="4" fill="{C["teal"]}"/>')
    text(1421, y, head, 13, 650)
    text(1421, y + 17, body, 12, 400, C["muted"])

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="Daedalus system architecture diagram">
<title>Daedalus system architecture</title>
<defs>{markers}</defs>
<rect width="{W}" height="{H}" fill="{C["bg"]}"/>
{chr(10).join(out)}
</svg>'''
with open("docs/architecture.svg", "w") as f:
    f.write(svg)
print("wrote docs/architecture.svg")
