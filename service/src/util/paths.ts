import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** service/ directory (works from both src/ via tsx and dist/). */
export const SERVICE_ROOT = path.resolve(here, '..', '..');
/** The service's version (package.json), shown in status so Cowork can spot an outdated install. */
export const SERVICE_VERSION: string = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();
/** Secrets file (API keys) read at start by dotenv. */
export const ENV_FILE = path.join(SERVICE_ROOT, '.env');

export const DATA_DIR = process.env.SOCIAL_LISTENER_DATA_DIR
  ? path.resolve(process.env.SOCIAL_LISTENER_DATA_DIR)
  : path.join(SERVICE_ROOT, 'data');

export const DB_PATH = path.join(DATA_DIR, 'social-listener.sqlite');
export const BROWSER_PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
export const CAPTURES_DIR = path.join(DATA_DIR, 'captures');

/** Where the service publishes {url, token} for the MCP proxy. */
export const CONNECTION_DIR = path.join(os.homedir(), '.social-listener');
export const CONNECTION_FILE = path.join(CONNECTION_DIR, 'connection.json');
