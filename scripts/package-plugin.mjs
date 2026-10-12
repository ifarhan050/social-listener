// Zips plugin/ into dist/social-listener-plugin.zip with the manifest at the archive root.
import fs from 'node:fs';
import path from 'node:path';
import { configuredRepo, installerWithRepo, writeZip } from './zip.mjs';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'plugin');
const out = path.join(root, 'dist', 'social-listener-plugin.zip');
const INCLUDE = ['.claude-plugin', '.mcp.json', 'server', 'skills', 'commands', 'install'];

// The GitHub repo the bundled installer downloads from (left as a placeholder if not set).
const repo = configuredRepo(root);

// Copy the installer into the plugin (repo pinned) and the prompts into the wizard and getting-started skills.
fs.mkdirSync(path.join(src, 'install'), { recursive: true });
for (const f of ['install.ps1', 'install.sh']) fs.writeFileSync(path.join(src, 'install', f), installerWithRepo(root, f, repo));
for (const skill of ['setup-wizard', 'getting-started']) {
  if (!fs.existsSync(path.join(src, 'skills', skill))) continue;
  const dst = path.join(src, 'skills', skill, 'prompts');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(path.join(root, 'prompts'))) fs.copyFileSync(path.join(root, 'prompts', f), path.join(dst, f));
}
if (!repo) console.warn('note: no GitHub repo set (SOCIAL_LISTENER_REPO or package.json socialListener.repo) — install_service will ask for one');

const files = [];
const walk = (rel) => {
  const abs = path.join(src, rel);
  if (fs.statSync(abs).isDirectory()) for (const e of fs.readdirSync(abs).sort()) walk(path.join(rel, e));
  else files.push(rel.split(path.sep).join('/'));
};
for (const i of INCLUDE) walk(i);

const size = writeZip(
  out,
  files.map((name) => ({ name, data: fs.readFileSync(path.join(src, name)), executable: name.endsWith('.sh') })),
);
console.log(`${path.relative(root, out)}: ${files.length} files, ${size} bytes`);
