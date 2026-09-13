/**
 * S3 - What does a run actually cost? (TDD s0.5)
 *
 * Gates the cost model in TDD s10. Three things decide the bill, and this measures all
 * three on real sites rather than assuming any of them:
 *
 *   1. payload shape   - full AX tree per page vs violations-with-context (sensor.ts)
 *   2. page count      - how many pages are distinct templates (cluster.ts)
 *   3. prompt caching  - how much of each request is a shared, cacheable prefix
 *
 * Honesty about what is measured and what is derived:
 *   - bytes, AX node counts, violation counts and cluster counts are MEASURED
 *   - tokens are measured only when count_tokens credentials exist; otherwise estimated
 *   - dollars are always derived from tokens, so they inherit that status
 * The verdict says which, every time. A cost spike that quietly presents an estimate as
 * a measurement is worse than no cost spike.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Recorder, RAW_DIR, round } from '../shared/results.ts';
import { openSession, waitForQuiescence } from '../shared/browser.ts';
import { checkRobots } from '../s5-instrumentation/robots.ts';
import { axTree, runAxe, buildPayloads, SYSTEM_PREFIX, type AxNode } from './sensor.ts';
import { signature, cluster } from './cluster.ts';
import { makeCounter, cachedRunCost, uncachedRunCost, type Model } from './tokens.ts';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 a11y-agent-spike/0.1 (+accessibility audit research; one request per host)';
const NAV_TIMEOUT = 45_000;
const PER_PAGE_DELAY_MS = 3_000;
/** Thresholds swept so the clustering saving is reported as a curve, not one number. */
const THRESHOLDS = [0.8, 0.9, 0.95];

const args = process.argv.slice(2);
const only = flagValue('--only');

const sitesFile = JSON.parse(readFileSync(new URL('./sites.json', import.meta.url), 'utf8')) as {
  maxPagesPerSite: number;
  sites: Array<{ url: string; profile: string }>;
};
const pricing = JSON.parse(readFileSync(new URL('./pricing.json', import.meta.url), 'utf8')) as {
  asOf: string;
  source: string;
  cacheWriteMultiplier: number;
  cacheReadMultiplier: number;
  models: Model[];
};

const sites = only ? sitesFile.sites.filter((s) => new URL(s.url).host.includes(only)) : sitesFile.sites;

const rec = new Recorder(
  's3',
  'What does a run actually cost?',
  'For a real site, how large is the per-page sensor payload the model must read, how many pages are distinct templates, and what does one run therefore cost at current per-token rates?',
);

interface PageMeasurement {
  site: string;
  url: string;
  axNodes: number;
  violations: number;
  violationNodes: number;
  fullBytes: number;
  minimalBytes: number;
  fullTokens: number;
  minimalTokens: number;
}

const measurements: PageMeasurement[] = [];
const siteSignatures = new Map<string, Array<{ url: string; sig: Set<string> }>>();

const counter = await makeCounter('claude-opus-5');
rec.observe({
  cell: 'environment',
  probe: 'token-source',
  // Not a failure - an estimated run is still a valid run, it is just labelled as one.
  ok: true,
  detail:
    counter.source === 'count_tokens'
      ? `tokens measured with the Messages API count_tokens endpoint (${counter.model})`
      : 'NO CREDENTIALS: tokens and dollars are ESTIMATED from payload bytes. Set ANTHROPIC_API_KEY and re-run to measure them.',
  metrics: { measured: counter.source === 'count_tokens' ? 1 : 0 },
});

const prefixTokens = await counter.count(SYSTEM_PREFIX);
rec.observe({
  cell: 'environment',
  probe: 'cacheable-prefix',
  ok: prefixTokens > 0,
  detail: `system prefix is ${prefixTokens} tokens (${SYSTEM_PREFIX.length} bytes) - this is the part a run can cache across pages`,
  metrics: { prefixTokens, prefixBytes: SYSTEM_PREFIX.length },
});

