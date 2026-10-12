/**
 * Scripts evaluated inside the Facebook page. Kept as plain JS strings (not TS
 * functions) so bundler helpers never leak into `page.evaluate`.
 *
 * Extraction uses ARIA roles, `dir="auto"` text blocks, and link patterns only —
 * never Facebook's obfuscated class names (spec §6.5). Elements we process are
 * tagged with `data-sl-*` attributes so Playwright can address them later.
 */

const SHARED = /* js */ `
  const POST_LINK_RE = /\\/(posts|permalink|videos)\\/|story_fbid=|\\/photo\\/?\\?fbid=|\\/watch\\/?\\?v=/;
  const COMMENT_LINK_RE = /[?&](reply_)?comment_id=/;
  const commentCache = new WeakMap();
  // A nested article is a comment if labelled "Comment by…"/"Reply by…", or if its own
  // links carry comment_id but none is a plain post permalink.
  const isCommentArticle = (n) => {
    if (!n || !n.getAttribute || n.getAttribute('role') !== 'article') return false;
    if (commentCache.has(n)) return commentCache.get(n);
    let res = /^(comment|reply) by /i.test(n.getAttribute('aria-label') || '');
    if (!res) {
      const own = Array.from(n.querySelectorAll('a[href]')).filter((a) => a.closest('[role="article"]') === n);
      res = own.some((a) => COMMENT_LINK_RE.test(a.href)) &&
        !own.some((a) => POST_LINK_RE.test(a.href) && !COMMENT_LINK_RE.test(a.href));
    }
    commentCache.set(n, res);
    return res;
  };
  const ownedBy = (el, root) => {
    // true if el is inside root and not inside a comment article nested in root
    let n = el === root ? root : el.parentElement;
    if (el !== root && isCommentArticle(el)) return false;
    while (n && n !== root) {
      if (isCommentArticle(n)) return false;
      n = n.parentElement;
    }
    return n === root;
  };
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const label = (el) => (el.getAttribute('aria-label') || text(el)).trim();
`;

/**
 * Tag top-level feed posts not yet seen. Returns their ids in DOM order.
 * A "post" is the outermost of: [aria-posinset] or [role=article] inside the feed.
 */
export const TAG_NEW_POSTS = /* js */ `(() => {
  ${SHARED}
  const feed = document.querySelector('[role="feed"]') || document.querySelector('[role="main"]') || document.body;
  const cands = Array.from(feed.querySelectorAll('[aria-posinset], [role="article"]'))
    .filter((el) => !isCommentArticle(el));
  const top = cands.filter((el) => {
    let p = el.parentElement;
    while (p && p !== feed) {
      if (p.matches('[aria-posinset], [role="article"]')) return false;
      p = p.parentElement;
    }
    return true;
  });
  window.__slSeq = window.__slSeq || 0;
  const ids = [];
  for (const el of top) {
    if (el.hasAttribute('data-sl-id')) continue;
    if (!text(el)) continue; // placeholder/loading skeleton
    const id = 'p' + (++window.__slSeq);
    el.setAttribute('data-sl-id', id);
    ids.push(id);
  }
  return ids;
})()`;

/** Find an allowed button inside `rootSel` (excluding nested articles unless `deep`) and tag it. */
export const TAG_BUTTON = /* js */ `((args) => {
  ${SHARED}
  const root = document.querySelector(args.rootSel);
  if (!root) return null;
  const re = new RegExp(args.pattern, 'i');
  const btns = Array.from(root.querySelectorAll('[role="button"], button, a[role="link"], span[role="button"], div[role="button"]'));
  for (const b of btns) {
    if (b.hasAttribute('data-sl-clicked')) continue;
    if (!args.deep && !ownedBy(b, root)) continue;
    const l = label(b).replace(/\\s+/g, ' ');
    if (!re.test(l)) continue;
    const id = 'b' + Math.random().toString(36).slice(2, 10);
    b.setAttribute('data-sl-btn', id);
    return { id, label: l };
  }
  return null;
})`;

/**
 * Tag the post's header links that look like its timestamp but have no real link yet.
 * Facebook fills in the permalink (and shows the exact date as a tooltip) only on hover,
 * so the adapter hovers these before extracting.
 */
