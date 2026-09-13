/**
 * S4 - How much visible text is literal in the repo? (TDD s0.5)
 *
 * Anchor search (TDD s5.3) is the fallback for every case where debug internals fail:
 * production builds, Vue (which S1 showed has no line number at all), and server
 * components. It works by taking the text of the offending node and finding it in the
 * source. That only works if the text is *there*, and if it is there *once*.
 *
 * So the measurement is deliberately two-tiered:
 *   - found      : the string exists in the source at all
 *   - unique     : it exists exactly once, which is what makes it a location
 * A string found in forty files has been found and has located nothing, so a spike that
 * only reported "found" would overstate the fallback the design leans on.
 *
 * Method: shallow-clone repos that publicly build a live site, render a page from that
 * site, take its visible strings, and look for each one in the checkout.
 *
 * Known confound, recorded rather than hidden: the live site is built from whatever
 * commit CI last deployed, which is not necessarily the HEAD we cloned. Text that
 * changed in between reads as absent. The cloned SHA is in the results so a re-run can
 * be compared, and the effect is one-directional - it can only understate the rate.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Recorder, RAW_DIR } from '../shared/results.ts';
import { openSession } from '../shared/browser.ts';
import { checkRobots } from '../s5-instrumentation/robots.ts';
import { ensureClone, gitVersion, loadCorpus, type CorpusEntry } from './clone.ts';
import { buildIndex, locate, normalizeText, classifyPath } from './search.ts';
import { visibleStrings, sample, type VisibleString } from './extract.ts';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 a11y-agent-spike/0.1 (+accessibility audit research; one request per host)';
const NAV_TIMEOUT = 45_000;
const PER_PAGE_DELAY_MS = 3_000;
/** Long enough to be a real anchor candidate; see the length buckets in the report. */
const LONG_STRING = 25;

const args = process.argv.slice(2);
const only = flagValue('--only');
const forceClone = args.includes('--force-clone');
const maxStrings = Number(flagValue('--max-strings') ?? 120);

const { entries } = loadCorpus();
const selected = only ? entries.filter((e) => e.id === only) : entries;

const rec = new Recorder(
  's4',
  'How much visible text is literal in the repo?',
  'For a page rendered from a known repo, what share of its visible strings appear literally in the source, and what share appear exactly once so that they identify a location?',
);

interface StringResult {
  site: string;
  page: string;
  text: string;
  tag: string;
  chrome: boolean;
  tier: 'literal' | 'normalized' | 'absent';
  occurrences: number;
  capped: boolean;
  paths: string[];
  where: string | null;
}

const allResults: StringResult[] = [];
const pageSummaries: Array<{ cell: string; n: number; found: number; unique: number }> = [];
let pagesPlanned = 0;
let pagesMeasured = 0;

const git = gitVersion();
if (!git) {
  // No git means no corpus, which means no measurement. This is an unmeasured spike,
  // not a failed one - reporting "fail" here would read as "the text is not in repos".
  rec.observe({ cell: 'environment', probe: 'git-available', ok: false, detail: 'git not found on PATH' });
  rec.finish(
    'skipped',
    'NOT MEASURED: git is not installed, so the corpus could not be cloned.\nInstall git and re-run: npm run setup:s4 && npm run spike:s4',
    'No design impact either way. Until this runs, treat anchor search (TDD s5.3) as an unverified fallback, not a working one.',
  );
  process.exit(0);
}
rec.observe({ cell: 'environment', probe: 'git-available', ok: true, detail: git });

