/**
 * Thin stdio MCP server for Claude Cowork / Claude Code.
 * It owns no state: every tool proxies to the long-running local service's
 * 127.0.0.1 HTTP API, so there is never a second scheduler or browser.
 *
 * Connection: SOCIAL_LISTENER_URL + SOCIAL_LISTENER_TOKEN, else
 * ~/.social-listener/connection.json (written by the service on boot).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startService, validateLaunch } from './autostart.js';
import { runInstaller } from './installer.js';
import { dashboardLink, loginSummary, newer, type StatusLite } from './helpers.js';

const NOT_RUNNING =
  'The social-listener agent is not installed or not running on this computer yet. Type /setup and I will install or start it for you (or run "Install on Windows" / "Install on Mac" from the Social Listener Setup download).';

/** Plugin version; get_status compares it with the service's version. */
const PLUGIN_VERSION = '0.2.0';

interface Conn {
  url: string;
  token: string;
  launch?: unknown;
}

const CONNECTION_FILE = path.join(os.homedir(), '.social-listener', 'connection.json');

function connection(): Conn | null {
  if (process.env.SOCIAL_LISTENER_URL && process.env.SOCIAL_LISTENER_TOKEN)
    return { url: process.env.SOCIAL_LISTENER_URL, token: process.env.SOCIAL_LISTENER_TOKEN };
  try {
    const c = JSON.parse(fs.readFileSync(CONNECTION_FILE, 'utf8')) as Partial<Conn>;
    return c.url && c.token ? { url: c.url, token: c.token, launch: c.launch } : null;
  } catch {
    return null;
  }
}

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): Result => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string): Result => ({ content: [{ type: 'text', text: msg }], isError: true });

const ping = async (conn: Conn) => {
  try {
    const r = await fetch(new URL('/api/status', conn.url), { headers: { authorization: `Bearer ${conn.token}` }, signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
};

let starting: Promise<{ ok: boolean; reason?: string }> | null = null;

/**
 * Auto-start (for Cowork scheduled tasks): if the service isn't answering, start it in the
 * background from the launch info it wrote last time, and wait until it's up.
 * Disable with SOCIAL_LISTENER_AUTOSTART=0.
 */
async function ensureService(conn: Conn): Promise<{ ok: boolean; reason?: string }> {
  if (process.env.SOCIAL_LISTENER_AUTOSTART === '0') return { ok: false, reason: 'auto-start is turned off' };
  const v = validateLaunch(conn.launch);
  if (!v.ok) return { ok: false, reason: v.reason };
  starting ??= startService(v.spec, { ping: () => ping(conn) }).finally(() => {
    starting = null;
  });
  return starting;
}

async function call(method: string, p: string, body?: unknown, query?: Record<string, unknown>, retried = false): Promise<Result> {
  const conn = connection();
  if (!conn) return fail(NOT_RUNNING);
  const url = new URL(`/api${p}`, conn.url);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'POST' && p === '/scan' ? 30 * 60_000 : 30_000),
    });
  } catch {
    if (retried) return fail(NOT_RUNNING);
    const started = await ensureService(conn);
    if (!started.ok) return fail(`${NOT_RUNNING} (Auto-start: ${started.reason})`);
    return call(method, p, body, query, true);
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    const d = data as { error?: string; reason?: string; issues?: unknown };
    const msg = d?.error ?? d?.reason ?? res.statusText;
    return fail(`Service returned ${res.status}: ${msg}${d?.issues ? `
${JSON.stringify(d.issues, null, 2)}` : ''}`);
  }
  return ok(data);
}

const server = new McpServer({ name: 'social-listener', version: PLUGIN_VERSION });

const id = z.number().int().positive();
const priority = z.enum(['high', 'normal']);
const status = z.enum(['active', 'candidate', 'dormant', 'disabled']);
const terms = z.array(z.string().min(1)).max(100);