export const TAG_TIME_LINKS = /* js */ `((id) => {
  ${SHARED}
  const root = document.querySelector('[data-sl-id="' + id + '"]');
  if (!root) return [];
  let author = '';
  const h = Array.from(root.querySelectorAll('h2 a, h3 a, h4 a, strong a')).find((e) => ownedBy(e, root) && text(e));
  if (h) author = text(h).split('\\n')[0];
  const out = [];
  const links = Array.from(root.querySelectorAll('a')).filter((a) => ownedBy(a, root)).slice(0, 10);
  for (const a of links) {
    if (a.closest('h2, h3, h4, strong')) continue;
    const href = a.getAttribute('href') || '';
    if (POST_LINK_RE.test(href)) continue; // already a real permalink
    const t = text(a);
    if (t === author || t.length > 40) continue;
    const unresolved = !href || href === '#' || /^javascript:/i.test(href) || /[?&]__cft__/.test(href) || /\\/groups\\/[^/]+\\/?$/.test(href);
    if (!unresolved) continue;
    const tid = 't' + Math.random().toString(36).slice(2, 10);
    a.setAttribute('data-sl-time', tid);
    out.push(tid);
    if (out.length >= 3) break;
  }
  return out;
})`;

/** Extract fields from a tagged post. */
export const EXTRACT_POST = /* js */ `((id) => {
  ${SHARED}
  const root = document.querySelector('[data-sl-id="' + id + '"]');
  if (!root) return null;

  const links = Array.from(root.querySelectorAll('a[href]')).filter((a) => ownedBy(a, root));
  const hrefs = links.map((a) => a.href);
  const permalinks = links.filter((a) => POST_LINK_RE.test(a.href));

  // Timestamp: permalink anchors whose label is short ("3h", "Yesterday at 4:10 PM").
  const timeLabels = [];
  for (const a of permalinks) {
    for (const v of [a.getAttribute('aria-label'), text(a), a.getAttribute('title')]) {
      if (v && v.length <= 60) timeLabels.push(v.trim());
    }
  }
  root.querySelectorAll('abbr[title], time[datetime]').forEach((t) => {
    if (ownedBy(t, root)) timeLabels.push(t.getAttribute('datetime') || t.getAttribute('title'));
  });

  // Author: first heading/strong link.
  let author = '';
  for (const sel of ['h2 a', 'h3 a', 'h4 a', 'strong a', 'a strong', 'h2', 'h3', 'h4']) {
    const el = Array.from(root.querySelectorAll(sel)).find((e) => ownedBy(e, root) && text(e));
    if (el) { author = text(el).split('\\n')[0]; break; }
  }

  // Message body: preview attribute if present, else dir=auto blocks outside headers/links/buttons.
  let body = '';
  const preview = Array.from(root.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]'))
    .find((e) => ownedBy(e, root));
  if (preview) {
    body = text(preview);
  } else {
    const seen = new Set();
    const parts = [];
    for (const el of root.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
      if (!ownedBy(el, root)) continue;
      if (el.closest('h2, h3, h4, strong, a, [role="button"], button')) continue;
      if (el.parentElement && el.parentElement.closest('div[dir="auto"], span[dir="auto"]') &&
          ownedBy(el.parentElement.closest('div[dir="auto"], span[dir="auto"]'), root)) continue;
      const t = text(el);
      // Skip screen-reader-only labels like "Facebook".
      if (!t || seen.has(t) || t === author || /^facebook$/i.test(t)) continue;
      seen.add(t);
      parts.push(t);
    }
    body = parts.join('\\n');
  }

  // Counts
  let commentCount = null, reactionCount = null;
  for (const el of root.querySelectorAll('[role="button"], span, div[aria-label]')) {
    if (!ownedBy(el, root)) continue;
    const l = label(el).replace(/\\s+/g, ' ');
    let m;
    if (commentCount === null && (m = l.match(/^([\\d.,]+\\s*[KkMm]?)\\s+comments?$/))) commentCount = m[1];
    if (reactionCount === null && (m = l.match(/^(?:All reactions:?|Reactions:?)\\s*([\\d.,]+\\s*[KkMm]?)/i))) reactionCount = m[1];
  }

  // Group the post belongs to (search results come from many groups): a link to the group root.
  let sourceName = null, sourceUrl = null;
  const groupLink = links.find((a) => /\\/groups\\/[^/?#]+\\/?(\\?|#|$)/.test(a.href) && text(a) && text(a) !== author);
  if (groupLink) { sourceName = text(groupLink).split('\\n')[0]; sourceUrl = groupLink.href; }

  const head = text(root).slice(0, 200);
  const isPinned = /^(featured|pinned post|pinned|announcement)s?\\b/im.test(head) ||
    !!root.closest('[aria-label*="Featured" i], [aria-label*="Pinned" i]') ||
    !!root.querySelector('[aria-label="Pinned post" i], [aria-label="Featured" i]');

  return { hrefs, permalinkHrefs: permalinks.map((a) => a.href), author, body, timeLabels, commentCount, reactionCount, isPinned, sourceName, sourceUrl };
})`;

