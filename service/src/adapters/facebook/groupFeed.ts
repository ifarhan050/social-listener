import type { Locator, Page } from 'playwright';
import type { Config } from '../../config/schema.js';
import { humanDelay } from '../../util/random.js';
import { logger } from '../../util/logger.js';
import type { CommentExpandOptions, HealthStatus, RawItem, ScanContext, SourceAdapter, Target } from '../types.js';
import type { BrowserManager } from './browser.js';
import { EXTRACT_COMMENTS, EXTRACT_POST, TAG_BUTTON, TAG_NEW_POSTS, TAG_TIME_LINKS } from './domScripts.js';
import { toCommentItem, toPostItem, type RawCommentData, type RawPostData } from './extract.js';
import { detectSession, healthCheck } from './session.js';

import { SessionError } from '../errors.js';
import { feedUrl, type FacebookTargetKind } from './urls.js';
import { Human } from './human.js';

/**
 * Read-only click allowlist (spec §14). Only these labels may ever be clicked.
 * Anything that would like, comment, share, join, follow or post is refused.
 */
export const CLICK_PATTERNS = {
  seeMore: '^see more$',
  commentCount: '^[\\d.,]+\\s*[KkMm]?\\s+comments?$',
  commentSort: '^(most relevant|top comments|newest|all comments)$',
  viewMore:
    '^(view more comments|view previous comments|see more comments|view \\d+ more comments?|view all \\d+ repl(y|ies)|view \\d+ repl(y|ies)|\\d+ repl(y|ies))$',
  overlayClose: '^(close|not now|decline optional cookies|only allow essential cookies)$',
} as const;

const FORBIDDEN = /^(like|love|care|haha|wow|sad|angry|react|comment|write a comment.*|share|send|join|join group|follow|post|reply|message)$/i;

export function isClickAllowed(label: string, pattern: string): boolean {
  const l = label.trim().replace(/\s+/g, ' ');
  return !FORBIDDEN.test(l) && new RegExp(pattern, 'i').test(l);
}

export { feedUrl } from './urls.js';

const postSel = (handle: string) => `[data-sl-id="${handle}"]`;

/**
 * One adapter for every Facebook post list: group feeds (chronological), page
 * timelines (newest first), and generic post search (Recent filter). They share
 * the same post markup; only the URL and the stop rule differ.
 */
export class FacebookFeedAdapter implements SourceAdapter {
  readonly id: string;
  readonly platform = 'facebook';
  readonly usesPageBudget = true;

  isConfigured(): boolean {
    return true; // login state is checked by healthCheck
  }

  constructor(
    readonly kind: FacebookTargetKind,
    private browser: BrowserManager,
    private getConfig: () => Config,
    /** Override for tests (fixture pages). */
    private navigate?: (page: Page, url: string) => Promise<void>,
    /** Injectable for tests. */
    readonly human: Human = new Human(() => getConfig().fetch.human),
  ) {
    this.id = `facebook_${kind}`;
  }

  /** Called by the runner between Facebook targets: a human-like break. */
  async pauseBetweenTargets(signal?: AbortSignal): Promise<void> {
    await this.human.breakBetweenTargets(signal);
  }

  /** Group/page feeds are newest-first, so the first too-old post ends the scan. Search results aren't. */
  private get strictlyChronological(): boolean {
    return this.kind !== 'search' && this.kind !== 'group_search';
  }

  healthCheck(): Promise<HealthStatus> {
    return healthCheck(this.browser);
  }

  private async page(): Promise<Page> {
    return this.browser.open(true);
  }

  /** Click the first element in `rootSel` whose label matches an allowlisted pattern. */
  private async safeClick(page: Page, rootSel: string, pattern: string, deep = false): Promise<boolean> {
    const hit = (await page.evaluate(`(${TAG_BUTTON})(${JSON.stringify({ rootSel, pattern, deep })})`)) as {
      id: string;
      label: string;
    } | null;
    if (!hit) return false;
    if (!isClickAllowed(hit.label, pattern)) {
      logger.warn({ label: hit.label }, 'refused click outside allowlist');
      return false;
    }
    const loc = page.locator(`[data-sl-btn="${hit.id}"]`);
    try {
      await loc.evaluate((el) => el.setAttribute('data-sl-clicked', '1'));
      await this.human.click(loc);
      return true;
    } catch (err) {
      logger.debug({ err: String(err), label: hit.label }, 'click failed');
      return false;
    }
  }

