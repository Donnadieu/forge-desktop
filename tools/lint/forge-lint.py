#!/usr/bin/env python3
"""Forge Desktop's own lint rules: the project rules a generic linter can't know.

  tools/lint/forge-lint.py            check; exits 1 on any NEW or worsened violation
  tools/lint/forge-lint.py --list     print every rule, why it exists, and its fix
  tools/lint/forge-lint.py --update   shrink the baseline after paying debt down (never grows it)
  tools/lint/forge-lint.py --prove    plant one violation per rule in a scratch copy and prove each is caught

Old debt lives in tools/lint/baseline.json as {"rule|file": count}. It is a ceiling, not a floor:
a file with no entry must be clean, and a count may only go down. tools/lint/check-baseline.sh
fails if the baseline grew compared with main, because the easy way to beat a ratchet is to edit it.

Adding a rule: write a function below, add it to RULES with an id, a one-line why and a FIX an
agent can follow word for word, and a canary in CANARIES so --prove keeps it honest. A mistake
seen twice in review becomes a new rule here.
"""
import json, os, re, shutil, subprocess, sys, tempfile
from collections import Counter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MAX_LINES = 400
TEXT_EXT = (".swift", ".ts", ".js", ".json", ".md", ".sh", ".py", ".yml", ".yaml", ".toml", ".plist", ".txt")

def tracked_files(root):
    """Every file git would commit (tracked + new, minus ignored). Falls back to a walk outside git."""
    try:
        out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=root,
                             capture_output=True, text=True, check=True).stdout.split("\n")
        files = [f for f in out if f and os.path.isfile(os.path.join(root, f))]
    except (subprocess.CalledProcessError, FileNotFoundError):
        files = []
        for d, dirs, fs in os.walk(root):
            dirs[:] = [x for x in dirs if x not in (".git", "node_modules", "build")]
            files += [os.path.relpath(os.path.join(d, f), root) for f in fs]
    return sorted(f for f in files if f.endswith(TEXT_EXT) or os.path.basename(f) in ("Makefile", "NOTICE", "LICENSE")
                  or f.startswith(".githooks/"))

def code_part(line):
    return line.split("//", 1)[0]

def strings(line):
    return re.findall(r'"((?:[^"\\]|\\.)*)"', code_part(line))

# ---------------------------------------------------------------- Swift rules (Sources/**.swift)

def r_file_length(path, lines, ctx):
    if len(lines) > MAX_LINES:
        yield 1, f"{len(lines)} lines (max {MAX_LINES})"

def r_core_imports(path, lines, ctx):
    if not path.startswith("Sources/Core/"): return
    for i, l in enumerate(lines, 1):
        if re.match(r'\s*import\s+(SwiftUI|AppKit)\b', l):
            yield i, l.strip()

def r_no_browser_view(path, lines, ctx):
    for i, l in enumerate(lines, 1):
        if re.search(r'\bimport\s+WebKit\b|\bWKWebView\b|\bWebView\b', code_part(l)):
            yield i, "a browser view in the app"

UI_CALL = re.compile(r'\b(Text|Label|Button|Toggle|TextField|SecureField|Section|navigationTitle|help|alert|Window)\s*\(')
# "workspace" left this list when Workspaces became the product's word for a group of projects (Omar, Nov 5 2026).
JARGON = ["orchestrator", "MCP", "harness", "sidecar", "JSON", "config", "endpoint", "webhook",
          "cron", "token", "CLI", "terminal", "stdout", "daemon", "PID"]
def r_ui_jargon(path, lines, ctx):
    for i, l in enumerate(lines, 1):
        if not UI_CALL.search(l): continue
        for s in strings(l):
            # "Harness engineering" is the name of the Settings tile and setup step Omar asked for.
            s = s.replace("Harness engineering", "")
            for word in JARGON:
                # "Orchestrator" with a capital is the main screen's name; "Terminal" with a capital is the session's
                # Terminal panel Omar asked for (Nov 12). The lower-case words (and "use a terminal" steps) stay out.
                flags = 0 if word in ("orchestrator", "terminal") else re.I
                if re.search(r'(?<![\w/.-])' + re.escape(word) + r'(?![\w/.-])', s, flags):
                    yield i, f'"{word}" in UI text: "{s[:50]}"'

PROCESS_OK = ("Sources/EngineHost/",)
def r_process_area(path, lines, ctx):
    if path.startswith(PROCESS_OK): return
    for i, l in enumerate(lines, 1):
        if re.search(r'\bProcess\s*\(\s*\)|\bposix_spawn\b|(?<![.\w])system\s*\(', code_part(l)):
            yield i, "runs a program outside Sources/EngineHost/"