server.registerTool(
  'get_status',
  {
    title: 'Get status',
    description:
      'Facebook session health, Reddit API status, per-platform readiness (platforms), scheduler.trigger and next_due per platform ("now" = due), whether a run can start (and why not), today\'s Facebook page loads vs budget, captures today, review queue counts, current/last run, and alerts. Starts the service automatically if it is not running. versions.update_available=true means the service on this computer is older than this plugin: offer update_service.',
    inputSchema: {},
  },
  async () => {
    const r = await call('GET', '/status');
    if (r.isError) return r;
    try {
      const s = JSON.parse(r.content[0].text) as { service?: { version?: string } };
      const service = s.service?.version ?? 'unknown';
      return ok({ ...s, versions: { plugin: PLUGIN_VERSION, service, update_available: service !== 'unknown' && newer(PLUGIN_VERSION, service) } });
    } catch {
      return r;
    }
  },
);

server.registerTool(
  'run_scan',
  {
    title: 'Run scan',
    description:
      'Run a collection pass now (manual /scan). The service never scans on its own. Scans only targets that are due (per-platform intervals, Facebook search cap, active hours, budgets, pauses all apply). Returns immediately; poll get_status until busy is null, then get_run_report. wait=true blocks until done (can take many minutes). Scheduled Cowork tasks must pass scheduled=true: those are refused while scheduler.scheduled_runs is off (the default). For "N posts of type X in a date range" use start_find instead.',
    inputSchema: {
      target_ids: z.array(id).optional().describe('Scan only these targets; default = all due targets'),
      wait: z.boolean().optional(),
      scheduled: z.boolean().optional().describe('true when called from a scheduled task (refused while scheduled runs are off)'),
    },
  },
  (args) => call('POST', '/scan', args),
);

server.registerTool(
  'list_targets',
  { title: 'List targets', description: 'List monitored targets: Facebook groups/pages, subreddits, YouTube channels, RSS feeds, and the automatic keyword-search targets (kind "search", one per keyword per platform: Facebook (capped by search.max_keywords), news, YouTube and Reddit when configured), with status, priority, overrides and scan stats.', inputSchema: {} },
  () => call('GET', '/targets'),
);

server.registerTool(
  'add_target',
  {
    title: 'Add target',
    description: 'Add a target to monitor: a public Facebook group or page, a subreddit, a YouTube channel, or any RSS/Atom feed (forum, blog, news section). Platform and kind are detected from the URL (feeds are fetched once to verify). Keyword searches on Facebook, news (Google/Bing News), YouTube and Reddit are created automatically from your keywords.',
    inputSchema: {
      url: z
        .string()
        .min(3)
        .describe('Facebook group: https://www.facebook.com/groups/<id-or-slug>; page: https://www.facebook.com/<page-name> or profile.php?id=<n>; subreddit: https://www.reddit.com/r/<name> or r/<name>; YouTube channel: https://www.youtube.com/@handle; or an RSS/Atom feed URL'),
      name: z.string().optional(),
      priority: priority.optional(),
      cutoff_hours: z.number().positive().nullable().optional(),
      max_posts: z.number().int().positive().nullable().optional(),
      comments_mode: z.enum(['matching', 'all']).optional().describe("all = every comment on this target's posts goes to review, even without your terms (use for your own brand page or an ombudsman page)"),
    },
  },
  (args) => call('POST', '/targets', args),
);

server.registerTool(
  'update_target',
  {
    title: 'Update target',
    description: 'Change a target\'s name, status, priority, or per-target cutoff/max posts. Set next_due_at=null to make it due now.',
    inputSchema: {
      id,
      name: z.string().nullable().optional(),
      status: status.optional(),
      priority: priority.optional(),
      cutoff_hours: z.number().positive().nullable().optional(),
      max_posts: z.number().int().positive().nullable().optional(),
      next_due_at: z.string().datetime().nullable().optional(),
      comments_mode: z.enum(['matching', 'all']).optional().describe("all = every comment on this target's posts goes to review, even without your terms (use for your own brand page or an ombudsman page)"),
    },
  },
  ({ id: tid, ...patch }) => call('PATCH', `/targets/${tid}`, patch),
);

