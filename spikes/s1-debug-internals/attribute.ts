import { SourceMapConsumer } from '../shared/sourcemap.ts';

export interface Attribution {
  file: string;
  line: number;
  column?: number;
}

/**
 * Turn a captured JSX-call-site stack into a source attribution.
 *
 * React 19 replaced _debugSource with _debugStack, an Error captured where jsx() was
 * called. Its frames point into the BUNDLE, so this is only attribution after a
 * source-map lookup - which quietly moves React 19 from TDD s5.1 (read a field) to
 * s5.2 (consume a map), with the build-output dependency that implies.
 *
 * We take the first frame that maps into a file the caller recognises as app source,
 * skipping React's own internals, which always sit on top of the stack.
 */
export function attributeFromStack(
  stack: string,
  map: SourceMapConsumer,
  isAppSource: (source: string) => boolean,
): Attribution | null {
  for (const frame of stack.split('\n').slice(1)) {
    const at = parseFrame(frame);
    if (!at) continue;
    // Stack columns are 1-based; source maps are 0-based.
    const pos = map.originalPositionFor(at.line, at.column - 1);
    if (!pos || !isAppSource(pos.source)) continue;
    return { file: pos.source, line: pos.line, column: pos.column };
  }
  return null;
}

/** Matches both "at fn (url:line:col)" and the bare "at url:line:col" form. */
export function parseFrame(frame: string): { line: number; column: number } | null {
  const paren = frame.match(/\((?:[a-z]+:\/\/[^/]+)?([^()]*?):(\d+):(\d+)\)\s*$/i);
  if (paren) return { line: Number(paren[2]), column: Number(paren[3]) };
  const bare = frame.match(/\s+at\s+(?:[a-z]+:\/\/[^/]+)?([^\s()]*?):(\d+):(\d+)\s*$/i);
  if (bare) return { line: Number(bare[2]), column: Number(bare[3]) };
  return null;
}

/** Ground truth stores "src/App.jsx"; maps report "src/App.jsx" or "../../src/App.jsx". */
export function sameFile(reported: string, expected: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/^.*?([^/]+\/[^/]+)$/, '$1');
  return norm(reported).endsWith(norm(expected)) || norm(expected).endsWith(norm(reported));
}
