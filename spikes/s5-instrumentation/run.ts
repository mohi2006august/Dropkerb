/**
 * S5 - Can we instrument real sites at all? (TDD s0.5)
 *
 * Everything downstream of the Explorer assumes we can inject axe-core and evaluate
 * JavaScript in the page. Strict CSP, bot detection, rate limiting and SSO break that
 * for reasons that have nothing to do with accessibility.
 *
 * The specific question worth answering is not "does injection work" but "does
 * CDP-level injection bypass page CSP", because if it does, strict CSP is a non-issue
 * and the failure modes that remain are bot detection and auth - which are handled by
 * product decisions, not engineering ones.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium, type Browser } from 'playwright';
import { Recorder } from '../shared/results.ts';
import { waitForQuiescence, launchArgs } from '../shared/browser.ts';
import { checkRobots } from './robots.ts';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 a11y-agent-spike/0.1 (+accessibility audit research; one request per host)';
const NAV_TIMEOUT = 45_000;
const PER_SITE_DELAY_MS = 3_000;

interface Site { url: string; profile: string }

const { sites } = JSON.parse(
  readFileSync(new URL('./sites.json', import.meta.url), 'utf8'),
) as { sites: Site[] };

const rec = new Recorder(
  's5',
  'Can we instrument real sites at all?',
  'Do strict CSP, bot detection, or rate limiting prevent injecting axe-core and evaluating JS, and is CDP-level injection sufficient where page-level injection fails?',
);

const browser: Browser = await chromium.launch({ headless: true, args: launchArgs() });
const cspFindings: Array<{ url: string; restricts: boolean; policy: string }> = [];

for (const site of sites) {
  const host = new URL(site.url).host;
  const cell = `${host} (${site.profile})`;

  const robots = await checkRobots(site.url, UA);
  if (!robots.allowed) {
    // A site that told us not to crawl is a result; a site we could not reach is a
    // hole in the sample. Label them differently so the verdict is honest about n.
    rec.observe({
      cell,
      probe: robots.transient ? 'unreachable' : 'robots',
      ok: false,
      detail: `skipped: ${robots.reason}`,
    });
    continue;
  }

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    // Method 1: CDP Page.addScriptToEvaluateOnNewDocument, set before navigation.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__a11ySpikeInit = true;
    });

    const t0 = Date.now();
    const response = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    const navMs = Date.now() - t0;
    const status = response?.status() ?? 0;
    const headers = response?.headers() ?? {};

    rec.observe({
      cell,
      probe: 'navigate',
      ok: status > 0 && status < 400,
      detail: `HTTP ${status}`,
      metrics: { status, navMs },
    });
    if (status >= 400) { await context.close(); continue; }

    await waitForQuiescence(page, { capMs: 12_000 });

    // Record what the site's CSP would do to DOM-based injection.
    const policy = headers['content-security-policy'] ?? headers['content-security-policy-report-only'] ?? '';
    const restricts = cspRestrictsScripts(policy);
    cspFindings.push({ url: site.url, restricts, policy: policy.slice(0, 300) });
    rec.observe({
      cell,
      probe: 'csp-present',
      ok: true,
      detail: policy ? (restricts ? 'restricts inline script' : 'present but permissive') : 'no CSP header',
      metrics: { hasCsp: policy ? 1 : 0, restrictsInline: restricts ? 1 : 0 },
    });

    // Bot / challenge detection before we trust anything else we measured.
    const challenge = await detectChallenge(page);
    rec.observe({
      cell,
      probe: 'bot-challenge',
      ok: !challenge,
      detail: challenge ?? 'no challenge detected',
    });

    const initLanded = await page.evaluate(() => Boolean((window as unknown as Record<string, unknown>).__a11ySpikeInit)).catch(() => false);
    rec.observe({ cell, probe: 'cdp-init-script', ok: initLanded, detail: initLanded ? 'init script executed' : 'init script did not run' });

    // Method 2: DOM-based injection - this is the one CSP is expected to block.
    let domInjectOk = false;
    let domInjectErr = '';
    try {
      await page.addScriptTag({ content: 'window.__a11ySpikeDomTag = true;' });
      domInjectOk = await page.evaluate(() => Boolean((window as unknown as Record<string, unknown>).__a11ySpikeDomTag));
    } catch (e) {
      domInjectErr = firstLine((e as Error).message);
    }
    rec.observe({ cell, probe: 'dom-script-tag', ok: domInjectOk, detail: domInjectOk ? 'executed' : `blocked: ${domInjectErr || 'script did not run'}` });

    // Method 3: CDP Runtime.evaluate, which is what page.evaluate compiles to.
    let cdpEvalOk = false;
    let cdpEvalErr = '';
    try {
      cdpEvalOk = await page.evaluate(() => 2 + 2 === 4);
    } catch (e) {
      cdpEvalErr = firstLine((e as Error).message);
    }
    rec.observe({ cell, probe: 'cdp-evaluate', ok: cdpEvalOk, detail: cdpEvalOk ? 'executed' : `blocked: ${cdpEvalErr}` });

    // The actual thing we need: axe-core injected and run end to end.
    let axeOk = false;
    let axeDetail = '';
    let violations = 0;
    let axeMs = 0;
    try {
      const a0 = Date.now();
      await page.evaluate(AXE_SOURCE);
      const injected = await page.evaluate(() => typeof (window as unknown as Record<string, unknown>).axe !== 'undefined');
      if (!injected) throw new Error('axe global absent after evaluate');
      const result = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: unknown[] }> } }).axe;
        const r = await axe.run(document, { resultTypes: ['violations'] });
        return { violations: r.violations.length };
      });
      axeMs = Date.now() - a0;
      violations = result.violations;
      axeOk = true;
    } catch (e) {
      axeDetail = firstLine((e as Error).message);
    }
    rec.observe({
      cell,
      probe: 'axe-run',
      ok: axeOk,
      detail: axeOk ? `${violations} violation rules` : `failed: ${axeDetail}`,
      metrics: axeOk ? { violations, axeMs } : {},
    });

    // CDP Accessibility.getFullAXTree - the Explorer's state-abstraction input (TDD s2.1).
    let axNodes = 0;
    let axOk = false;
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Accessibility.enable');
      const tree = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: unknown[] };
      axNodes = tree.nodes.length;
      axOk = axNodes > 0;
      await cdp.detach().catch(() => {});
    } catch (e) {
      axeDetail = firstLine((e as Error).message);
    }
    rec.observe({ cell, probe: 'ax-tree', ok: axOk, detail: axOk ? `${axNodes} nodes` : 'unavailable', metrics: { axNodes } });
  } catch (e) {
    rec.observe({ cell, probe: 'navigate', ok: false, detail: `threw: ${firstLine((e as Error).message)}` });
  } finally {
    await context.close().catch(() => {});
  }

  // Rate limit ourselves; TDD s9.5 asks for this and it costs us nothing here.
  await new Promise((r) => setTimeout(r, PER_SITE_DELAY_MS));
}

await browser.close();
const navRate = rec.rate('navigate');
const cdpEvalRate = rec.rate('cdp-evaluate');
const domRate = rec.rate('dom-script-tag');
const axeRate = rec.rate('axe-run');
const axRate = rec.rate('ax-tree');
const challengeRate = 1 - rec.rate('bot-challenge');
const cspRestrictCount = cspFindings.filter((c) => c.restricts).length;

const verdict = axeRate >= 0.9 ? 'pass' : axeRate >= 0.6 ? 'partial' : 'fail';

rec.finish(
  verdict,
  [
    `Sample: ${rec.count('navigate')} of ${sites.length} listed sites measured` +
      (rec.count('unreachable') ? `; ${rec.count('unreachable')} unreachable (network, not a block)` : '') +
      (rec.count('robots') ? `; ${rec.count('robots')} disallowed by robots.txt` : '') + '.',
    `Navigated ${pct(navRate)} of ${rec.count('navigate')} sites.`,
    `CDP-level evaluate succeeded on ${pct(cdpEvalRate)}; DOM script-tag injection succeeded on ${pct(domRate)}.`,
    `${cspRestrictCount} of ${cspFindings.length} sites ship a CSP that restricts inline script.`,
    `Full axe-core inject-and-run: ${pct(axeRate)}. CDP AX tree available on ${pct(axRate)}.`,
    `Bot challenge encountered on ${pct(challengeRate)} of sites.`,
    '',
    domRate < cdpEvalRate
      ? 'CDP injection bypasses page CSP where DOM injection is blocked, which is the result the design was counting on: strict CSP is not a blocker, provided we always inject via CDP and never via addScriptTag.'
      : 'DOM injection was not measurably worse than CDP injection on this sample, so CSP was not the discriminating factor here; the remaining failure modes are bot detection and auth.',
  ].join('\n'),
  axeRate >= 0.9
    ? 'No design change. Remote auditing stays a supported path; keep all injection on the CDP path and treat addScriptTag as unusable.'
    : 'Remote auditing degrades to best-effort and the local dev server becomes the supported default - a change to the product framing (PRD s5.1), not just the implementation.',
);

function cspRestrictsScripts(policy: string): boolean {
  if (!policy) return false;
  const directives = Object.fromEntries(
    policy.split(';').map((d) => {
      const parts = d.trim().split(/\s+/);
      return [parts[0]?.toLowerCase() ?? '', parts.slice(1).map((p) => p.toLowerCase())];
    }),
  );
  const src = directives['script-src'] ?? directives['default-src'];
  if (!src) return false;
  // A policy without 'unsafe-inline', or one running a nonce/strict-dynamic regime,
  // blocks the inline script that addScriptTag injects.
  return !src.includes("'unsafe-inline'") || src.some((s) => s.startsWith("'nonce-") || s === "'strict-dynamic'");
}

async function detectChallenge(page: import('playwright').Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const title = document.title.toLowerCase();
      const body = (document.body?.innerText ?? '').slice(0, 4000).toLowerCase();
      const markers: Array<[string, string]> = [
        ['just a moment', 'cloudflare interstitial'],
        ['checking your browser', 'cloudflare interstitial'],
        ['attention required', 'cloudflare block'],
        ['are you a robot', 'bot challenge'],
        ['verify you are human', 'bot challenge'],
        ['access denied', 'access denied'],
        ['unusual traffic', 'rate limited'],
      ];
      for (const [needle, label] of markers) {
        if (title.includes(needle) || body.includes(needle)) return label;
      }
      if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], #challenge-form')) return 'captcha widget';
      return null;
    })
    .catch(() => null);
}

function firstLine(s: string): string {
  return s.split('\n')[0].slice(0, 160);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
