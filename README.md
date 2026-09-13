# a11y-agent — week-one de-risking spikes

Five timeboxed experiments (S1–S5) that answer the questions the a11y-agent technical
design rests on (its §0.5 defines them). Three of them can change the project's phasing,
which is why they run **before** production code rather than after it.

The design docs themselves belong in [`docs/`](./docs/) — see that directory's README for
the section numbers the code comments cite.

Each spike is a real program against real targets. None of them mock anything. Every one
writes a machine-readable result to `results/<id>.json` and prints a verdict it derived
from its own observations.

| Spike | Question | Budget | Verdict |
|---|---|---|---|
| **S1** | Do framework debug internals actually resolve? | 1.5 d | ✅ **pass** (with three caveats that change the design) |
| **S2** | Can React Server Components be attributed at all? | 2 d | ✅ **pass** (via probing and CSS Modules, not the fiber) |
| **S3** | What does a run actually cost? | 1 d | 🟡 **partial** (ratios measured; tokens estimated) |
| **S4** | How much visible text is literal in the repo? | 1 d | 🟡 **partial** (96% present, only 31% unique) |
| **S5** | Can we instrument real sites at all? | 1 d | ✅ **pass** |

> An unrun spike is an open question, not a passing one. `npm run report` always prints
> a row for all five so a missing result can never read as a clean one.

---

## Quick start

Works the same on Windows, macOS and Linux.

```bash
git clone <this repo>
cd dropkerb

npm run setup      # deps + Chromium + all fixture apps
npm run setup:s4   # optional, separate: S4 corpus (~330 MB of git clones)
npm run doctor     # verify the environment, per-OS hints if not
npm run spike:s1   # run one spike
npm run report     # render results/REPORT.md
```

**Requires Node ≥ 22.18.** The spikes are written in TypeScript and run directly —
Node's native type stripping, no build step, no loader, no `ts-node`. `npm run doctor`
checks this first and tells you if your Node is too old.

### Commands

| Command | What it does |
|---|---|
| `npm run setup` | Installs root deps, downloads Chromium, installs all seven fixture apps |
| `npm run setup -- --spike s1` | Only the fixtures S1 needs |
| `npm run setup -- --skip-browsers` | Skip the ~115 MB Chromium download |
| `npm run setup:s4` | **Separate install:** clone the 7 repos S4 measures (~330 MB). Needs `git` |
| `npm run setup -- --with-corpus` | Do the normal setup *and* the S4 corpus in one go |
| `node spikes/s4-literal-text/install.ts --list` | Show which corpus repos are installed |
| `npm run doctor` | Checks Node, deps, Chromium, and each fixture; prints the fix for anything missing |
| `npm run spike:s1` … `s5` | Run one spike |
| `npm run spike:all` | Run all five in sequence, then render the report |
| `npm run spike:all -- --offline` | Only the spikes that need no network (S1, S2) |
| `npm run spike:all -- s1 s5` | Only the named spikes |
| `npm run report` | Regenerate `results/REPORT.md` from `results/*.json` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run clean` | Remove build output and run artifacts |
| `npm run clean -- --deps` | Also remove every `node_modules` |
| `npm run clean -- --corpus` | Also remove S4's cloned repos (~330 MB) |

---

## Platform notes

Everything routes through Node — no shell loops, no `rm -rf`, no `&&` chains — so the
same commands work in PowerShell, cmd, bash, zsh and fish.

### Windows

Works in **PowerShell**, **cmd** and **Git Bash** without changes. The setup script
resolves `npm.cmd` / `npx.cmd` itself and spawns without a shell, so paths containing
spaces (`C:\Users\Jane Smith\...`) and OneDrive-backed folders are fine.

S4 additionally needs `git` on `PATH` (`winget install --id Git.Git`). Its clones force
`core.autocrlf=false`, `core.longpaths=true` and `core.symlinks=false` regardless of your
global git config — otherwise the default Windows `autocrlf=true` would rewrite line
endings in the corpus and S4 would report a lower result on Windows than on macOS or Linux
for no reason but the OS. Checkouts under OneDrive occasionally fail while a sync or
indexer holds a file; the installer retries and then verifies the tree, so a partial
checkout can't masquerade as "this text isn't in the repo".

One caveat if you edit files from a shell: **heredocs in Git Bash on Windows eat one
level of backslash**, so a regex like `/[\\]/` silently becomes `/[\]/` and the file
stops parsing. Use an editor, or PowerShell here-strings, for anything containing
backslashes. This bit us while building the harness and the fix is written up in
[CLAUDE.md](./CLAUDE.md).

### macOS

No special steps. On Apple Silicon, Playwright downloads the arm64 Chromium build
automatically. For S4, `git` ships with the Xcode command line tools
(`xcode-select --install`).

### Linux

Use `npm run setup`, which passes `--with-deps` to Playwright so the shared libraries
Chromium needs get installed. On a distro where that can't run (no root, or an unsupported
package manager):

```bash
npx playwright install chromium          # browser only
# then install the system libs your distro needs for Chromium
```

For S4, install `git` from your package manager (`apt-get install git`, `dnf install git`).

**Running as root** (Docker, most CI images): Chromium refuses to start with a sandbox as
root. The harness detects this and adds `--no-sandbox` automatically. Override either way:

```bash
A11Y_SPIKE_NO_SANDBOX=1 npm run spike:s1   # force off (containers)
A11Y_SPIKE_NO_SANDBOX=0 npm run spike:s1   # force the sandbox back on
```

### WSL

Treat as Linux. Run from the Linux filesystem (`~/…`), not `/mnt/c/…` — npm installs and
S4's git clones onto a mounted Windows drive are slow enough to be worth avoiding.

### CI

```yaml
- uses: actions/setup-node@v4
  with: { node-version: '22' }
