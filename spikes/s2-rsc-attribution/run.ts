/**
 * S2 - Can React Server Components be attributed at all? (TDD s0.5)
 *
 * RSC output has no client-side fiber, so the Locator's primary signal (TDD s5.1) is
 * structurally absent. Next.js App Router is a large share of the exact codebases in the
 * target profile, so "we don't support it" is close to "we don't support the market".
 *
 * Tests, in the order s0.5 specifies:
 *   (a) does any client-side residue identify server-rendered nodes
 *   (b) does the RSC flight payload carry usable component identity
 *   (c) do CSS source maps (s5.2) still resolve
 *   (d) does probing (s5.5) work through the server build
 *
 * The client component in the fixture is the control: whatever works there is the React
 * 19 client path S1 already measured, so anything failing ONLY on server nodes is
 * RSC-specific rather than a bug in our resolver.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Recorder } from '../shared/results.ts';
import { openSession } from '../shared/browser.ts';
import { startDevServer, freePort, resolveBin } from '../shared/proc.ts';
import { groundTruth, type GroundTruth } from '../s1-debug-internals/manifest.ts';
import { REACT_RESOLVER } from '../s1-debug-internals/resolvers/react.ts';
import { extractFlight, findIdentity, parseCssModuleClass } from './flight.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixture-next');
const APP = join(FIXTURE, 'app');

/** Server components (no 'use client') vs the client control. */
const SERVER_SOURCES = [
  { absPath: join(APP, 'page.jsx'), reportedAs: 'app/page.jsx' },
  { absPath: join(APP, 'Nested.jsx'), reportedAs: 'app/Nested.jsx' },
];
const CLIENT_SOURCES = [{ absPath: join(APP, 'Client.jsx'), reportedAs: 'app/Client.jsx' }];

const rec = new Recorder(
  's2',
  'Can React Server Components be attributed at all?',
  'With no client fiber for server-rendered markup, does any signal - client residue, the flight payload, CSS source maps, or differential probing - recover the source location of a server-rendered DOM node?',
);

// A run killed part-way through - Ctrl-C, a CI timeout, taskkill - never reaches the
// restore in `finally`, so its probe marker stays in the fixture. That is not harmless:
// JSX keeps the LAST of duplicate attributes, so a stale marker shadows the new one and
// probing reports "marker never appeared" about a mechanism that works perfectly. It
// cost two runs and looked exactly like an RSC finding. Clean before reading the
// baseline rather than trusting the previous run to have tidied up after itself.
const cleaned = sanitizeFixtures();
if (cleaned.length > 0) {
  rec.observe({
    cell: 'fixture',
    probe: 'stale-probe-markers',
    ok: false,
    detail: `removed leftover data-probe markers from ${cleaned.join(', ')} - a previous run was killed before restoring the fixture`,
  });
}

const serverGt = SERVER_SOURCES.flatMap((s) => groundTruth(s.absPath, s.reportedAs));
const clientGt = CLIENT_SOURCES.flatMap((s) => groundTruth(s.absPath, s.reportedAs));

const port = await freePort();
let server: Awaited<ReturnType<typeof startDevServer>> | null = null;
const pageSource = readFileSync(SERVER_SOURCES[0].absPath, 'utf8');

try {
  // Run Next's own JS entry through node rather than the npx/next shim: Windows throws
  // EINVAL on spawning a .cmd without a shell, and a shell reintroduces quoting bugs.
  const nextBin = await resolveBin(FIXTURE, 'next/dist/bin/next');
  server = await startDevServer({
    command: process.execPath,
    args: [nextBin, 'dev', '--port', String(port)],
    cwd: FIXTURE,
    ready: /Ready in|started server on|Local:/i,
    port,
    timeoutMs: 180_000,
  });
  rec.observe({ cell: 'next-dev', probe: 'server-start', ok: true, detail: `dev server on :${port}` });

  const session = await openSession();
  try {
    await gotoWithRetry(session.page, server.url);
    const rendered = await session.page.locator('[data-spike-id]').count();
    rec.observe({
      cell: 'next-dev',
      probe: 'fixture-renders',
      ok: rendered >= serverGt.length + clientGt.length,
      detail: `${rendered} tagged nodes (${serverGt.length} server + ${clientGt.length} client expected)`,
      metrics: { rendered },
    });

    await testClientResidue(session.page);
    await testFlightPayload(session.page);
    await testCssModules(session.page);
    // Probing reuses this session instead of launching a second browser. The extra
    // launch was the least reliable step in the whole run - it hung indefinitely on a
    // loaded machine - and nothing about the test needs a cold profile: the dev server
    // sends no-cache headers and we navigate explicitly after editing the source.
    await testProbing(session.page, server.url, port);
  } finally {
    await session.close();
  }
} catch (e) {
  rec.observe({
    cell: 'next-dev',
    probe: 'server-start',
    ok: false,
    detail: (e as Error).message.replace(/\s*\n\s*/g, ' | ').slice(0, 400),
  });
} finally {
  // Always put the fixture source back, even if probing threw halfway through. A spike
  // that corrupts its own fixture poisons every later run.
  writeFileSync(SERVER_SOURCES[0].absPath, pageSource);
  if (server) await server.stop();
}