def r_raw_workflow_ui(path, lines, ctx):
    """The workflow file is Forge's: no screen reads it, shows it or writes it (Omar, Nov 11 2026)."""
    if not path.startswith("Sources/UI/"): return
    for i, l in enumerate(lines, 1):
        if re.search(r'\bWorkflowFile\b|\bWorkflowCheck\b|WORKFLOW\.md', code_part(l)):
            yield i, "a screen touches the raw workflow file"

# ---------------------------------------------------------------- repo-wide rules (every committed text file)

BANNED_WORD = "sym" + "phony"   # split so this file doesn't trip its own rule
def r_banned_name(path, lines, ctx):
    if path == "NOTICE": return
    for i, l in enumerate(lines, 1):
        if BANNED_WORD in l.lower():
            yield i, "names the project Forge is based on"

EMAIL = re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b')
EMAIL_OK = re.compile(r'@(example\.(com|org)|[a-z.]*\.test|users\.noreply\.github\.com)$|^noreply@github\.com$|^git@github\.com$')
KEY_ID = re.compile(r'(?<![0-9A-Fa-f])(?:[0-9A-F]{16}|[0-9A-F]{40})(?![0-9A-Fa-f])')
def r_hardcoded_identity(path, lines, ctx):
    if path in (".env.example",): return
    for i, l in enumerate(lines, 1):
        for e in EMAIL.findall(l):
            if not EMAIL_OK.search(e):
                yield i, f"email address {e}"
        if KEY_ID.search(l) and re.search(r'[A-F]', KEY_ID.search(l).group(0)):
            yield i, "a key ID or fingerprint"
        for v in ctx["identity"]:
            if v in l:
                yield i, "a value from your .env"

# Real keys are long; short look-alikes (a prefix table, test fixtures like "sk-ant-oat-owner") are not secrets.
SECRET = re.compile(r'lin_api_[A-Za-z0-9]{32}|sk-ant-[A-Za-z0-9_-]{60}|sk-proj-[A-Za-z0-9_-]{40}|\bghp_[A-Za-z0-9]{30}|\bgho_[A-Za-z0-9]{30}'
                    r'|github_pat_[A-Za-z0-9_]{20}|xox[bp]-[A-Za-z0-9-]{10}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30}')
def r_no_secrets(path, lines, ctx):
    for i, l in enumerate(lines, 1):
        if SECRET.search(l):
            yield i, "looks like a secret"

def r_keychain_only(path, lines, ctx):
    """Secrets go through Sources/Core/Keychain.swift only, and never into UserDefaults."""
    for i, l in enumerate(lines, 1):
        c = code_part(l)
        if path != "Sources/Core/Keychain.swift" and re.search(r'\bSecItem(Add|Update|CopyMatching|Delete)\b', c):
            yield i, "talks to the Keychain outside Sources/Core/Keychain.swift"
        if re.search(r'UserDefaults', c) and re.search(r'(?i)(key|token|secret|password)"', c):
            yield i, "keeps something secret-looking in UserDefaults"

def r_no_git_config_null(path, lines, ctx):
    """Never point git's global or system config at /dev/null: it drops the gh credential helper."""
    if path == "tools/lint/forge-lint.py": return
    for i, l in enumerate(lines, 1):
        if re.search(r'GIT_CONFIG_(GLOBAL|SYSTEM)', l) and "/dev/null" in l:
            yield i, "sets GIT_CONFIG_GLOBAL/SYSTEM to /dev/null"

def r_engine_provenance(path, lines, ctx):
    if not path.startswith("engine/src/"): return
    if path[len("engine/"):] not in ctx["provenance"]:
        yield 1, "no line in engine/PROVENANCE.md"

LINK = re.compile(r'\]\(([^)#\s]+)(?:#[^)]*)?\)')
def r_docs_map(path, lines, ctx):
    if path == "AGENTS.md" and len(lines) > 80:
        yield 1, f"AGENTS.md is {len(lines)} lines (max 80): it's a map, not a manual"
    if path.endswith(".md"):
        fenced = False
        for i, l in enumerate(lines, 1):
            # Links inside ``` code blocks are examples (message templates), not links.
            if l.lstrip().startswith("```"):
                fenced = not fenced
                continue
            if fenced: continue
            for target in LINK.findall(l):
                if re.match(r'[a-z]+:', target): continue
                full = os.path.normpath(os.path.join(ctx["root"], os.path.dirname(path), target))
                if not os.path.exists(full):
                    yield i, f"broken link {target}"
    if path.startswith("docs/") and path.endswith(".md") and path not in ctx["indexed"] and path != "docs/INDEX.md":
        yield 1, "not linked from docs/INDEX.md"

