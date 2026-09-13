# Spike results: a11y-agent week-one de-risking

Generated 2026-09-13 12:54 UTC. Source: `results/*.json`, regenerate with `npm run report`.

These five experiments (TDD s0.5) gate the design. Three of them can change the phasing.

| Spike | Question | Verdict | Gates |
|---|---|---|---|
| **S1** | Do framework debug internals actually resolve? | **PASS** | Phase 3 (Locate) |
| **S2** | Can React Server Components be attributed at all? | **PASS** | Phase 3, v1 scope for App Router |
| **S3** | What does a run actually cost? | **PARTIAL** | the cost model in TDD s10 |
| **S4** | How much visible text is literal in the repo? | **PARTIAL** | anchor search (s5.3) as a fallback |
| **S5** | Can we instrument real sites at all? | **PASS** | Phase 1, and the product framing |

## S1 - Do framework debug internals actually resolve?

**Verdict: PASS** — 65 observations, run 2026-09-13 12:31 UTC on win32 x64, node v24.20.0.

### What we found

```
Dev builds: 6/6 cells attributed every node, each via whichever signal that version exposes.
  react-17/dev     100% via _debugSource (file:line) [react 17.0.2]
  react-18/dev     100% via _debugSource (file:line) [react 18.3.1]
  react-19/dev     100% via _debugStack+sourcemap (file:line) [react 19.2.0]
  vue-3/dev        100% via __vueParentComponent.type.__file (file) [vue 3.5.13]
  svelte-4/dev     100% via __svelte_meta.loc (file:line) [svelte 4.2.19; loc.line offset -1]
  svelte-5/dev     100% via __svelte_meta.loc (file:line) [svelte 5.19.0]
Production builds: 0/6 cells attributed - every debug field is stripped.
React 19 removes _debugSource from the fiber entirely. The field is absent, not null, so a resolver that reads it gets undefined and, without the startup self-test TDD s5.1 mentions, silently attributes nothing rather than failing loudly.
React 19 still carries the JSX call site in _debugStack, but as a bundle-relative Error stack. Recovering a source line means consuming the build source map, which moves React 19 from TDD s5.1 (read a field) to s5.2 (consume a map) and makes it depend on the build emitting usable maps.
Vue attributes to a FILE and carries no line at all (vue-3/dev). The design's "file:line at 0.95" does not hold for Vue; locating the element inside the file needs anchor search or structural verification as a second stage.
Svelte is the cleanest signal of the three - __svelte_meta sits on the element itself, no tree walk - but Svelte 4 reports loc.line 0-based while Svelte 5 reports it 1-based. A resolver written against one and shipped against the other lands every patch exactly one line off, which is the quietest possible way to be wrong.
No debug signal survives a production build in any framework tested.
Not measured: Angular 17, which the s0.5 matrix lists. Treat its row as unknown, not as working.
```

### What this changes in the design

- TDD s5.1 cannot be one resolver. It is per framework AND per major: read a field (React 17/18, Svelte), parse a stack through a source map (React 19), or accept file-only (Vue).
- The startup self-test is not optional. It is the only thing between a removed private API and silent non-attribution, and it must assert line numbers, not just presence, or the Svelte indexing change passes it.
- Build s5.2 (source-map indexing) before or alongside s5.1: React 19 already needs it, so it is not a fallback, it is a dependency.
- Vue needs the s5.3/s5.4 anchor-plus-structural stage to reach line granularity, so Vue support costs more than the "pluggable locator" framing suggests.
- Dev-server dependency is confirmed as a hard precondition for this entire signal class, which makes spike S2 (RSC) and the probing fallback in s5.5 more load-bearing, not less.

<details><summary>31 failing observation(s)</summary>