const session = await openSession();
try {
  for (const entry of selected) {
    pagesPlanned += entry.pages.length;
    let index;
    try {
      const clone = await ensureClone(entry, {
        force: forceClone,
        onProgress: (m) => console.log(`  ... ${m}`),
      });
      index = buildIndex(clone.dir);
      rec.observe({
        cell: entry.id,
        probe: 'corpus',
        ok: index.fileCount > 0,
        detail:
          `${clone.sha} - ${index.fileCount} text files, ${mb(index.bytes)} MB indexed ` +
          `of ${mb(clone.bytes)} MB checkout${index.truncated ? ' (TRUNCATED at cap)' : ''}` +
          `${index.skippedMinified ? `, ${index.skippedMinified} minified skipped` : ''}`,
        metrics: { files: index.fileCount, indexedMb: mb(index.bytes), checkoutMb: mb(clone.bytes) },
      });
      if (index.truncated) {
        // A truncated index silently shrinks the haystack and every "absent" after it
        // is unsafe, so say so rather than folding it into the rate.
        rec.observe({
          cell: entry.id,
          probe: 'corpus-complete',
          ok: false,
          detail: 'index hit the byte cap; absent-rates for this repo are upper bounds',
        });
      }
    } catch (e) {
      rec.observe({ cell: entry.id, probe: 'corpus', ok: false, detail: (e as Error).message.slice(0, 200) });
      continue;
    }

    for (const page of entry.pages) {
      const cell = `${entry.id}/${page.kind}`;
      const robots = await checkRobots(page.url, UA);
      if (!robots.allowed) {
        rec.observe({
          cell,
          probe: robots.transient ? 'unreachable' : 'robots',
          ok: false,
          detail: `skipped: ${robots.reason}`,
        });
        continue;
      }

      let strings: VisibleString[];
      try {
        const response = await session.page.goto(page.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        const status = response?.status() ?? 0;
        if (status === 0 || status >= 400) {
          rec.observe({ cell, probe: 'navigate', ok: false, detail: `HTTP ${status} - page not measured`, metrics: { status } });
          continue;
        }
        await session.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        strings = sample(await visibleStrings(session.page), maxStrings);
      } catch (e) {
        rec.observe({ cell, probe: 'navigate', ok: false, detail: (e as Error).message.split('\n')[0].slice(0, 160) });
        continue;
      }

      if (strings.length === 0) {
        rec.observe({ cell, probe: 'extract', ok: false, detail: 'no visible strings extracted' });
        continue;
      }

      const pageResults: StringResult[] = [];
      for (const s of strings) {
        let tier: StringResult['tier'] = 'absent';
        let hit = locate(index.raw, s.text);
        if (hit.count > 0) {
          tier = 'literal';
        } else {
          hit = locate(index.norm, normalizeText(s.text));
          if (hit.count > 0) tier = 'normalized';
        }
        pageResults.push({
          site: entry.id,
          page: page.kind,
          text: s.text.slice(0, 200),
          tag: s.tag,
          chrome: s.chrome,
          tier,
          occurrences: hit.count,
          capped: hit.capped,
          paths: hit.paths.slice(0, 3),
          where: hit.paths.length > 0 ? classifyPath(hit.paths[0]) : null,
        });
      }

      // Is this page actually built from this repo? Several projects publish a site
      // whose content is pulled from elsewhere at build time - eslint.org renders the
      // docs from the eslint/eslint repo, so its own checkout contains none of that
      // text. Averaging such a page in would report "the text is not in the repo" as a
      // finding about anchor search when it is really a finding about the corpus.
      //
      // Distinctive long strings are the test: a repo that genuinely stores its text
      // somewhere unusual (an i18n catalogue) still contains them, while a repo that
      // does not build the page contains almost none.
      const longOnPage = pageResults.filter((r) => r.text.length >= LONG_STRING);
      const longFound = longOnPage.filter((r) => r.tier !== 'absent').length;
      const coverage = longOnPage.length > 0 ? longFound / longOnPage.length : 1;
      if (longOnPage.length >= 10 && coverage < 0.2) {
        rec.observe({
          cell,
          probe: 'corpus-covers-page',
          ok: false,
          detail:
            `only ${pct(longFound, longOnPage.length)} of long strings appear anywhere in the checkout - ` +
            `this page is not built from this repo. Excluded from the rates rather than counted as absent text.`,
          metrics: { longCoverage: coverage, longN: longOnPage.length },
        });
        continue;
      }

      pagesMeasured++;
      allResults.push(...pageResults);

      const n = pageResults.length;
      const literal = pageResults.filter((r) => r.tier === 'literal').length;
      const normalized = pageResults.filter((r) => r.tier === 'normalized').length;
      const found = literal + normalized;
      const unique = pageResults.filter((r) => r.occurrences === 1).length;
      const longN = longOnPage.length;
      const longUnique = longOnPage.filter((r) => r.occurrences === 1).length;
      const whereCount: Record<string, number> = { markup: 0, content: 0, catalogue: 0, other: 0 };
      for (const r of pageResults) {
        if (r.occurrences === 1 && r.where) whereCount[r.where]++;
      }
      pageSummaries.push({ cell, n, found, unique });

      rec.observe({
        cell,
        probe: 'text-in-source',
        ok: found / n >= 0.5,
        detail: `${pct(found, n)} of ${n} visible strings appear in the source (${literal} literal, ${normalized} only after normalising typography)`,
        metrics: { n, literal, normalized, foundRate: found / n },
      });
      rec.observe({
        cell,
        probe: 'unique-anchor',
        ok: unique / n >= 0.5,
        detail:
          `${pct(unique, n)} occur exactly once, so they locate a file` +
          `${longN ? `; ${pct(longUnique, longN)} of strings >= ${LONG_STRING} chars do` : ''}` +
          ` - unique hits land in markup ${whereCount.markup}, content ${whereCount.content}, catalogue ${whereCount.catalogue}`,
        metrics: {
          unique,
          uniqueRate: unique / n,
          longUniqueRate: longN ? longUnique / longN : 0,
          inMarkup: whereCount.markup,
          inCatalogue: whereCount.catalogue,
        },
      });

      await new Promise((r) => setTimeout(r, PER_PAGE_DELAY_MS));
    }
  }
} finally {
  await session.close();
}

writeFileSync(join(RAW_DIR, 's4-strings.json'), JSON.stringify(allResults, null, 2));
reportVerdict();

function reportVerdict(): void {
  const n = allResults.length;
  if (n === 0 || pagesMeasured === 0) {
    rec.finish(
      'skipped',
      `NOT MEASURED: ${pagesMeasured}/${pagesPlanned} pages produced strings. Nothing was compared against a repo.`,
      'Anchor search (TDD s5.3) remains unverified. It must not be counted as a working fallback in the phasing.',
    );
    return;
  }

  const literal = allResults.filter((r) => r.tier === 'literal').length;
  const normalized = allResults.filter((r) => r.tier === 'normalized').length;
  const found = literal + normalized;
  const unique = allResults.filter((r) => r.occurrences === 1).length;
  const ambiguous = allResults.filter((r) => r.occurrences > 1).length;

  const longs = allResults.filter((r) => r.text.length >= LONG_STRING);
  const longUnique = longs.filter((r) => r.occurrences === 1).length;
  const shorts = allResults.filter((r) => r.text.length < LONG_STRING);
  const shortUnique = shorts.filter((r) => r.occurrences === 1).length;

  const uniqueHits = allResults.filter((r) => r.occurrences === 1);
  const inCatalogue = uniqueHits.filter((r) => r.where === 'catalogue').length;
  const inContent = uniqueHits.filter((r) => r.where === 'content').length;
  const inMarkup = uniqueHits.filter((r) => r.where === 'markup').length;

  const chrome = allResults.filter((r) => r.chrome);
  const chromeUnique = chrome.filter((r) => r.occurrences === 1).length;

  const uniqueRate = unique / n;
  const foundRate = found / n;

  // Thresholds are stated, not hidden: a fallback that locates fewer than half the
  // nodes it is handed cannot carry the cases s5.1 cannot reach.
  const verdict = uniqueRate >= 0.5 ? 'pass' : foundRate >= 0.5 ? 'partial' : 'fail';

  const worst = [...pageSummaries].sort((a, b) => a.unique / a.n - b.unique / b.n)[0];
  const best = [...pageSummaries].sort((a, b) => b.unique / b.n - a.unique / a.n)[0];

  rec.finish(
    verdict,
    [
      `${n} visible strings from ${pagesMeasured}/${pagesPlanned} pages across ${new Set(allResults.map((r) => r.site)).size} repos.`,
      '',
      `Present in source:   ${pct(found, n)}  (${pct(literal, n)} literal, ${pct(normalized, n)} only after normalising typography)`,
      `Locates a file:      ${pct(unique, n)}  (exactly one occurrence)`,
      `Ambiguous:           ${pct(ambiguous, n)}  (found, but in more than one place)`,
      `Absent:              ${pct(n - found, n)}`,
      '',
      `By length:  >= ${LONG_STRING} chars ${pct(longUnique, longs.length)} unique (n=${longs.length}), < ${LONG_STRING} chars ${pct(shortUnique, shorts.length)} unique (n=${shorts.length})`,
      `Unique hits land in: markup ${inMarkup}, prose content ${inContent}, i18n/data catalogue ${inCatalogue}`,
      `Site chrome (nav/header/footer): ${pct(chromeUnique, chrome.length)} unique of ${chrome.length}`,
      '',
      `Best page: ${best.cell} at ${pct(best.unique, best.n)} unique. Worst: ${worst.cell} at ${pct(worst.unique, worst.n)}.`,
      '',
      `Threshold used: anchor search is usable as a fallback if it locates >= 50% of the strings it is handed. Measured ${pct(unique, n)}.`,
    ].join('\n'),
    designImpact({ uniqueRate, foundRate, normalized, n, longs: longs.length, longUnique, shorts: shorts.length, shortUnique, inCatalogue, inContent, inMarkup, chrome: chrome.length, chromeUnique }),
  );
}

function designImpact(m: {
  uniqueRate: number; foundRate: number; normalized: number; n: number;
  longs: number; longUnique: number; shorts: number; shortUnique: number;
  inCatalogue: number; inContent: number; inMarkup: number;
  chrome: number; chromeUnique: number;
}): string {
  const out: string[] = [];

  out.push(
    m.uniqueRate >= 0.5
      ? `Anchor search locates ${pct(m.uniqueRate * m.n, m.n)} of visible strings, so TDD s5.3 can carry the cases s5.1 cannot reach - production builds, Vue (no line number, per S1) and server components (per S2).`
      : m.foundRate >= 0.5
        ? `The text is usually present (${pct(m.foundRate * m.n, m.n)}) but usually not unique, so s5.3 returns candidate sets, not locations. The design must treat anchor search as a *ranking* input alongside another signal, not as a locator on its own.`
        : `Anchor search fails on its own terms: only ${pct(m.foundRate * m.n, m.n)} of visible text is in the repo at all. TDD s5.3 cannot be the fallback for s5.1, and the phasing needs a different answer for production builds.`,
  );

  const longRate = m.longs ? m.longUnique / m.longs : 0;
  const shortRate = m.shorts ? m.shortUnique / m.shorts : 0;
  if (m.longs && m.shorts && longRate - shortRate > 0.15) {
    out.push(
      `String length decides the outcome: ${pct(m.longUnique, m.longs)} unique at >= ${LONG_STRING} chars versus ${pct(m.shortUnique, m.shorts)} below it. s5.3 should require a minimum anchor length and fall through rather than return a low-confidence match for short labels - which is exactly the button and link text most accessibility findings attach to.`,
    );
  }

  if (m.inCatalogue > 0 && m.inCatalogue >= m.inMarkup) {
    out.push(
      `${m.inCatalogue} of the unique hits land in an i18n or data catalogue rather than markup, against ${m.inMarkup} in markup. Finding the string in a locale file proves the text exists but not where it is rendered, so s5.3 needs a second hop from catalogue key to usage site. The design does not currently describe that hop.`,
    );
  } else if (m.inContent > m.inMarkup) {
    out.push(
      `Unique hits land in prose content (${m.inContent}) more often than in markup (${m.inMarkup}). For docs-style sites the located file is a markdown document, not the component that renders it, so "fix the source" means editing content, not code - a product distinction s5.3 should surface rather than hide.`,
    );
  }

  if (m.normalized / m.n > 0.05) {
    out.push(
      `${pct(m.normalized, m.n)} of strings match only after normalising typography (smart quotes, dashes, entities, whitespace). That is not free: s5.3 must normalise both sides or it will silently lose that share.`,
    );
  }

  if (m.chrome > 0) {
    out.push(
      `Site chrome behaves differently from body content (${pct(m.chromeUnique, m.chrome)} unique across ${m.chrome} chrome strings). Since nav and footer are where a large share of real accessibility findings sit, this subset - not the page average - is the number that matters for the fallback.`,
    );
  }

  return out.join('\n');
}

function pct(part: number, whole: number): string {
  if (!whole) return 'n/a';
  return `${Math.round((part / whole) * 100)}%`;
}

function mb(bytes: number): number {
  return Math.round((bytes / 1_000_000) * 10) / 10;
}

function flagValue(flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? null : null;
}