- run: npm run setup
- run: npm run spike:all -- --offline    # S1 + S2, no external network
- run: npm run report
```

Keep the network spikes (S3, S4, S5) off PR runs — they hit third-party sites, and
hammering them from CI is exactly the behaviour TDD §9.5 says not to enable.

---

## What each spike does

### S1 — framework debug internals ✅

Builds a fixture per matrix cell — **{React 17, 18, 19} × {dev, prod}**, plus Vue 3 and
Svelte 4/5 — each with 20 tagged DOM nodes, and asks each framework's private debug API
to name the source line that produced each node. Ground truth is derived from the fixture
source itself, so a fixture edit can't silently drift from what it's checked against.

**Result: every dev cell attributed all 20 nodes. No production cell attributed any.**
But the headline hides three findings that change the design:

1. **React 19 removed `_debugSource`.** The field is *absent*, not null — a resolver that
   reads it gets `undefined` and, without a startup self-test, silently attributes nothing
   instead of failing. React 19 still carries the JSX call site in `_debugStack`, but as a
   bundle-relative `Error` stack: recovering a source line means consuming the build's
   source map. That moves React 19 from TDD §5.1 (read a field) to §5.2 (consume a map).
2. **Vue has no line number at all.** `__vueParentComponent.type.__file` names the correct
   file and stops there. The design's "file:line at confidence 0.95" doesn't hold for Vue;
   reaching line granularity needs anchor search plus structural verification as a second
   stage, so Vue costs more than "pluggable locator" suggests.
3. **Svelte 4 reports `loc.line` 0-based; Svelte 5 reports it 1-based.** A resolver written
   against one and shipped against the other lands every patch exactly one line off — the
   quietest possible way to be wrong. The startup self-test has to assert *line numbers*,
   not just field presence, or it sails straight past this.

Not measured: **Angular 17**, which is in the §0.5 matrix. Its row is recorded as an
explicit gap, not omitted.

### S2 — RSC attribution ⬜

Next.js App Router fixture mixing a server component and a client component, testing in
order: client-side residue on server-rendered nodes, component identity in the RSC flight
payload, CSS-module source maps, and differential probing through the server build.

Fixture is built; the runner isn't written yet.

### S3 — what a run costs 🟡

Crawls a few pages of real sites, builds the sensor payload a run would actually send
(CDP accessibility tree + axe violations), and costs it against the current rate card.

Three levers, measured in order of size. **Payload shape dominates**: sending
violations-with-context instead of the whole accessibility tree is ~6% of the payload,
taking a 500-page site from ~$103 to ~$7 on Opus 5. **Model tier is a 5× lever.**
**Prompt caching is a red herring** at this prompt shape — the cacheable prefix is 188
tokens against a multi-thousand-token page.

**Template clustering is the one that cannot be quoted yet**: 46% of pages are
structurally distinct at Jaccard 0.8 and 96% at 0.95. A 50-point swing from a
hand-picked threshold is not a saving, it is an unvalidated parameter — and saying so
is the finding.

Verdict is `partial` because this machine has no `ANTHROPIC_API_KEY`, so tokens and
dollars are estimated from measured bytes. The ratios above need no tokenizer and are
measured either way. Set a key and re-run to convert the estimates:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run spike:s3
```