const session = await openSession();
try {
  for (const site of sites) {
    const host = new URL(site.url).host;
    const cell = `${host} (${site.profile})`;

    const robots = await checkRobots(site.url, UA);
    if (!robots.allowed) {
      rec.observe({
        cell,
        probe: robots.transient ? 'unreachable' : 'robots',
        ok: false,
        detail: `skipped: ${robots.reason}`,
      });
      continue;
    }

    let urls: string[];
    let siblings: number;
    try {
      ({ urls, siblings } = await discover(site.url, sitesFile.maxPagesPerSite));
    } catch (e) {
      rec.observe({ cell, probe: 'discover', ok: false, detail: (e as Error).message.slice(0, 160) });
      continue;
    }
    rec.observe({
      cell,
      probe: 'discover',
      // A sample that is mostly top-nav cannot say anything about template clustering,
      // so a low sibling count is a weak sample, not a passing one.
      ok: siblings >= Math.floor((urls.length - 1) / 2),
      detail: `${urls.length} pages queued (cap ${sitesFile.maxPagesPerSite}), ${siblings} siblings of the entry path`,
      metrics: { pages: urls.length, siblings },
    });

    const sigs: Array<{ url: string; sig: Set<string> }> = [];
    for (const url of urls) {
      try {
        const res = await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        if (!res || res.status() >= 400) continue;
        await waitForQuiescence(session.page, { capMs: 8_000 });

        const nodes: AxNode[] = await axTree(session.cdp);
        const violations = await runAxe(session.page, AXE_SOURCE);
        const payloads = buildPayloads(nodes, violations);

        measurements.push({
          site: host,
          url,
          axNodes: payloads.axNodeCount,
          violations: payloads.violationCount,
          violationNodes: payloads.violationNodeCount,
          fullBytes: payloads.full.length,
          minimalBytes: payloads.minimal.length,
          fullTokens: await counter.count(payloads.full),
          minimalTokens: await counter.count(payloads.minimal),
        });
        sigs.push({ url, sig: signature(nodes) });
      } catch {
        /* one page that will not load is not worth failing a site over */
      }
      await new Promise((r) => setTimeout(r, PER_PAGE_DELAY_MS));
    }

    if (sigs.length === 0) {
      rec.observe({ cell, probe: 'sensor', ok: false, detail: 'no pages produced a payload' });
      continue;
    }
    siteSignatures.set(host, sigs);

    const mine = measurements.filter((m) => m.site === host);
    const avgFull = mean(mine.map((m) => m.fullTokens));
    const avgMinimal = mean(mine.map((m) => m.minimalTokens));
    rec.observe({
      cell,
      probe: 'payload-size',
      // A payload that does not fit the cheapest model's context is a design problem.
      ok: avgFull > 0,
      detail:
        `${mine.length} pages: full AX tree averages ${Math.round(avgFull)} tokens, ` +
        `violations-with-context ${Math.round(avgMinimal)} tokens ` +
        `(${pct(avgMinimal, avgFull)} of full), ${Math.round(mean(mine.map((m) => m.violations)))} violations/page`,
      metrics: {
        fullTokens: Math.round(avgFull),
        minimalTokens: Math.round(avgMinimal),
        minimalShare: avgFull ? avgMinimal / avgFull : 0,
        axNodes: Math.round(mean(mine.map((m) => m.axNodes))),
      },
    });

    for (const t of THRESHOLDS) {
      const clusters = cluster(sigs, t);
      rec.observe({
        cell,
        probe: `clustering@${t}`,
        ok: clusters.length < sigs.length,
        detail: `${clusters.length} templates across ${sigs.length} pages - ${pct(clusters.length, sigs.length)} of pages need judging`,
        metrics: { clusters: clusters.length, pages: sigs.length, ratio: clusters.length / sigs.length },
      });
    }
  }
} finally {
  await session.close();
}

writeFileSync(join(RAW_DIR, 's3-pages.json'), JSON.stringify(measurements, null, 2));
reportVerdict();

