import { sleep } from '../../util/random.js';
import { logger } from '../../util/logger.js';

export const USER_AGENT = 'social-listener/0.1 (+local brand monitoring; read-only)';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  /** Minimum spacing between requests to the same host. */
  minHostIntervalMs?: number;
  retries?: number;
}

/**
 * Polite HTTP GET for public feeds and APIs: identifies itself, spaces requests per
 * host, retries 429/5xx with backoff, and times out. No cookies, no proxies.
 */
export class HttpClient {
  private fetchImpl: typeof fetch;
  private sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private lastByHost = new Map<string, number>();

  constructor(private opts: HttpOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleepImpl = opts.sleep ?? sleep;
  }

  async get(url: string, init: { headers?: Record<string, string>; signal?: AbortSignal; accept?: string } = {}): Promise<Response> {
    const host = new URL(url).host;
    const retries = this.opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const wait = (this.lastByHost.get(host) ?? 0) + (this.opts.minHostIntervalMs ?? 1000) - Date.now();
      if (wait > 0) await this.sleepImpl(wait, init.signal);
      this.lastByHost.set(host, Date.now());

      const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 20_000);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: init.accept ?? '*/*', ...init.headers },
        signal,
        redirect: 'follow',
      });
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const backoff = 2000 * 2 ** attempt;
        logger.warn({ host, status: res.status, backoff }, 'http request failed — retrying');
        await this.sleepImpl(backoff, init.signal);
        continue;
      }
      throw new HttpError(res.status, `GET ${host} failed with ${res.status}`);
    }
  }

  async text(url: string, init?: Parameters<HttpClient['get']>[1]): Promise<string> {
    return (await this.get(url, init)).text();
  }

  async json<T>(url: string, init?: Parameters<HttpClient['get']>[1]): Promise<T> {
    return (await (await this.get(url, { accept: 'application/json', ...init })).json()) as T;
  }
}