Token counts use the Messages API `count_tokens` endpoint — free, and the only exact
answer for a given model.

### S4 — literal text in repos 🟡

Anchor search (§5.3) assumes visible copy lives in source. On CMS-driven and i18n'd sites
it lives in a database or a locale bundle. Shallow-clones seven real projects, renders a
page each project publishes, and looks for every visible string in the checkout.

The answer is not the one the design assumed. **96% of visible strings are in the repo —
but only 31% appear exactly once**, and a string found in forty files has located nothing.
Anchor search is a ranking input, not a locator. Length is what decides it (77% unique at
≥ 25 characters, 16% below it), and site chrome — nav, header, footer, where a great many
real accessibility findings sit — is the worst case at 9%.

Needs `git` and a separate corpus install: `npm run setup:s4`.

### S5 — instrumenting real sites ✅

Fifteen real sites across the target profile. For each: navigate, record CSP, attempt DOM
script injection, attempt CDP injection, run a full axe-core scan, pull the CDP
accessibility tree, and check for bot challenges.

**Result: 15/15 navigated, 15/15 ran axe end to end, 15/15 exposed the AX tree, zero bot
challenges.** Four sites ship a CSP strict enough to block `addScriptTag` — and CDP-level
evaluation bypassed it every time.

**So: strict CSP is not a blocker, provided every injection goes through CDP and
`addScriptTag` is treated as unusable.** Remote auditing stays a supported path and the
product framing in PRD §5.1 holds.

---

## Reading the results

```
results/
  REPORT.md         rendered summary — start here
  s1.json           full result: verdict, conclusion, design impact, every observation
  s5.json
  raw/
    s1.jsonl        append-only log, survives a crashed run
    s1-nodes.json   per-node detail for every matrix cell
    s1-cells.json   per-cell summary
```

Each `results/<id>.json` carries the question, the verdict, a conclusion the spike wrote
from its own observations, and a `designImpact` field saying what changes if the verdict
is bad. That last field is the point of the exercise.

---

## Layout

```
scripts/          cross-platform setup, doctor, runner, reporter, clean
spikes/
  shared/         browser + CDP session, static server, source-map consumer, recorder
  s1-debug-internals/
    fixtures/     react/{v17,v18,v19}, vue/v3, svelte/{v4,v5} — isolated node_modules each
    resolvers/    the browser-side probes, one per framework
    manifest.ts   derives ground truth from fixture source
    grade.ts      scoring, including systematic-offset detection
  s2-rsc-attribution/fixture-next/
  s3-cost/  s4-literal-text/  s5-instrumentation/
results/
```

Each fixture has **its own `node_modules` on purpose**. A single tree would let
`react-dom@17` resolve `react@19` internally and quietly break the version isolation S1
exists to measure.

---

## Crawling ethics

S4 and S5 reach the public internet. They fetch each site's `robots.txt` first (with
retries, so a transient failure shrinks the sample visibly rather than silently), honour
`Disallow`, send a descriptive user agent that says what they are, rate-limit to one
request per host every 3 seconds, and touch homepages only.

Per TDD §9.5: a tool that makes it easy to crawl sites you don't own is a tool that will
be used to crawl sites people don't own. Keep these off CI.

---

*Written for engineers picking up the a11y-agent project — the people who'll run these
spikes and act on what they found.*
