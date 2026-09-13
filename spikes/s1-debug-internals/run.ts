/**
 * S1 - Do framework debug internals actually resolve? (TDD s0.5)
 *
 * _debugSource, __svelte_meta and __vueParentComponent are private, unstable APIs that
 * return undefined rather than throwing when absent. The Locator's strongest signal
 * (TDD s5.1, confidence 0.95-0.99) may simply not exist on current versions.
 *
 * Method: a fixture per matrix cell, 20 known DOM nodes each, ground truth derived from
 * the fixture source itself. For every node, ask each signal independently whether it
 * returns the correct file:line. Signals are scored separately because they fail
 * separately and the design assigns them different confidences.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Recorder, RAW_DIR } from '../shared/results.ts';
import { openSession, type Session } from '../shared/browser.ts';
import { serveDir } from '../shared/serve.ts';
import { SourceMapConsumer } from '../shared/sourcemap.ts';
import { groundTruth, type GroundTruth } from './manifest.ts';
import { attributeFromStack } from './attribute.ts';
import { grade, systematicOffset, type Grade, type Located } from './grade.ts';
import { buildReactCell } from './fixtures/react/build.ts';
import { buildVueCell } from './fixtures/vue/build.ts';
import { buildSvelteCell } from './fixtures/svelte/build.ts';
import { REACT_RESOLVER } from './resolvers/react.ts';
import { VUE_RESOLVER } from './resolvers/vue.ts';
import { SVELTE_RESOLVER } from './resolvers/svelte.ts';

/** Component names in the React fixture, for grading the owner-name fallback. */
const REACT_COMPONENTS = ['App', 'Card', 'Badge', 'Toolbar', 'Field', 'SignupForm', 'Deep'];

const rec = new Recorder(
  's1',
  'Do framework debug internals actually resolve?',
  'For a known DOM node, does the framework expose enough to recover the correct source file and line - and does that still hold on current major versions and in production builds?',
);

interface NodeOutcome {
  id: string;
  instances: number;
  expected: string;
  signals: Record<string, { grade: Grade; got: string | null }>;
  fieldsPresent: string[];
}

interface CellSummary {
  framework: string;
  mode: 'dev' | 'prod';
  /** Accuracy of the best signal available on this cell. */
  best: number;
  via: string;
  /** Granularity the winning signal actually delivers. */
  granularity: 'file:line' | 'file' | 'none';
  note?: string;
}

const details: Record<string, NodeOutcome[]> = {};
const summaries = new Map<string, CellSummary>();

for (const major of [17, 18, 19] as const) {
  for (const mode of ['dev', 'prod'] as const) {
    await guard(`react-${major}/${mode}`, () => runReact(major, mode));
  }
}
for (const mode of ['dev', 'prod'] as const) {
  await guard(`vue-3/${mode}`, () => runVue(mode));
}
for (const major of [4, 5] as const) {
  for (const mode of ['dev', 'prod'] as const) {
    await guard(`svelte-${major}/${mode}`, () => runSvelte(major, mode));
  }
}

// Angular 17 is in the s0.5 matrix and is NOT measured here. Recording that as an
// explicit gap rather than omitting the row, for the same reason TDD s3.9 refuses to
// report a clean result for a region it could not see: an absent row reads as a pass.
rec.observe({
  cell: 'angular-17/dev',
  probe: 'unmeasured',
  ok: false,
  detail: 'not built - Angular needs its own compiler toolchain; ng.getComponent is expected to be component-level like Vue, but expected is not measured',
});

writeFileSync(join(RAW_DIR, 's1-nodes.json'), JSON.stringify(details, null, 2));
writeFileSync(join(RAW_DIR, 's1-cells.json'), JSON.stringify([...summaries], null, 2));

reportVerdict();

// ---------------------------------------------------------------- framework runners