reportVerdict();

/** Strips probe markers left behind by a previous run. Returns the files it changed. */
function sanitizeFixtures(): string[] {
  const dirty: string[] = [];
  for (const src of [...SERVER_SOURCES, ...CLIENT_SOURCES]) {
    const before = readFileSync(src.absPath, 'utf8');
    const after = before.replace(/\s+data-probe="[^"]*"/g, '');
    if (after !== before) {
      writeFileSync(src.absPath, after);
      dirty.push(src.reportedAs);
    }
  }
  return dirty;
}

/**
 * Next's dev server can accept a connection and then reset it while its worker is still
 * coming up, so the first navigation after the port answers is not reliable - one run
 * died on ERR_CONNECTION_RESET and reported it as an RSC finding. Retry instead.
 */
async function gotoWithRetry(page: import('playwright').Page, url: string, attempts = 3): Promise<void> {
  let last: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 90_000 });
      return;
    } catch (e) {
      last = e as Error;
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  throw last ?? new Error('navigation failed');
}

// -------------------------------------------------------------------------- (a)

/** Does anything on a server-rendered node identify its source? */
async function testClientResidue(page: import('playwright').Page): Promise<void> {
  for (const [label, gt] of [['server', serverGt], ['client', clientGt]] as const) {
    let fiberFound = 0;
    let attributed = 0;
    let sample = '';

    for (const want of gt) {
      const probes = await probe(page, want.id);
      if (probes.length === 0) continue;
      if (probes.some((p) => p?.fiberFound)) fiberFound++;
      const hasSource = probes.some((p) => p?.debugSource?.fileName || p?.debugStack);
      if (hasSource) attributed++;
      if (!sample && probes[0]) {
        sample = probes[0].fiberFound
          ? `fiber present, fields: ${(probes[0].fieldsPresent ?? []).join(' ') || 'none'}`
          : 'no fiber key on the element';
      }
    }

    const n = gt.length;
    rec.observe({
      cell: `${label}-components`,
      probe: 'client-residue',
      // The client control SHOULD attribute; the server side is the open question.
      ok: label === 'client' ? attributed === n : attributed > 0,
      detail: `${fiberFound}/${n} have a React fiber, ${attributed}/${n} carry source info - ${sample}`,
      metrics: { fiberFound, attributed, n },
    });
  }
}

// -------------------------------------------------------------------------- (b)

async function testFlightPayload(page: import('playwright').Page): Promise<void> {
  const html = await page.content();
  const flight = extractFlight(html);
  rec.observe({
    cell: 'flight-payload',
    probe: 'payload-present',
    ok: flight.chunks > 0,
    detail: `${flight.chunks} chunks, ${flight.text.length} chars`,
    metrics: { chunks: flight.chunks, chars: flight.text.length },
  });
  if (flight.chunks === 0) return;

  const serverFiles = SERVER_SOURCES.map((s) => s.reportedAs);
  const clientFiles = CLIENT_SOURCES.map((s) => s.reportedAs);
  const idServer = findIdentity(flight.text, serverFiles);
  const idClient = findIdentity(flight.text, clientFiles);

  rec.observe({
    cell: 'flight-payload',
    probe: 'server-component-identity',
    ok: idServer.namesFixtureSource,
    detail: idServer.namesFixtureSource
      ? `names server source: ${idServer.paths.filter((p) => serverFiles.some((f) => p.endsWith(f))).join(', ')}`
      : `no server source named; payload mentions ${idServer.paths.length} paths (${idServer.paths.slice(0, 4).join(', ') || 'none'})`,
    metrics: { paths: idServer.paths.length },
  });
  rec.observe({
    cell: 'flight-payload',
    probe: 'client-component-identity',
    ok: idClient.namesFixtureSource,
    detail: idClient.namesFixtureSource
      ? 'client component module reference present (expected - it must be hydrated)'
      : 'no client module reference found',
    metrics: { clientRefs: idClient.clientRefs },
  });
}

// -------------------------------------------------------------------------- (c)

