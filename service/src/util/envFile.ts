import fs from 'node:fs';

/** API keys the dashboard may set. Everything else in .env is left alone. */
export const SECRET_KEYS = ['YOUTUBE_API_KEY', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Quote a value for .env (dotenv syntax) when it has spaces, quotes or #. */
function envValue(v: string): string {
  return /[\s"'#\\]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
}

/**
 * Set or remove keys in a .env file, keeping comments and other lines in place.
 * `null` or '' removes the key. Creates the file (owner-only) if missing.
 */
export function upsertEnvFile(file: string, updates: Partial<Record<string, string | null>>): void {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const out: string[] = [];
  for (const line of lines) {
    const k = LINE.exec(line)?.[1];
    if (k && pending.has(k)) {
      const v = pending.get(k);
      pending.delete(k);
      if (v) out.push(`${k}=${envValue(v)}`);
      continue;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of pending) if (v) out.push(`${k}=${envValue(v)}`);
  fs.writeFileSync(file, `${out.join('\n')}\n`, { mode: 0o600 });
}

/** "set" / "not set" per secret key, from the current environment (never the values). */
export function secretsStatus(env: NodeJS.ProcessEnv = process.env): Record<SecretKey, 'set' | 'not set'> {
  return Object.fromEntries(SECRET_KEYS.map((k) => [k, env[k] ? 'set' : 'not set'])) as Record<SecretKey, 'set' | 'not set'>;
}