SWIFT_RULES = {"file-length", "core-imports", "no-browser-view", "ui-jargon", "process-area", "keychain-only", "raw-workflow-ui"}
RULES = {
    "file-length":   (r_file_length, "Big files are hard to read and to change safely.",
                      "Move whole declarations into a new file for that area (see docs/ARCHITECTURE.md)."),
    "core-imports":  (r_core_imports, "Core holds plain logic every layer can use; UI frameworks there tangle the layers.",
                      "Move the view code to Sources/UI/ (or the app wiring to Sources/App/); Core imports Foundation only."),
    "no-browser-view": (r_no_browser_view, "Forge is a native Mac window, never a browser page.",
                      "Build the screen in SwiftUI. Open links in the person's browser with NSWorkspace instead."),
    "ui-jargon":     (r_ui_jargon, "People see cards, columns, agents and repos, not engine words.",
                      "Say it in plain words (see docs/PRODUCT_SENSE.md 'Words on screen')."),
    "process-area":  (r_process_area, "Running programs is risky; it happens in one known place.",
                      "Move the call into Sources/EngineHost/ (the code that starts and stops the engine)."),
    "raw-workflow-ui": (r_raw_workflow_ui, "Hand edits to the workflow file broke too much; Forge alone writes it, from real controls.",
                      "Add the setting as its own control (Workflow Studio or Settings) saved through SetupChoices; EngineSettings writes the file."),
    "keychain-only": (r_keychain_only, "Secrets live in the Keychain and nowhere else (plan section 2).",
                      "Use Keychain.get/set (Sources/Core/Keychain.swift). Settings that aren't secret go in setup.json."),
    "no-git-config-null": (r_no_git_config_null, "It drops the gh credential helper, so git asks the macOS keychain and pops a password prompt.",
                      "Leave git's global config alone; set what you need with `git config --local` in the scratch repo."),
    "banned-name":   (r_banned_name, "This is Forge. The project it was based on is never named, except in NOTICE.",
                      "Remove the name. Credit lives only in NOTICE, which travels with copied code."),
    "hardcoded-identity": (r_hardcoded_identity, "Twelve-factor: names, emails and key IDs come from env or the Keychain.",
                      "Read it from the environment (.env locally, see .env.example) or the Keychain at run time."),
    "no-secrets":    (r_no_secrets, "Secrets never live in the repo.",
                      "Remove it and rotate it. Secrets come from the Keychain at run time, or .env for local tooling."),
    "engine-provenance": (r_engine_provenance, "Every engine file must say which Forge commit it came from, so pulls stay easy.",
                      "Add a row to engine/PROVENANCE.md: | src/<path> | <forge commit> | <forge path> | <changes> |."),
    "docs-map":      (r_docs_map, "Agents find their way through AGENTS.md and docs/INDEX.md; broken or missing links strand them.",
                      "Fix the link, link the new doc from docs/INDEX.md, or move detail out of AGENTS.md into docs/."),
}

# One planted violation per rule, used by --prove: (file, content).
CANARIES = {
    "file-length": ("Sources/UI/Canary.swift", "import SwiftUI\n" + "let x = 1\n" * 401),
    "core-imports": ("Sources/Core/Canary.swift", "import SwiftUI\n"),
    "no-browser-view": ("Sources/UI/Canary.swift", "import WebKit\n"),
    "ui-jargon": ("Sources/UI/Canary.swift", 'let t = Text("Restart the orchestrator")\n'),
    "process-area": ("Sources/UI/Canary.swift", "let p = Process()\n"),
    "raw-workflow-ui": ("Sources/UI/Canary.swift", "let f = WorkflowFile(home: home).text\n"),
    "keychain-only": ("Sources/UI/Canary.swift", 'func f() { UserDefaults.standard.set("x", forKey: "linearKey") }\n'),
    "no-git-config-null": ("tools/canary.sh", 'GIT_CONFIG_GLOBAL=/dev/null git status\n'),
    "banned-name": ("docs/canary.md", "Based on " + BANNED_WORD.title() + ".\n"),
    "hardcoded-identity": ("Sources/Core/Canary.swift", '// signed by ' + "0123456789ABCDEF" + '\nlet e = "' + "someone" + "@" + "forjado.ai" + '"\n'),
    "no-secrets": ("Sources/Core/Canary.swift", 'let k = "' + "lin_api_" + "a1B2c3D4" * 5 + '"\n'),
    "engine-provenance": ("engine/src/config/canary.ts", "export const x = 1;\n"),
    "docs-map": ("docs/canary-orphan.md", "# Orphan\n"),
}

