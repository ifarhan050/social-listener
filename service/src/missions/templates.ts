import type { PlatformName } from '../config/schema.js';

export type TemplateId = 'complaints' | 'leads' | 'businesses' | 'topic' | 'custom';

export interface MissionTemplate {
  id: TemplateId;
  title: string;
  /** One line shown in the setup wizard. */
  summary: string;
  /** Example goal, to help the user phrase their own. */
  example_goal: string;
  /** Default keep/exclude rules Claude applies in review (editable per mission). */
  keep_rules: string;
  exclude_rules: string;
  /** Labels Claude assigns to kept items, most important first. */
  labels: string[];
  /** How search phrases and match rules are usually built for this template. */
  query_guidance: string;
  match_example: { any?: string[]; all_of?: string[][]; none?: string[] };
  default_sources: Partial<Record<PlatformName, boolean>>;
  /** Suggested Cowork schedule for the report. */
  report_schedule: string;
  /** Layout of the report file Claude writes. */
  report_format: string;
  /** Freshness window used for reports by default. */
  report_days: number;
}

export const TEMPLATES: Record<TemplateId, MissionTemplate> = {
  complaints: {
    id: 'complaints',
    title: 'Complaints, issues & scams',
    summary: 'Negative experiences, scams and service failures about a brand or product.',
    example_goal: 'Find complaints, scam warnings and service problems about XYZ Bank in Pakistan.',
    keep_rules:
      'Keep posts/comments that complain about, criticise, warn about, or report a problem with the brand: failed transactions, outages, blocked accounts/cards, hidden fees, poor service, refund delays, fraud or scam warnings — including sarcasm and polite questions that report a real problem.',
    exclude_rules:
      "Exclude promotional content (ads, offers, the brand's own marketing, agents/resellers, giveaways, job posts, competitor ads), posts from the brand's own pages, praise, and neutral questions without a complaint.",
    labels: ['scam', 'money', 'service', 'other'],
    query_guidance: 'Search for the brand name and its common spellings/abbreviations. Match on the brand (any) and use none for job/hiring/promo noise.',
    match_example: { any: ['XYZ Bank', 'xyzbank', 'XYZB'], none: ['hiring', 'jobs'] },
    default_sources: { facebook: true, news: true, rss: true, youtube: true, reddit: true },
    report_schedule: 'weekly',
    report_format:
      'Top 5 by negative signal (negative comments weighted: scam=3, money=2, service/other=1). For each: source/group, date, author first name, excerpt, top 3 negative comments (≤20 words, first names), negative vs total comments, link. Then themes with counts.',
    report_days: 30,
  },
  leads: {
    id: 'leads',
    title: 'Leads — people asking for something',
    summary: 'People expressing a need you can serve (e.g. "need a home tutor in Lahore").',
    example_goal: 'Find parents and students in Lahore looking for O/A-level maths tutors or tuition.',
    keep_rules:
      'Keep posts/comments where a person is ASKING FOR or LOOKING FOR the service/product described in the goal (a request, requirement or question about finding a provider), ideally in the goal\'s location. Recent and specific requests (subject, level, area, budget, timing) are best.',
    exclude_rules:
      'Exclude people OFFERING the service (providers advertising themselves), ads and promotions, academies/agencies marketing, job postings for providers unless the goal asks for them, requests clearly outside the location, and requests that are already fulfilled.',
    labels: ['hot', 'warm', 'cold'],
    query_guidance:
      'Search phrases describe the need as people write it ("need home tutor", "looking for tuition", "tutor required"), plus the area. Match with all_of: [[service words], [need/looking/required/wanted words]] and none for offers ("available", "we offer", "contact for classes").',
    match_example: {
      all_of: [
        ['tutor', 'tuition', 'teacher', 'home tutor'],
        ['need', 'needed', 'looking for', 'required', 'wanted', 'chahiye', 'chahye'],
      ],
      none: ['available for tuition', 'we offer', 'academy admissions open'],
    },
    default_sources: { facebook: true, news: false, rss: true, youtube: false, reddit: true },
    report_schedule: 'daily',
    report_format:
      'Open leads, newest first. For each: label (hot/warm/cold), date, first name, what they need (subject/level/details), location, how to respond (link to the post — never contact automatically), source. Then a count by area and by need.',
    report_days: 7,
  },
  businesses: {
    id: 'businesses',
    title: 'Similar businesses & competitors',
    summary: 'Businesses or people offering the same or a similar service — competitors or partners.',
    example_goal: 'Find home-tuition providers and academies in Lahore offering O/A-level tutoring.',
    keep_rules:
      'Keep posts/comments where a business or person OFFERS the same or a similar product/service as described in the goal (ads, service announcements, "available for…", price lists), or where people discuss such providers (recommendations, reviews).',
    exclude_rules:
      'Exclude customers asking for the service (those are leads, not businesses), unrelated industries, and pure spam/link farms.',
    labels: ['competitor', 'partner', 'mention'],
    query_guidance:
      'Search phrases describe offers ("tuition available", "home tutor available", "academy admissions") plus area. Match with all_of: [[service words], [offer words: available, offering, admissions, contact, call]].',
    match_example: {
      all_of: [
        ['tutor', 'tuition', 'academy', 'coaching'],
        ['available', 'offering', 'admissions', 'contact', 'call', 'whatsapp'],
      ],
    },
    default_sources: { facebook: true, news: false, rss: true, youtube: true, reddit: false },
    report_schedule: 'weekly',
    report_format:
      'List of businesses/providers: name (as shown), what they offer, area, price if stated, how active (posts seen), link. Group duplicates of the same provider. Then a short overview of the market (common offers, price ranges, gaps).',
    report_days: 30,
  },
  topic: {
    id: 'topic',
    title: 'Topic / market watch',
    summary: 'Track any topic or trend and summarise what people are saying.',
    example_goal: 'Follow what people in Pakistan say about electric bikes: prices, brands, problems, demand.',
    keep_rules:
      'Keep substantive posts/comments about the topic: opinions, experiences, questions, news, prices, comparisons.',
    exclude_rules: 'Exclude spam, off-topic uses of the words, and pure ads unless the goal is about offers.',
    labels: ['positive', 'negative', 'question', 'news'],
    query_guidance: 'Search phrases are the topic and its common synonyms; match on any of them, with none for unrelated meanings.',
    match_example: { any: ['electric bike', 'e-bike', 'electric scooter'] },
    default_sources: { facebook: true, news: true, rss: true, youtube: true, reddit: true },
    report_schedule: 'weekly',
    report_format:
      'Themes (with counts and 1–2 short example quotes, first names only), sentiment split, notable posts with links, what changed since the last report.',
    report_days: 14,
  },
  custom: {
    id: 'custom',
    title: 'Custom',
    summary: 'Anything else — you describe what to keep, what to drop and how to report.',
    example_goal: 'Describe in a sentence what you want to find.',
    keep_rules: 'Keep items that match the goal as described.',
    exclude_rules: 'Exclude spam, ads and off-topic items unless the goal asks for them.',
    labels: ['relevant'],
    query_guidance: 'Derive search phrases and match terms from the goal with the user.',
    match_example: { any: ['term'] },
    default_sources: { facebook: true, news: true, rss: true, youtube: true, reddit: true },
    report_schedule: 'weekly',
    report_format: 'As the user describes; default: newest relevant items with source, date, excerpt and link.',
    report_days: 14,
  },
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];