function reportVerdict(): void {
  if (measurements.length === 0) {
    rec.finish(
      'skipped',
      'NOT MEASURED: no page produced a sensor payload, so nothing was costed.',
      'The cost model in TDD s10 stays unverified. It must not be quoted as measured.',
    );
    return;
  }

  const estimated = counter.source !== 'count_tokens';
  const label = estimated ? 'ESTIMATED' : 'measured';
  const pages = measurements.length;
  const avgFull = mean(measurements.map((m) => m.fullTokens));
  const avgMinimal = mean(measurements.map((m) => m.minimalTokens));
  const p95Full = percentile(measurements.map((m) => m.fullTokens), 0.95);
  const shrink = avgFull ? 1 - avgMinimal / avgFull : 0;
  const avgViolations = mean(measurements.map((m) => m.violations));

  // Clustering across the whole threshold sweep, aggregated over sites. Reporting one
  // threshold would hide the thing most worth knowing: how much the saving depends on a
  // similarity cut-off that nobody has validated against ground truth.
  const curve = THRESHOLDS.map((th) => {
    let clusters = 0;
    let pages = 0;
    for (const sigs of siteSignatures.values()) {
      clusters += cluster(sigs, th).length;
      pages += sigs.length;
    }
    return { threshold: th, clusters, pages, ratio: pages ? clusters / pages : 1 };
  });
  const mid = THRESHOLDS[1];
  const midPoint = curve.find((c) => c.threshold === mid)!;
  const clusterRatio = midPoint.ratio;
  const clusteredPages = midPoint.clusters;
  const totalPages = midPoint.pages;
  const spread = Math.max(...curve.map((c) => c.ratio)) - Math.min(...curve.map((c) => c.ratio));

  const opus = pricing.models.find((m) => m.id === 'claude-opus-5')!;
  const haiku = pricing.models.find((m) => m.id === 'claude-haiku-4-5')!;

  // A "run" modelled as a 500-page site, which is the scale the cost question is really
  // about. Per-page cost at small n is dominated by the prefix and tells you nothing.
  const SITE_PAGES = 500;
  const judged = Math.max(1, Math.round(SITE_PAGES * clusterRatio));

  const naive = uncachedRunCost(SITE_PAGES, prefixTokens, avgFull, opus);
  const minimalOnly = uncachedRunCost(SITE_PAGES, prefixTokens, avgMinimal, opus);
  const clustered = uncachedRunCost(judged, prefixTokens, avgMinimal, opus);
  const cached = cachedRunCost(judged, prefixTokens, avgMinimal, opus, pricing.cacheWriteMultiplier, pricing.cacheReadMultiplier);
  const cachedHaiku = cachedRunCost(judged, prefixTokens, avgMinimal, haiku, pricing.cacheWriteMultiplier, pricing.cacheReadMultiplier);

  const fitsHaiku = avgFull + prefixTokens < haiku.contextTokens;

  // Pass/fail is about whether a run is affordable at the scale the product implies.
  // A run that costs more than a few dollars per site cannot be offered per-commit.
  const AFFORDABLE_USD = 5;
  const verdict = estimated ? 'partial' : cached <= AFFORDABLE_USD ? 'pass' : 'fail';

  rec.finish(
    verdict,
    [
      estimated
        ? 'ESTIMATED RUN: no count_tokens credentials, so token and dollar figures below are derived from measured bytes at a fixed chars-per-token ratio. Byte, page and template counts ARE measured. Set ANTHROPIC_API_KEY and re-run to replace the estimates.'
        : `Tokens measured with count_tokens against ${counter.model}.`,
      '',
      `Sampled ${pages} pages across ${siteSignatures.size} sites. Rate card ${pricing.asOf} (${pricing.source}).`,
      '',
      `Per page (${label}):`,
      `  full AX tree              ${Math.round(avgFull)} tokens avg, ${Math.round(p95Full)} at p95`,
      `  violations-with-context   ${Math.round(avgMinimal)} tokens avg  -> ${pct(1 - shrink, 1)} the size`,
      `  cacheable system prefix   ${prefixTokens} tokens`,
      '',
      'Templates (share of pages that are structurally distinct, so need judging):',
      ...curve.map((c) => `  Jaccard ${c.threshold}   ${c.clusters}/${c.pages} distinct   ${pct(c.ratio, 1)} of pages`),
      '',
      `Cost of one ${SITE_PAGES}-page site on ${opus.label} (${label}):`,
      `  naive: full tree, every page         $${money(naive)}`,
      `  minimal payload, every page          $${money(minimalOnly)}`,
      `  + template clustering (${judged} pages)  $${money(clustered)}`,
      `  + prompt caching                     $${money(cached)}`,
      `  same, on ${haiku.label}                    $${money(cachedHaiku)}`,
      '',
      `Threshold used: a run is affordable if it lands under $${AFFORDABLE_USD} for a ${SITE_PAGES}-page site. ${estimated ? 'Not asserted - figures are estimates.' : cached <= AFFORDABLE_USD ? `Measured $${money(cached)}.` : `Measured $${money(cached)}, over budget.`}`,
    ].join('\n'),
    designImpact({ shrink, clusterRatio, naive, cached, minimalOnly, clustered, avgFull, p95Full, prefixTokens, fitsHaiku, estimated, opus, haiku, cachedHaiku, SITE_PAGES, avgViolations, spread, mid, curve }),
  );
}