/** Tag and extract comments (nested articles) inside a scope element not yet processed. */
export const EXTRACT_COMMENTS = /* js */ `((scopeSel) => {
  ${SHARED}
  const scope = document.querySelector(scopeSel);
  if (!scope) return [];
  const out = [];
  for (const art of scope.querySelectorAll('[role="article"]')) {
    if (art === scope || art.hasAttribute('data-sl-cid') || !isCommentArticle(art)) continue;
    const aria = art.getAttribute('aria-label') || '';
    const links = Array.from(art.querySelectorAll('a[href]')).filter((a) => ownedBy(a, art));
    const cLinks = links.filter((a) => COMMENT_LINK_RE.test(a.href));

    const cid = 'c' + Math.random().toString(36).slice(2, 10);
    art.setAttribute('data-sl-cid', cid);

    let author = '';
    const m = aria.match(/^(?:comment|reply) by (.+?)(?:\\s+(?:\\d|a |an |just|yesterday)|$)/i);
    if (m) author = m[1].trim();
    if (!author) {
      const a = links.find((l) => !/comment_id=/.test(l.href) && text(l));
      author = a ? text(a).split('\\n')[0] : '';
    }

    const seen = new Set();
    const parts = [];
    for (const el of art.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
      if (!ownedBy(el, art)) continue;
      if (el.closest('a, [role="button"], button, h2, h3, h4')) continue;
      const parent = el.parentElement && el.parentElement.closest('div[dir="auto"], span[dir="auto"]');
      if (parent && ownedBy(parent, art)) continue;
      const t = text(el);
      if (!t || seen.has(t) || t === author) continue;
      seen.add(t);
      parts.push(t);
    }

    const timeLabels = [];
    for (const a of cLinks) {
      for (const v of [a.getAttribute('aria-label'), text(a), a.getAttribute('title')]) {
        if (v && v.length <= 60) timeLabels.push(v.trim());
      }
    }
    out.push({ cid, hrefs: cLinks.map((a) => a.href), author, body: parts.join('\\n'), timeLabels });
  }
  return out;
})`;

/** Detect login wall / checkpoint (spec §6.1). */
export const DETECT_SESSION = /* js */ `(() => {
  const href = location.href;
  if (/\\/checkpoint\\//.test(href)) return 'checkpoint';
  if (/\\/login(\\/|\\.php|\\?|$)/.test(href)) return 'login_required';
  const hasLoginForm = !!document.querySelector('input[name="email"]') && !!document.querySelector('input[name="pass"]');
  if (hasLoginForm) return 'login_required';
  const body = (document.body && document.body.innerText || '').slice(0, 4000);
  if (/you must log in to continue|log in to facebook|log into facebook/i.test(body) && !document.querySelector('[role="navigation"]')) return 'login_required';
  if (/confirm your identity|we suspended your account|your account has been locked|security check/i.test(body)) return 'checkpoint';
  // Soft blocks / rate limits: Facebook wants us to slow down.
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).map((d) => d.innerText || '').join(' ');
  if (/you'?re temporarily blocked|you can'?t use this feature right now|misusing this feature by going too fast|you'?ve been temporarily blocked|your account has been restricted|we limit how often you can/i.test(body + ' ' + dialogs)) return 'rate_limited';
  return 'ok';
})()`;
