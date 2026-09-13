#!/usr/bin/env node
/**
 * Separate installer for the S4 corpus.
 *
 * Kept out of `npm run setup` deliberately: these are shallow clones of real projects,
 * they total hundreds of megabytes, and they come from the public internet. Four of the
 * five spikes need none of it, so making every contributor pay that cost to run S1
 * would be wrong. `npm run setup` prints a pointer to this command instead.
 *
 *   node spikes/s4-literal-text/install.ts              clone everything missing
 *   node spikes/s4-literal-text/install.ts --only vue   just one
 *   node spikes/s4-literal-text/install.ts --force      re-clone from scratch
 *   node spikes/s4-literal-text/install.ts --list       show what is installed
 */
import { ensureClone, gitVersion, isCloned, loadCorpus, corpusDir } from './clone.ts';

const args = process.argv.slice(2);
const only = valueOf('--only');
const force = args.includes('--force');
const list = args.includes('--list');

const { entries } = loadCorpus();
const selected = only ? entries.filter((e) => e.id === only) : entries;

if (selected.length === 0) {
  console.error(`No corpus entry "${only}". Known: ${entries.map((e) => e.id).join(', ')}`);
  process.exit(1);
}

console.log('S4 corpus - repos whose live pages are measured for literal text');
console.log(`  target   ${corpusDir()}`);

const git = gitVersion();
console.log(`  git      ${git ?? 'NOT FOUND'}`);
if (!git) {
  console.error('\ngit is required to install the corpus.');
  console.error(
    process.platform === 'win32'
      ? '  Windows: winget install --id Git.Git  (or https://git-scm.com/download/win)'
      : process.platform === 'darwin'
        ? '  macOS:   xcode-select --install  (or brew install git)'
        : '  Linux:   sudo apt-get install git  |  sudo dnf install git',
  );
  process.exit(1);
}
console.log('');

if (list) {
  for (const e of entries) {
    console.log(`  ${isCloned(e) ? 'installed' : 'missing  '}  ${e.id.padEnd(10)} ${e.repo}`);
  }
  process.exit(0);
}

let failed = 0;
let totalBytes = 0;

for (const entry of selected) {
  process.stdout.write(`  ${entry.id.padEnd(10)}`);
  try {
    const info = await ensureClone(entry, {
      force,
      onProgress: (m) => process.stdout.write(`\n    ... ${m}\n  ${''.padEnd(10)}`),
    });
    totalBytes += info.bytes;
    console.log(`${info.fresh ? 'cloned  ' : 'present '} ${info.sha}  ${mb(info.bytes)} MB, ${info.files} files`);
  } catch (e) {
    failed++;
    console.log('FAILED');
    console.log(`    ${(e as Error).message.slice(0, 300)}`);
  }
}

console.log('');
console.log(`  total ${mb(totalBytes)} MB on disk`);
if (failed > 0) {
  console.error(`${failed} repo(s) failed to install. Re-run to retry just those.`);
  process.exit(1);
}
console.log('Corpus ready. Run: npm run spike:s4');

function mb(bytes: number): number {
  return Math.round((bytes / 1_000_000) * 10) / 10;
}

function valueOf(flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? null : null;
}