server.registerTool(
  'remove_target',
  { title: 'Remove target', description: 'Stop monitoring a group, page or subreddit (captures already taken are kept). Search targets follow keywords and cannot be removed: disable them, or turn search off (search.mode / reddit.search_mode).', inputSchema: { id } },
  ({ id: tid }) => call('DELETE', `/targets/${tid}`),
);

server.registerTool(
  'list_keywords',
  { title: 'List keywords', description: 'List brand keywords with variants and negative keywords.', inputSchema: {} },
  () => call('GET', '/keywords'),
);

server.registerTool(
  'add_keyword',
  {
    title: 'Add keyword',
    description:
      'Add a brand keyword. Matching is case/space/punctuation-insensitive with fuzzy distance 1 for long keywords; add variants for other scripts, transliterations and abbreviations, and negatives to discard false positives.',
    inputSchema: { keyword: z.string().min(2), variants: terms.optional(), negatives: terms.optional(), enabled: z.boolean().optional() },
  },
  (args) => call('POST', '/keywords', args),
);

server.registerTool(
  'update_keyword',
  {
    title: 'Update keyword',
    description: 'Update a keyword. Variants/negatives arrays replace the existing lists.',
    inputSchema: { id, keyword: z.string().min(2).optional(), variants: terms.optional(), negatives: terms.optional(), enabled: z.boolean().optional() },
  },
  ({ id: kid, ...patch }) => call('PATCH', `/keywords/${kid}`, patch),
);

server.registerTool(
  'remove_keyword',
  { title: 'Remove keyword', description: 'Delete a keyword.', inputSchema: { id } },
  ({ id: kid }) => call('DELETE', `/keywords/${kid}`),
);

server.registerTool(
  'get_config',
  { title: 'Get config', description: 'Read all settings (fetch limits, budgets, active hours, comments, matching, capture, sync, retention).', inputSchema: {} },
  () => call('GET', '/config'),
);

server.registerTool(
  'update_config',
  {
    title: 'Update config',
    description:
      'Deep-merge a partial settings patch, e.g. {"fetch": {"max_posts": 40}} or {"active_hours": {"start": "09:00"}}. Arrays replace. Validated; invalid patches are rejected. Applies from the next run.',
    inputSchema: { patch: z.record(z.unknown()) },
  },
  ({ patch }) => call('PATCH', '/config', patch),
);

server.registerTool(
  'get_captures',
  {
    title: 'Get captures',
    description: 'Query captured matches (posts and comments) with their meta.json, filtered by date range (ISO), keyword, target, or sync status.',
    inputSchema: {
      from: z.string().optional(),
      to: z.string().optional(),
      keyword: z.string().optional(),
      target_id: id.optional(),
      sync_status: z.enum(['pending', 'synced', 'failed']).optional(),
      review_status: z
        .enum(['pending', 'kept', 'context', 'rejected', 'all'])
        .optional()
        .describe('Default: everything except rejected. Use kept/context for stored negative mentions.'),
      limit: z.number().int().positive().max(1000).optional(),
    },
  },
  (args) => call('GET', '/captures', undefined, args),
);

server.registerTool(
  'get_run_report',
  {
    title: 'Get run report',
    description: 'Stats for one run (run_id) or a date range (from/to ISO; default = today): page loads, posts scanned, new captures, duplicates skipped, errors.',
    inputSchema: { run_id: id.optional(), from: z.string().optional(), to: z.string().optional() },
  },
  (args) => call('GET', '/report', undefined, args),
);

