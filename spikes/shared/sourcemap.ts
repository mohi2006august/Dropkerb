/**
 * Minimal source-map consumer: generated (line, column) -> original (source, line, column).
 *
 * Written rather than pulled in because the real Locator needs exactly this for TDD s5.2
 * (hashed CSS class names) and, as S1 turns out to show, for React 19 attribution as
 * well - where _debugStack points into the bundle and only a map turns it back into a
 * source line. Knowing the cost of this piece is part of what the spike is for.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export interface OriginalPosition {
  source: string;
  line: number;
  column: number;
}

interface Segment {
  genCol: number;
  srcIdx: number;
  srcLine: number;
  srcCol: number;
}

export interface RawSourceMap {
  version: number;
  sources: string[];
  sourcesContent?: (string | null)[];
  mappings: string;
  names?: string[];
  sourceRoot?: string;
}

export class SourceMapConsumer {
  readonly sources: string[];
  private readonly lines: Segment[][];

  constructor(map: RawSourceMap) {
    this.sources = map.sources.map((s) => (map.sourceRoot ? `${map.sourceRoot}${s}` : s));
    this.lines = decodeMappings(map.mappings);
  }

  /** genLine is 1-based, genCol is 0-based, matching what a JS stack trace reports. */
  originalPositionFor(genLine: number, genCol: number): OriginalPosition | null {
    const segments = this.lines[genLine - 1];
    if (!segments || segments.length === 0) return null;
    // Largest segment whose generated column is at or before the query column.
    let lo = 0;
    let hi = segments.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].genCol <= genCol) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // A column before the first mapping still belongs to that mapping in practice -
    // minified output routinely starts a line mid-expression.
    const seg = segments[found >= 0 ? found : 0];
    if (seg.srcIdx < 0) return null;
    return { source: this.sources[seg.srcIdx] ?? '?', line: seg.srcLine + 1, column: seg.srcCol };
  }
}

function decodeMappings(mappings: string): Segment[][] {
  const out: Segment[][] = [];
  // These four accumulate across the whole file, not per line - except genCol, which
  // resets at every line. Getting that wrong yields plausible-looking garbage.
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;

  for (const lineStr of mappings.split(';')) {
    const segs: Segment[] = [];
    let genCol = 0;
    if (lineStr.length > 0) {
      for (const segStr of lineStr.split(',')) {
        if (segStr.length === 0) continue;
        const fields = decodeVlq(segStr);
        genCol += fields[0];
        if (fields.length >= 4) {
          srcIdx += fields[1];
          srcLine += fields[2];
          srcCol += fields[3];
          segs.push({ genCol, srcIdx, srcLine, srcCol });
        } else {
          segs.push({ genCol, srcIdx: -1, srcLine: 0, srcCol: 0 });
        }
      }
    }
    segs.sort((a, b) => a.genCol - b.genCol);
    out.push(segs);
  }
  return out;
}

function decodeVlq(str: string): number[] {
  const values: number[] = [];
  let shift = 0;
  let value = 0;
  for (const ch of str) {
    const digit = B64.indexOf(ch);
    if (digit < 0) throw new Error(`bad base64 VLQ char: ${ch}`);
    const cont = (digit & 32) !== 0;
    value += (digit & 31) << shift;
    if (cont) {
      shift += 5;
    } else {
      const negate = (value & 1) === 1;
      value >>>= 1;
      values.push(negate ? (value === 0 ? -0x80000000 : -value) : value);
      value = 0;
      shift = 0;
    }
  }
  return values;
}
