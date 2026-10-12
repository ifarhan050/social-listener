import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { Config } from '../../config/schema.js';
import { BROWSER_PROFILE_DIR } from '../../util/paths.js';
import { logger } from '../../util/logger.js';

export type Channel = Config['browser']['channel'];

/** Known install locations of system browsers, per platform. */
function candidatePaths(channel: Exclude<Channel, 'chromium'>): string[] {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean) as string[];
    const rel =
      channel === 'chrome'
        ? path.join('Google', 'Chrome', 'Application', 'chrome.exe')
        : path.join('Microsoft', 'Edge', 'Application', 'msedge.exe');
    return roots.map((r) => path.join(r, rel));
  }
  if (process.platform === 'darwin') {
    return channel === 'chrome'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
      : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  return channel === 'chrome'
    ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
    : ['/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge'];
}

export function findBrowserExecutable(channel: Channel): string | null {
  if (channel === 'chromium') return null;
  return candidatePaths(channel).find((p) => fs.existsSync(p)) ?? null;
}

/** Channel actually usable on this machine (falls back to bundled Chromium if the browser isn't installed). */
export function resolveChannel(wanted: Channel): Channel {
  if (wanted === 'chromium' || findBrowserExecutable(wanted)) return wanted;
  logger.warn({ wanted }, 'browser not installed — falling back to bundled Chromium');
  return 'chromium';
}

/**
 * Profile directory per channel. Chrome/Edge profiles aren't interchangeable with
 * Playwright's Chromium (different versions, cookie storage), so each gets its own.
 */
export function profileDirFor(channel: Channel, base = BROWSER_PROFILE_DIR): string {
  return channel === 'chromium' ? base : `${base}-${channel}`;
}

/**
 * Owns the single persistent Playwright context on the dedicated profile.
 * No stealth plugins, proxies, or fingerprint changes (spec §14). One tab only.
 */
export class BrowserManager {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private headless = true;

  constructor(
    private getConfig: () => Config,
    private profileBase = BROWSER_PROFILE_DIR,
  ) {}

  get channel(): Channel {
    return resolveChannel(this.getConfig().browser.channel);
  }

  get profileDir(): string {
    return profileDirFor(this.channel, this.profileBase);
  }

  async open(headless: boolean): Promise<Page> {
    if (this.ctx && this.headless !== headless) await this.close();
    if (!this.ctx) {
      const cfg = this.getConfig();
      const channel = this.channel;
      fs.mkdirSync(this.profileDir, { recursive: true });
      this.headless = headless;
      this.ctx = await chromium.launchPersistentContext(this.profileDir, {
        ...(channel === 'chromium' ? {} : { channel }),
        headless,
        viewport: { width: cfg.capture.viewport_width, height: 1000 },
        deviceScaleFactor: cfg.capture.device_scale_factor,
        locale: 'en-US',
        timezoneId: cfg.timezone,
      });
      this.ctx.setDefaultTimeout(cfg.fetch.page_timeout_ms);
      this.ctx.on('close', () => {
        this.ctx = null;
        this.page = null;
      });
      logger.info({ headless, channel }, 'browser context opened');
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    }
    return this.page;
  }

  get context(): BrowserContext | null {
    return this.ctx;
  }

  async close(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = null;
    this.page = null;
    if (ctx) await ctx.close().catch(() => undefined);
  }
}