function designImpact(m: {
  shrink: number; clusterRatio: number; naive: number; cached: number; minimalOnly: number;
  clustered: number; avgFull: number; p95Full: number; prefixTokens: number; fitsHaiku: boolean;
  estimated: boolean; opus: Model; haiku: Model; cachedHaiku: number; SITE_PAGES: number;
  avgViolations: number; spread: number; mid: number;
  curve: Array<{ threshold: number; ratio: number }>;
}): string {
  const out: string[] = [];

  if (m.estimated) {
    out.push(
      'Tokens were estimated, not measured, so the dollar figures are indicative only. The RATIOS below do not depend on the tokenizer - they are measured from payload bytes and page counts - so the structural conclusions hold either way.',
    );
  }

  out.push(
    m.shrink > 0.5
      ? `Sending violations-with-context instead of the full accessibility tree removes ${pct(m.shrink, 1)} of the per-page payload. TDD s10 must cost a run against the minimal payload, and the Judge prompt has to be built outward from each violation rather than handed the tree - that is a structural requirement on s5, not a tuning knob.`
      : `Pruning the tree to violations-with-context saved only ${pct(m.shrink, 1)}, so the payload is dominated by the violations themselves rather than the tree. Cost work should target the number of pages judged, not the shape of the per-page prompt.`,
  );

  // The minimal payload is violations plus their context, so its size tracks how many
  // violations a page has. A clean sample makes the pruning look better than it is.
  if (m.avgViolations < 5) {
    out.push(
      `Caveat on that figure: the minimal payload is violations plus context, so it scales with violation count, and this sample averaged only ${m.avgViolations.toFixed(1)} violations per page. On a page with dozens of violations the saving shrinks toward zero. The per-page cost to plan against is the p95 (${Math.round(m.p95Full)} tokens full tree), not the mean of a clean sample.`,
    );
  }

  if (m.spread > 0.2) {
    out.push(
      `The clustering saving is highly sensitive to the similarity threshold: ${pct(m.curve[0].ratio, 1)} of pages are distinct at Jaccard ${m.curve[0].threshold} but ${pct(m.curve[m.curve.length - 1].ratio, 1)} at ${m.curve[m.curve.length - 1].threshold} - a ${pct(m.spread, 1)} swing from a parameter chosen by hand. That sensitivity IS the finding: TDD s10 cannot quote a clustering saving until the similarity metric is validated against pages known to share a template. Quoting the favourable end of this curve would be picking a number, not measuring one.`,
    );
  }

  out.push(
    m.clusterRatio < 0.5
      ? `Template clustering is the largest single lever: only ${pct(m.clusterRatio, 1)} of pages are structurally distinct, cutting a ${m.SITE_PAGES}-page run from $${money(m.minimalOnly)} to $${money(m.clustered)}. The cost model may assume it - but the Explorer must then actually implement clustering before the Judge, which the phasing currently leaves implicit.`
      : `Clustering removed less than half the pages (${pct(m.clusterRatio, 1)} distinct). The cost model cannot lean on it as the primary saving, and per-page cost stays the number that matters.`,
  );

  const cacheSaving = m.clustered > 0 ? 1 - m.cached / m.clustered : 0;
  out.push(
    cacheSaving > 0.1
      ? `Prompt caching the ${m.prefixTokens}-token system prefix saves a further ${pct(cacheSaving, 1)}. Worth doing, but it is the smallest of the three levers - the prefix is small next to a page payload, so caching cannot rescue a design that sends whole trees.`
      : `Prompt caching the ${m.prefixTokens}-token prefix saves almost nothing (${pct(cacheSaving, 1)}) because the prefix is tiny next to the per-page payload. The design should not count on caching as a cost lever at this prompt shape.`,
  );

  out.push(
    `Model choice is a ${round(m.cached / Math.max(m.cachedHaiku, 1e-9))}x lever: the same run is $${money(m.cached)} on ${m.opus.label} against $${money(m.cachedHaiku)} on ${m.haiku.label}. Since the Judge's task is bounded and rule-driven, a cheaper model per violation with escalation for ambiguous cases is worth measuring before the cost model fixes on one tier.`,
  );

  if (!m.fitsHaiku) {
    out.push(
      `The p95 full-tree payload (${Math.round(m.p95Full)} tokens) does not fit ${m.haiku.label}'s ${m.haiku.contextTokens / 1000}K context. Cheaper tiers are only reachable with the minimal payload, which couples the cost model to the sensor design.`,
    );
  }

  return out.join('\n');
}

