# CLAUDE.md — working context

Read this before touching the repo. It records what's built, what isn't, and the
non-obvious things that cost time to discover.

## What this repo is

Not the a11y-agent product. This is the **week-one de-risking spikes** (S1–S5) from the
technical design's §0.5 — five timeboxed experiments that gate the phasing. The user
chose this scope deliberately over building Phase 1 or a demo, because three of the five
can invalidate the plan.

**The deliverable of a spike is its `designImpact` field, not its verdict.** A spike that
passes but reveals the design was wrong about *how* it passes has done its job.

## Status

| Spike | State | Notes |
|---|---|---|
| S1 debug internals | ✅ done, verdict `pass` | 10 cells: React 17/18/19 × dev/prod, Vue 3, Svelte 4/5. Angular 17 recorded as an explicit gap, not measured. |
| S2 RSC attribution | ✅ done, verdict `pass` | Next 15.1.6, 13 server + 5 client tagged nodes. Probing and CSS Module class names attribute; flight payload and client residue do not. |
| S3 cost | ✅ done, verdict `partial` | 24 pages, 3 sites. Ratios measured; **tokens and dollars are estimated** — no `count_tokens` credentials on this machine. |
| S4 literal text | ✅ done, verdict `partial` | 932 visible strings, 8 pages, 7 real repos. Corpus installs **separately** (`npm run setup:s4`), ~330 MB. |
| S5 instrumentation | ✅ done, verdict `pass` | 15 sites, full sample. |

## Findings so far (don't re-derive these)

**S1.** Every dev cell attributed all 20 nodes; no production cell attributed any. The
three findings that actually matter:

- **React 19 removed `_debugSource`** — the field is *absent* from the fiber, not null.
  Reading it yields `undefined` and silently attributes nothing. React 19 still carries
  the JSX call site in `_debugStack`, an `Error` whose frames point into the **bundle**,
  so attribution needs a source-map lookup. This moves React 19 from TDD §5.1 to §5.2.
- **Vue has no line number.** `__vueParentComponent.type.__file` gives the correct file
  and nothing more. `line: null`, always.
- **Svelte 4 `loc.line` is 0-based; Svelte 5 is 1-based.** Same fixture, same markup,
  every line off by exactly one. `grade.ts`'s `systematicOffset()` detects this rather
  than reporting 20 separate "wrong-line" failures.
- No debug signal of any kind survives a production build, in any framework.

**S2.** Server components *do* carry a React fiber (13/13) — the fiber is not the problem,
the debug fields are. Nothing on it names a source location.

- **Probing works, and it is fast** — marker injected at `app/page.jsx:19`, landed on the
  right node in ~1s through the App Router dev server. This is the load-bearing signal
  for RSC, which confirms the hard dev-server dependency for App Router projects.
- **Next's dev CSS Module class names decode without a source map**:
  `page_serverCard__aV6KY` → `page.module.css .serverCard`, 5/5. Production uses a bare
  hash and no stylesheet advertised a source map, so §5.2 still needs the map index.
- **The flight payload names `app/page.js` but never the server component's own source.**
  Client components appear as module references because they must be hydrated; server
  components are already HTML on arrival, so there is nothing to reference. Structural,
  not a Next version detail.
- **The client control failed here but passed in S1.** Both are React 19, but under Next
  the fiber carries `_debugOwner`/`_debugInfo` and no `_debugStack`, so 0/5 client nodes
  attributed. Next's React build is not plain React 19 — don't assume S1's React 19 row
  covers Next.

**S3.** Verdict is `partial` **because of the environment, not the result**: there are no
`count_tokens` credentials here, so tokens and dollars are estimated from measured bytes.
Byte, page, violation and template counts are real. Re-run with `ANTHROPIC_API_KEY` set
and the estimates become measurements — the spike says which, every time.

- **Payload shape is the biggest lever: violations-with-context is ~6% of the full AX
  tree** (40.9k → 2.6k tokens/page average). Costing a 500-page site on Opus 5 goes from
  ~$103 naive to ~$7. The Judge prompt must be built outward from each violation; handing
  the model the tree is not a tuning choice, it is a 15× cost difference.
- **But that saving scales with violation count.** The sample averaged 2.8 violations/page
  and p95 full-tree is 99k tokens. Plan against p95, not the mean of a clean sample.
- **Template clustering is threshold-sensitive to the point of being unusable as a quoted
  number**: 46% of pages distinct at Jaccard 0.8, 96% at 0.95 — a 50-point swing from a
  hand-picked parameter. §10 cannot quote a clustering saving until the similarity metric
  is validated against pages *known* to share a template.
- **Prompt caching is a red herring at this prompt shape** — the system prefix is 188
  tokens against a multi-thousand-token page payload, so it saves ~6%.
- **Model tier is a 5× lever** ($5.42 Opus 5 vs $1.08 Haiku 4.5 for the same run).

**S4.** The text is almost always there; it just doesn't identify a place.

