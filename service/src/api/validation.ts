import { z } from 'zod';

export { classifyTarget } from '../adapters/classify.js';

const strList = z.array(z.string().trim().min(1).max(200)).max(100);

export const targetCreate = z
  .object({
    /** Facebook group/page URL, subreddit URL, or bare `r/<name>`. */
    url: z.string().trim().min(3).max(500),
    /** Optional; inferred from the URL. Search targets are managed automatically from keywords. */
    kind: z.enum(['group', 'page', 'subreddit', 'channel', 'feed']).optional(),
    name: z.string().trim().max(200).optional(),
    priority: z.enum(['high', 'normal']).optional(),
    status: z.enum(['active', 'candidate', 'dormant', 'disabled']).optional(),
    cutoff_hours: z.number().positive().max(24 * 30).nullable().optional(),
    max_posts: z.number().int().positive().max(500).nullable().optional(),
    /** 'all' = every comment on this target goes to review (e.g. your brand's own page). */
    comments_mode: z.enum(['matching', 'all']).optional(),
  })
  .strict();

export const targetPatch = z
  .object({
    name: z.string().trim().max(200).nullable().optional(),
    priority: z.enum(['high', 'normal']).optional(),
    status: z.enum(['active', 'candidate', 'dormant', 'disabled']).optional(),
    cutoff_hours: z.number().positive().max(24 * 30).nullable().optional(),
    max_posts: z.number().int().positive().max(500).nullable().optional(),
    /** 'all' = every comment on this target goes to review (e.g. your brand's own page). */
    comments_mode: z.enum(['matching', 'all']).optional(),
    /** Set to null to make the target due immediately. */
    next_due_at: z.string().datetime().nullable().optional(),
  })
  .strict();

