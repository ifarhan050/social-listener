import fs from 'node:fs';
import path from 'node:path';
import type { ConfigStore } from '../config/store.js';
import type { Repos } from '../db/index.js';
import type { Target } from '../db/targets.js';
import type { BrowserManager } from '../adapters/facebook/browser.js';
import { DETECT_SESSION, TAG_NEW_POSTS } from '../adapters/facebook/domScripts.js';
import { feedUrl, type FacebookTargetKind } from '../adapters/facebook/urls.js';
import type { Runner } from '../scheduler/runner.js';

/**
 * Sanitized structure of the first posts on a Facebook page: tags, roles, aria attributes,
 * link *shapes* and text *lengths* — never names, text or ids. Used to fix selectors when
 * Facebook changes its markup. Runs inside the page; plain JS string (no bundler helpers).
 */
export const SNAPSHOT_SCRIPT = /* js */ `((maxPosts) => {
  const UI_WORDS = /^(like|comment|share|send|see more|most relevant|all comments|newest|reply|follow|join|reactions?|comments?|shares?|edited|public|members?|admin|moderator|top contributor|author|pinned|featured)$/i;
  const TIMEISH = /^(\\d+\\s*[a-z]{1,4}|just now|yesterday|today)$/i;
  const shapeHref = (h) => {
    if (!h) return '';
    try {
      const u = new URL(h, location.href);
      const p = u.pathname.split('/').map((seg) => (/^\\d+$/.test(seg) ? '{num}' : seg.length > 14 || /pfbid/.test(seg) ? '{id}' : /^[A-Za-z0-9._-]+$/.test(seg) && !['groups','posts','permalink','photo','user','videos','search','story.php','permalink.php','profile.php','watch','reel'].includes(seg) ? '{name}' : seg)).join('/');
      const q = [...u.searchParams.keys()].join(',');
      return (u.host === location.host ? '' : u.host) + p + (q ? '?' + q : '');
    } catch { return '[bad href]'; }
  };
  const label = (v) => {
    if (!v) return undefined;
    const t = v.trim();
    if (UI_WORDS.test(t) || TIMEISH.test(t)) return t;
    if (/^(comment|reply) by /i.test(t)) return t.replace(/ by .+$/i, ' by [name]');
    if (/^all reactions/i.test(t)) return 'All reactions: [n]';
    return '[label ' + t.length + ' chars]';
  };
  let budget = 600;
  const walk = (el, depth) => {
    if (budget-- <= 0 || depth > 16) return { truncated: true };
    const node = { tag: el.tagName.toLowerCase() };
    const role = el.getAttribute('role'); if (role) node.role = role;
    for (const a of ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'aria-posinset', 'dir', 'tabindex']) {
      const v = el.getAttribute(a);
      if (v == null) continue;
      node[a] = a === 'aria-label' ? label(v) : a.startsWith('aria-labelled') || a.startsWith('aria-described') ? '[id]' : v;
    }
    const data = [...el.attributes].map((x) => x.name).filter((n) => n.startsWith('data-') && !n.startsWith('data-sl-'));
    if (data.length) node.data = data;
    if (el.tagName === 'A') node.href = shapeHref(el.getAttribute('href'));
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (own) node.text = UI_WORDS.test(own) || TIMEISH.test(own) ? own : '[text ' + own.length + ']';
    const kids = [...el.children];
    if (kids.length) node.children = kids.map((k) => walk(k, depth + 1));
    return node;
  };
  const posts = [...document.querySelectorAll('[data-sl-id]')].slice(0, maxPosts);
  const tooltip = document.querySelector('[role="tooltip"]');
  return {
    url_shape: shapeHref(location.href),
    feed_found: !!document.querySelector('[role="feed"]'),
    posts_found: document.querySelectorAll('[data-sl-id]').length,
    tooltip_present: !!tooltip,
    posts: posts.map((p) => walk(p, 0)),
  };
})`;

export interface SnapshotDeps {
  repos: Repos;
  config: ConfigStore;
  runner: Runner;
  browser: BrowserManager;
  dataDir: string;
}

/** Load one Facebook target headless (1 page load, same gates as a scan) and save a sanitized outline. */
export async function facebookSnapshot(deps: SnapshotDeps, opts: { target_id?: number; posts?: number }): Promise<{ file: string; summary: Record<string, unknown> }> {
  const { repos, config, runner, browser } = deps;
  const cfg = config.get();
  const blocked = runner.platformBlockedReason('facebook', cfg, new Date());
  if (blocked) throw new Error(`facebook: ${blocked}`);
  const target: Target | undefined = opts.target_id
    ? repos.targets.get(opts.target_id)
    : repos.targets.list().find((t) => t.platform === 'facebook' && t.kind !== 'search' && t.status === 'active') ??
      repos.targets.list().find((t) => t.platform === 'facebook' && t.status === 'active');
  if (!target || target.platform !== 'facebook') throw new Error('no Facebook target to snapshot (give target_id)');

  return runner.exclusive('report', async () => {
    const runId = repos.runs.start('report', new Date());
    try {
      const page = await browser.open(true);
      await page.goto(feedUrl(target.url, target.kind as FacebookTargetKind), { waitUntil: 'domcontentloaded' });
      await page.locator('[role="feed"], [role="main"]').first().waitFor({ timeout: cfg.fetch.page_timeout_ms }).catch(() => undefined);
      await page.waitForTimeout(3000);
      const session = await page.evaluate(DETECT_SESSION);
      if (session !== 'ok') throw new Error(`facebook session: ${session}`);
      await page.evaluate(TAG_NEW_POSTS);
      // Hover the first post's header links so the snapshot shows what appears on hover.
      const first = page.locator('[data-sl-id]').first();
      for (const a of await first.locator('a').all().then((x) => x.slice(0, 6))) {
        await a.hover({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(500);
      }
      const outline = await page.evaluate(`(${SNAPSHOT_SCRIPT})(${JSON.stringify(opts.posts ?? 2)})`);
      const dir = path.join(deps.dataDir, 'debug');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `fb-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify({ target_kind: target.kind, ...(outline as object) }, null, 2));
      const o = outline as { posts_found: number; feed_found: boolean; tooltip_present: boolean };
      return { file, summary: { target: target.name ?? target.url, kind: target.kind, posts_found: o.posts_found, feed_found: o.feed_found, tooltip_present: o.tooltip_present } };
    } finally {
      repos.runs.finish(runId, new Date(), { page_loads: 1, posts_scanned: 0, new_captures: 0, duplicates_skipped: 0, errors: 0, notes: '{"debug":"facebook snapshot"}' });
      await browser.close().catch(() => undefined);
    }
  });
}