server.registerTool(
  'start_facebook_group_report',
  {
    title: 'Start Facebook group report',
    description:
      'Collect brand mentions from monitored Facebook groups for the last N days (default 30), with ALL comments of each matching post, for the negative-mentions report. Uses the service\'s own read-only, human-paced browser (no OpenCLI) within page budgets; runs in the background. Returns job_id; poll get_facebook_group_report. If it ends "partial" (budget reached), call again with resume_job_id to continue. Refused with a reason if Facebook is not ready.',
    inputSchema: {
      group_ids: z.array(id).optional().describe('Default: all active Facebook group targets'),
      days: z.number().int().positive().max(90).optional(),
      max_posts_per_group: z.number().int().positive().max(100).optional(),
      resume_job_id: id.optional(),
      mission_id: id.optional().describe('Mission whose search phrases and rules to use (default: the brand/keywords mission)'),
    },
  },
  (args) => call('POST', '/reports/facebook-groups', args),
);

server.registerTool(
  'get_facebook_group_report',
  {
    title: 'Get Facebook group report',
    description:
      'Status (running | partial | done | aborted | failed), progress and collected posts of a report job: group, post link, author, date, text, matched keyword, comment count and all collected comments.',
    inputSchema: { job_id: id },
  },
  ({ job_id }) => call('GET', `/reports/${job_id}`),
);

const platformEnum = z.enum(['facebook', 'news', 'rss', 'youtube', 'reddit']);