| Cell | Probe | Detail |
|---|---|---|
| react-17/dev | _debugStack+map@dev | 0/20 |
| react-17/prod | _debugSource@prod | 0/20 |
| react-17/prod | _debugStack+map@prod | 0/20 |
| react-17/prod | _debugOwner(name)@prod | 0/20 |
| react-17/prod | fields-present | no debug fields on the element |
| react-17/prod | best-signal@prod | no signal resolves this cell |
| react-18/dev | _debugStack+map@dev | 0/20 |
| react-18/prod | _debugSource@prod | 0/20 |
| react-18/prod | _debugStack+map@prod | 0/20 |
| react-18/prod | _debugOwner(name)@prod | 0/20 |
| react-18/prod | fields-present | no debug fields on the element |
| react-18/prod | best-signal@prod | no signal resolves this cell |
| react-19/dev | _debugSource@dev | 0/20 |
| react-19/prod | _debugSource@prod | 0/20 |
| react-19/prod | _debugStack+map@prod | 0/20 |
| react-19/prod | _debugOwner(name)@prod | 0/20 |
| react-19/prod | fields-present | no debug fields on the element |
| react-19/prod | best-signal@prod | no signal resolves this cell |
| vue-3/prod | __file(component)@prod | 0/20 - correct FILE; Vue carries no line |
| vue-3/prod | fields-present | no debug fields on the element |
| vue-3/prod | best-signal@prod | no signal resolves this cell |
| svelte-4/dev | __svelte_meta.loc@dev | 0/20 - systematic line offset -1 |
| svelte-4/prod | __svelte_meta.loc@prod | 0/20 |
| svelte-4/prod | __svelte_meta(file)@prod | 0/20 |
| svelte-4/prod | fields-present | no debug fields on the element |
| svelte-4/prod | best-signal@prod | no signal resolves this cell |
| svelte-5/prod | __svelte_meta.loc@prod | 0/20 |
| svelte-5/prod | __svelte_meta(file)@prod | 0/20 |
| svelte-5/prod | fields-present | no debug fields on the element |
| svelte-5/prod | best-signal@prod | no signal resolves this cell |
| angular-17/dev | unmeasured | not built - Angular needs its own compiler toolchain; ng.getComponent is expected to be component-level like Vue, but expected is not measur |

</details>

## S2 - Can React Server Components be attributed at all?

**Verdict: PASS** — 12 observations, run 2026-09-13 12:32 UTC on win32 x64, node v24.20.0.

### What we found

```
Server components: attributable via (c) CSS module class, (d) differential probing through.
(a) client residue on server nodes: no
(b) server component identity in the flight payload: no
(c) CSS module class names decode to file + local name: WORKS
(d) differential probing through the server build: WORKS

The client component in the same tree is the control. Where it attributes and the server components do not, the gap is RSC-specific rather than a defect in the resolver.
```

### What this changes in the design

- Probing (TDD s5.5) works through the App Router dev build, so it carries RSC attribution. That confirms the hard dev-server requirement for App Router projects: it belongs on the README, not in a footnote.
- Next's dev CSS Module format encodes file and local class name directly, so s5.2 needs no source map in dev - but production uses a bare hash and does, so the map index is still required.
- The flight payload carries module references only for client components, which must be hydrated. Server components are already HTML by the time they arrive, so there is nothing to reference - this is structural, not a Next.js version detail.
- Either way, s5.1 is unavailable for server-rendered markup and must not be listed as the primary path for App Router.

<details><summary>4 failing observation(s)</summary>

