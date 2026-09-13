#!/usr/bin/env node
/**
 * Removes build output and run artifacts. Cross-platform because `rm -rf` is not.
 *
 *   node scripts/clean.mjs             build output + results
 *   node scripts/clean.mjs --deps      also every node_modules (root and fixtures)
 *   node scripts/clean.mjs --corpus    also S4's cloned repos (~330 MB)
 *
 * The corpus is not removed by default because re-cloning it costs several minutes of
 * network, and unlike build output it is not regenerated as a side effect of a run.
 */
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, FIXTURES } from './platform.mjs';

const alsoDeps = process.argv.includes('--deps');
const alsoCorpus = process.argv.includes('--corpus');

const targets = [
  'spikes/s1-debug-internals/fixtures/react/dist',
  'spikes/s1-debug-internals/fixtures/react/.gen',
  'spikes/s1-debug-internals/fixtures/vue/dist',
  'spikes/s1-debug-internals/fixtures/svelte/dist',
  'spikes/s1-debug-internals/fixtures/svelte/.gen',
  'spikes/s2-rsc-attribution/fixture-next/.next',
  'results/raw',
];

for (const t of targets) remove(t);

if (alsoDeps) {
  remove('node_modules');
  for (const fx of FIXTURES) remove(join(fx.dir, 'node_modules'));
}

if (alsoCorpus) remove('spikes/s4-literal-text/repos');

const extras = [alsoDeps ? '--deps' : null, alsoCorpus ? '--corpus' : null].filter(Boolean);
console.log(
  extras.length
    ? `clean (including ${extras.join(' ')})`
    : 'clean. Use --deps for node_modules, --corpus for S4 clones.',
);

function remove(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return;
  rmSync(p, { recursive: true, force: true });
  console.log(`  removed ${rel.replace(/\\/g, '/')}`);
}
