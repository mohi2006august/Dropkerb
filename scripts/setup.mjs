#!/usr/bin/env node
/**
 * One-command setup for every OS.
 *
 * Replaces the shell loops this repo was bootstrapped with, which only worked on a
 * POSIX shell. Everything here goes through Node so Windows (cmd/PowerShell), macOS
 * and Linux take the same path.
 *
 *   node scripts/setup.mjs            install everything
 *   node scripts/setup.mjs --spike s1 only what S1 needs
 *   node scripts/setup.mjs --skip-browsers
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, NPM, IS_LINUX, FIXTURES, fixtureInstalled, nodeTooOld, run, runNpm, MIN_NODE,
  S4_INSTALLER, s4Corpus, PLAYWRIGHT_CLI,
} from './platform.mjs';

const args = process.argv.slice(2);
const only = valueOf('--spike');
const skipBrowsers = args.includes('--skip-browsers');
const force = args.includes('--force');

if (nodeTooOld()) {
  console.error(
    `Node ${process.versions.node} is too old.\n` +
      `These spikes run TypeScript directly, which needs Node >= ${MIN_NODE.join('.')} ` +
      `(native type stripping). Install a newer Node and re-run.`,
  );
  process.exit(1);
}

console.log(`a11y-agent spikes - setup`);
console.log(`  node     ${process.versions.node}`);
console.log(`  platform ${process.platform} ${process.arch}`);
console.log('');

let failed = 0;

// 1. Root tooling: playwright, axe-core, esbuild.
step('root dependencies', () => {
  if (!force && existsSync(join(ROOT, 'node_modules', 'playwright'))) return 'already installed';
  const r = runNpm(['install', '--no-audit', '--no-fund'], { quiet: true });
  if (!r.ok) throw new Error(firstError(r));
  return 'installed';
});

// 2. The browser. Playwright pins a Chromium build per release, so an already-present
//    cache from a different Playwright version does not count as installed.
if (!skipBrowsers) {
  step('chromium (playwright)', () => {
    // --with-deps pulls the shared libraries Chromium needs on a bare Linux image.
    // It is a no-op-but-error on mac/Windows, so only pass it where it applies.
    const argv = IS_LINUX
      ? ['install', '--with-deps', 'chromium']
      : ['install', 'chromium'];
    // Playwright's own cli.js, never "npx playwright" - see runNpm in platform.mjs for
    // why a .cmd shim cannot be spawned here.
    if (!PLAYWRIGHT_CLI) throw new Error('playwright is not installed yet; root dependencies must succeed first');
    const r = run(process.execPath, [PLAYWRIGHT_CLI, ...argv], { quiet: true });
    if (!r.ok) {
      const hint = IS_LINUX
        ? ' (on Linux without root, try: npx playwright install chromium, then install system deps manually)'
        : '';
      throw new Error(firstError(r) + hint);
    }
    return 'ready';
  });
} else {
  console.log('  skip  chromium (--skip-browsers)');
}

// 3. Fixture apps. Each has its own node_modules on purpose: a single tree would let
//    react-dom@17 resolve react@19 internally and silently break version isolation,
//    which is the exact thing S1 is trying to measure.
for (const fx of FIXTURES) {
  if (only && fx.spike !== only) continue;
  step(`fixture ${fx.label} (${fx.spike})`, () => {
    if (!existsSync(join(ROOT, fx.dir, 'package.json'))) return 'no package.json - skipped';
    if (!force && fixtureInstalled(fx.dir)) return 'already installed';
    const r = runNpm(['install', '--no-audit', '--no-fund'], { cwd: join(ROOT, fx.dir), quiet: true });
    if (!r.ok) throw new Error(firstError(r));
    return 'installed';
  });
}

// 4. S4's corpus of real repositories. Opt-in: it is hundreds of megabytes of shallow
//    clones from the public internet, and the other four spikes do not need any of it.
//    Installed by `--spike s4` or `--with-corpus`; otherwise we only point at it, so
//    nobody discovers the requirement three minutes into a run.
const wantCorpus = only === 's4' || args.includes('--with-corpus');
if (wantCorpus) {
  step('s4 corpus (git clones)', () => {
    const r = run(process.execPath, [join(ROOT, S4_INSTALLER)], { quiet: true });
    if (!r.ok) throw new Error(firstError(r));
    const installed = s4Corpus().filter((c) => c.installed).length;
    return `${installed}/${s4Corpus().length} repos ready`;
  });
} else if (!only || only === 's4') {
  const corpus = s4Corpus();
  const ready = corpus.filter((c) => c.installed).length;
  console.log(`  skip  s4 corpus (${ready}/${corpus.length} repos present)`);
  console.log(`          separate install, several hundred MB: npm run setup:s4`);
}

console.log('');
if (failed > 0) {
  console.error(`${failed} step(s) failed. Run "node scripts/doctor.mjs" for details.`);
  process.exit(1);
}
console.log('Setup complete. Next: node scripts/doctor.mjs, then npm run spike:s1');

function step(label, fn) {
  process.stdout.write(`  ${label.padEnd(38)}`);
  try {
    const note = fn();
    console.log(note ?? 'ok');
  } catch (e) {
    failed++;
    console.log('FAILED');
    console.log(`      ${String(e.message).split('\n').slice(0, 3).join('\n      ')}`);
  }
}

function firstError(r) {
  const text = `${r.stderr || ''}\n${r.stdout || ''}`.trim();
  if (r.error) return r.error.message;
  const line = text.split('\n').find((l) => /err|error|fail/i.test(l));
  return (line || text.split('\n')[0] || `exit ${r.status}`).slice(0, 300);
}

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
