/**
 * Canonical form of an article link for dedup:
 * unwraps Bing's apiclick redirect (`url=` param), drops tracking params and fragments.
 * Google News `rss/articles/…` links are opaque and kept as-is (dedup falls back to title).
 */
export function canonicalLink(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href.trim();
  }
  if (/(^|\.)bing\.com$/i.test(u.hostname) && /apiclick\.aspx$/i.test(u.pathname)) {
    const target = u.searchParams.get('url');
    if (target) return canonicalLink(target);
  }
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_|ref$|ocid$|oc$|cmpid$)/i.test(k)) u.searchParams.delete(k);
  }
  u.hostname = u.hostname.replace(/^www\./i, '').toLowerCase();
  u.protocol = 'https:';
  return u.toString().replace(/\/$/, '');
}

/** Hostname without www, for display/source fallbacks. */
export const hostOf = (href: string): string | null => {
  try {
    return new URL(href).hostname.replace(/^www\./i, '');
  } catch {
    return null;
  }
};
