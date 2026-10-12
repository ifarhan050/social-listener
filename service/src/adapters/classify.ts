import { classifyTargetUrl as classifyFacebook } from './facebook/urls.js';

/** Not a known social URL; the caller may still try it as an RSS/Atom feed. */
export class NotASocialUrl extends Error {}

export interface ClassifiedTarget {
  platform: 'facebook' | 'reddit' | 'youtube';
  kind: 'group' | 'page' | 'subreddit' | 'channel';
  url: string;
}

const isYouTubeHost = (h: string) => /(^|\.)youtube\.com$/i.test(h);

/** `youtube.com/@handle`, `/channel/UC…`, `/user/name` → canonical channel URL. */
function classifyYouTube(input: string): ClassifiedTarget | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (!isYouTubeHost(u.hostname)) return null;
  const m =
    u.pathname.match(/^\/(@[\w.\-]+)/) ?? u.pathname.match(/^\/(channel\/UC[\w-]{20,})/) ?? u.pathname.match(/^\/(user\/[\w.\-]+)/);
  if (!m) throw new Error('expected a YouTube channel URL like https://www.youtube.com/@handle or /channel/UC…');
  return { platform: 'youtube', kind: 'channel', url: `https://www.youtube.com/${m[1]}` };
}

const isRedditHost = (h: string) => /(^|\.)reddit\.com$/i.test(h);

/** `https://www.reddit.com/r/<sub>/…`, `old.reddit.com/r/<sub>`, or bare `r/<sub>` → canonical subreddit URL. */
function classifyReddit(input: string): ClassifiedTarget | null {
  const bare = input.trim().match(/^\/?r\/([A-Za-z0-9_]{2,21})\/?$/);
  if (bare) return { platform: 'reddit', kind: 'subreddit', url: `https://www.reddit.com/r/${bare[1]}` };
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (!isRedditHost(u.hostname)) return null;
  const m = u.pathname.match(/^\/r\/([A-Za-z0-9_]{2,21})(\/|$)/);
  if (!m) throw new Error('expected a subreddit URL like https://www.reddit.com/r/<name>');
  return { platform: 'reddit', kind: 'subreddit', url: `https://www.reddit.com/r/${m[1]}` };
}

/**
 * Classify any user-supplied target URL: Facebook group/page, subreddit, or YouTube channel.
 * Throws NotASocialUrl for anything else (the API then tries it as an RSS/Atom feed).
 * Keyword-search targets are never user-created; they follow the keyword list.
 */
export function classifyTarget(input: string): ClassifiedTarget {
  const reddit = classifyReddit(input);
  if (reddit) return reddit;
  const youtube = classifyYouTube(input);
  if (youtube) return youtube;
  try {
    return { platform: 'facebook', ...classifyFacebook(input) };
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'URL must be on facebook.com' || msg === 'not a valid URL')
      throw new NotASocialUrl(
        'expected a Facebook group/page, a subreddit (r/<name>), a YouTube channel (youtube.com/@handle), or an RSS/Atom feed URL',
      );
    throw err;
  }
}