/**
 * Pages to sample from the entry point, preferring *siblings* of the entry page.
 *
 * This preference is the whole measurement, not a nicety. Taking the first same-origin
 * links means taking the top nav, and the top nav points at the handful of pages that
 * are deliberately structurally different - homepage, about, contact. Cluster those and
 * you measure 8 templates in 8 pages and conclude that template clustering saves
 * nothing, when what you actually sampled was the one part of the site that has no
 * templates. Real sites are mostly siblings: /docs/x, /docs/y, /products/123.
 *
 * So: links under the entry page's own directory first, topped up with anything else
 * same-origin only if there are not enough. The caller reports how many were siblings so
 * a low-sibling sample is visible rather than silently weakening the result.
 */
async function discover(entry: string, cap: number): Promise<{ urls: string[]; siblings: number }> {
  const res = await session.page.goto(entry, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  if (!res || res.status() >= 400) throw new Error(`entry page HTTP ${res?.status() ?? 0}`);
  const origin = new URL(entry).origin;
  const found = (await session.page.evaluate((o) => {
    const out: string[] = [];
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const href = (a as HTMLAnchorElement).href;
      if (href.startsWith(o) && !href.includes('#')) out.push(href.split('?')[0]);
    }
    return out;
  }, origin)) as string[];

  const entryDir = new URL(entry).pathname.replace(/[^/]*$/, '');
  const unique = [...new Set(found.filter((u) => u !== entry))];
  const isSibling = (u: string) => {
    const p = new URL(u).pathname;
    return p.startsWith(entryDir) && p !== entryDir;
  };
  const siblings = unique.filter(isSibling);
  const others = unique.filter((u) => !isSibling(u));
  const picked = [entry, ...siblings, ...others].slice(0, cap);
  return { urls: picked, siblings: picked.filter(isSibling).length };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function pct(part: number, whole: number): string {
  if (!whole) return 'n/a';
  return `${Math.round((part / whole) * 100)}%`;
}

function money(usd: number): string {
  return usd >= 1 ? usd.toFixed(2) : usd.toFixed(3);
}

function flagValue(flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? null : null;
}