async function testCssModules(page: import('playwright').Page): Promise<void> {
  const classes = (await page.evaluate(() => {
    const out: Array<{ id: string; cls: string }> = [];
    for (const el of Array.from(document.querySelectorAll('[data-spike-id][class]'))) {
      out.push({ id: el.getAttribute('data-spike-id')!, cls: el.getAttribute('class')! });
    }
    return out;
  })) as Array<{ id: string; cls: string }>;

  rec.observe({
    cell: 'css-modules',
    probe: 'hashed-classes-present',
    ok: classes.length > 0,
    detail: classes.length ? `${classes.length} tagged nodes carry a class: ${classes[0].cls}` : 'no classed nodes found',
    metrics: { classed: classes.length },
  });
  if (classes.length === 0) return;

  let decoded = 0;
  let sample = '';
  for (const { cls } of classes) {
    for (const one of cls.split(/\s+/)) {
      const parsed = parseCssModuleClass(one);
      if (parsed) {
        decoded++;
        if (!sample) sample = `${one} -> ${parsed.file}.module.css .${parsed.local}`;
        break;
      }
    }
  }
  rec.observe({
    cell: 'css-modules',
    probe: 'class-name-decodes',
    ok: decoded === classes.length,
    detail: decoded ? `${decoded}/${classes.length} decode to file+local name: ${sample}` : 'class names are opaque; a CSS source map would be required',
    metrics: { decoded, n: classes.length },
  });

  // Is a CSS source map actually served? That is what TDD s5.2 depends on in production,
  // where the dev-readable class format is gone.
  const cssHrefs = (await page.evaluate(() =>
    Array.from(document.querySelectorAll('link[rel=stylesheet]')).map((l) => (l as HTMLLinkElement).href),
  )) as string[];
  let mapped = 0;
  for (const href of cssHrefs) {
    try {
      const res = await fetch(href, { signal: AbortSignal.timeout(10_000) });
      const text = await res.text();
      if (/sourceMappingURL/.test(text)) mapped++;
    } catch {
      /* a stylesheet we cannot fetch is one we cannot count */
    }
  }
  rec.observe({
    cell: 'css-modules',
    probe: 'css-source-map',
    ok: mapped > 0,
    detail: `${mapped}/${cssHrefs.length} stylesheets advertise a source map`,
    metrics: { mapped, sheets: cssHrefs.length },
  });
}

// -------------------------------------------------------------------------- (d)

/**
 * Differential probing (TDD s5.5): mark a candidate source location, rebuild, and see
 * which DOM node the marker lands on. This does not infer attribution, it demonstrates
 * it - and it is the fallback the whole RSC story depends on if (a)-(c) fail.
 */
async function testProbing(page: import('playwright').Page, url: string, port: number): Promise<void> {
  const target = serverGt.find((g) => g.id === 'r05') ?? serverGt[0];
  const marker = `probe-${Date.now().toString(36)}`;
  const lines = pageSource.split(/\r?\n/);
  const idx = target.line - 1;

  if (!/data-spike-id/.test(lines[idx] ?? '')) {
    rec.observe({ cell: 'probing', probe: 'marker-injected', ok: false, detail: 'could not locate the target line to mark' });
    return;
  }

  lines[idx] = lines[idx].replace(/(<\w+)/, `$1 data-probe="${marker}"`);
  writeFileSync(SERVER_SOURCES[0].absPath, lines.join('\n'));
  rec.observe({
    cell: 'probing',
    probe: 'marker-injected',
    ok: true,
    detail: `marked ${target.file}:${target.line} (${target.id})`,
  });

  const started = Date.now();
  {
    let landedOn: string | null = null;
    const deadline = Date.now() + 60_000;
    // Poll rather than trust one reload: the dev server recompiles asynchronously and
    // the first request after an edit can still serve the previous render.
    //
    // Wait on domcontentloaded, never networkidle. This page holds an open HMR
    // websocket and keeps polling the dev server, so the network never goes idle - each
    // reload burned the full 60s timeout and the probe reported "marker never appeared"
    // against a dev server that had already rendered it. The marker is in the server
    // HTML, so the document being parsed is all the readiness this needs.
    while (Date.now() < deadline && landedOn === null) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
      landedOn = (await page.evaluate((m) => {
        const el = document.querySelector(`[data-probe="${m}"]`);
        return el ? el.getAttribute('data-spike-id') : null;
      }, marker)) as string | null;
      if (landedOn === null) await new Promise((r) => setTimeout(r, 2_000));
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    rec.observe({
      cell: 'probing',
      probe: 'marker-lands-on-target',
      ok: landedOn === target.id,
      detail:
        landedOn === null
          ? `marker never appeared within 60s (port ${port})`
          : `marker landed on ${landedOn}, expected ${target.id}`,
      metrics: { seconds },
    });
  }
}

// ------------------------------------------------------------------------ report

