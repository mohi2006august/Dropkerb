import type { GroundTruth } from './manifest.ts';
import { sameFile } from './attribute.ts';

export interface Located {
  file: string;
  line: number | null;
}

export type Grade = 'exact' | 'file-only' | 'wrong-line' | 'wrong-file' | 'partial' | null;

/**
 * Every instance of a node must agree. One correct instance out of three is luck, not
 * attribution, and TDD s5.7 collapses instances to one source location - so a signal
 * that only works on the first render of a loop is not usable.
 *
 * "file-only" is a first-class outcome rather than a failure: Vue genuinely attributes
 * to a file and carries no line, and flattening that into "wrong" would hide the fact
 * that the Locator needs a second signal on Vue and does not on Svelte.
 */
export function grade(results: Array<Located | null>, want: GroundTruth): Grade {
  if (results.length === 0 || results.every((r) => r === null)) return null;
  if (results.some((r) => r === null)) return 'partial';
  const all = results as Located[];
  if (!all.every((r) => sameFile(r.file, want.file))) return 'wrong-file';
  if (all.every((r) => r.line === null)) return 'file-only';
  return all.every((r) => r.line === want.line) ? 'exact' : 'wrong-line';
}

/**
 * If every reported line is wrong by the same constant, that is a systematic indexing
 * difference, not noise - Svelte 4 reports loc.line 0-based while Svelte 5 reports it
 * 1-based, for instance. Naming that is far more useful than "wrong-line", because it
 * is both trivially correctable and exactly the kind of silent version drift that
 * would otherwise land every patch one line away from its target.
 */
export function systematicOffset(pairs: Array<{ got: number | null; want: number }>): number | null {
  const deltas = pairs.filter((p) => p.got !== null).map((p) => p.got! - p.want);
  if (deltas.length === 0) return null;
  const first = deltas[0];
  if (first === 0) return null;
  return deltas.every((d) => d === first) ? first : null;
}