export const keywordCreate = z
  .object({
    keyword: z.string().trim().min(2).max(100),
    variants: strList.optional(),
    negatives: strList.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const keywordPatch = keywordCreate.partial().strict();

export const scanRequest = z
  .object({
    /** Set by /scheduled-run; refused while scheduler.scheduled_runs is off. */
    scheduled: z.boolean().optional(),
    target_ids: z.array(z.number().int().positive()).max(100).optional(),
    wait: z.boolean().optional(),
  })
  .strict();

export const capturesQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  keyword: z.string().optional(),
  target_id: z.coerce.number().int().positive().optional(),
  sync_status: z.enum(['pending', 'synced', 'failed']).optional(),
  /** Default: all except rejected. */
  review_status: z.enum(['pending', 'kept', 'context', 'rejected', 'all']).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const sentiment = z.enum(['negative', 'neutral', 'positive']);

export const reviewSubmit = z
  .object({
    decisions: z
      .array(
        z
          .object({
            item_key: z.string().min(3),
            /** Required when the item matched several missions. */
            mission_id: z.number().int().positive().optional(),
            /** Generic verdict: keep it for this mission? */
            keep: z.boolean().optional(),
            label: z.string().trim().min(1).max(40).optional(),
            score: z.number().int().min(0).max(3).optional(),
            /** Complaint-style verdict (keep = negative and not promotional). */
            sentiment: sentiment.optional(),
            promotional: z.boolean().optional(),
            reason: z.string().trim().min(1).max(500),
          })
          .strict()
          .refine((d) => d.keep !== undefined || d.sentiment !== undefined, { message: 'give keep (true/false) or sentiment' }),
      )
      .min(1)
      .max(500),
  })
  .strict();

export const reviewQueueQuery = z.object({ limit: z.coerce.number().int().positive().max(100).optional() });
export const reviewLogQuery = z.object({
  status: z.enum(['kept', 'context', 'rejected']).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const platformName = z.enum(['facebook', 'news', 'rss', 'youtube', 'reddit'], {
  errorMap: () => ({ message: 'platform must be one of facebook, news, rss, youtube, reddit' }),
});
export const platformToggle = z.object({ enabled: z.boolean() }).strict();

// --- Missions ---------------------------------------------------------------------------

const term = z.string().trim().min(1).max(100);
const termList = z.array(term).max(100);
const missionMatch = z
  .object({
    any: termList.optional(),
    all_of: z.array(termList.min(1)).max(6).optional(),
    none: termList.optional(),
  })
  .strict()
  .refine((m) => (m.any?.length ?? 0) + (m.all_of?.length ?? 0) > 0, { message: 'match needs "any" terms or "all_of" groups' });
const missionSources = z
  .object({ facebook: z.boolean(), news: z.boolean(), rss: z.boolean(), youtube: z.boolean(), reddit: z.boolean() })
  .partial()
  .strict();
const missionFields = {
  name: z.string().trim().min(2).max(80),
  template: z.enum(['complaints', 'leads', 'businesses', 'topic', 'custom']),
  goal: z.string().trim().min(5).max(1000),
  status: z.enum(['active', 'paused']),
  match: missionMatch,
  search_queries: z.array(term).min(1).max(20),
  keep_rules: z.string().trim().max(2000),
  exclude_rules: z.string().trim().max(2000),
  sources: missionSources,
  target_ids: z.array(z.number().int().positive()).max(500).nullable(),
  locale: z.object({ location: z.string().trim().max(120), languages: z.array(z.string().trim().min(2).max(30)).max(6) }).partial().strict(),
  report: z
    .object({ days: z.number().int().positive().max(90), format: z.string().trim().max(2000), schedule: z.string().trim().max(60) })
    .partial()
    .strict(),
};
export const missionCreate = z
  .object(missionFields)
  .partial({ status: true, keep_rules: true, exclude_rules: true, sources: true, target_ids: true, locale: true, report: true })
  .strict();
export const missionPatch = z.object(missionFields).partial().strict();
export const missionStatus = z.object({ status: z.enum(['active', 'paused']) }).strict();
export const missionItemsQuery = z.object({
  status: z.enum(['kept', 'context', 'pending', 'rejected', 'stored']).optional(),
  days: z.coerce.number().int().positive().max(365).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const groupReportStart = z
  .object({
    group_ids: z.array(z.number().int().positive()).max(200).optional(),
    days: z.number().int().positive().max(90).optional(),
    max_posts_per_group: z.number().int().positive().max(100).optional(),
    resume_job_id: z.number().int().positive().optional(),
    /** Which mission's search phrases and rules to use (default: the original brand mission / keywords). */
    mission_id: z.number().int().positive().optional(),
  })
  .strict();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, 'use YYYY-MM-DD');
export const findStart = z
  .object({
    mission_id: z.number().int().positive().optional(),
    /** One-off search phrases (default: the mission's). */
    queries: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
    count: z.number().int().positive().max(200),
    types: z.array(z.string().trim().min(1).max(40)).min(1).max(10),
    /** Facebook group/page target ids or URLs. Empty: general search. */
    groups: z.array(z.union([z.number().int().positive(), z.string().url()])).max(20).optional(),
    platforms: z.array(z.enum(['news', 'rss', 'youtube', 'reddit', 'facebook'])).optional(),
    when: z
      .object({
        preset: z.enum(['today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'this_month', 'last_month', 'this_year', 'last_year']).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export const findLabels = z
  .object({
    labels: z
      .array(
        z
          .object({
            item_key: z.string().min(1),
            label: z.string().trim().min(1).max(40),
            keep: z.boolean().optional(),
            reason: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export const findExportQuery = z.object({
  include: z.enum(['kept', 'labelled', 'all']).optional(),
  format: z.enum(['json', 'csv']).optional(),
});

const secretValue = z.string().trim().max(300).regex(/^[^\r\n]*$/, 'one line only').nullable().optional();
export const secretsUpdate = z
  .object({
    YOUTUBE_API_KEY: secretValue,
    REDDIT_CLIENT_ID: secretValue,
    REDDIT_CLIENT_SECRET: secretValue,
    REDDIT_USER_AGENT: secretValue,
  })
  .strict();

export const snapshotRequest = z
  .object({ target_id: z.number().int().positive().optional(), posts: z.number().int().positive().max(5).optional() })
  .strict();

export const reportQuery = z.object({
  run_id: z.coerce.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