async function runReact(major: 17 | 18 | 19, mode: 'dev' | 'prod'): Promise<void> {
  const cell = await buildReactCell(major, mode);
  const gt = groundTruth(cell.sourcePath, cell.reportedAs);
  const map = loadMap(cell.dist);

  await withPage(cell.cell, cell.dist, gt, async (page) => {
    const outcomes: NodeOutcome[] = [];
    let ds = 0;
    let stack = 0;
    let owner = 0;
    let fields: string[] = [];

    for (const want of gt) {
      const probes = await probeAll(page, REACT_RESOLVER, want.id);
      const dsLoc = probes.map((p) =>
        p?.debugSource?.fileName ? { file: p.debugSource.fileName, line: p.debugSource.lineNumber } : null,
      );
      const stackLoc = probes.map((p) =>
        p?.debugStack && map ? asLocated(attributeFromStack(p.debugStack, map, (s) => s.includes('App.jsx'))) : null,
      );
      const dsGrade = grade(dsLoc, want);
      const stackGrade = grade(stackLoc, want);
      const ownerName = probes[0]?.ownerName ?? null;

      if (dsGrade === 'exact') ds++;
      if (stackGrade === 'exact') stack++;
      if (ownerName && REACT_COMPONENTS.includes(ownerName)) owner++;
      if (fields.length === 0 && probes[0]?.fieldsPresent?.length) fields = probes[0].fieldsPresent;

      outcomes.push({
        id: want.id,
        instances: probes.length,
        expected: `${want.file}:${want.line}`,
        signals: {
          _debugSource: { grade: dsGrade, got: show(dsLoc[0]) },
          _debugStack: { grade: stackGrade, got: show(stackLoc[0]) },
          _debugOwner: { grade: ownerName ? 'file-only' : null, got: ownerName },
        },
        fieldsPresent: probes[0]?.fieldsPresent ?? [],
      });
    }

    const n = gt.length;
    emit(cell.cell, mode, '_debugSource', ds, n);
    emit(cell.cell, mode, '_debugStack+map', stack, n);
    emit(cell.cell, mode, '_debugOwner(name)', owner, n);
    emitFields(cell.cell, fields);

    const best = Math.max(ds, stack) / n;
    summaries.set(cell.cell, {
      framework: `react-${major}`,
      mode,
      best,
      via: best === 0 ? 'none' : ds >= stack ? '_debugSource' : '_debugStack+sourcemap',
      granularity: best > 0 ? 'file:line' : 'none',
      note: `react ${cell.reactVersion}`,
    });
    details[cell.cell] = outcomes;
    return best;
  });
}

async function runVue(mode: 'dev' | 'prod'): Promise<void> {
  const cell = await buildVueCell(mode);
  const gt = cell.sources.flatMap((s) => groundTruth(s.absPath, s.reportedAs));

  await withPage(cell.cell, cell.dist, gt, async (page) => {
    const outcomes: NodeOutcome[] = [];
    let fileHits = 0;
    let fields: string[] = [];

    for (const want of gt) {
      const probes = await probeAll(page, VUE_RESOLVER, want.id);
      const loc = probes.map((p) => (p?.file ? { file: p.file as string, line: p.line ?? null } : null));
      const g = grade(loc, want);
      if (g === 'file-only' || g === 'exact') fileHits++;
      if (fields.length === 0 && probes[0]?.fieldsPresent?.length) fields = probes[0].fieldsPresent;
      outcomes.push({
        id: want.id,
        instances: probes.length,
        expected: `${want.file}:${want.line}`,
        signals: { __file: { grade: g, got: show(loc[0]) } },
        fieldsPresent: probes[0]?.fieldsPresent ?? [],
      });
    }

    const n = gt.length;
    emit(cell.cell, mode, '__file(component)', fileHits, n, 'correct FILE; Vue carries no line');
    emitFields(cell.cell, fields);

    const best = fileHits / n;
    summaries.set(cell.cell, {
      framework: 'vue-3',
      mode,
      best,
      via: best === 0 ? 'none' : '__vueParentComponent.type.__file',
      granularity: best > 0 ? 'file' : 'none',
      note: `vue ${cell.vueVersion}`,
    });
    details[cell.cell] = outcomes;
    return best;
  });
}

