#!/usr/bin/env node
/**
 * Renders results/*.json into one Markdown report a human can read and paste into the
 * design doc. Deliberately says "NOT RUN" for missing spikes rather than omitting them:
 * an absent row reads as a pass, which is the failure mode TDD s3.9 is built to avoid.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './platform.mjs';

const SPIKES = {
  s1: { title: 'Do framework debug internals actually resolve?', budget: '1.5 days', gates: 'Phase 3 (Locate)' },
  s2: { title: 'Can React Server Components be attributed at all?', budget: '2 days', gates: 'Phase 3, v1 scope for App Router' },
  s3: { title: 'What does a run actually cost?', budget: '1 day', gates: 'the cost model in TDD s10' },
  s4: { title: 'How much visible text is literal in the repo?', budget: '1 day', gates: 'anchor search (s5.3) as a fallback' },
  s5: { title: 'Can we instrument real sites at all?', budget: '1 day', gates: 'Phase 1, and the product framing' },
};

const lines = [];
const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

lines.push('# Spike results: a11y-agent week-one de-risking');
lines.push('');
lines.push(`Generated ${now} UTC. Source: \`results/*.json\`, regenerate with \`npm run report\`.`);
lines.push('');
lines.push('These five experiments (TDD s0.5) gate the design. Three of them can change the phasing.');
lines.push('');
lines.push('| Spike | Question | Verdict | Gates |');
lines.push('|---|---|---|---|');

const loaded = {};
for (const [id, meta] of Object.entries(SPIKES)) {
  const path = join(ROOT, 'results', `${id}.json`);
  if (!existsSync(path)) {
    lines.push(`| **${id.toUpperCase()}** | ${meta.title} | **NOT RUN** | ${meta.gates} |`);
    continue;
  }
  const r = JSON.parse(readFileSync(path, 'utf8'));
  loaded[id] = r;
  lines.push(`| **${id.toUpperCase()}** | ${meta.title} | **${r.verdict.toUpperCase()}** | ${meta.gates} |`);
}

lines.push('');

for (const [id, meta] of Object.entries(SPIKES)) {
  lines.push(`## ${id.toUpperCase()} - ${meta.title}`);
  lines.push('');
  const r = loaded[id];
  if (!r) {
    lines.push(`**NOT RUN.** Budgeted at ${meta.budget}. Until it runs, treat its answer as unknown, not as working.`);
    lines.push('');
    continue;
  }
  lines.push(`**Verdict: ${r.verdict.toUpperCase()}** — ${r.observations.length} observations, run ${r.startedAt.slice(0, 16).replace('T', ' ')} UTC on ${r.env.platform}, node ${r.env.node}.`);
  lines.push('');
  lines.push('### What we found');
  lines.push('');
  lines.push('```');
  lines.push(r.conclusion);
  lines.push('```');
  lines.push('');
  lines.push('### What this changes in the design');
  lines.push('');
  for (const line of String(r.designImpact).split('\n').filter(Boolean)) {
    lines.push(`- ${line}`);
  }
  lines.push('');

  const failures = r.observations.filter((o) => !o.ok);
  if (failures.length > 0) {
    lines.push(`<details><summary>${failures.length} failing observation(s)</summary>`);
    lines.push('');
    lines.push('| Cell | Probe | Detail |');
    lines.push('|---|---|---|');
    for (const f of failures.slice(0, 40)) {
      lines.push(`| ${f.cell} | ${f.probe} | ${String(f.detail ?? '').replace(/\|/g, '\\|').slice(0, 140)} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
}

const missing = Object.keys(SPIKES).filter((id) => !loaded[id]);
lines.push('## Status');
lines.push('');
lines.push(`Run: ${Object.keys(loaded).length}/5. ${missing.length ? `Not run: ${missing.join(', ').toUpperCase()}.` : 'All five complete.'}`);
lines.push('');
if (missing.length) {
  lines.push('An unrun spike is an open question, not a passing one. The design decisions it gates stay unmade.');
  lines.push('');
}

const out = join(ROOT, 'results', 'REPORT.md');
writeFileSync(out, lines.join('\n'));
console.log(`report written: results/REPORT.md (${Object.keys(loaded).length}/5 spikes)`);
