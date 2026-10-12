import { sleep } from '../../util/random.js';
import { logger } from '../../util/logger.js';

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  userAgent: string;
}

export interface RedditClientOptions {
  minIntervalMs: () => number;
  maxRequestsPerRun: () => number;
  fetch?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export class RedditApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown when the per-run request cap is reached; the adapter stops the target cleanly. */
export class RedditBudgetExhausted extends Error {
  constructor() {
    super('reddit per-run request cap reached');
  }
}

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';
const MAX_RETRIES = 3;

/**
 * Minimal read-only client for Reddit's official Data API (spec §16 Phase 4).
 * App-only OAuth (client_credentials): reads public content, no user login.
 * Paces requests, honours X-Ratelimit-* headers, retries 429/5xx with backoff,
 * and enforces a hard per-run request cap.
 */
export class RedditClient {
  private token: { value: string; expiresAt: number } | null = null;
  private lastRequestAt = 0;
  private runId: number | null = null;
  private used = 0;
  private fetchImpl: typeof fetch;
  private sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private nowImpl: () => number;

  constructor(
    private creds: RedditCredentials | null,
    private opts: RedditClientOptions,
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleepImpl = opts.sleep ?? sleep;
    this.nowImpl = opts.now ?? Date.now;
  }

  static fromEnv(env: NodeJS.ProcessEnv, opts: RedditClientOptions): RedditClient {
    const { REDDIT_CLIENT_ID: id, REDDIT_CLIENT_SECRET: secret, REDDIT_USER_AGENT: ua } = env;
    const creds = id && secret ? { clientId: id, clientSecret: secret, userAgent: ua || 'windows:social-listener:0.1.0' } : null;
    return new RedditClient(creds, opts);
  }

  get configured(): boolean {
    return this.creds !== null;
  }

  /** Requests made in the current run. */
  get requestsUsed(): number {
    return this.used;
  }

  /** Reset the per-run counter when a new run starts. */
  beginRun(runId: number): void {
    if (this.runId !== runId) {
      this.runId = runId;
      this.used = 0;
    }
  }

  private async pace(signal?: AbortSignal): Promise<void> {
    if (this.used >= this.opts.maxRequestsPerRun()) throw new RedditBudgetExhausted();
    const wait = this.lastRequestAt + this.opts.minIntervalMs() - this.nowImpl();
    if (wait > 0) await this.sleepImpl(wait, signal);
    this.lastRequestAt = this.nowImpl();
    this.used++;
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    if (!this.creds) throw new RedditApiError(0, 'Reddit is not configured (set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env)');
    if (this.token && this.token.expiresAt > this.nowImpl() + 60_000) return this.token.value;
    await this.pace(signal);
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64')}`,
        'user-agent': this.creds.userAgent,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      throw new RedditApiError(res.status, `Reddit token request failed (${res.status}${body.error ? `: ${body.error}` : ''})`);
    }
    this.token = { value: body.access_token, expiresAt: this.nowImpl() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** Verify credentials. Uses one request at most (the token request). */
  async check(signal?: AbortSignal): Promise<void> {
    await this.accessToken(signal);
  }

  /** GET an API path (e.g. `/r/pakistan/new`). Read-only by construction. */
  async get<T>(path: string, params: Record<string, string | number | undefined> = {}, signal?: AbortSignal): Promise<T> {
    const url = new URL(path, API_BASE);
    url.searchParams.set('raw_json', '1');
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(signal);
      await this.pace(signal);
      const res = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, 'user-agent': this.creds!.userAgent },
        signal,
      });

      // Back off when the window is nearly used up.
      const remaining = Number(res.headers.get('x-ratelimit-remaining'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      if (Number.isFinite(remaining) && remaining < 2 && Number.isFinite(reset)) {
        logger.info({ reset }, 'reddit rate limit nearly exhausted — waiting');
        await this.sleepImpl((reset + 1) * 1000, signal);
      }

      if (res.ok) return (await res.json()) as T;
      if (res.status === 401 && attempt < MAX_RETRIES) {
        this.token = null; // expired/revoked — fetch a new one
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const backoff = Number.isFinite(reset) && res.status === 429 ? (reset + 1) * 1000 : 2000 * 2 ** attempt;
        logger.warn({ status: res.status, backoff, path }, 'reddit request failed — retrying');
        await this.sleepImpl(backoff, signal);
        continue;
      }
      throw new RedditApiError(res.status, `Reddit API ${res.status} for ${path}`);
    }
  }
}
