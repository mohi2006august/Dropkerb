# Design documents

The spikes in this repo exist to de-risk two documents:

- **`a11y-agent-prd.md`** — product requirements. Problem, users, goals and non-goals,
  the five-stage pipeline (crawl → detect → locate → fix → verify → PR), autonomy tiers
  A–D, success metrics, risks, phasing.
- **`a11y-agent-technical-design.md`** — architecture, algorithms, data model, privacy
  and evaluation methodology. §0.5 defines the five spikes S1–S5 that this repo runs.

**Drop both files in this directory.** They are the source of truth for everything in
`spikes/`, and the code comments reference them by section number (`TDD s5.1`, `PRD s5.1`
and so on) rather than restating their reasoning.

## Section numbers the code refers to

Written down here so a reader can follow a comment without opening the design doc.

| Reference | Subject |
|---|---|
| PRD §5.1 | Crawl — routes, states, auth; the product framing S5 tests |
| PRD §5.3 | Locate — the DOM→source strategies, in priority order |
| TDD §0.5 | The five spikes: S1 debug internals, S2 RSC, S3 cost, S4 literal text, S5 instrumentation |
| TDD §2.1 | State abstraction — AX tree, `shape()`, SimHash |
| TDD §2.2 | Template clustering — the main cost lever S3 measures |
| TDD §2.4 | Determinism: quiescence detection, animation freezing, clock pinning |
| TDD §3.9 | Environments we cannot audit — and must not silently pass |
| TDD §5.1 | Signal 1: framework dev instrumentation — **what S1 measures** |
| TDD §5.2 | Signal 2: CSS source maps for hashed class names |
| TDD §5.3 | Signal 3: anchor search, IDF-ranked — **what S4 measures** |
| TDD §5.4 | Signal 4: structural verification via tree edit distance |
| TDD §5.5 | Signal 5: differential probing — **part of what S2 measures** |
| TDD §5.7 | Instance collapse — why a signal must agree across every instance |
| TDD §5.8 | Where attribution gets hard: RSC, CMS/i18n, monorepos, minified prod |
| TDD §9.5 | Crawling ethics — robots.txt, rate limits, descriptive UA |
| TDD §10 | Cost model — the target S3 checks |

## What the spikes found

See [`../results/REPORT.md`](../results/REPORT.md), regenerated with `npm run report`.
Findings that contradict the design are recorded in each result's `designImpact` field —
that field is the deliverable, not the verdict.