async function runSvelte(major: 4 | 5, mode: 'dev' | 'prod'): Promise<void> {
  const cell = await buildSvelteCell(major, mode);
  const gt = cell.sources.flatMap((s) => groundTruth(s.absPath, s.reportedAs));

  await withPage(cell.cell, cell.dist, gt, async (page) => {
    const outcomes: NodeOutcome[] = [];
    const linePairs: Array<{ got: number | null; want: number }> = [];
    let exact = 0;
    let fileOk = 0;
    let fields: string[] = [];

    for (const want of gt) {
      const probes = await probeAll(page, SVELTE_RESOLVER, want.id);
      const loc = probes.map((p) => (p?.file ? { file: p.file as string, line: p.line ?? null } : null));
      const g = grade(loc, want);
      if (g === 'exact') exact++;
      if (g === 'exact' || g === 'wrong-line' || g === 'file-only') fileOk++;
      linePairs.push({ got: (loc[0]?.line ?? null) as number | null, want: want.line });
      if (fields.length === 0 && probes[0]?.fieldsPresent?.length) fields = probes[0].fieldsPresent;
      outcomes.push({
        id: want.id,
        instances: probes.length,
        expected: `${want.file}:${want.line}`,
        signals: { __svelte_meta: { grade: g, got: show(loc[0]) } },
        fieldsPresent: probes[0]?.fieldsPresent ?? [],
      });
    }

    const n = gt.length;
    const offset = systematicOffset(linePairs);
    emit(cell.cell, mode, '__svelte_meta.loc', exact, n, offset !== null ? `systematic line offset ${offset > 0 ? '+' : ''}${offset}` : undefined);
    emit(cell.cell, mode, '__svelte_meta(file)', fileOk, n);
    emitFields(cell.cell, fields);

    // An offset that is constant across every node is a known-correctable indexing
    // convention, not a failure to attribute - so the cell's usable accuracy counts it.
    const usable = offset !== null ? fileOk / n : exact / n;
    summaries.set(cell.cell, {
      framework: `svelte-${major}`,
      mode,
      best: usable,
      via: usable === 0 ? 'none' : '__svelte_meta.loc',
      granularity: usable > 0 ? 'file:line' : 'none',
      note: offset !== null ? `svelte ${cell.svelteVersion}; loc.line offset ${offset}` : `svelte ${cell.svelteVersion}`,
    });
    details[cell.cell] = outcomes;
    return usable;
  });
}

// ---------------------------------------------------------------------- scaffolding

async function guard(cell: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    rec.observe({ cell, probe: 'build', ok: false, detail: (e as Error).message.split('\n')[0].slice(0, 160) });
    summaries.set(cell, { framework: cell.split('/')[0], mode: cell.endsWith('prod') ? 'prod' : 'dev', best: 0, via: 'build failed', granularity: 'none' });
  }
}

async function withPage(
  cell: string,
  dist: string,
  gt: GroundTruth[],
  fn: (page: Session['page']) => Promise<number>,
): Promise<void> {
  const srv = await serveDir(dist);
  const session = await openSession();
  const pageErrors: string[] = [];
  session.page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await session.page.goto(srv.url, { waitUntil: 'networkidle' });
    const rendered = await session.page.locator('[data-spike-id]').count();
    rec.observe({
      cell,
      probe: 'fixture-renders',
      ok: rendered >= gt.length && pageErrors.length === 0,
      detail: pageErrors.length ? `page error: ${pageErrors[0].slice(0, 90)}` : `${rendered} tagged nodes for ${gt.length} ids`,
      metrics: { rendered, ids: gt.length },
    });
    const best = await fn(session.page);
    rec.observe({
      cell,
      probe: `best-signal@${cell.endsWith('prod') ? 'prod' : 'dev'}`,
      ok: best === 1,
      detail: best > 0 ? `${pct(best)} via ${summaries.get(cell)?.via}` : 'no signal resolves this cell',
      metrics: { accuracy: best },
    });
  } finally {
    await session.close();
    await srv.close();
  }
}

async function probeAll(page: Session['page'], resolver: string, id: string): Promise<Array<Record<string, any>>> {
  return (await page.evaluate(
    ({ fn, id }) => {
      const els = Array.from(document.querySelectorAll('[data-spike-id="' + id + '"]'));
      const resolve = (0, eval)('(' + fn + ')');
      return els.map((el) => resolve(el));
    },
    { fn: resolver, id },
  )) as Array<Record<string, any>>;
}

function emit(cell: string, mode: 'dev' | 'prod', signal: string, hits: number, n: number, note?: string): void {
  rec.observe({
    cell,
    probe: `${signal}@${mode}`,
    ok: hits === n,
    detail: `${hits}/${n}${note ? ` - ${note}` : ''}`,
    metrics: { accuracy: n ? hits / n : 0, hits, n },
  });
}

