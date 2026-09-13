import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';

/** How long the port may keep answering after the spawned process exits. */
const EXIT_GRACE_MS = 5_000;

export interface DevServer {
  url: string;
  port: number;
  /** Everything the server has printed, for diagnosing a failed start. */
  output: () => string;
  /** Stops the server and frees the port, including workers it forked. */
  stop: () => Promise<void>;
}

/**
 * Launches a framework dev server and waits until it actually serves.
 *
 * Prefer passing `command: process.execPath` with the framework's own JS entry point
 * (see resolveBin) over a shim like `npx`. Since the CVE-2024-27980 fix, Node refuses
 * to spawn .cmd/.bat on Windows without `shell: true` and throws EINVAL - and turning
 * the shell on reintroduces the quoting problems that break paths containing spaces.
 * Going straight to node avoids both and behaves identically on every OS.
 *
 * Readiness means the port answers an HTTP request - see the polling loop below for why
 * a stdout banner is not a usable signal.
 *
 * Shutdown kills the whole process tree and then whatever still holds the port: `next
 * dev` forks workers, and killing only the parent leaves the port bound and every later
 * run failing for the wrong reason.
 */
export async function startDevServer(opts: {
  command: string;
  args: string[];
  cwd: string;
  /**
   * Diagnostic only. Reported in the error when a start fails, so a timeout says
   * whether the server ever announced itself. It does NOT gate readiness.
   */
  ready: RegExp;
  port: number;
  timeoutMs?: number;
  env?: Record<string, string>;
}): Promise<DevServer> {
  const child: ChildProcessWithoutNullStreams = spawn(winBin(opts.command), opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, PORT: String(opts.port), BROWSER: 'none', FORCE_COLOR: '0' },
    shell: false,
    windowsHide: true,
    // detached gives the child its own process group on POSIX, which is what makes the
    // negative-pid kill in killTree() reach the workers `next dev` forks. Without it,
    // process.kill(-pid) throws ESRCH and the port stays bound after the run.
    detached: process.platform !== 'win32',
  });

  let buffer = '';
  const collect = (chunk: Buffer) => {
    buffer += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const url = `http://127.0.0.1:${opts.port}`;
  const timeout = opts.timeoutMs ?? 120_000;

  // 'close' rather than 'exit': exit fires before the stdio pipes have flushed, so an
  // error message built at exit time routinely quoted an empty buffer and told us
  // nothing about why the server stopped.
  let exitCode: number | null = null;
  child.once('close', (code) => {
    exitCode = code ?? -1;
  });

  // A failed start must still clean up. Without this the spawned process outlives the
  // run: it keeps the port bound so the next run fails too, and its open stdio pipes
  // keep our own event loop alive, so the spike hangs forever instead of reporting the
  // timeout it already detected.
  try {
    await waitUntilServing();
  } catch (e) {
    await killTree(child, opts.port);
    throw e;
  }

  return {
    url,
    port: opts.port,
    output: () => buffer,
    stop: () => killTree(child, opts.port),
  };

  async function waitUntilServing(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + timeout;
      let settled = false;
      let graceUntil: number | null = null;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        err ? reject(err) : resolve();
      };

      const why = (headline: string) =>
        new Error(
          `${headline}\n` +
            `  banner seen: ${opts.ready.test(buffer) ? 'yes' : 'no'}\n` +
            `  output: ${buffer.trim() ? buffer.slice(-1500) : '(nothing captured)'}`,
        );

      // Readiness is "the port answers", and nothing else.
      //
      // It used to also require a banner in stdout, which broke against Next 15: `next
      // dev` is a supervisor that forks the real server as a grandchild, so the banner
      // does not reliably reach our pipe. The buffer stayed empty, the gate never opened,
      // and the spike reported "RSC is not attributable" about a server that was serving
      // correctly the whole time. Asking the port is both simpler and the thing we
      // actually care about - and it handles the case the banner was meant to cover,
      // since a dev server holds the request until the route has compiled.
      const timer = setInterval(async () => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
          if (res.status < 500) return finish();
        } catch {
          /* not up yet */
        }
        if (Date.now() > deadline) return finish(why(`dev server not ready within ${timeout}ms`));
        // The process we spawned exiting is not proof the server is gone: a supervisor
        // that has handed off to a worker exits 0 while the port stays bound. Give the
        // port a short grace window before calling it a failure.
        if (exitCode !== null) {
          if (graceUntil === null) graceUntil = Date.now() + EXIT_GRACE_MS;
          else if (Date.now() > graceUntil) {
            return finish(why(`dev server exited (code ${exitCode}) and nothing is listening on :${opts.port}`));
          }
        }
      }, 500);
    });
  }
}

/**
 * On Windows, npm-installed shims are .cmd files and must be named as such. An absolute
 * path, an executable, or anything already carrying an extension is passed through
 * untouched - blanket-suffixing turns `node.exe` into `node.exe.cmd`, which spawn
 * reports as a bare EINVAL with no hint about what it tried to run.
 */
function winBin(command: string): string {
  if (process.platform !== 'win32') return command;
  const looksLikePath = command.includes('/') || command.includes('\\');
  const hasExtension = /\.[a-z0-9]+$/i.test(command);
  if (looksLikePath || hasExtension) return command;
  return `${command}.cmd`;
}

/**
 * Resolves a package's JS entry point so it can be run with `node` instead of through a
 * platform-specific shim. `fromDir` is the project whose node_modules to resolve in, so
 * a fixture's own dependency tree is used rather than the repo root's.
 */
export async function resolveBin(fromDir: string, relativeEntry: string): Promise<string> {
  const { createRequire } = await import('node:module');
  const { join } = await import('node:path');
  const req = createRequire(join(fromDir, 'noop.js'));
  return req.resolve(relativeEntry);
}

/** Picks a port the OS says is free. Racy in principle, fine for a single local run. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'string' || addr === null) return reject(new Error('no port'));
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function killTree(child: ChildProcessWithoutNullStreams, port: number): Promise<void> {
  const alive = child.exitCode === null && child.signalCode === null;
  if (alive) {
    const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));

    if (process.platform === 'win32') {
      // SIGTERM does not propagate to grandchildren on Windows; taskkill /T does.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
    } else {
      try {
        // Negative pid signals the whole process group.
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }

    await Promise.race([done, new Promise<void>((r) => setTimeout(r, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  // Then take the port, whatever still holds it. Killing the tree is not enough on
  // Windows: when the supervisor exits first, its worker is reparented and `taskkill
  // /T` on the dead parent reaches nothing. Those orphans stay bound to the port and
  // keep .next locked, so the *next* run starts against a server it does not control
  // and fails for a reason that has nothing to do with what it is measuring.
  await killByPort(port);
}

/**
 * Kills whatever is listening on a port. Windows only: on POSIX the process-group kill
 * above already reaches every descendant, and shelling out to lsof/fuser would add a
 * dependency that is not present on every image.
 */
async function killByPort(port: number): Promise<void> {
  if (process.platform !== 'win32') return;
  const res = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', shell: false });
  if (res.status !== 0 || !res.stdout) return;

  const pids = new Set<string>();
  for (const line of res.stdout.split(/\r?\n/)) {
    // "  TCP    127.0.0.1:55457    0.0.0.0:0    LISTENING    27932"
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (m && Number(m[1]) === port && m[2] !== '0') pids.add(m[2]);
  }
  for (const pid of pids) {
    spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore', shell: false });
  }
}