- **96% of visible strings appear in the repo, but only 31% appear exactly once.** 65% are
  found in more than one place, so anchor search returns candidate sets, not locations.
- **Length decides everything: 77% unique at ≥ 25 chars, 16% below it.** The short strings
  are button and link labels — exactly what accessibility findings attach to.
- **Site chrome is the worst case: 9% unique across 354 nav/header/footer strings.** The
  page average flatters the fallback; the chrome subset is the number that matters.
- Unique hits land in prose content (177) more often than markup (75); 38 land in i18n
  catalogues, where the string is found but the render site still isn't.

**S5.** 15/15 sites navigated, ran axe end to end, and exposed the CDP AX tree. Four ship
a CSP strict enough to block `addScriptTag`; **CDP-level evaluation bypassed it every
time.** Conclusion: always inject via CDP, treat `addScriptTag` as unusable.

## Gotchas that cost real time

**Bash heredocs on this machine eat one level of backslash.** Writing a file with
`cat > f.ts <<'EOF'` turns `/[\\]/` into `/[\]/` — an unterminated character class that
fails to parse. It bit `robots.ts`, `serve.ts`, `manifest.ts` and `attribute.ts`.
**Use the Write/Edit tools for any file containing a backslash.** Heredocs are fine for
everything else.

Heredocs also **truncate silently past roughly 170 lines**. Two files got cut mid-token.
Use Write for anything longer.

**Each fixture needs its own `node_modules`.** A single tree lets `react-dom@17` resolve
`react@19` internally, which destroys the version isolation S1 exists to measure. npm
aliases (`react17@npm:react@17`) don't fix this — the transitive `require('react')` still
resolves to the root copy.

**TypeScript runs natively** on Node ≥ 22.18, no loader. So: no enums, no namespaces, no
parameter properties, and `.ts` extensions are required in relative imports.

**Clone the S4 corpus with portable git config or the result is OS-dependent.**
`clone.ts` forces `core.autocrlf=false`, `core.eol=lf`, `core.longpaths=true` and
`core.symlinks=false` on every clone. The default Git for Windows install sets
`autocrlf=true`, which rewrites LF to CRLF on checkout — the strings we search for come
from a browser and contain LF, so without this S4 would report a *lower* literal-text
rate on Windows than on macOS/Linux for no reason but the OS.

