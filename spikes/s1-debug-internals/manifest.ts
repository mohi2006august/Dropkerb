import { readFileSync } from 'node:fs';

export interface GroundTruth {
  /** The data-spike-id value, e.g. "n07". */
  id: string;
  /** Path as the framework is expected to report it, normalised to forward slashes. */
  file: string;
  /** 1-based line of the element's opening tag. */
  line: number;
  /** The source line itself, so a mismatch report can show what was expected. */
  text: string;
}

/**
 * Ground truth is derived from the fixture source rather than hand-maintained, so a
 * fixture edit can never silently desynchronise from the expectations it is checked
 * against. The fixture convention - one tagged element per line, opening tag and
 * data-spike-id on the same line - is what makes this a one-liner instead of a parser.
 */
export function groundTruth(absPath: string, reportedAs: string): GroundTruth[] {
  const lines = readFileSync(absPath, 'utf8').split(/\r?\n/);
  const out: GroundTruth[] = [];
  const seen = new Map<string, number>();
  lines.forEach((text, i) => {
    // Skip the convention comment at the top of each fixture.
    const trimmed = text.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) return;
    const all = [...text.matchAll(/data-spike-id=["']([^"']+)["']/g)];
    if (all.length === 0) return;
    // Two tagged elements on one line would silently drop the second from ground
    // truth and show up later as a resolver miss. Fail loudly instead: a fixture bug
    // that reads as a product finding is the worst kind of bug in an experiment.
    if (all.length > 1) {
      throw new Error(
        `${reportedAs}:${i + 1} has ${all.length} data-spike-id attributes on one line ` +
          `(${all.map((m) => m[1]).join(', ')}). The fixture convention is one per line.`,
      );
    }
    const id = all[0][1];
    const prior = seen.get(id);
    if (prior !== undefined) {
      throw new Error(`${reportedAs}: duplicate data-spike-id "${id}" on lines ${prior} and ${i + 1}.`);
    }
    seen.set(id, i + 1);
    out.push({ id, file: reportedAs.replace(/\\/g, '/'), line: i + 1, text: text.trim() });
  });
  return out;
}
