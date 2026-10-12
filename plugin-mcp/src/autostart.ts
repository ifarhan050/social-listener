import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

/** Written by the service into ~/.social-listener/connection.json (see service/src/app.ts). */
export interface LaunchSpec {
  node: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Only ever start *our* service: the node binary that ran it before, from a folder whose
 * package.json is @social-listener/service, with scripts inside that project. Never an
 * arbitrary command from the file.
 */
export function validateLaunch(spec: unknown): { ok: true; spec: LaunchSpec } | { ok: false; reason: string } {
  const s = spec as Partial<LaunchSpec> | undefined;
  if (!s || typeof s !== 'object') return { ok: false, reason: 'no launch info (start the service once with `npm run start`)' };
  if (typeof s.node !== 'string' || !path.isAbsolute(s.node) || !/^node(\.exe)?$/i.test(path.basename(s.node)) || !fs.existsSync(s.node))
    return { ok: false, reason: 'launch info has an invalid node path' };
  if (typeof s.cwd !== 'string' || !path.isAbsolute(s.cwd)) return { ok: false, reason: 'launch info has an invalid folder' };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(s.cwd, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name !== '@social-listener/service') return { ok: false, reason: 'launch folder is not the social-listener service' };
  } catch {
    return { ok: false, reason: 'launch folder has no package.json' };
  }
  const project = path.dirname(s.cwd);
  if (!Array.isArray(s.args) || !s.args.length || !s.args.every((a) => typeof a === 'string' && path.isAbsolute(a) && isInside(a, project) && fs.existsSync(a)))
    return { ok: false, reason: 'launch info has invalid script paths' };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.env ?? {})) if (/^(SOCIAL_LISTENER_|LOG_LEVEL$)/.test(k) && typeof v === 'string') env[k] = v;
  return { ok: true, spec: { node: s.node, args: s.args, cwd: s.cwd, env } };
}

export interface EnsureDeps {
  spawn?: typeof nodeSpawn;
  /** Returns true when the service answers /api/status. */
  ping: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** Start the service in the background (detached, no window) and wait until it answers. */
export async function startService(spec: LaunchSpec, deps: EnsureDeps): Promise<{ ok: boolean; reason?: string }> {
  const spawn = deps.spawn ?? nodeSpawn;
  const wait = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const dataDir = spec.env.SOCIAL_LISTENER_DATA_DIR ?? path.join(spec.cwd, 'data');
  let out: number | 'ignore' = 'ignore';
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    out = fs.openSync(path.join(dataDir, 'service.log'), 'a');
  } catch {
    /* log file is optional */
  }
  const child = spawn(spec.node, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  const deadline = Date.now() + (deps.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    await wait(1000);
    if (await deps.ping()) return { ok: true };
  }
  return { ok: false, reason: `service did not answer within ${Math.round((deps.timeoutMs ?? 30_000) / 1000)} s (see ${path.join(dataDir, 'service.log')})` };
}
