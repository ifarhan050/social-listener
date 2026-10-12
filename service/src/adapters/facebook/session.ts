import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { HealthStatus } from '../types.js';
import { findBrowserExecutable, type BrowserManager } from './browser.js';
import { DETECT_SESSION } from './domScripts.js';
import { logger } from '../../util/logger.js';

export const FB_HOME = 'https://www.facebook.com/';

export async function detectSession(page: Page): Promise<HealthStatus> {
  try {
    const status = (await page.evaluate(DETECT_SESSION)) as HealthStatus['status'];
    return { ok: status === 'ok', status };
  } catch (err) {
    return { ok: false, status: 'error', detail: String(err) };
  }
}

/**
 * Manual login flow (spec §6.1). The user logs in themselves (incl. 2FA); we never
 * type credentials.
 *
 * For Chrome/Edge the installed browser is launched as a plain process on the
 * dedicated profile — no Playwright, no remote-debugging port — exactly as if the
 * user opened it. When they close the window, a headless check confirms the session.
 */
export async function connectInteractive(
  browser: BrowserManager,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<HealthStatus> {
  const exe = findBrowserExecutable(browser.channel);
  if (exe) return connectWithSystemBrowser(browser, exe, opts.timeoutMs ?? 20 * 60_000);
  return connectWithPlaywright(browser, opts);
}

async function connectWithSystemBrowser(browser: BrowserManager, exe: string, timeoutMs: number): Promise<HealthStatus> {
  await browser.close(); // the profile can only be open in one process
  fs.mkdirSync(browser.profileDir, { recursive: true });
  logger.info(
    { browser: path.basename(exe), profile: browser.profileDir },
    'Log in to Facebook in the opened browser window, then CLOSE that window to finish.',
  );
  const child = spawn(
    exe,
    [`--user-data-dir=${browser.profileDir}`, '--no-first-run', '--no-default-browser-check', '--new-window', FB_HOME],
    { stdio: 'ignore', windowsHide: false },
  );
  const exited = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => (clearTimeout(t), resolve(true)));
    child.once('error', (err) => {
      clearTimeout(t);
      logger.error({ err: String(err) }, 'failed to launch browser');
      resolve(true);
    });
  });
  if (!exited) {
    child.kill();
    return { ok: false, status: 'error', detail: 'login window was not closed within the time limit' };
  }
  // Let the browser flush cookies to disk before Playwright opens the same profile.
  await new Promise((r) => setTimeout(r, 2000));
  const health = await healthCheck(browser);
  await browser.close();
  return health;
}

async function connectWithPlaywright(
  browser: BrowserManager,
  opts: { timeoutMs?: number; pollMs?: number },
): Promise<HealthStatus> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const pollMs = opts.pollMs ?? 3000;
  const page = await browser.open(false);
  await page.goto(FB_HOME, { waitUntil: 'domcontentloaded' });
  logger.info('Log in to Facebook in the opened window. It will close automatically once you are logged in.');

  const deadline = Date.now() + timeoutMs;
  let last: HealthStatus = { ok: false, status: 'login_required' };
  try {
    while (Date.now() < deadline) {
      if (page.isClosed() || !browser.context) break;
      last = await detectSession(page);
      if (last.ok && (await page.locator('[role="navigation"], [role="banner"]').count()) > 0) {
        // Give Facebook a moment to persist cookies to the profile.
        await page.waitForTimeout(2000);
        break;
      }
      await page.waitForTimeout(pollMs);
    }
  } catch (err) {
    last = { ok: false, status: 'error', detail: String(err) };
  } finally {
    await browser.close();
  }
  return last;
}

/** Headless health check before each run. Consumes one page load. */
export async function healthCheck(browser: BrowserManager): Promise<HealthStatus> {
  try {
    const page = await browser.open(true);
    await page.goto(FB_HOME, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    return await detectSession(page);
  } catch (err) {
    return { ok: false, status: 'error', detail: String(err) };
  }
}