server.registerTool(
  'start_find',
  {
    title: 'Start find',
    description:
      'Manual search: find COUNT items of the given TYPES (e.g. negative, scam, promotional, lead, question) in a date range, from given Facebook groups/pages or a general search. Zero-account sources (news, RSS, YouTube, Reddit) run first, then Facebook (read-only, human-paced, page budgets). Runs in the background and returns job_id + plan; poll get_find until status is "ready", then label every item in to_label with submit_find_labels. Items you label with a wanted type are saved to captures for the mission. If kept < count after labelling and status is "partial", call continue_find. Facebook reaches back up to 90 days (older: best-effort year filter). Refused with a reason if busy or nothing can be searched.',
    inputSchema: {
      count: z.number().int().positive().max(200).describe('How many matching items you want'),
      types: z.array(z.string()).min(1).describe('Wanted labels, e.g. ["negative","scam"], ["lead"], ["promotional"]'),
      mission_id: id.optional().describe('Mission whose phrases and rules to use (required when there are several missions)'),
      queries: z.array(z.string()).max(10).optional().describe('One-off search phrases instead of the mission\'s'),
      groups: z.array(z.union([id, z.string().url()])).max(20).optional().describe('Facebook group/page target ids or URLs. Omit for a general search'),
      platforms: z.array(platformEnum).optional().describe('Default: the mission\'s enabled sources'),
      when: z
        .object({
          preset: z.enum(['today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'this_month', 'last_month', 'this_year', 'last_year']).optional(),
          from: z.string().optional().describe('YYYY-MM-DD (your timezone)'),
          to: z.string().optional().describe('YYYY-MM-DD (inclusive)'),
        })
        .optional()
        .describe('Default: last_7_days'),
    },
  },
  (args) => call('POST', '/find', { ...args, when: args.when ?? {} }),
);

server.registerTool(
  'get_find',
  {
    title: 'Get find job',
    description:
      'Status of a find job: collecting (wait and poll again) | ready (label to_label) | partial (more sources left; continue_find) | done (count reached) | exhausted (no more sources in the range) | aborted (Facebook stopped) | failed. Includes progress, notes, the items to label (text, author, date, link, comments) and the items kept so far.',
    inputSchema: { job_id: id },
  },
  ({ job_id }) => call('GET', `/find/${job_id}`),
);

server.registerTool(
  'submit_find_labels',
  {
    title: 'Submit find labels',
    description:
      'Label every item in the current batch (to_label). label = one of the requested types when it fits, else what it is (e.g. "promotional", "neutral", "other"). keep defaults to label being one of the requested types. Kept items are saved to captures (as kept, for the mission) until count is reached. Returns kept_total, wanted and the new status.',
    inputSchema: {
      job_id: id,
      labels: z
        .array(z.object({ item_key: z.string(), label: z.string(), keep: z.boolean().optional(), reason: z.string().describe('One short sentence') }))
        .min(1),
    },
  },
  ({ job_id, labels }) => call('POST', `/find/${job_id}/labels`, { labels }),
);

server.registerTool(
  'continue_find',
  {
    title: 'Continue find',
    description: 'Collect the next batch of a find job (after the current batch is labelled). Refused when done, exhausted, or busy. Then poll get_find again.',
    inputSchema: { job_id: id },
  },
  ({ job_id }) => call('POST', `/find/${job_id}/continue`),
);

server.registerTool(
  'export_find_csv',
  {
    title: 'Export find results as CSV',
    description:
      'Export the results of a find job as CSV: one row per post, followed by one row per collected comment (row_type=comment, parent_item_key = its post). include: kept (default) | labelled (also rejected, with label and reason) | all (also unlabelled). Returns filename, rows, file (a copy the service keeps under data/exports) and csv. Save the csv text UNCHANGED (it starts with a UTF-8 BOM for Excel) into the working folder as filename.',
    inputSchema: { job_id: id, include: z.enum(['kept', 'labelled', 'all']).optional() },
  },
  ({ job_id, include }) => call('GET', `/find/${job_id}/export`, undefined, include ? { include } : undefined),
);

server.registerTool(
  'debug_facebook_snapshot',
  {
    title: 'Debug Facebook snapshot',
    description:
      'Load one Facebook target (1 page load, same safety gates as a scan) and save a sanitized outline of the first posts\' markup (tags, roles, link shapes; no text or names) to the service data/debug folder. Use when doctor warns that Facebook post dates are approximate, and share the saved file with the developer.',
    inputSchema: { target_id: id.optional().describe('Default: the first active Facebook group/page'), posts: z.number().int().positive().max(5).optional() },
  },
  (args) => call('POST', '/debug/facebook-snapshot', args),
);



server.registerTool(
  'list_platforms',
  {
    title: 'List platforms',
    description:
      'Each source platform (facebook, news, rss, youtube, reddit) with its on/off switch, whether credentials are present (and which .env key is missing), readiness ("yes" or why it cannot run), target count, last check, and whether it uses a personal account.',
    inputSchema: {},
  },
  () => call('GET', '/platforms'),
);

server.registerTool(
  'set_platform_enabled',
  {
    title: 'Enable/disable a platform',
    description:
      'Switch a whole platform on or off. Non-destructive: targets, captures and review history are kept, and scanning resumes when switched back on. Takes effect from the next target scanned.',
    inputSchema: { platform: platformEnum, enabled: z.boolean() },
  },
  ({ platform, enabled }) => call('PATCH', `/platforms/${platform}`, { enabled }),
);

server.registerTool(
  'doctor',
  {
    title: 'Doctor',
    description:
      'Health and risk report: environment, each source (Facebook session, news, RSS, YouTube, Reddit), quota, last-run errors, and settings that raise the risk of a Facebook restriction — each with a plain-English fix. live=true also makes one cheap request per API source (never Facebook).',
    inputSchema: { live: z.boolean().optional() },
  },
  ({ live }) => call('GET', '/doctor', undefined, { live: live ? 'true' : undefined }),
);

server.registerTool(
  'get_review_queue',
  {
    title: 'Get review queue',
    description:
      'Captures waiting for your judgement (oldest first). Each entry has the post, its matching comments, and `missions`: the goal, keep_rules and exclude_rules of every mission involved. Each item lists `missions_pending` (mission ids still needing a verdict). Judge each item against EACH pending mission\'s goal and rules, then call submit_reviews. Items with an empty missions_pending are from before missions existed: judge them with the complaint rules (sentiment/promotional). post.needs_review=false means the post is only context. Follow the review-captures skill.',
    inputSchema: { limit: z.number().int().positive().max(100).optional().describe('Captures per page (default 20)') },
  },
  (args) => call('GET', '/review/queue', undefined, args),
);

server.registerTool(
  'submit_reviews',
  {
    title: 'Submit reviews',
    description:
      'Give one verdict per (item, mission). Generic form: keep=true/false against that mission\'s goal and rules, plus a label from the mission template (e.g. leads: hot/warm/cold; complaints: scam/money/service) and optional score 0–3. Complaint form (also accepted): sentiment + promotional (kept = negative and not promotional). mission_id is required when an item has several pending missions. Kept items are stored; an item rejected by every mission has its files deleted (decision logged). A post that is not kept is still stored as context when its comments are kept. Returns counts and remaining_in_queue.',
    inputSchema: {
      decisions: z
        .array(
          z.object({
            item_key: z.string(),
            mission_id: z.number().int().positive().optional(),
            keep: z.boolean().optional(),
            label: z.string().min(1).max(40).optional(),
            score: z.number().int().min(0).max(3).optional(),
            sentiment: z.enum(['negative', 'neutral', 'positive']).optional(),
            promotional: z.boolean().optional(),
            reason: z.string().min(1).max(500).describe('Short justification, e.g. "parent needs O-level maths tutor in DHA"'),
          }),
        )
        .min(1)
        .max(500),
    },
  },
  (args) => call('POST', '/review', args),
);

// --- Missions -----------------------------------------------------------------------------

const missionMatch = z
  .object({
    any: z.array(z.string().min(1)).optional().describe('At least one of these must appear (fuzzy, case/space-insensitive)'),
    all_of: z
      .array(z.array(z.string().min(1)).min(1))
      .optional()
      .describe('Each group must have at least one hit, e.g. [["tutor","tuition"],["need","looking for","required"]]'),
    none: z.array(z.string().min(1)).optional().describe('Any of these vetoes the match (e.g. offers, hiring)'),
  })
  .describe('Cheap prefilter; Claude makes the final call in review');
const missionSources = z
  .object({ facebook: z.boolean(), news: z.boolean(), rss: z.boolean(), youtube: z.boolean(), reddit: z.boolean() })
  .partial();
const missionBody = {
  name: z.string().min(2).max(80),
  template: z.enum(['complaints', 'leads', 'businesses', 'topic', 'custom']),
  goal: z.string().min(5).max(1000).describe('One or two sentences: what to find, for whom, where'),
  match: missionMatch,
  search_queries: z.array(z.string().min(1)).min(1).max(20).describe('Phrases typed into Facebook/news/YouTube/Reddit search, most important first'),
  keep_rules: z.string().max(2000).optional().describe('Default: the template\'s rules'),
  exclude_rules: z.string().max(2000).optional(),
  sources: missionSources.optional().describe('Default: the template\'s sources (within the global platform switches)'),
  target_ids: z.array(id).nullable().optional().describe('Only these groups/pages/feeds/channels; null = all'),
  locale: z.object({ location: z.string().optional(), languages: z.array(z.string()).optional() }).optional(),
  report: z.object({ days: z.number().int().positive().max(90).optional(), format: z.string().optional(), schedule: z.string().optional() }).optional(),
};

server.registerTool(
  'install_service',
  {
    title: 'Install/update the local service',
    description:
      'Install or update the social-listener agent on THIS computer with the installer bundled in the plugin. It needs no admin rights: if Node.js 20+ is missing it downloads the official Node.js privately into the app folder (checksum-verified). It downloads the app from GitHub, installs and builds it, starts it (and at every login), then opens the dashboard. Keeps existing data, settings and the Facebook login. Takes about 3-10 minutes. ONLY call after the user explicitly agreed to install. If the output says Claude must be restarted, tell the user to quit Claude completely and reopen it.',
    inputSchema: {
      confirm: z.literal(true).describe('Must be true: the user agreed to install'),
      repo: z.string().optional().describe('owner/repo override; default is the repo this plugin was built for'),
    },
  },
  async ({ repo }) => {
    const r = await runInstaller(repo, { serverDir: path.dirname(fileURLToPath(import.meta.url)) });
    return r.ok ? ok({ installed: true, log: r.output }) : fail(`Install failed:\n${r.output}`);
  },
);

server.registerTool(
  'list_templates',
  {
    title: 'List mission templates',
    description:
      'Ready-made mission types (complaints, leads, businesses, topic, custom) with default keep/exclude rules, labels, match examples, default sources, report format and schedule. Use them to propose a mission in /setup.',
    inputSchema: {},
  },
  () => call('GET', '/templates'),
);

server.registerTool(
  'list_missions',
  {
    title: 'List missions',
    description:
      'All missions (what the agent is looking for): goal, template, status, match rules, effective search phrases, sources, and verdict counts (pending/kept/rejected).',
    inputSchema: {},
  },
  () => call('GET', '/missions'),
);

server.registerTool(
  'create_mission',
  {
    title: 'Create mission',
    description:
      'Create a mission after the user confirmed it. Unspecified keep/exclude rules, sources and report settings come from the template. Search targets for its phrases are created automatically on the enabled sources.',
    inputSchema: missionBody,
  },
  (args) => call('POST', '/missions', args),
);

server.registerTool(
  'update_mission',
  {
    title: 'Update mission',
    description: 'Change any mission field (arrays replace). Giving the original keyword-based brand mission explicit `match` rules switches it off the keywords list.',
    inputSchema: {
      id,
      ...Object.fromEntries(Object.entries(missionBody).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
      status: z.enum(['active', 'paused']).optional(),
    },
  },
  ({ id: mid, ...patch }) => call('PATCH', `/missions/${mid}`, patch),
);

server.registerTool(
  'set_mission_status',
  {
    title: 'Pause/resume mission',
    description: 'Pause or resume a mission. Paused missions are not matched or searched; their captures and verdicts are kept.',
    inputSchema: { id, status: z.enum(['active', 'paused']) },
  },
  ({ id: mid, status: st }) => call('POST', `/missions/${mid}/status`, { status: st }),
);

server.registerTool(
  'delete_mission',
  {
    title: 'Delete mission',
    description: 'Delete a mission and its verdicts (captures stay). Ask the user to confirm first; pausing is usually better.',
    inputSchema: { id },
  },
  ({ id: mid }) => call('DELETE', `/missions/${mid}`),
);

server.registerTool(
  'get_mission_items',
  {
    title: 'Get mission items',
    description:
      'Items for a mission\'s report: by default those kept (and context posts) in the mission\'s report window, newest first, with verdict label/score/reason, text, author, source, date and link (comments include their post). Use it to write /report <mission>.',
    inputSchema: {
      id,
      status: z.enum(['stored', 'kept', 'context', 'pending', 'rejected']).optional(),
      days: z.number().int().positive().max(365).optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
  },
  ({ id: mid, ...q }) => call('GET', `/missions/${mid}/items`, undefined, q),
);

server.registerTool(
  'get_review_log',
  {
    title: 'Get review log',
    description: 'Audit past review decisions (newest first), optionally only kept, context, or rejected items, with sentiment, promotional flag and reason.',
    inputSchema: { status: z.enum(['kept', 'context', 'rejected']).optional(), limit: z.number().int().positive().max(500).optional() },
  },
  (args) => call('GET', '/review/log', undefined, args),
);

// --- Beginner-friendly tools: Facebook login, dashboard link, find jobs, updates ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse a tool result's JSON (our own ok() output). */
const dataOf = <T>(r: Result): T | null => {
  if (r.isError) return null;
  try {
    return JSON.parse(r.content[0].text) as T;
  } catch {
    return null;
  }
};

server.registerTool(
  'facebook_login_status',
  {
    title: 'Facebook login status',
    description: 'Is the agent logged in to Facebook on this computer? Returns connected (true/false), status (ok | needs_reconnect | unknown…), last check time, any safety pause, and a plain-language message to relay.',
    inputSchema: {},
  },
  async () => ok(loginSummary(dataOf<StatusLite>(await call('GET', '/status')))),
);

server.registerTool(
  'connect_facebook',
  {
    title: 'Log in to Facebook (one time)',
    description:
      'Opens a normal Chrome window on THIS computer at facebook.com, using the agent\'s own dedicated browser profile. The user logs in there (including any 2-step code), then simply CLOSES the window. The login is kept in that profile, so later runs need no login. BEFORE calling: tell the user in chat, in plain words, the account-risk notice — automated reading of Facebook is against Facebook\'s terms and can lead to checkpoints or restrictions; the agent is read-only, slow and human-paced, within daily limits, but the risk is not zero; using a secondary account is safer — and call with accept_risk=true ONLY after the user clearly agrees. Waits up to wait_minutes (default 4) for the window to be closed; if still open, returns waiting=true — then call facebook_login_status after the user says they are done.',
    inputSchema: {
      accept_risk: z.literal(true).describe('true only after the user agreed to the account-risk notice in chat'),
      wait_minutes: z.number().int().min(0).max(10).optional(),
    },
  },
  async ({ wait_minutes }) => {
    const ack = await call('POST', '/session/acknowledge-risk', { acknowledged: true });
    if (ack.isError) return ack;
    const started = await call('POST', '/session/connect');
    if (started.isError) return started;
    const deadline = Date.now() + (wait_minutes ?? 4) * 60_000;
    await sleep(3000);
    while (Date.now() < deadline) {
      const s = dataOf<StatusLite>(await call('GET', '/status'));
      if (s && s.busy !== 'connect') return ok({ waiting: false, ...loginSummary(s) });
      await sleep(5000);
    }
    return ok({
      waiting: true,
      message:
        'The Facebook window is still open on this computer. Log in there (including any code Facebook asks for), then close the window. Tell me when you are done and I will check.',
    });
  },
);

/** Open a URL in the user's default browser (local only). */
function openInBrowser(url: string): boolean {
  try {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

server.registerTool(
  'open_dashboard',
  {
    title: 'Open the dashboard',
    description:
      'Opens the agent\'s local dashboard (Facebook login, API keys for YouTube/Reddit, platforms, targets, health) in the browser on this computer, and returns its private link (it contains this computer\'s access token: do not post it anywhere else). Use for "open settings", "add my YouTube key", or when the user prefers buttons.',
    inputSchema: { open: z.boolean().optional().describe('Default true: open it in the browser now') },
  },
  async ({ open }) => {
    const first = await call('GET', '/status'); // starts the service if needed
    if (first.isError) return first;
    const conn = connection();
    if (!conn) return fail(NOT_RUNNING);
    const link = dashboardLink(conn);
    const opened = open === false ? false : openInBrowser(link);
    return ok({ opened, link, note: 'This link only works on this computer. Keep it private.' });
  },
);

server.registerTool(
  'list_find_jobs',
  {
    title: 'List find jobs',
    description: 'Recent /find jobs, newest first: id, status, mission, types, count wanted, date range, collected and kept. Use it for "my last find", "export my last search", or to resume a partial job.',
    inputSchema: { limit: z.number().int().positive().max(50).optional() },
  },
  ({ limit }) => call('GET', '/find', undefined, { limit }),
);

server.registerTool(
  'update_service',
  {
    title: 'Update the local service',
    description:
      'Update the social-listener service on this computer to the latest version (same as install_service): keeps all data, settings and the Facebook login. Takes a few minutes. ONLY call after the user agreed. Suggest it when get_status shows versions.update_available.',
    inputSchema: { confirm: z.literal(true).describe('Must be true: the user agreed to update') },
  },
  async () => {
    const r = await runInstaller(undefined, { serverDir: path.dirname(fileURLToPath(import.meta.url)) });
    return r.ok ? ok({ updated: true, log: r.output }) : fail(`Update failed:\n${r.output}`);
  },
);

await server.connect(new StdioServerTransport());