def load_env_identity(root):
    vals = []
    p = os.path.join(root, ".env")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            m = re.match(r'\s*(GIT_AUTHOR_NAME|GIT_AUTHOR_EMAIL|GIT_COMMITTER_NAME|GIT_COMMITTER_EMAIL|FORGE_GIT_SIGNING_KEY)=(.*)', line)
            if m:
                v = m.group(2).strip().strip('"').strip("'")
                if len(v) >= 4: vals.append(v)
    return sorted(set(vals))

def context(root):
    prov = set()
    pp = os.path.join(root, "engine", "PROVENANCE.md")
    if os.path.exists(pp):
        for l in open(pp, encoding="utf-8"):
            m = re.match(r'\|\s*`?(src/[^|`\s]+)`?\s*\|', l)
            if m: prov.add(m.group(1))
    indexed = set()
    ip = os.path.join(root, "docs", "INDEX.md")
    if os.path.exists(ip):
        for t in LINK.findall(open(ip, encoding="utf-8").read()):
            indexed.add(os.path.normpath(os.path.join("docs", t)))
    return {"root": root, "provenance": prov, "indexed": indexed, "identity": load_env_identity(root)}

def scan(root):
    ctx = context(root)
    found = []
    for path in tracked_files(root):
        try:
            lines = open(os.path.join(root, path), encoding="utf-8").read().split("\n")
        except UnicodeDecodeError:
            continue
        is_swift = path.startswith("Sources/") and path.endswith(".swift")
        for rid, (fn, _, _) in RULES.items():
            if (rid in SWIFT_RULES) and not is_swift:
                continue
            if rid == "hardcoded-identity" and path in ("tools/lint/forge-lint.py",):
                continue
            for line, msg in fn(path, lines, ctx):
                found.append((rid, path, line, msg))
    return found

def baseline_path(root):
    return os.path.join(root, "tools", "lint", "baseline.json")

def load_baseline(root):
    p = baseline_path(root)
    return json.load(open(p)) if os.path.exists(p) else {}

def report(root, quiet=False):
    found = scan(root)
    counts = Counter(f"{r}|{p}" for r, p, _, _ in found)
    base = load_baseline(root)
    bad = [k for k, n in counts.items() if n > base.get(k, 0)]
    if not quiet:
        for k in bad:
            rid, path = k.split("|", 1)
            _, why, fix = RULES[rid]
            print(f"✗ {rid} in {path}: {counts[k]} (allowed {base.get(k, 0)}). {why}")
            for r, p, line, msg in found:
                if r == rid and p == path: print(f"    {path}:{line}  {msg}")
            print(f"    FIX: {fix}")
        paid = sum(base.values()) - sum(min(v, counts.get(k, 0)) for k, v in base.items())
        if paid: print(f"Debt paid down: {paid}. Run tools/lint/forge-lint.py --update to lock it in.")
        print(f"forge-lint: {len(RULES)} rules, {sum(counts.values())} findings, {sum(base.values())} grandfathered, {len(bad)} new problems")
    return bad, counts, base

def prove():
    """Each rule must catch its canary in a scratch copy of the repo; the real tree is never touched."""
    missing = [r for r in RULES if r not in CANARIES]
    if missing:
        print(f"✗ rules without a canary: {missing}. FIX: add one to CANARIES."); return 1
    failed = 0
    for rid, (rel, content) in CANARIES.items():
        with tempfile.TemporaryDirectory() as tmp:
            for f in tracked_files(ROOT):
                dst = os.path.join(tmp, f); os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy(os.path.join(ROOT, f), dst)
            dst = os.path.join(tmp, rel); os.makedirs(os.path.dirname(dst), exist_ok=True)
            open(dst, "w").write(content)
            bad, _, _ = report(tmp, quiet=True)
            hit = any(k == f"{rid}|{rel}" for k in bad)
            print(f"{'✓' if hit else '✗'} {rid} catches {rel}")
            failed += 0 if hit else 1
    print("prove: every rule blocks its canary" if not failed else f"prove: {failed} rule(s) let a canary through")
    return 1 if failed else 0

def main():
    args = sys.argv[1:]
    if "--list" in args:
        for rid, (_, why, fix) in RULES.items(): print(f"{rid}: {why}\n    FIX: {fix}")
        return 0
    if "--prove" in args:
        return prove()
    if "--update" in args:
        bad, counts, base = report(ROOT, quiet=True)
        new = {k: min(v, counts.get(k, 0)) for k, v in base.items() if counts.get(k, 0) > 0}
        json.dump(dict(sorted(new.items())), open(baseline_path(ROOT), "w"), indent=1)
        open(baseline_path(ROOT), "a").write("\n")
        print(f"Baseline: {sum(base.values())} -> {sum(new.values())}")
        return 0
    bad, _, _ = report(ROOT)
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
