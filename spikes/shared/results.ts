import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation, SpikeId, SpikeResult, Verdict } from './types.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RESULTS_DIR = join(ROOT, 'results');
export const RAW_DIR = join(RESULTS_DIR, 'raw');

/**
 * Accumulates observations during a spike run and writes both a machine-readable
 * result file and an append-only raw log. The raw log survives a crashed run, which
 * matters because several spikes hit the network and will crash.
 */
export class Recorder {
  readonly spike: SpikeId;
  readonly title: string;
  readonly question: string;
  private readonly startedAt = new Date().toISOString();
  private readonly observations: Observation[] = [];

  constructor(spike: SpikeId, title: string, question: string) {
    this.spike = spike;
    this.title = title;
    this.question = question;
    mkdirSync(RAW_DIR, { recursive: true });
  }

  observe(o: Observation): void {
    this.observations.push(o);
    appendFileSync(
      join(RAW_DIR, `${this.spike}.jsonl`),
      JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n',
    );
    const mark = o.ok ? 'PASS' : 'FAIL';
    const metrics = o.metrics
      ? '  ' + Object.entries(o.metrics).map(([k, v]) => `${k}=${round(v)}`).join(' ')
      : '';
    console.log(`  [${mark}] ${o.cell.padEnd(28)} ${o.probe.padEnd(24)}${metrics}${o.detail ? '  -- ' + o.detail : ''}`);
  }

  /** Fraction of observations for a given probe that succeeded. */
  rate(probe?: string): number {
    const set = probe ? this.observations.filter((o) => o.probe === probe) : this.observations;
    if (set.length === 0) return 0;
    return set.filter((o) => o.ok).length / set.length;
  }

  count(probe?: string): number {
    return probe ? this.observations.filter((o) => o.probe === probe).length : this.observations.length;
  }

  finish(verdict: Verdict, conclusion: string, designImpact: string): SpikeResult {
    const result: SpikeResult = {
      spike: this.spike,
      title: this.title,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      question: this.question,
      verdict,
      conclusion,
      designImpact,
      observations: this.observations,
      env: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
      },
    };
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `${this.spike}.json`), JSON.stringify(result, null, 2));
    console.log(`\n${this.spike.toUpperCase()} verdict: ${verdict.toUpperCase()}`);
    console.log(conclusion.trim().replace(/^/gm, '  '));
    console.log(`\nwritten: results/${this.spike}.json`);
    return result;
  }
}

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function loadResult(spike: SpikeId): SpikeResult | null {
  const p = join(RESULTS_DIR, `${spike}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as SpikeResult;
}
