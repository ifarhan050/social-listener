// Builds dist/Social-Listener-Setup.zip: everything a new user downloads.
//   Social Listener Setup/
//     START HERE.html               picture-free one-page guide
//     Install on Windows.cmd        double-click (runs install.ps1)
//     Install on Mac.command        double-click (runs install.sh)
//     Uninstall on Windows.cmd / Uninstall on Mac.command
//     install.ps1, install.sh       the installers (repo filled in)
//     social-listener-plugin.zip    upload this in Claude -> Customize -> Plugins
// Run `npm run package:plugin` first (the release script does it for you).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configuredRepo, installerWithRepo, toLf, writeZip } from './zip.mjs';

const root = path.resolve(import.meta.dirname, '..');
const repo = configuredRepo(root);
if (!repo) throw new Error('set socialListener.repo in package.json (or SOCIAL_LISTENER_REPO) before building a release');
const plugin = path.join(root, 'dist', 'social-listener-plugin.zip');
if (!fs.existsSync(plugin)) throw new Error('dist/social-listener-plugin.zip is missing: run npm run package:plugin first');

const version = JSON.parse(fs.readFileSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version;
const dir = 'Social Listener Setup';
const read = (...p) => fs.readFileSync(path.join(root, ...p));
const guide = read('docs', 'START-HERE.html').toString('utf8').replaceAll('__VERSION__', version).replaceAll('__SOCIAL_LISTENER_REPO__', repo);

const entries = [
  { name: `${dir}/START HERE.html`, data: Buffer.from(guide, 'utf8') },
  { name: `${dir}/Install on Windows.cmd`, data: read('install', 'Install on Windows.cmd') },
  { name: `${dir}/Install on Mac.command`, data: Buffer.from(toLf(read('install', 'Install on Mac.command').toString('utf8'))), executable: true },
  { name: `${dir}/Uninstall on Windows.cmd`, data: read('install', 'Uninstall on Windows.cmd') },
  { name: `${dir}/Uninstall on Mac.command`, data: Buffer.from(toLf(read('install', 'Uninstall on Mac.command').toString('utf8'))), executable: true },
  { name: `${dir}/install.ps1`, data: Buffer.from(installerWithRepo(root, 'install.ps1', repo), 'utf8') },
  { name: `${dir}/install.sh`, data: Buffer.from(installerWithRepo(root, 'install.sh', repo), 'utf8'), executable: true },
  { name: `${dir}/social-listener-plugin.zip`, data: fs.readFileSync(plugin) },
];
const out = path.join(root, 'dist', 'Social-Listener-Setup.zip');
const size = writeZip(out, entries);
console.log(`${path.relative(root, out)}: v${version}, ${entries.length} files, ${size} bytes (repo ${repo})`);

// social-listener.plugin: the plugin zip under the name Cowork shows as an installable card
// (INSTALL.md has Claude download it). SHA256SUMS.txt lets Claude verify every asset.
const dotPlugin = path.join(root, 'dist', 'social-listener.plugin');
fs.copyFileSync(plugin, dotPlugin);
const assets = [out, plugin, dotPlugin];
const sums = assets.map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${path.basename(f)}`).join('\n') + '\n';
fs.writeFileSync(path.join(root, 'dist', 'SHA256SUMS.txt'), sums);
fs.writeFileSync(path.join(root, 'dist', 'VERSION.txt'), `${version}\n`);
console.log(`dist/social-listener.plugin, dist/SHA256SUMS.txt, dist/VERSION.txt (v${version})`);
