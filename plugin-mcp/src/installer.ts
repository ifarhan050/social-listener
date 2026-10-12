import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

export interface InstallDeps {
  /** Folder of the bundled proxy (plugin/server); the installer lives in plugin/install. */
  serverDir: string;
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
}

/** The installer script shipped inside the plugin (never a downloaded path). */
export function bundledInstaller(serverDir: string, platform: NodeJS.Platform = process.platform): string | null {
  const file = path.join(serverDir, '..', 'install', platform === 'win32' ? 'install.ps1' : 'install.sh');
  return fs.existsSync(file) ? file : null;
}

/**
 * Run the plugin's bundled installer (download project from its pinned GitHub repo,
 * npm ci, build, start). Only called after the user explicitly agreed in chat.
 */
export async function runInstaller(repo: string | undefined, deps: InstallDeps): Promise<{ ok: boolean; output: string }> {
  const platform = deps.platform ?? process.platform;
  const script = bundledInstaller(deps.serverDir, platform);
  if (!script) return { ok: false, output: 'The installer is not bundled with this plugin build. Run the install command from the README instead.' };
  if (repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { ok: false, output: 'repo must look like owner/repo' };

  const [cmd, args] =
    platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...(repo ? ['-Repo', repo] : [])]]
      : ['bash', [script, ...(repo ? ['--repo', repo] : [])]];
  const spawn = deps.spawn ?? nodeSpawn;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const append = (d: Buffer) => {
      out = (out + d.toString()).slice(-20_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, output: `${out}\n(installer timed out)` });
    }, deps.timeoutMs ?? 20 * 60_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${out}\n${String(err)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.split('\n').slice(-40).join('\n') });
    });
  });
}