async function probe(page: import('playwright').Page, id: string): Promise<Array<Record<string, any>>> {
  return (await page.evaluate(
    ({ fn, id }) => {
      const els = Array.from(document.querySelectorAll('[data-spike-id="' + id + '"]'));
      const resolve = (0, eval)('(' + fn + ')');
      return els.map((el) => resolve(el));
    },
    { fn: REACT_RESOLVER, id },
  )) as Array<Record<string, any>>;
}

function ok(probeName: string): boolean {
  return rec.rate(probeName) === 1;
}

function reportVerdict(): void {
  // Four independent signals, each in one of THREE states: measured-and-working,
  // measured-and-not, or never measured. The third must never be rendered as the
  // second. An earlier version collapsed them to a boolean, so a run that died before
  // testing anything published "NOT attributable by any signal tested" - a claim about
  // React that nobody had observed, written over a previous run's real result.
  //
  // This is the same rule the reporter applies across spikes (TDD s3.9): a missing
  // result reads as a pass unless it is spelled out, so spell it out.
  const signals = [
    { tag: '(a)', label: 'client residue on server nodes', probe: 'client-residue', works: () => rec.rate('client-residue') > 0.5 },
    { tag: '(b)', label: 'server component identity in the flight payload', probe: 'server-component-identity', works: () => ok('server-component-identity') },
    { tag: '(c)', label: 'CSS module class names decode to file + local name', probe: 'class-name-decodes', works: () => ok('class-name-decodes') },
    { tag: '(d)', label: 'differential probing through the server build', probe: 'marker-lands-on-target', works: () => ok('marker-lands-on-target') },
  ].map((s) => {
    const tested = rec.count(s.probe) > 0;
    return { ...s, tested, working: tested && s.works() };
  });

  const untested = signals.filter((s) => !s.tested);
  const working = signals.filter((s) => s.working);

  if (untested.length === signals.length) {
    const why = rec.rate('server-start') === 1 ? 'the run failed before any signal was tested' : 'the Next dev server never started';
    rec.finish(
      'skipped',
      [
        `NOT MEASURED: ${why}, so none of the four signals was exercised.`,
        'This is a harness failure, not a result about RSC attribution.',
        '',
        'Re-run: node spikes/s2-rsc-attribution/run.ts',
      ].join('\n'),
      'None. S2 gates Phase 3 scope for App Router and that question stays open until this runs.',
    );
    return;
  }

  // An incomplete run can be neither a pass nor a definitive fail: the signals that
  // were not reached might have gone either way.
  const verdict = untested.length > 0
    ? 'partial'
    : working.length > 0
      ? (working.length > 1 ? 'pass' : 'partial')
      : 'fail';

  const headline = untested.length > 0
    ? `INCOMPLETE: ${untested.length} of 4 signals not tested this run.`
    : working.length
      ? `Server components: attributable via ${working.map((s) => `${s.tag} ${shortLabel(s)}`).join(', ')}.`
      : 'Server components: NOT attributable by any of the four signals, all of which were tested.';

  const probingWorks = signals[3].working;
  const cssDecodes = signals[2].working;
  const flightServer = signals[1].working;

  rec.finish(
    verdict,
    [
      headline,
      ...signals.map((s) => `${s.tag} ${s.label}: ${s.tested ? (s.working ? 'WORKS' : 'no') : 'NOT TESTED'}`),
      '',
      'The client component in the same tree is the control. Where it attributes and the server components do not, the gap is RSC-specific rather than a defect in the resolver.',
    ].join('\n'),
    [
      untested.length > 0
        ? `Nothing can be concluded about ${untested.map((s) => s.tag).join(', ')} from this run - they were not reached. Re-run before using S2 to make a scope decision.`
        : '',
      signals[3].tested
        ? probingWorks
          ? 'Probing (TDD s5.5) works through the App Router dev build, so it carries RSC attribution. That confirms the hard dev-server requirement for App Router projects: it belongs on the README, not in a footnote.'
          : 'Probing did not resolve here, which removes the fallback TDD s5.8 leans on for RSC.'
        : '',
      signals[2].tested && cssDecodes
        ? "Next's dev CSS Module format encodes file and local class name directly, so s5.2 needs no source map in dev - but production uses a bare hash and does, so the map index is still required."
        : '',
      signals[1].tested
        ? flightServer
          ? 'The flight payload names server source, which is a signal the design does not currently list. Worth adding to s5 as an RSC-specific signal.'
          : 'The flight payload carries module references only for client components, which must be hydrated. Server components are already HTML by the time they arrive, so there is nothing to reference - this is structural, not a Next.js version detail.'
        : '',
      signals[0].tested
        ? 'Either way, s5.1 is unavailable for server-rendered markup and must not be listed as the primary path for App Router.'
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/** The short name used in the "attributable via ..." list. */
function shortLabel(s: { tag: string; label: string }): string {
  return s.label.split(' ').slice(0, 3).join(' ');
}