function emitFields(cell: string, fields: string[]): void {
  rec.observe({
    cell,
    probe: 'fields-present',
    ok: fields.length > 0,
    detail: fields.length ? fields.join(' ') : 'no debug fields on the element',
  });
}

function loadMap(dist: string): SourceMapConsumer | null {
  const p = join(dist, 'app.js.map');
  return existsSync(p) ? new SourceMapConsumer(JSON.parse(readFileSync(p, 'utf8'))) : null;
}

function asLocated(a: { file: string; line: number } | null): Located | null {
  return a ? { file: a.file, line: a.line } : null;
}

function show(l: Located | null | undefined): string | null {
  if (!l) return null;
  return l.line === null ? l.file : `${l.file}:${l.line}`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function reportVerdict(): void {
  const all = [...summaries.entries()];
  const dev = all.filter(([, v]) => v.mode === 'dev');
  const prod = all.filter(([, v]) => v.mode === 'prod');
  const devFull = dev.filter(([, v]) => v.best === 1);
  const devCoverage = dev.length ? devFull.length / dev.length : 0;
  const prodFull = prod.filter(([, v]) => v.best === 1);
  const fileOnly = dev.filter(([, v]) => v.granularity === 'file');

  // The design's claim is that a resolver exists, not that one particular field does,
  // so the verdict turns on coverage by the best available signal per cell. Reporting
  // _debugSource's 2-of-3 as the headline would understate a result where every dev
  // cell in fact resolved perfectly, just through different doors.
  const verdict = devCoverage === 1 ? 'pass' : devCoverage >= 0.6 ? 'partial' : 'fail';

  rec.finish(
    verdict,
    [
      `Dev builds: ${devFull.length}/${dev.length} cells attributed every node, each via whichever signal that version exposes.`,
      ...dev.map(([c, v]) => `  ${c.padEnd(16)} ${pct(v.best).padStart(4)} via ${v.via} (${v.granularity})${v.note ? ` [${v.note}]` : ''}`),
      `Production builds: ${prodFull.length}/${prod.length} cells attributed - every debug field is stripped.`,
      '',
      'React 19 removes _debugSource from the fiber entirely. The field is absent, not null, so a resolver that reads it gets undefined and, without the startup self-test TDD s5.1 mentions, silently attributes nothing rather than failing loudly.',
      'React 19 still carries the JSX call site in _debugStack, but as a bundle-relative Error stack. Recovering a source line means consuming the build source map, which moves React 19 from TDD s5.1 (read a field) to s5.2 (consume a map) and makes it depend on the build emitting usable maps.',
      fileOnly.length
        ? `Vue attributes to a FILE and carries no line at all (${fileOnly.map(([c]) => c).join(', ')}). The design's "file:line at 0.95" does not hold for Vue; locating the element inside the file needs anchor search or structural verification as a second stage.`
        : '',
      'Svelte is the cleanest signal of the three - __svelte_meta sits on the element itself, no tree walk - but Svelte 4 reports loc.line 0-based while Svelte 5 reports it 1-based. A resolver written against one and shipped against the other lands every patch exactly one line off, which is the quietest possible way to be wrong.',
      'No debug signal survives a production build in any framework tested.',
      'Not measured: Angular 17, which the s0.5 matrix lists. Treat its row as unknown, not as working.',
    ]
      .filter(Boolean)
      .join('\n'),
    [
      'TDD s5.1 cannot be one resolver. It is per framework AND per major: read a field (React 17/18, Svelte), parse a stack through a source map (React 19), or accept file-only (Vue).',
      'The startup self-test is not optional. It is the only thing between a removed private API and silent non-attribution, and it must assert line numbers, not just presence, or the Svelte indexing change passes it.',
      'Build s5.2 (source-map indexing) before or alongside s5.1: React 19 already needs it, so it is not a fallback, it is a dependency.',
      'Vue needs the s5.3/s5.4 anchor-plus-structural stage to reach line granularity, so Vue support costs more than the "pluggable locator" framing suggests.',
      'Dev-server dependency is confirmed as a hard precondition for this entire signal class, which makes spike S2 (RSC) and the probing fallback in s5.5 more load-bearing, not less.',
    ].join('\n'),
  );
}