  /** Hover the post's unresolved timestamp link(s); returns any tooltip texts (exact dates). */
  private async resolveTimestamps(page: Page, handle: string, signal?: AbortSignal): Promise<string[]> {
    const ids = (await page.evaluate(`(${TAG_TIME_LINKS})(${JSON.stringify(handle)})`).catch(() => [])) as string[];
    const labels: string[] = [];
    for (const tid of ids) {
      try {
        await this.human.hover(page.locator(`[data-sl-time="${tid}"]`).first(), signal);
        const tip = await page
          .locator('[role="tooltip"]')
          .last()
          .innerText({ timeout: 1200 })
          .catch(() => '');
        if (tip && tip.trim().length <= 80) labels.push(tip.trim());
      } catch {
        /* element went away or isn't hoverable — fall back to the visible label */
      }
    }
    if (ids.length) await page.mouse.move(5, 5).catch(() => undefined);
    return labels;
  }

  private async dismissOverlays(page: Page): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const clicked = await this.safeClick(page, '[role="dialog"]', CLICK_PATTERNS.overlayClose, true);
      if (!clicked) break;
      await page.waitForTimeout(500);
    }
  }

  private async assertSession(page: Page): Promise<void> {
    const h = await detectSession(page);
    if (!h.ok) throw new SessionError(h);
  }

  async *scanTarget(target: Target, ctx: ScanContext): AsyncGenerator<RawItem> {
    const cfg = this.getConfig();
    if (!ctx.budget.tryConsume()) return;
    const page = await this.page();
    const url = feedUrl(target.url, this.kind);

    if (this.navigate) await this.navigate(page, url);
    else {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('[role="feed"], [role="main"]').first().waitFor({ timeout: cfg.fetch.page_timeout_ms }).catch(() => undefined);
    }
    await this.assertSession(page);
    await humanDelay(cfg.fetch.page_delay_ms, ctx.signal);
    await this.dismissOverlays(page);

    let posts = 0;
    let consecutiveSeen = 0;
    let consecutiveOld = 0;
    let scrolls = 0;
    let emptyScrolls = 0;

    while (!ctx.signal.aborted) {
      const ids = (await page.evaluate(TAG_NEW_POSTS)) as string[];
      for (const handle of ids) {
        if (ctx.signal.aborted) return;
        await this.safeClick(page, postSel(handle), CLICK_PATTERNS.seeMore);
        // Hover the timestamp: Facebook only then fills in the post's link and shows its exact date.
        const tooltips = await this.resolveTimestamps(page, handle, ctx.signal);
        const data = (await page.evaluate(`(${EXTRACT_POST})(${JSON.stringify(handle)})`)) as RawPostData | null;
        if (!data) continue;
        if (tooltips.length) data.timeLabels = [...tooltips, ...data.timeLabels];
        const item = toPostItem(data, handle, ctx.now, ctx.timezone, this.kind === 'search' || this.kind === 'group_search' ? null : target.url);
        // Take time to read what's on screen, and pause now and then.
        await this.human.read(data.body, ctx.signal);
        await this.human.afterPost(ctx.signal);

        // Pinned/featured posts never trigger the cutoff and don't count (spec §6.2).
        if (item.isPinned) {
          yield item;
          continue;
        }

        const tooOld =
          !item.postedAtApprox &&
          (item.postedAt < ctx.cutoffTime || (!!ctx.watermark && item.postedAt < ctx.watermark));
        if (tooOld) {
          if (this.strictlyChronological) return;
          // Search: skip old results; stop only after several in a row.
          if (++consecutiveOld >= cfg.search.stop_after_consecutive_old) return;
          continue;
        }
        consecutiveOld = 0;

        const seen = ctx.isSeen(item.itemKey) || (!!item.aliasKey && ctx.isSeen(item.aliasKey));
        consecutiveSeen = seen ? consecutiveSeen + 1 : 0;

        yield item;
        posts++;

        if (consecutiveSeen >= ctx.stopAfterConsecutiveSeen) return;
        if (posts >= ctx.maxPosts) return;
      }

      if (scrolls >= ctx.maxScrolls) return;
      emptyScrolls = ids.length ? 0 : emptyScrolls + 1;
      if (emptyScrolls >= 2) return; // end of feed
      await this.human.scroll(page, ctx.signal);
      scrolls++;
      await humanDelay(cfg.fetch.scroll_delay_ms, ctx.signal);
      // Re-check after every scroll: login walls, checkpoints and soft blocks ("going too fast").
      await this.assertSession(page);
    }
  }

  async *expandComments(post: RawItem, ctx: ScanContext, opts: CommentExpandOptions): AsyncGenerator<RawItem> {
    const cfg = this.getConfig();
    const page = await this.page();
    const handle = String(post.elementHandle);
    let scopeSel = postSel(handle);
    let openedDialog = false;

    try {
      const before = await page.locator('[role="dialog"]').count();
      if (await this.safeClick(page, scopeSel, CLICK_PATTERNS.commentCount)) {
        await humanDelay(cfg.fetch.scroll_delay_ms, ctx.signal);
        // Newer layouts open the post in a dialog; older ones expand inline.
        const tagged = (await page.evaluate(`(() => {
          const ds = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => d.querySelector('[role="article"]'));
          const d = ds[ds.length - 1];
          if (!d) return false;
          d.setAttribute('data-sl-dialog', '1');
          return true;
        })()`)) as boolean;
        if (tagged && (await page.locator('[role="dialog"]').count()) > before) {
          scopeSel = '[data-sl-dialog="1"]';
          openedDialog = true;
        }
      }

      // Switch to "All comments" when the sort control is present (spec §6.5).
      if (await this.safeClick(page, scopeSel, CLICK_PATTERNS.commentSort)) {
        const item = page.getByRole('menuitem', { name: /^All comments/i }).first();
        if (await item.isVisible({ timeout: 3000 }).catch(() => false)) {
          await item.click().catch(() => undefined);
          await humanDelay(cfg.fetch.scroll_delay_ms, ctx.signal);
        } else {
          await page.keyboard.press('Escape');
        }
      }

      for (let i = 0; i < opts.maxExpansions; i++) {
        if (!(await this.safeClick(page, scopeSel, CLICK_PATTERNS.viewMore, true))) break;
        await humanDelay(cfg.fetch.scroll_delay_ms, ctx.signal);
      }
      for (let i = 0; i < 10; i++) {
        if (!(await this.safeClick(page, scopeSel, CLICK_PATTERNS.seeMore, true))) break;
        await page.waitForTimeout(300);
      }

      const comments = (await page.evaluate(`(${EXTRACT_COMMENTS})(${JSON.stringify(scopeSel)})`)) as RawCommentData[];
      await this.human.read(comments.map((c) => c.body).join(' '), ctx.signal);
      for (const c of comments) {
        if (ctx.signal.aborted) return;
        if (!c.body) continue;
        yield toCommentItem(c, post, `[data-sl-cid="${c.cid}"]`, ctx.now, ctx.timezone);
      }
    } finally {
      if (openedDialog) {
        await page.keyboard.press('Escape').catch(() => undefined);
        await page
          .locator('[data-sl-dialog="1"]')
          .waitFor({ state: 'detached', timeout: 5000 })
          .catch(() => undefined);
        await page.evaluate(`document.querySelectorAll('[data-sl-dialog]').forEach((d) => d.removeAttribute('data-sl-dialog'))`);
      }
    }
  }

  async captureScreenshot(item: RawItem): Promise<Buffer> {
    const page = await this.page();
    const sel = item.type === 'post' ? postSel(String(item.elementHandle)) : String(item.elementHandle);
    const loc: Locator = page.locator(sel).first();
    await loc.scrollIntoViewIfNeeded();
    // Wait for images inside the element to finish loading (bounded).
    await loc
      .evaluate(
        (el) =>
          Promise.race([
            Promise.all(
              Array.from(el.querySelectorAll('img'))
                .filter((img) => !img.complete)
                .map((img) => new Promise((r) => ((img.onload = r), (img.onerror = r)))),
            ),
            new Promise((r) => setTimeout(r, 5000)),
          ]),
      )
      .catch(() => undefined);
    return loc.screenshot({ type: 'png', animations: 'disabled' });
  }
}
