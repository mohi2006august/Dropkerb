#!/usr/bin/env node
/**
 * Runs every spike in sequence and then renders the summary report.
 *
 * Sequential on purpose: S1 and S2 start local servers and browsers, S4 and S5 reach
 * the public internet under a self-imposed rate limit. Running them in parallel would
 * make the timings in S3 meaningless and the politeness in S5 a lie.
 *
 *   node scripts/run-all.mjs                 all five
 *   node scripts/run-all.mjs s1 s5           just those
 *   node scripts/run-all.mjs --offline       skip the spikes that need the network
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, run } from './platform.mjs';

const SPIKES = [
  { id: 's1', dir: 'spikes/s1-debug-internals', network: false, label: 'framework debug internals' },
  { id: 's2', dir: 'spikes/s2-rsc-attribution', network: false, label: 'RSC attribution' },
  { id: 's3', dir: 'spikes/s3-cost', network: true, label: 'run cost' },
  { id: 's4', dir: 'spikes/s4-literal-text', network: true, label: 'literal text in repos' },
  { id: 's5', dir: 'spikes/s5-instrumentation', network: true, label: 'instrumenting real sites' },
];

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const picked = args.filter((a) => /^s[1-5]$/.test(a));

const selected = SPIKES.filter((s) => {
  if (picked.length > 0) return picked.includes(s.id);
  if (offline && s.network) return false;
  return true;
});

const results = [];
for (const spike of selected) {
  const entry = join(ROOT, spike.dir, 'run.ts');
  if (!existsSync(entry)) {
    console.log(`\n=== ${spike.id.toUpperCase()} ${spike.label} - NOT IMPLEMENTED (no run.ts) ===`);
    results.push({ id: spike.id, status: 'not-implemented' });
    continue;
  }
  console.log(`\n=== ${spike.id.toUpperCase()} ${spike.label} ===`);
  const started = Date.now();
  const r = run(process.execPath, [entry]);
  results.push({
    id: spike.id,
    status: r.ok ? 'ok' : 'failed',
    seconds: Math.round((Date.now() - started) / 1000),
  });
}

console.log('\n=== summary ===');
for (const r of results) {
  console.log(`  ${r.id}  ${r.status}${r.seconds !== undefined ? `  ${r.seconds}s` : ''}`);
}

run(process.execPath, [join(ROOT, 'scripts', 'report.mjs')]);

// A spike that fails to RUN is a broken harness and should fail the command. A spike
// that runs and returns a bad verdict is a result, not an error - that distinction is
// the whole point of the exercise.
process.exit(results.some((r) => r.status === 'failed') ? 1 : 0);
