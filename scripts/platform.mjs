import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The name to *print* in a "run this" hint. Not what we spawn - see runNpm below.
 */
export const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

/** Minimum Node that can run .ts files without a loader (native type stripping). */
export const MIN_NODE = [22, 18, 0];

export function nodeVersionTuple() {
  return process.versions.node.split('.').map((n) => parseInt(n, 10));
}

export function nodeTooOld() {
  const [maj, min] = nodeVersionTuple();
  const [rMaj, rMin] = MIN_NODE;
  if (maj > rMaj) return false;
  if (maj < rMaj) return true;
  return min < rMin;
}

/**
 * Chromium refuses to start as root without --no-sandbox, which is the default
 * situation inside most CI containers and Docker images. Detect it rather than making
 * every Linux user pass a flag, but never disable the sandbox where it would work.
 */
export function needsNoSandbox() {
  if (process.env.A11Y_SPIKE_NO_SANDBOX === '1') return true;
  if (process.env.A11Y_SPIKE_NO_SANDBOX === '0') return false;
  if (!IS_LINUX) return false;
  try {
    return typeof process.getuid === 'function' && process.getuid() === 0;
  } catch {
    return false;
  }
}

/**
 * Spawns a package's JS entry point with node instead of going through its shell shim.
 *
 * On Windows npm and npx are `npm.cmd` / `npx.cmd`, and since the fix for
 * CVE-2024-27980 Node refuses to spawn a .cmd without `shell: true` and throws a bare
 * EINVAL. Turning the shell on would fix that and reintroduce quoting bugs on paths
 * containing spaces, which is the common case here ("C:\Users\Jane Smith\..."). Running
 * the .js directly avoids both and behaves identically on macOS and Linux. This mirrors
 * resolveBin() in spikes/shared/proc.ts, which solved the same problem for `next dev`.
 */
function firstExisting(...candidates) {
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

const NODE_DIR = dirname(process.execPath);

/** npm bundled with this Node: beside node.exe on Windows, under ../lib on POSIX. */
export const NPM_CLI = firstExisting(
  join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(NODE_DIR, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
);

/** Playwright's own CLI, so `npx playwright` is never needed. */
export const PLAYWRIGHT_CLI = firstExisting(join(ROOT, 'node_modules', 'playwright', 'cli.js'));

export function runNpm(args, opts = {}) {
  if (NPM_CLI) return run(process.execPath, [NPM_CLI, ...args], opts);
  // Fallback for an npm that is not the one bundled with this Node (nvm, corepack,
  // a distro split package). The shell is a last resort, not the default.
  return run(NPM, args, { ...opts, shell: IS_WINDOWS });
}

export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: opts.shell ?? false,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout ? res.stdout.toString() : '',
    stderr: res.stderr ? res.stderr.toString() : '',
    error: res.error,
  };
}

/** Every fixture with its own package.json, relative to the repo root. */
export const FIXTURES = [
  { dir: 'spikes/s1-debug-internals/fixtures/react/v17', label: 'React 17', spike: 's1' },
  { dir: 'spikes/s1-debug-internals/fixtures/react/v18', label: 'React 18', spike: 's1' },
  { dir: 'spikes/s1-debug-internals/fixtures/react/v19', label: 'React 19', spike: 's1' },
  { dir: 'spikes/s1-debug-internals/fixtures/vue/v3', label: 'Vue 3', spike: 's1' },
  { dir: 'spikes/s1-debug-internals/fixtures/svelte/v4', label: 'Svelte 4', spike: 's1' },
  { dir: 'spikes/s1-debug-internals/fixtures/svelte/v5', label: 'Svelte 5', spike: 's1' },
  { dir: 'spikes/s2-rsc-attribution/fixture-next', label: 'Next.js App Router', spike: 's2' },
];

export function fixtureInstalled(dir) {
  return existsSync(join(ROOT, dir, 'node_modules'));
}

/**
 * S4's corpus is installed separately from the fixtures - see
 * spikes/s4-literal-text/install.ts for why. These helpers exist so setup and doctor
 * can report on it without duplicating the corpus definition.
 */
export const S4_INSTALLER = 'spikes/s4-literal-text/install.ts';
const S4_CORPUS_DIR = 'spikes/s4-literal-text/repos';

export function s4Corpus() {
  const manifest = join(ROOT, 'spikes', 's4-literal-text', 'corpus.json');
  if (!existsSync(manifest)) return [];
  const { entries } = JSON.parse(readFileSync(manifest, 'utf8'));
  return entries.map((e) => ({
    id: e.id,
    // A directory without .git is a clone that died partway through, which must not
    // count as installed - S4 would then measure a partial tree and report the missing
    // files as "this text is not in the repo".
    installed: existsSync(join(ROOT, S4_CORPUS_DIR, e.id, '.git')),
  }));
}

/** git is a real .exe on Windows, so it needs no shim and no shell. */
export function gitAvailable() {
  const r = spawnSync('git', ['--version'], { shell: false, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
