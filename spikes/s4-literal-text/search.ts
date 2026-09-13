/**
 * Builds a searchable index of a repo's text files and answers "does this string from
 * the rendered page appear in the source, and in exactly one place?"
 *
 * Uniqueness is the metric that matters, not presence. Anchor search (TDD s5.3) has to
 * produce a source *location*; a string that appears in forty files has been found and
 * has still located nothing. So every lookup reports occurrence count, not a boolean.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';

/** Extensions that can plausibly hold user-visible text. */
const TEXT_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.vue', '.svelte', '.astro',
  '.md', '.mdx', '.markdown',
  '.html', '.htm', '.njk', '.nunjucks', '.hbs', '.handlebars', '.ejs', '.erb', '.liquid', '.twig', '.pug', '.jade',
  '.json', '.json5', '.yml', '.yaml', '.toml',
  '.txt', '.rst', '.php', '.rb', '.py', '.go', '.java', '.cs', '.xml', '.csv',
]);

/** Directories that hold build output or dependencies, never authored text. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  '.astro', '.vercel', '.netlify', '.cache', 'coverage', 'vendor', 'target',
  '.turbo', '.output', 'tmp', '.venv', '__pycache__',
]);

/**
 * Lockfiles are large, machine-generated, and full of package names and descriptions
 * that collide with short UI labels. A hit in one is never the source of rendered text,
 * so indexing them can only manufacture ambiguity.
 */
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'composer.lock']);

const MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 32_000_000;
/**
 * A file whose average line is enormous is a generated bundle or a minified asset that
 * slipped past the directory filter. Including it would let a match land in build
 * output and be counted as "the text is in the repo", which is the opposite of what
 * anchor search needs - it needs the authored source.
 */
const MINIFIED_BYTES_PER_LINE = 2_000;

/** NUL cannot occur in text scraped from a rendered page, so it is a safe separator:
 *  it guarantees no match can straddle two concatenated files. */
const SEP = '\u0000';

export interface FileSpan {
  path: string;
  start: number;
  end: number;
}

export interface Layer {
  text: string;
  spans: FileSpan[];
}

export interface SourceIndex {
  root: string;
  raw: Layer;
  norm: Layer;
  fileCount: number;
  bytes: number;
  /** True when the byte cap stopped the walk, so the denominator is explicit. */
  truncated: boolean;
  skippedMinified: number;
}

export function buildIndex(root: string, opts: { maxTotalBytes?: number } = {}): SourceIndex {
  const cap = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const rawParts: string[] = [];
  const normParts: string[] = [];
  const rawSpans: FileSpan[] = [];
  const normSpans: FileSpan[] = [];
  let rawOffset = 0;
  let normOffset = 0;
  let bytes = 0;
  let fileCount = 0;
  let skippedMinified = 0;
  let truncated = false;

  const stack: string[] = [root];
  while (stack.length > 0 && !truncated) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(current, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
        continue;
      }
      // Symlinks are skipped rather than followed: checkouts made with
      // core.symlinks=false leave them as plain files holding a path, and following
      // them could escape the repo entirely.
      if (!e.isFile()) continue;
      if (SKIP_FILES.has(e.name.toLowerCase())) continue;
      if (!TEXT_EXT.has(extname(e.name).toLowerCase())) continue;

      let size: number;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      if (bytes + size > cap) {
        truncated = true;
        break;
      }

      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const lines = countLines(text);
      if (lines > 0 && text.length / lines > MINIFIED_BYTES_PER_LINE) {
        skippedMinified++;
        continue;
      }

      const rel = relative(root, full).split(sep).join('/');
      const normText = normalizeText(text);

      rawParts.push(text, SEP);
      rawSpans.push({ path: rel, start: rawOffset, end: rawOffset + text.length });
      rawOffset += text.length + SEP.length;

      normParts.push(normText, SEP);
      normSpans.push({ path: rel, start: normOffset, end: normOffset + normText.length });
      normOffset += normText.length + SEP.length;

      bytes += size;
      fileCount++;
    }
  }

  return {
    root,
    raw: { text: rawParts.join(''), spans: rawSpans },
    norm: { text: normParts.join(''), spans: normSpans },
    fileCount,
    bytes,
    truncated,
    skippedMinified,
  };
}

/**
 * Folds away the differences that are typography rather than content: a markdown
 * source writes "don't" and a rendered page shows "don’t" because the renderer applied
 * smart quotes. Counting that as "the text is not in the repo" would understate what
 * anchor search can do, so it is measured as a separate, weaker tier instead.
 */
export function normalizeText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/…/g, '...')
    // Zero-width characters are not matched by \s, so they must go before the collapse
    // below; every other kind of unicode space \s already covers.
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ');
}

export interface Located {
  /** Occurrences found, capped at `cap`; `capped` says the true count is at least this. */
  count: number;
  capped: boolean;
  /** Distinct files the occurrences fall in, in first-seen order. */
  paths: string[];
}

export function locate(layer: Layer, needle: string, cap = 5): Located {
  if (needle.length === 0) return { count: 0, capped: false, paths: [] };
  const paths: string[] = [];
  let count = 0;
  let from = 0;
  while (count < cap) {
    const at = layer.text.indexOf(needle, from);
    if (at < 0) break;
    count++;
    const path = spanAt(layer.spans, at);
    if (path && !paths.includes(path)) paths.push(path);
    from = at + 1;
  }
  return { count, capped: count >= cap, paths };
}

/** Binary search: which file does this offset fall inside? */
function spanAt(spans: FileSpan[], offset: number): string | null {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    if (offset < s.start) hi = mid - 1;
    else if (offset >= s.end) lo = mid + 1;
    else return s.path;
  }
  return null;
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Classifies where a hit landed. A string found only in an i18n catalogue or a data
 * file proves the text is in the repo but does not point at the markup that renders
 * it - which is the difference between "anchor search finds the string" and "anchor
 * search locates the node".
 */
export function classifyPath(path: string): 'markup' | 'content' | 'catalogue' | 'other' {
  const lower = path.toLowerCase();
  const ext = extname(lower);
  if (/(^|\/)(locales?|i18n|lang|translations?|messages)(\/|$)/.test(lower)) return 'catalogue';
  if (ext === '.json' || ext === '.yml' || ext === '.yaml' || ext === '.toml' || ext === '.json5') return 'catalogue';
  if (ext === '.md' || ext === '.mdx' || ext === '.markdown' || ext === '.rst' || ext === '.txt') return 'content';
  if (TEXT_EXT.has(ext)) return 'markup';
  return 'other';
}