**`git clone` checkout fails transiently on Windows, and a failed checkout looks like a
finding.** "Clone succeeded, but checkout failed" left a valid `.git` beside a partial
tree; the identical command then worked. Under OneDrive (this checkout's location) that
is an indexer or sync holding a file, not a git problem. `ensureClone` retries three
times and then verifies with `git ls-files --deleted`, because an unverified partial tree
makes every string read as absent — i.e. it reports "the text is not in the repo".
The retry is not theoretical: `govuk` needed attempt 2 during the corpus install.

**`tsconfig.json` must exclude `spikes/s4-literal-text/repos/`.** The corpus lands inside
`spikes/`, so the default `spikes/**/*.ts` include swept real projects into the program
and `tsc --noEmit` died with an out-of-memory abort.

**Readiness is "the port answers", never a banner on stdout.** `next dev` is a supervisor
that forks the real server as a grandchild, so its startup banner does not reliably reach
our pipe. `startDevServer` used to gate on that banner; the buffer stayed empty, the gate
never opened, and S2 published *"RSC is not attributable by any signal"* about a dev
server that was serving correctly the whole time. Four separate runs were lost to this.

**A failed start must kill what it spawned.** When `startDevServer` threw, nothing killed
the child: its open stdio pipes kept our own event loop alive, so the spike hung forever
instead of reporting the timeout it had already detected — and the leaked server held the
port so the *next* run failed too. On Windows `taskkill /T` cannot reach a grandchild once
the parent has exited, so `killTree` also sweeps the port via `netstat` + `taskkill`.

**S2's probe edits the fixture, so a killed run poisons the next one.** The restore lives
in a `finally`, which a SIGKILL/taskkill never reaches, leaving `data-probe="..."` behind.
This is not cosmetic: **JSX keeps the _last_ of duplicate attributes**, so a stale marker
shadows the new one and probing reports "marker never appeared" about a mechanism that
works in 0s. `run.ts` now strips stale markers at startup and records an explicit
observation when it has to, rather than trusting the previous run to have tidied up.

**Never wait on `networkidle` against a dev server.** The page holds an open HMR socket
and keeps polling, so the network never goes idle and every reload burns its full timeout.
Use `domcontentloaded` — for server-rendered markup the parsed document is all you need.

**A spike must not report a verdict for a signal it never tested.** S2 collapsed four
signals to booleans, so a run that died early rendered "not tested" as "no" and wrote a
confident `fail` over a previous real result. Each signal now carries three states and
prints `NOT TESTED`; an incomplete run can be neither `pass` nor `fail`. This is the
same rule as `NOT RUN` in the reporter, applied *within* a spike.

**S3's page sampling must prefer siblings, or it measures the one part of a site that has
no templates.** Taking the first same-origin links means taking the top nav, which points
at the handful of deliberately-different pages (home, about, contact). Clustering those
gave 8 templates in 8 pages and "clustering saves nothing" — a false negative about the
cost model. `discover()` now prefers links under the entry page's own directory and
reports how many of the sample were siblings, so a weak sample is visible.

**Structural signatures must exclude `StaticText`.** With text nodes in the signature,
every site hit exactly 100% distinct at Jaccard 0.9 — a suspiciously uniform cliff that
was measuring how much prose a page has, not its template. Excluding content roles
produced a real gradient and per-site differences that match what the sites actually are.
The general rule: when a metric returns the same extreme value for every input, suspect
the metric.

**Ground truth is derived, never hand-written.** `manifest.ts` parses the fixture source
for `data-spike-id` and records the line. The convention is **one tagged element per
line**, and `manifest.ts` throws if a line carries two — a fixture bug that reads as a
product finding is the worst kind of bug in an experiment.

## Conventions

- Code comments cite design sections as `TDD s5.1` / `PRD s5.1` (ASCII `s`, not `§`, to
  survive shell round-trips) instead of restating the reasoning.
- Comments explain **why**, and are load-bearing where a choice looks arbitrary — why the
  AX tree and not the DOM, why per-fixture `node_modules`, why 5th percentile not minimum.
- Every spike writes a verdict **it derived from its own observations**. Never hardcode a
  conclusion; if the numbers change, the text must change with them.
- Missing results render as `NOT RUN`, never as absent rows. An omitted row reads as a
  pass — the exact failure mode TDD §3.9 exists to prevent.
- Unmeasured matrix cells get an explicit `unmeasured` observation (see Angular in S1).

## Cross-platform

Everything goes through Node (`scripts/*.mjs`) — no shell loops, no `rm -rf`, no `&&`.
`scripts/platform.mjs` holds the OS branching: `--with-deps` for Playwright on Linux,
`--no-sandbox` auto-detected when running as root, and the spawn rule below.

**Never spawn a `.cmd` shim — spawn the JS entry point with `process.execPath`.**
Since the CVE-2024-27980 fix, Node refuses to spawn `.cmd`/`.bat` without `shell: true`
and throws a bare `EINVAL` naming nothing useful. `shell: true` would fix it and
reintroduce quoting bugs on paths with spaces (`C:\Users\Jane Smith\...`). So:
`runNpm()` runs npm's bundled `npm-cli.js`, setup runs `playwright/cli.js` directly
instead of `npx playwright`, and `proc.ts` runs `next/dist/bin/next`. This is one rule
with three instances — `setup.mjs` shipped with the npx form and it failed on the first
Windows machine that ran it with nothing installed.

git is the exception: it is a real `.exe` on Windows, so it spawns normally.

Verify with `npm run doctor` before assuming an environment problem is a code problem.

## Running things

```bash
npm run setup                  # deps + Chromium + 7 fixture apps (NOT the S4 corpus)
npm run setup:s4               # S4 corpus: 7 shallow git clones, ~330 MB, separate
npm run doctor                 # environment check with per-OS fixes
npm run spike:s1               # one spike
npm run spike:all -- --offline # S1 + S2 only, no external network
npm run report                 # results/*.json -> results/REPORT.md
```

The S4 corpus is a **separate install** on purpose: it is hundreds of megabytes of clones
from the public internet and the other four spikes need none of it, so `npm run setup`
prints a pointer instead of paying that cost. `spike:s4` clones anything missing on
demand, so the spike still runs standalone. Useful flags:
`install.ts --list | --only <id> | --force`, `run.ts --only <id> | --max-strings N`.

S1 takes ~2 minutes (ten builds). S5 takes ~3 minutes (15 sites, self-rate-limited).
S4 takes ~3 minutes once cloned; the first clone adds several minutes.

## If you're continuing the work

Next in value order:

All five spikes have now run. What is left is tightening two of them and closing one gap:

1. **Re-run S3 with `ANTHROPIC_API_KEY` set.** One command, and it converts every token
   and dollar figure from estimate to measurement. Until then §10 has ratios but no
   costs, and `partial` is an environment artifact rather than a finding.
2. **Validate S3's template-similarity metric.** The 50-point swing across thresholds is
   the one result blocking the clustering half of the cost model. It needs a small set of
   pages *known* to share a template to calibrate against — that is a fixture, not a
   crawl.
3. **Re-run S4 against app-shaped sites.** The current corpus is 7 docs/marketing sites,
   which is where the "unique hits land in prose content" result comes from. The target
   profile includes apps whose text lives in components; that number could differ enough
   to change the §5.3 recommendation.
4. **Angular 17** in S1 — one matrix cell, lowest value. JIT mode avoids the AOT
   toolchain. Expect component-level only, like Vue — but expected is not measured.

Don't let the network spikes run in CI. They touch third-party sites.
