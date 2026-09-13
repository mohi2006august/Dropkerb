/**
 * Extracts and inspects the RSC flight payload that Next.js inlines into the HTML.
 *
 * App Router streams the server render as a sequence of `self.__next_f.push([1,"..."])`
 * calls. If component identity survives into that stream, it is an attribution signal
 * that needs no client fiber - which is the question TDD s5.8 leaves open for RSC.
 */

export interface FlightPayload {
  /** Concatenated payload text, or '' if none was found. */
  text: string;
  /** Number of push() chunks recovered. */
  chunks: number;
}

/**
 * Pull the flight chunks out of raw HTML. Parsing the `push([1,"…"])` argument as JSON
 * rather than regex-unescaping it matters: the payload is full of escaped quotes and
 * backslashes, and a naive unescape corrupts exactly the file paths we are looking for.
 */
export function extractFlight(html: string): FlightPayload {
  const chunks: string[] = [];
  const re = /self\.__next_f\.push\(\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      chunks.push(JSON.parse(m[1]) as string);
    } catch {
      /* a chunk we cannot parse is a chunk we do not count */
    }
  }
  return { text: chunks.join(''), chunks: chunks.length };
}

export interface FlightIdentity {
  /** Source-ish paths the payload mentions, deduped. */
  paths: string[];
  /** Whether any path names a file the fixture actually owns. */
  namesFixtureSource: boolean;
  /** Client component references (the `I[...]` / module-id rows). */
  clientRefs: number;
}

/**
 * Look for component identity in the payload. The distinction that matters: Next emits
 * module references for CLIENT components (they must be hydrated, so the browser needs
 * their chunk), but server components are already rendered to HTML and have no reason
 * to appear. Finding only client paths is therefore the expected-bad result, and it is
 * worth reporting precisely rather than as "no identity found".
 */
export function findIdentity(text: string, fixtureFiles: string[]): FlightIdentity {
  const paths = new Set<string>();
  // Webpack module ids in dev look like "(app-pages-browser)/./app/Client.jsx".
  const pathRe = /(?:\(app-pages-browser\)|\(rsc\)|\(ssr\))?\/?\.?\/?((?:app|src|components)\/[\w./@-]+\.(?:jsx?|tsx?|mjs|css))/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(text)) !== null) paths.add(m[1]);

  const clientRefs = (text.match(/"\$L?\d+"|\bI\[/g) ?? []).length;
  const list = [...paths];
  return {
    paths: list,
    namesFixtureSource: list.some((p) => fixtureFiles.some((f) => p.endsWith(f))),
    clientRefs,
  };
}

/**
 * Next's dev CSS Modules format is `<file>_<local>__<hash>`, which encodes the source
 * file and the original class name directly in the class string - no source map needed.
 * Production uses a bare hash and does need the map (TDD s5.2).
 */
export function parseCssModuleClass(cls: string): { file: string; local: string } | null {
  const m = cls.match(/^([A-Za-z0-9-]+)_([A-Za-z0-9-]+)__[A-Za-z0-9]+$/);
  if (!m) return null;
  return { file: m[1], local: m[2] };
}
