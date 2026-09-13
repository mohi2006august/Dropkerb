// Shared result shapes for the S1-S5 spikes (TDD s0.5).
// Every spike writes the same envelope so results/ can be rendered by one reporter.

export type SpikeId = 's1' | 's2' | 's3' | 's4' | 's5';

export type Verdict = 'pass' | 'partial' | 'fail' | 'skipped';

/** One measurement. Spikes emit many of these; the reporter aggregates. */
export interface Observation {
  /** Cell of the spike's matrix, e.g. "react-19/dev" or "https://example.com". */
  cell: string;
  /** What was being probed, e.g. "_debugSource" or "cdp-injection". */
  probe: string;
  ok: boolean;
  /** Free-form detail the reporter prints when ok === false. */
  detail?: string;
  /** Numeric payload for aggregation (accuracy, ms, tokens, ratio...). */
  metrics?: Record<string, number>;
}

export interface SpikeResult {
  spike: SpikeId;
  title: string;
  /** ISO timestamp of the run. */
  startedAt: string;
  finishedAt: string;
  /** The question s0.5 poses, restated so a reader needs no other doc. */
  question: string;
  /** The answer, written by the spike itself from its own observations. */
  verdict: Verdict;
  /** One paragraph a human can act on, including the "if it fails" branch. */
  conclusion: string;
  /** What this changes in the design if the verdict is bad. */
  designImpact: string;
  observations: Observation[];
  /** Environment captured so a later re-run can be compared honestly. */
  env: Record<string, string>;
}
