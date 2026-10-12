import { XMLParser } from 'fast-xml-parser';

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  /** Plain-text summary/description (HTML stripped). */
  summary: string;
  /** Plain-text full content when the feed carries it (content:encoded / Atom content). */
  content: string;
  published: Date | null;
  author: string | null;
  /** Publisher, when the feed names one per item (Google News <source>, Bing News:Source). */
  sourceName: string | null;
  sourceUrl: string | null;
}

export interface Feed {
  title: string | null;
  link: string | null;
  items: FeedItem[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ['item', 'entry', 'link', 'category'].includes(name),
});

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Text of an XML node that may be a string, a number, or {#text}. */
const txt = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'object') return txt((v as Record<string, unknown>)['#text']);
  return '';
};

/** Strip HTML tags and decode common entities to plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const toDate = (s: string): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

function atomLink(links: unknown): string {
  const arr = (Array.isArray(links) ? links : [links]) as Record<string, string>[];
  const alt = arr.find((l) => l && (l['@_rel'] === 'alternate' || !l['@_rel'])) ?? arr[0];
  return alt?.['@_href'] ?? txt(alt);
}

/** Parse RSS 2.0, RSS 1.0 (RDF) or Atom. Throws if the document is not a feed. */
export function parseFeed(xml: string): Feed {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new Error(`not a valid feed: ${(err as Error).message}`);
  }

  const channel = doc.rss?.channel ?? doc['rdf:RDF']?.channel;
  if (channel) {
    const items = (doc.rss?.channel?.item ?? doc['rdf:RDF']?.item ?? []) as Record<string, any>[];
    return {
      title: txt(channel.title) || null,
      link: txt(Array.isArray(channel.link) ? channel.link.find((l: unknown) => typeof l === 'string') ?? channel.link[0] : channel.link) || null,
      items: items.map((it) => {
        const link = txt(it.link) || txt(it.guid);
        const source = it.source;
        return {
          id: txt(it.guid) || link || txt(it.title),
          title: htmlToText(txt(it.title)),
          link,
          summary: htmlToText(txt(it.description)),
          content: htmlToText(txt(it['content:encoded'])),
          published: toDate(txt(it.pubDate) || txt(it['dc:date'])),
          author: txt(it['dc:creator']) || txt(it.author) || null,
          sourceName: txt(source) || txt(it['News:Source']) || null,
          sourceUrl: (source && typeof source === 'object' ? (source as Record<string, string>)['@_url'] : null) ?? null,
        };
      }),
    };
  }

  const feed = doc.feed;
  if (feed) {
    const entries = (feed.entry ?? []) as Record<string, any>[];
    return {
      title: htmlToText(txt(feed.title)) || null,
      link: feed.link ? atomLink(feed.link) || null : null,
      items: entries.map((e) => {
        const link = e.link ? atomLink(e.link) : '';
        return {
          id: txt(e.id) || link,
          title: htmlToText(txt(e.title)),
          link,
          summary: htmlToText(txt(e.summary)),
          content: htmlToText(txt(e.content)),
          published: toDate(txt(e.published) || txt(e.updated)),
          author: txt(e.author?.name) || null,
          sourceName: null,
          sourceUrl: null,
        };
      }),
    };
  }
  throw new Error('not an RSS or Atom feed');
}
