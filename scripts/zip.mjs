// Minimal zip writer (node:zlib only), so packaging doesn't depend on which `zip`/`tar` is on PATH.
// Entries with `executable: true` get Unix 0755 permissions (macOS keeps them when unzipping,
// so "Install on Mac.command" can be double-clicked).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** @param {string} out @param {{ name: string, data: Buffer, executable?: boolean }[]} entries */
export function writeZip(out, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, executable } of entries) {
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0x00210000, 10); // 1980-01-01 00:00
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, so the mode below is honoured
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((executable ? 0o100755 : 0o100644) << 16) >>> 0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }

  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([...locals, cd, end]));
  return fs.statSync(out).size;
}

/** The GitHub repo baked into installers: SOCIAL_LISTENER_REPO, or package.json socialListener.repo. */
export function configuredRepo(root) {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const repo = process.env.SOCIAL_LISTENER_REPO || rootPkg.socialListener?.repo || '';
  if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`invalid repo "${repo}" (expected owner/repo)`);
  return repo;
}

/** An installer script with the repo filled in. */
export function installerWithRepo(root, file, repo) {
  let body = fs.readFileSync(path.join(root, 'install', file), 'utf8');
  if (/\.(sh|command)$/.test(file)) body = toLf(body); // bash on macOS fails on CRLF
  return repo ? body.replaceAll('__SOCIAL_LISTENER_REPO__', repo) : body;
}

/** Unix line endings (for shell scripts). */
export const toLf = (s) => s.replace(/\r\n/g, '\n');
