import { chromium, type Browser, type Page, type CDPSession } from 'playwright';

export interface Session {
  browser: Browser;
  page: Page;
  cdp: CDPSession;
  close: () => Promise<void>;
}

/**
 * Chromium will not start as root without --no-sandbox, which is the normal situation
 * inside CI containers and Docker images. Detect that case rather than asking every
 * Linux user for a flag - but never drop the sandbox where it would have worked.
 * A11Y_SPIKE_NO_SANDBOX=1/0 overrides in either direction.
 */
export function launchArgs(): string[] {
  const env = process.env.A11Y_SPIKE_NO_SANDBOX;
  if (env === '1') return ['--no-sandbox'];
  if (env === '0') return [];
  const isRootLinux =
    process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
  return isRootLinux ? ['--no-sandbox'] : [];
}

/**
 * A page plus a raw CDP session. The design (TDD s1) depends on CDP for
 * Accessibility.getFullAXTree, DOMDebugger.getEventListeners and
 * DOM.getNodeForLocation, none of which Playwright exposes, so every spike that
 * touches a browser opens the CDP session up front rather than bolting it on.
 */
export async function openSession(opts: { headless?: boolean } = {}): Promise<Session> {
  const browser = await chromium.launch({ headless: opts.headless ?? true, args: launchArgs() });
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  return {
    browser,
    page,
    cdp,
    close: async () => {
      await cdp.detach().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

/** Quiescence detection from TDD s2.4: network idle, then a DOM-mutation-free window. */
export async function waitForQuiescence(page: Page, opts: { mutationQuietMs?: number; capMs?: number } = {}): Promise<boolean> {
  const quiet = opts.mutationQuietMs ?? 300;
  const cap = opts.capMs ?? 10_000;
  const deadline = Date.now() + cap;
  await page.waitForLoadState('networkidle', { timeout: cap }).catch(() => {});
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining === 0) return false;
  return page
    .evaluate(
      ({ quiet, remaining }) =>
        new Promise<boolean>((resolve) => {
          let timer: number = window.setTimeout(() => done(true), quiet);
          const obs = new MutationObserver(() => {
            clearTimeout(timer);
            timer = window.setTimeout(() => done(true), quiet);
          });
          obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          const capTimer = window.setTimeout(() => done(false), remaining);
          function done(settled: boolean) {
            clearTimeout(timer);
            clearTimeout(capTimer);
            obs.disconnect();
            resolve(settled);
          }
        }),
      { quiet, remaining },
    )
    .catch(() => false);
}
