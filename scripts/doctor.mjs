#!/usr/bin/env node
/**
 * Environment check. Says what is missing and what to run, per OS, instead of letting a
 * spike fail three minutes in with a stack trace from inside Playwright.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, NPM, IS_WINDOWS, IS_MAC, IS_LINUX, FIXTURES, fixtureInstalled,
  nodeTooOld, needsNoSandbox, run, MIN_NODE, gitAvailable, s4Corpus,
} from './platform.mjs';

let problems = 0;
const osName = IS_WINDOWS ? 'Windows' : IS_MAC ? 'macOS' : IS_LINUX ? 'Linux' : process.platform;

console.log(`a11y-agent spikes - doctor`);
console.log(`  os        ${osName} (${process.platform} ${process.arch})`);
console.log(`  node      ${process.versions.node}`);
console.log('');

check(
  'Node supports running .ts directly',
  !nodeTooOld(),
  `Node >= ${MIN_NODE.join('.')} required (native type stripping). Current: ${process.versions.node}.`,
);

check(
  'root dependencies installed',
  existsSync(join(ROOT, 'node_modules', 'playwright')),
  `Run: ${NPM} run setup`,
);

const browsers = playwrightBrowsers();
check(
  'chromium available to playwright',
  browsers.ok,
  browsers.hint,
);

for (const fx of FIXTURES) {
  const hasPkg = existsSync(join(ROOT, fx.dir, 'package.json'));
  if (!hasPkg) {
    console.log(`  --    fixture ${fx.label.padEnd(22)} not present (${fx.spike} cannot run)`);
    continue;
  }
  check(`fixture ${fx.label} (${fx.spike})`, fixtureInstalled(fx.dir), `Run: node scripts/setup.mjs --spike ${fx.spike}`);
}

// S4 needs git and its own separately-installed corpus; report both rather than
// letting the spike discover them after it has already opened a browser.
const git = gitAvailable();
check(
  'git available (S4 corpus)',
  Boolean(git),
  IS_WINDOWS
    ? 'winget install --id Git.Git  (or https://git-scm.com/download/win)'
    : IS_MAC
      ? 'xcode-select --install  (or brew install git)'
      : 'sudo apt-get install git  |  sudo dnf install git',
);

const corpus = s4Corpus();
const ready = corpus.filter((c) => c.installed).length;
if (ready === corpus.length && corpus.length > 0) {
  console.log(`  ok    s4 corpus (${ready}/${corpus.length} repos cloned)`);
} else {
  // Not a FAIL: the corpus is an opt-in install and S4 clones on demand. Saying
  // otherwise would train people to ignore the doctor's failures.
  console.log(`  --    s4 corpus ${ready}/${corpus.length} repos cloned`);
  console.log(`        Install ahead of time with: ${NPM} run setup:s4`);
  if (ready < corpus.length) {
    console.log(`        Missing: ${corpus.filter((c) => !c.installed).map((c) => c.id).join(', ')}`);
  }
}

if (needsNoSandbox()) {
  console.log('');
  console.log('  note  running as root on Linux - Chromium will be launched with --no-sandbox.');
  console.log('        Set A11Y_SPIKE_NO_SANDBOX=0 to force the sandbox back on.');
}

const networkSpikes = ['s3', 's4', 's5'];
console.log('');
const spikeList = networkSpikes.slice(0, -1).join(', ') + ' and ' + networkSpikes.at(-1);
console.log(`  note  spikes ${spikeList} reach the public internet.`);
console.log('        They honour robots.txt, send a descriptive user agent, and rate-limit themselves.');

console.log('');
if (problems > 0) {
  console.log(`${problems} problem(s) found. Fix the lines marked FAIL above.`);
  process.exit(1);
}
console.log('All checks passed.');

function check(label, ok, hint) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) {
    problems++;
    console.log(`        ${hint}`);
  }
}

/**
 * Playwright pins one Chromium build per release, so "a browser is cached" is not the
 * same as "the browser this Playwright wants is cached". Ask Playwright itself.
 */
function playwrightBrowsers() {
  if (!existsSync(join(ROOT, 'node_modules', 'playwright'))) {
    return { ok: false, hint: `Install dependencies first: ${NPM} run setup` };
  }
  const r = run(process.execPath, [join(ROOT, 'scripts', 'probe-browser.mjs')], { quiet: true });
  if (r.ok) return { ok: true, hint: '' };
  const detail = (r.stderr || r.stdout || '').split('\n').find((l) => l.trim()) ?? '';
  const extra = IS_LINUX
    ? ' On a bare Linux image also install system libraries: npx playwright install --with-deps chromium'
    : '';
  return { ok: false, hint: `Run: npx playwright install chromium.${extra} (${detail.slice(0, 120)})` };
}

/** Unused but kept honest: listing the cache is only a hint, never the check. */
export function cacheHint() {
  const dirs = {
    win32: join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'),
    darwin: join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright'),
    linux: join(process.env.HOME ?? '', '.cache', 'ms-playwright'),
  };
  const d = dirs[process.platform];
  if (!d || !existsSync(d)) return 'no playwright cache found';
  return readdirSync(d).join(', ');
}