| Cell | Probe | Detail |
|---|---|---|
| server-components | client-residue | 13/13 have a React fiber, 0/13 carry source info - fiber present, fields: _debugOwner:set _debugInfo:set _debugHookTypes:null |
| client-components | client-residue | 5/5 have a React fiber, 0/5 carry source info - fiber present, fields: _debugOwner:set _debugInfo:null _debugHookTypes:null |
| flight-payload | server-component-identity | no server source named; payload mentions 9 paths (components/layout-router.js, components/render-from-template-context.js, app/Client.jsx, a |
| css-modules | css-source-map | 0/1 stylesheets advertise a source map |

</details>

## S3 - What does a run actually cost?

**Verdict: PARTIAL** — 17 observations, run 2026-09-13 12:51 UTC on win32 x64, node v24.20.0.

### What we found

```
ESTIMATED RUN: no count_tokens credentials, so token and dollar figures below are derived from measured bytes at a fixed chars-per-token ratio. Byte, page and template counts ARE measured. Set ANTHROPIC_API_KEY and re-run to replace the estimates.

Sampled 24 pages across 3 sites. Rate card 2026-06-24 (claude-api skill rate card).

Per page (ESTIMATED):
  full AX tree              40841 tokens avg, 99003 at p95
  violations-with-context   2579 tokens avg  -> 6% the size
  cacheable system prefix   188 tokens

Templates (share of pages that are structurally distinct, so need judging):
  Jaccard 0.8   11/24 distinct   46% of pages
  Jaccard 0.9   20/24 distinct   83% of pages
  Jaccard 0.95   23/24 distinct   96% of pages

Cost of one 500-page site on Opus 5 (ESTIMATED):
  naive: full tree, every page         $102.57
  minimal payload, every page          $6.92
  + template clustering (417 pages)  $5.77
  + prompt caching                     $5.42
  same, on Haiku 4.5                    $1.08

Threshold used: a run is affordable if it lands under $5 for a 500-page site. Not asserted - figures are estimates.
```

### What this changes in the design

- Tokens were estimated, not measured, so the dollar figures are indicative only. The RATIOS below do not depend on the tokenizer - they are measured from payload bytes and page counts - so the structural conclusions hold either way.
- Sending violations-with-context instead of the full accessibility tree removes 94% of the per-page payload. TDD s10 must cost a run against the minimal payload, and the Judge prompt has to be built outward from each violation rather than handed the tree - that is a structural requirement on s5, not a tuning knob.
- Caveat on that figure: the minimal payload is violations plus context, so it scales with violation count, and this sample averaged only 2.8 violations per page. On a page with dozens of violations the saving shrinks toward zero. The per-page cost to plan against is the p95 (99003 tokens full tree), not the mean of a clean sample.
- The clustering saving is highly sensitive to the similarity threshold: 46% of pages are distinct at Jaccard 0.8 but 96% at 0.95 - a 50% swing from a parameter chosen by hand. That sensitivity IS the finding: TDD s10 cannot quote a clustering saving until the similarity metric is validated against pages known to share a template. Quoting the favourable end of this curve would be picking a number, not measuring one.
- Clustering removed less than half the pages (83% distinct). The cost model cannot lean on it as the primary saving, and per-page cost stays the number that matters.
- Prompt caching the 188-token prefix saves almost nothing (6%) because the prefix is tiny next to the per-page payload. The design should not count on caching as a cost lever at this prompt shape.
- Model choice is a 5x lever: the same run is $5.42 on Opus 5 against $1.08 on Haiku 4.5. Since the Judge's task is bounded and rule-driven, a cheaper model per violation with escalation for ambiguous cases is worth measuring before the cost model fixes on one tier.

<details><summary>3 failing observation(s)</summary>

| Cell | Probe | Detail |
|---|---|---|
| www.w3.org (public-sector) | clustering@0.9 | 8 templates across 8 pages - 100% of pages need judging |
| www.w3.org (public-sector) | clustering@0.95 | 8 templates across 8 pages - 100% of pages need judging |
| svelte.dev (docs-spa) | clustering@0.95 | 8 templates across 8 pages - 100% of pages need judging |

</details>

## S4 - How much visible text is literal in the repo?

**Verdict: PARTIAL** — 24 observations, run 2026-09-13 11:28 UTC on win32 x64, node v24.20.0.

### What we found

```
932 visible strings from 8/8 pages across 7 repos.

Present in source:   96%  (92% literal, 5% only after normalising typography)
Locates a file:      31%  (exactly one occurrence)
Ambiguous:           65%  (found, but in more than one place)
Absent:              4%

By length:  >= 25 chars 77% unique (n=232), < 25 chars 16% unique (n=700)
Unique hits land in: markup 75, prose content 177, i18n/data catalogue 38
Site chrome (nav/header/footer): 9% unique of 354

Best page: react/docs at 46% unique. Worst: tailwind/docs at 8%.

Threshold used: anchor search is usable as a fallback if it locates >= 50% of the strings it is handed. Measured 31%.
```

### What this changes in the design

- The text is usually present (96%) but usually not unique, so s5.3 returns candidate sets, not locations. The design must treat anchor search as a *ranking* input alongside another signal, not as a locator on its own.
- String length decides the outcome: 77% unique at >= 25 chars versus 16% below it. s5.3 should require a minimum anchor length and fall through rather than return a low-confidence match for short labels - which is exactly the button and link text most accessibility findings attach to.
- Unique hits land in prose content (177) more often than in markup (75). For docs-style sites the located file is a markdown document, not the component that renders it, so "fix the source" means editing content, not code - a product distinction s5.3 should surface rather than hide.
- Site chrome behaves differently from body content (9% unique across 354 chrome strings). Since nav and footer are where a large share of real accessibility findings sit, this subset - not the page average - is the number that matters for the fallback.

<details><summary>8 failing observation(s)</summary>

| Cell | Probe | Detail |
|---|---|---|
| eslint/homepage | unique-anchor | 40% occur exactly once, so they locate a file; 60% of strings >= 25 chars do - unique hits land in markup 6, content 6, catalogue 29 |
| vue/docs | unique-anchor | 38% occur exactly once, so they locate a file; 97% of strings >= 25 chars do - unique hits land in markup 7, content 39, catalogue 0 |
| react/docs | unique-anchor | 46% occur exactly once, so they locate a file; 91% of strings >= 25 chars do - unique hits land in markup 1, content 54, catalogue 0 |
| svelte/docs | unique-anchor | 9% occur exactly once, so they locate a file; 70% of strings >= 25 chars do - unique hits land in markup 2, content 9, catalogue 0 |
| tailwind/homepage | unique-anchor | 37% occur exactly once, so they locate a file; 89% of strings >= 25 chars do - unique hits land in markup 44, content 0, catalogue 0 |
| tailwind/docs | unique-anchor | 8% occur exactly once, so they locate a file; 20% of strings >= 25 chars do - unique hits land in markup 9, content 0, catalogue 0 |
| nodejs/content | unique-anchor | 35% occur exactly once, so they locate a file; 79% of strings >= 25 chars do - unique hits land in markup 0, content 30, catalogue 9 |
| govuk/docs | unique-anchor | 38% occur exactly once, so they locate a file; 70% of strings >= 25 chars do - unique hits land in markup 6, content 39, catalogue 0 |

</details>

## S5 - Can we instrument real sites at all?

**Verdict: PASS** — 120 observations, run 2026-09-13 10:03 UTC on win32 x64, node v24.20.0.

### What we found

```
Sample: 15 of 15 listed sites measured.
Navigated 100% of 15 sites.
CDP-level evaluate succeeded on 100%; DOM script-tag injection succeeded on 73%.
4 of 15 sites ship a CSP that restricts inline script.
Full axe-core inject-and-run: 100%. CDP AX tree available on 100%.
Bot challenge encountered on 0% of sites.

CDP injection bypasses page CSP where DOM injection is blocked, which is the result the design was counting on: strict CSP is not a blocker, provided we always inject via CDP and never via addScriptTag.
```

### What this changes in the design

- No design change. Remote auditing stays a supported path; keep all injection on the CDP path and treat addScriptTag as unusable.

<details><summary>4 failing observation(s)</summary>

| Cell | Probe | Detail |
|---|---|---|
| developer.mozilla.org (docs) | dom-script-tag | blocked: page.addScriptTag: Executing inline script violates the following Content Security Policy directive 'script-src-elem 'report-sample |
| github.com (strict-csp-saas) | dom-script-tag | blocked: page.addScriptTag: Executing inline script violates the following Content Security Policy directive 'script-src github.githubassets |
| stripe.com (strict-csp-saas) | dom-script-tag | blocked: page.addScriptTag: Executing inline script violates the following Content Security Policy directive 'script-src https://b.stripecdn |
| www.gov.uk (public-sector) | dom-script-tag | blocked: page.addScriptTag: Executing inline script violates the following Content Security Policy directive 'script-src 'self' www.google-a |

</details>

## Status

Run: 5/5. All five complete.
