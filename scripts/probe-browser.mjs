/**
 * Exits 0 only if Playwright can actually launch the Chromium it expects. Doctor runs
 * this in a child process because a failed launch can leave state behind, and because
 * "the executable exists" is a weaker claim than "it starts".
 */
import { chromium } from 'playwright';
import { needsNoSandbox } from './platform.mjs';

const browser = await chromium.launch({
  args: needsNoSandbox() ? ['--no-sandbox'] : [],
});
await browser.close();
