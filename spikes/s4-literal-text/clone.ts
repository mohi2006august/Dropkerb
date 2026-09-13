/**
 * Corpus acquisition for S4: shallow clones of the repos whose live pages we measure.
 *
 * This is a *separate installation step* on purpose. The clones are hundreds of
 * megabytes and come from the public internet, so folding them into `npm run setup`
 * would make the ordinary setup slow and network-bound for the four spikes that do not
 * need them. `node scripts/setup.mjs --spike s4` (or `npm run setup:s4`) installs them;
 * the runner will also clone on demand so the spike works standalone.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CorpusPage {
  url: string;
  kind: string;
}

export interface CorpusEntry {
  id: string;
  repo: string;
  textStrategy: string;
  pages: CorpusPage[];
}

export interface CloneInfo {
  id: string;
  dir: string;
  /** Commit actually checked out, recorded so a later run can be compared honestly. */
  sha: string;
  bytes: number;
  files: number;
  /** True when this run did the cloning, false when an existing checkout was reused. */
  fresh: boolean;
}

/** Where clones live. Gitignored - this is build output, not source. */
export function corpusDir(): string {
  return join(HERE, 'repos');
}

export function loadCorpus(): { entries: CorpusEntry[] } {
  return JSON.parse(readFileSync(join(HERE, 'corpus.json'), 'utf8')) as { entries: CorpusEntry[] };
}

/**
 * git is a real executable on every platform we target (git.exe on Windows), so unlike
 * npm it needs no .cmd shim and no shell - which keeps paths containing spaces safe.
 */
export function gitVersion(): string | null {
  const r = spawnSync('git', ['--version'], { shell: false, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim();
}

/**
 * Config forced on every clone, for identical bytes on Windows, macOS and Linux.
 *
 * `core.autocrlf=false` + `core.eol=lf` are not tidiness: the default Git for Windows
 * install sets autocrlf=true, which rewrites every LF to CRLF on checkout. The strings
 * we search for come from a browser and contain LF. Without this, multi-line and
 * whitespace-normalised matches would fail on Windows and succeed on macOS/Linux, and
 * S4 would report a lower "literal text" rate purely because of the operating system.
 *
 * `core.longpaths=true` is the other one: several of these repos have paths past the
 * 260-character Windows MAX_PATH, and a default Git for Windows fails the checkout with
 * "Filename too long" partway through - leaving a half-populated tree that would read
 * as "the repo does not contain this text".
 *
 * `core.symlinks=false` keeps checkouts working for non-elevated Windows accounts,
 * where creating a symlink needs Developer Mode or admin rights.
 */
const PORTABLE_GIT_CONFIG = [
  '-c', 'core.autocrlf=false',
  '-c', 'core.eol=lf',
  '-c', 'core.longpaths=true',
  '-c', 'core.symlinks=false',
  // Never let a credential prompt block a headless run; a private repo should fail fast.
  '-c', 'credential.helper=',
];

export interface EnsureOptions {
  force?: boolean;
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}

export async function ensureClone(entry: CorpusEntry, opts: EnsureOptions = {}): Promise<CloneInfo> {
  const root = corpusDir();
  mkdirSync(root, { recursive: true });
  const dir = join(root, entry.id);

  let fresh = false;
  if (opts.force && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }

  if (!existsSync(join(dir, '.git'))) {
    // A directory that exists without .git is a previous clone that died partway
    // through. Reusing it would measure a truncated tree, so start over.
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    cloneWithRetry(entry, dir, opts);
    fresh = true;
  }

  // Verify every time, not only after a fresh clone. "Clone succeeded, but checkout
  // failed" leaves a valid .git next to an empty or partial working tree, and on
  // Windows that happens for reasons outside git - a file locked by an indexer,
  // antivirus, or OneDrive mid-sync. An unverified partial tree is the worst outcome
  // this spike can produce: every string would read as absent and the run would report
  // "the text is not in the repo" about a checkout that simply never finished.
  repairCheckout(entry, dir);

  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, shell: false, encoding: 'utf8' });
  const size = measure(dir);
  return {
    id: entry.id,
    dir,
    sha: sha.status === 0 ? sha.stdout.trim().slice(0, 12) : 'unknown',
    bytes: size.bytes,
    files: size.files,
    fresh,
  };
}

export function isCloned(entry: CorpusEntry): boolean {
  return existsSync(join(corpusDir(), entry.id, '.git'));
}

/**
 * Clone, retrying the whole thing on failure. The retry is not superstition: the first
 * attempt against eslint.org on this machine failed with "Clone succeeded, but checkout
 * failed" and the identical command succeeded immediately afterwards, which is the
 * signature of another process holding a file during checkout rather than of anything
 * wrong with the repo or the network.
 */
function cloneWithRetry(entry: CorpusEntry, dir: string, opts: EnsureOptions): void {
  const attempts = 3;
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    opts.onProgress?.(`cloning ${entry.repo}${attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ''}`);
    const r = spawnSync(
      'git',
      [...PORTABLE_GIT_CONFIG, 'clone', '--depth', '1', '--single-branch', '--no-tags', entry.repo, dir],
      {
        shell: false,
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? 600_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      },
    );
    if (r.status === 0) return;
    lastError = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ') || `exit ${r.status}`;
    // A failed clone leaves a partial tree that the next attempt would refuse to
    // clone into, so clear it before retrying.
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  throw new Error(`clone failed for ${entry.id} after ${attempts} attempts: ${lastError}`);
}

/**
 * Makes the working tree match HEAD, and proves it did. `reset --hard` re-runs the
 * checkout, which repairs the partial-checkout case in place instead of paying for
 * another full clone.
 */
function repairCheckout(entry: CorpusEntry, dir: string): void {
  if (trackedFileCount(dir) > 0 && !hasMissingFiles(dir)) return;
  const r = spawnSync('git', [...PORTABLE_GIT_CONFIG, 'reset', '--hard', 'HEAD'], {
    cwd: dir,
    shell: false,
    encoding: 'utf8',
    timeout: 300_000,
  });
  const tracked = trackedFileCount(dir);
  if (r.status !== 0 || tracked === 0) {
    throw new Error(
      `checkout for ${entry.id} is incomplete and could not be repaired ` +
        `(${tracked} tracked files). Delete ${dir} and re-run.`,
    );
  }
}

function trackedFileCount(dir: string): number {
  const r = spawnSync('git', ['ls-files'], { cwd: dir, shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return 0;
  return r.stdout.split('\n').filter(Boolean).length;
}

/** Any tracked file absent from the working tree means the checkout did not finish. */
function hasMissingFiles(dir: string): boolean {
  const r = spawnSync('git', ['ls-files', '--deleted'], {
    cwd: dir,
    shell: false,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return false;
  return (r.stdout ?? '').trim().length > 0;
}

/** Working-tree size excluding .git, so the disk cost reported is what a user pays. */
function measure(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = join(current, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        try {
          bytes += statSync(full).size;
          files++;
        } catch {
          /* a file that vanished mid-walk is not worth failing the run over */
        }
      }
    }
  }
  return { bytes, files };
}
