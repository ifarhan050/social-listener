import { describe, expect, it } from 'vitest';
import {
  bestPostId,
  canonicalUrl,
  contentAlias,
  extractCommentId,
  extractGroupId,
  extractPostId,
  fallbackKey,
} from '../src/adapters/facebook/keys.js';

describe('extractPostId', () => {
  it.each([
    ['https://www.facebook.com/groups/123/posts/456789/', '456789'],
    ['https://www.facebook.com/groups/my.group/posts/456789/?comment_id=1&__cft__[0]=x', '456789'],
    ['https://m.facebook.com/groups/123/permalink/456789/', '456789'],
    ['https://www.facebook.com/permalink.php?story_fbid=456789&id=100', '456789'],
    ['https://www.facebook.com/story.php?story_fbid=pfbid02AbCdEf123&id=100', 'pfbid02AbCdEf123'],
    ['https://www.facebook.com/somepage/posts/pfbid0xYz987', 'pfbid0xYz987'],
    ['https://www.facebook.com/photo/?fbid=1122&set=a.1', '1122'],
    ['https://www.facebook.com/watch/?v=3344', '3344'],
    ['https://www.facebook.com/somepage/videos/5566/', '5566'],
    ['/groups/123/posts/777/', '777'],
  ])('%s → %s', (url, id) => {
    expect(extractPostId(url)).toBe(id);
  });

  it.each(['https://www.facebook.com/groups/123/', 'https://example.com/posts/1', 'https://www.facebook.com/profile.php?id=5'])(
    'returns null for %s',
    (url) => expect(extractPostId(url)).toBeNull(),
  );
});

describe('extractCommentId', () => {
  it('reads numeric and reply ids', () => {
    expect(extractCommentId('https://www.facebook.com/groups/1/posts/2/?comment_id=333')).toBe('333');
    expect(extractCommentId('https://www.facebook.com/groups/1/posts/2/?comment_id=333&reply_comment_id=444')).toBe('444');
  });
  it('decodes base64 comment ids', () => {
    const b64 = Buffer.from('comment:222_98765').toString('base64');
    expect(extractCommentId(`https://www.facebook.com/x/posts/2?comment_id=${encodeURIComponent(b64)}`)).toBe('98765');
  });
  it('returns null without comment id', () => {
    expect(extractCommentId('https://www.facebook.com/groups/1/posts/2/')).toBeNull();
  });
});

describe('helpers', () => {
  it('extracts group ids', () => {
    expect(extractGroupId('https://www.facebook.com/groups/karachi.buysell/?ref=share')).toBe('karachi.buysell');
  });
  it('canonicalizes URLs (strips tracking params)', () => {
    expect(canonicalUrl('https://m.facebook.com/groups/1/posts/2/?__cft__[0]=abc&__tn__=R')).toBe(
      'https://www.facebook.com/groups/1/posts/2',
    );
    expect(canonicalUrl('https://www.facebook.com/permalink.php?story_fbid=9&id=100&ref=x')).toBe(
      'https://www.facebook.com/permalink.php?story_fbid=9&id=100',
    );
  });
  it('prefers numeric ids over pfbid', () => {
    expect(bestPostId(['https://www.facebook.com/g/posts/pfbid0abc', 'https://www.facebook.com/groups/1/posts/42/'])).toBe('42');
    expect(bestPostId(['https://www.facebook.com/g/posts/pfbid0abc'])).toBe('pfbid0abc');
    expect(bestPostId(['https://www.facebook.com/profile.php?id=1'])).toBeNull();
  });
  it('fallback key is stable per minute and text-normalized', () => {
    const t = new Date('2026-10-03T09:12:31Z');
    const a = fallbackKey('post', 'Ali', 'Hello  XYZ Bank!', t);
    const b = fallbackKey('post', 'Ali', 'hello xyz bank', new Date('2026-10-03T09:12:05Z'));
    expect(a).toBe(b);
    expect(a).toMatch(/^fb:post:h:[0-9a-f]{32}$/);
    expect(fallbackKey('post', 'Ali', 'hello xyz bank', new Date('2026-10-03T09:13:00Z'))).not.toBe(a);
  });
  it('content alias ignores short texts', () => {
    expect(contentAlias('Ali', 'hi')).toBeNull();
    expect(contentAlias('Ali', 'This is a long enough post about xyzbank')).toMatch(/^fb:alias:/);
  });
});
