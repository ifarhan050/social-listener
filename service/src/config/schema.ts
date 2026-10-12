import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const range = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([a, b]) => a <= b, 'range min must be <= max');

// Every value here is a configurable default (spec §12).
export const configSchema = z.object({
  mode: z.enum(['groups_and_pages', 'groups_only']).default('groups_and_pages'),
  timezone: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'unknown IANA timezone')
    .default('Asia/Karachi'),
  active_hours: z
    .object({ start: hhmm.default('08:00'), end: hhmm.default('23:00') })
    .default({}),

  fetch: z
    .object({
      cutoff_hours: z.number().positive().default(24),
      max_posts: z.number().int().positive().default(30),
      max_scrolls: z.number().int().positive().default(8),
      use_watermark: z.boolean().default(true),
      overlap_minutes: z.number().int().nonnegative().default(30),
      stop_after_consecutive_seen: z.number().int().positive().default(3),
      run_page_budget: z.number().int().positive().default(40),
      daily_page_budget: z.number().int().positive().default(180),
      page_delay_ms: range.default([3000, 8000]),
      scroll_delay_ms: range.default([1000, 3000]),
      page_timeout_ms: z.number().int().positive().default(30000),
      // Human pacing makes Facebook slow; leave room so runs aren't cut short.
      run_timeout_minutes: z.number().positive().default(45),
      /** Look-back for a target's first scan (no watermark yet); later scans use cutoff_hours. */
      first_scan_lookback_hours: z.number().positive().default(168),
      checkpoint_pause_hours: z.number().positive().default(18),
      /** Pause after a soft block ("You're temporarily blocked", "going too fast"). Longer than a checkpoint. */
      soft_block_pause_hours: z.number().positive().default(48),
      // Phase 1 fixed revisit interval; adaptive scheduling arrives in Phase 2.
      default_interval_hours: z.number().positive().default(3),
      /**
       * Human-like pacing for Facebook: natural scrolling, reading time, pausing before clicks,
       * breaks between targets. (Pacing only — no fingerprint/automation disguise.)
       */
      human: z
        .object({
          /** Only for tests/fixtures. Doctor warns when off. */
          enabled: z.boolean().default(true),
          reading_wpm: range.default([200, 300]),
          max_dwell_ms: z.number().int().nonnegative().default(12000),
          click_pause_ms: range.default([150, 600]),
          scroll_step_px: range.default([80, 160]),
          scroll_step_pause_ms: range.default([40, 180]),
          target_break_ms: range.default([20000, 60000]),
          idle_every_posts: range.default([5, 9]),
          idle_pause_ms: range.default([3000, 8000]),
        })
        .default({}),
    })
    .default({}),

  scheduler: z
    .object({
      target_posts_per_visit: z.number().positive().default(20),
      min_interval_hours: z.number().positive().default(1),
      max_interval_hours: z.number().positive().default(24),
      jitter_minutes: z.number().nonnegative().default(25),
      ucb_c: z.number().nonnegative().default(0.5),
      ema_alpha: z.number().min(0).max(1).default(0.3),
      promote_threshold: z.number().nonnegative().default(0.05),
      retire_after_zero_scans: z.number().int().positive().default(10),
      dormant_recheck_days: z.number().positive().default(14),
      tick_seconds: z.number().int().positive().default(60),
      /**
       * Who starts scans. `cowork` (default): only Claude Cowork (scheduled tasks / run_scan);
       * the service never scans on its own. `service`: the built-in timer starts due scans.
       */
      trigger: z.enum(['cowork', 'service']).default('cowork'),
      /** Scheduled collection (/scheduled-run from Cowork tasks). Off = manual runs only (/scan, /find). */
      scheduled_runs: z.boolean().default(false),
    })
    .default({}),

  /** Your brand's own Facebook pages (names or URLs). Their posts are never reported as mentions. */
  brand: z
    .object({ own_pages: z.array(z.string().trim().min(1)).default([]) })
    .default({}),

  /** Facebook group report job ("last N days, most negative posts"). */
  /** Manual /find jobs. */
  find: z
    .object({
      /** Candidates collected per batch before handing them to Claude for labelling. */
      batch_size: z.number().int().positive().max(100).default(25),
      /** Facebook only scrolls back this far (longer ranges use Facebook's year filter, best-effort). */
      facebook_max_days: z.number().int().positive().max(365).default(90),
      /** Comments kept with each candidate post (evidence for the result file). */
      max_comments_per_post: z.number().int().nonnegative().max(100).default(20),
    })
    .default({}),

  report: z
    .object({
      days: z.number().int().positive().max(90).default(30),
      max_posts_per_group: z.number().int().positive().max(100).default(15),
      /** "View more comments" clicks per post when collecting comments for the report. */
      max_comment_expansions: z.number().int().nonnegative().max(20).default(5),
    })
    .default({}),

  comments: z
    .object({
      expand_min_count: z.number().int().nonnegative().default(10),
      max_expansions: z.number().int().nonnegative().default(3),
      secondary_terms: z.array(z.string()).default(['account', 'card', 'branch', 'atm', 'app']),
      rescan_offsets_hours: z.array(z.number().positive()).default([2, 6, 24, 48]),
    })
    .default({}),

  matching: z
    .object({
      fuzzy_max_distance: z.number().int().nonnegative().default(1),
      fuzzy_min_length: z.number().int().positive().default(6),
    })
    .default({}),

  search: z
    .object({
      /**
       * Generic Facebook post search ("Recent posts") per enabled keyword.
       * when_no_targets: only while no group/page targets are active.
       * always: alongside groups/pages. off: never.
       */
      mode: z.enum(['when_no_targets', 'always', 'off']).default('when_no_targets'),
      /** Search results aren't strictly chronological: stop after this many consecutive too-old results. */
      stop_after_consecutive_old: z.number().int().positive().default(4),
      /** Facebook search is the most scrutinized action: at most one search per keyword per this many hours. */
      min_interval_hours: z.number().positive().default(12),
      /** Only the first N search phrases (across all missions) get a Facebook search; zero-account sources cover the rest. */
      max_queries: z.number().int().positive().default(5),
    })
    .default({}),

  /**
   * One on/off switch per platform. Turning one off is non-destructive: its targets,
   * captures and review history are kept, and it resumes when switched back on.
   */
  platforms: z
    .object({
      facebook: z.boolean().default(true),
      news: z.boolean().default(true),
      rss: z.boolean().default(true),
      youtube: z.boolean().default(true),
      reddit: z.boolean().default(true),
    })
    .strict()
    .default({}),

  reddit: z
    .object({
      /** Needs REDDIT_CLIENT_ID/SECRET in .env. On/off switch: platforms.reddit. */
      /** Site-wide keyword search: always (default), only when no subreddits are monitored, or off. */
      search_mode: z.enum(['always', 'when_no_targets', 'off']).default('always'),
      /** Hard cap on Reddit API requests per run (Reddit allows ~100/min per app). */
      max_requests_per_run: z.number().int().positive().max(1000).default(60),
      /** Minimum spacing between API requests. */
      min_request_interval_ms: z.number().int().nonnegative().default(1000),
      include_nsfw: z.boolean().default(false),
    })
    .default({}),

  news: z
    .object({
      /** Google News + Bing News RSS search per keyword. No account or key. On/off switch: platforms.news. */
      search_mode: z.enum(['always', 'when_no_targets', 'off']).default('always'),
      /** Google News edition, e.g. hl=en-PK gl=PK ceid=PK:en. */
      region: z.object({ hl: z.string().default('en-PK'), gl: z.string().default('PK'), ceid: z.string().default('PK:en') }).default({}),
      /** Also search the Urdu edition when a keyword has Urdu-script variants. */
      urdu_edition: z.boolean().default(true),
      engines: z.array(z.enum(['google_news', 'bing_news'])).default(['google_news', 'bing_news']),
      interval_hours: z.number().positive().default(1),
    })
    .default({}),

  youtube: z
    .object({
      /** Official YouTube Data API v3; needs YOUTUBE_API_KEY in .env. On/off switch: platforms.youtube. */
      search_mode: z.enum(['always', 'when_no_targets', 'off']).default('always'),
      region_code: z.string().default('PK'),
      /** Hard daily cap (Google's default quota is 10,000 units; search.list costs 100). */
      daily_quota_units: z.number().int().positive().default(8000),
      interval_hours: z.number().positive().default(6),
      max_comment_pages: z.number().int().positive().default(2),
    })
    .default({}),

  rss: z
    .object({
      /** On/off switch: platforms.rss. */
      interval_hours: z.number().positive().default(2),
    })
    .default({}),

  review: z
    .object({
      /**
       * When true, new captures wait in a review queue; Claude (Cowork) labels them and only
       * negative, non-promotional items are kept. When false, every keyword match is kept.
       */
      enabled: z.boolean().default(true),
      /** Keep a promotional post as context when it has negative comments (only the comments count as mentions). */
      keep_promo_post_as_context: z.boolean().default(true),
    })
    .default({}),

  discovery: z
    .object({ enabled: z.boolean().default(true), interval_days: z.number().positive().default(7) })
    .default({}),

  browser: z
    .object({
      /**
       * Which browser runs scans. `chrome`/`msedge` use the installed browser; login then
       * happens in that browser launched normally (no automation attached). `chromium`
       * uses Playwright's bundled build and an automated login window.
       */
      channel: z.enum(['chrome', 'msedge', 'chromium']).default('chrome'),
    })
    .default({}),

  capture: z
    .object({
      viewport_width: z.number().int().positive().default(1280),
      device_scale_factor: z.number().positive().default(2),
      format: z.enum(['webp', 'jpeg']).default('webp'),
      quality: z.number().int().min(1).max(100).default(80),
    })
    .default({}),

  sync: z
    .object({
      portal_base_url: z.string().default(''),
      interval_minutes: z.number().positive().default(20),
      batch_size: z.number().int().positive().default(40),
      concurrency: z.number().int().positive().default(2),
      max_attempts: z.number().int().positive().default(5),
      backoff_minutes: z.array(z.number().positive()).default([1, 5, 15, 60]),
    })
    .default({}),

  retention: z
    .object({
      local_retention_days: z.number().positive().default(10),
      seen_retention_days: z.number().positive().default(120),
    })
    .default({}),

  track_edits: z.boolean().default(false),
});

export type Config = z.infer<typeof configSchema>;

export const PLATFORMS = ['facebook', 'news', 'rss', 'youtube', 'reddit'] as const;
export type PlatformName = (typeof PLATFORMS)[number];

export const defaultConfig = (): Config => configSchema.parse({});
