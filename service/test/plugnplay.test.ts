import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertEnvFile, secretsStatus } from '../src/util/envFile.js';
import { createService, type Service } from '../src/app.js';
import { createApp } from '../src/api/server.js';
import { SERVICE_VERSION } from '../src/util/paths.js';
import { dashboardLink, loginSummary, newer } from '../../plugin-mcp/src/helpers.js';

describe('.env updates', () => {
  it('sets, replaces and removes keys while keeping comments and other settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-env-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, '# my settings\nSOCIAL_LISTENER_PORT=4737\nYOUTUBE_API_KEY=old\n# REDDIT_CLIENT_ID=\nLOG_LEVEL=info\n');
    upsertEnvFile(file, { YOUTUBE_API_KEY: 'AIza123', REDDIT_CLIENT_ID: 'abc', REDDIT_USER_AGENT: 'windows:sl:0.2.0 (by /u/me)' });
    let text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# my settings\nSOCIAL_LISTENER_PORT=4737\nYOUTUBE_API_KEY=AIza123\n# REDDIT_CLIENT_ID=\nLOG_LEVEL=info\n');
    expect(text).toContain('REDDIT_CLIENT_ID=abc\n');
    expect(text).toContain('REDDIT_USER_AGENT="windows:sl:0.2.0 (by /u/me)"\n'); // spaces → quoted
    upsertEnvFile(file, { YOUTUBE_API_KEY: null });
    text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/^YOUTUBE_API_KEY=/m);
    expect(text).toContain('LOG_LEVEL=info');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports only set / not set', () => {
    expect(secretsStatus({ YOUTUBE_API_KEY: 'x' })).toEqual({
      YOUTUBE_API_KEY: 'set',
      REDDIT_CLIENT_ID: 'not set',
      REDDIT_CLIENT_SECRET: 'not set',
      REDDIT_USER_AGENT: 'not set',
    });
  });
});

describe('API keys, find job list and version over the API', () => {
  let svc: Service;
  let server: Server;
  let base: string;
  let dir: string;
  const TOKEN = 'p'.repeat(40);
  const saved = { ...process.env };

  beforeAll(async () => {
    for (const k of ['YOUTUBE_API_KEY', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT']) delete process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-pnp-'));
    svc = createService({ dbPath: ':memory:', capturesDir: path.join(dir, 'captures'), dataDir: dir, envFile: path.join(dir, '.env') });
    server = createApp({
      repos: svc.repos, config: svc.config, state: svc.state, runner: svc.runner, review: svc.review,
      registry: svc.registry, http: svc.http, find: svc.find, updateSecrets: svc.updateSecrets,
      token: TOKEN, port: 0, connectFacebook: async () => undefined, startedAt: new Date(),
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterAll(async () => {
    server?.close();
    await svc?.shutdown();
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const api = async (p: string, init: RequestInit = {}) => {
    const r = await fetch(base + p, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
    return { status: r.status, text: await r.text() };
  };

  it('saves API keys to .env, switches YouTube on without a restart, and never returns the values', async () => {
    expect(svc.registry.forTarget({ platform: 'youtube', kind: 'search' })!.isConfigured()).toBe(false);
    const put = await api('/secrets', { method: 'PUT', body: JSON.stringify({ YOUTUBE_API_KEY: 'AIzaSECRET123' }) });
    expect(put.status).toBe(200);
    expect(put.text).not.toContain('AIzaSECRET123');
    expect(JSON.parse(put.text)).toMatchObject({ YOUTUBE_API_KEY: 'set', REDDIT_CLIENT_ID: 'not set' });
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toContain('YOUTUBE_API_KEY=AIzaSECRET123');
    expect(svc.registry.forTarget({ platform: 'youtube', kind: 'search' })!.isConfigured()).toBe(true);
    const get = await api('/secrets');
    expect(get.text).not.toContain('AIzaSECRET123');
    // Clearing a key turns the source off again.
    await api('/secrets', { method: 'PUT', body: JSON.stringify({ YOUTUBE_API_KEY: null }) });
    expect(svc.registry.forTarget({ platform: 'youtube', kind: 'search' })!.isConfigured()).toBe(false);
  });

  it('rejects unknown keys and multi-line values', async () => {
    expect((await api('/secrets', { method: 'PUT', body: JSON.stringify({ PATH: 'x' }) })).status).toBe(400);
    expect((await api('/secrets', { method: 'PUT', body: JSON.stringify({ YOUTUBE_API_KEY: 'a\nLOG_LEVEL=trace' }) })).status).toBe(400);
  });

  it('lists find jobs newest first and reports the version', async () => {
    expect(JSON.parse((await api('/find')).text)).toEqual([]);
    const status = JSON.parse((await api('/status')).text) as { service: { version: string } };
    expect(status.service.version).toBe(SERVICE_VERSION);
    expect(SERVICE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('plugin helpers', () => {
  it('compares versions', () => {
    expect(newer('0.2.0', '0.1.9')).toBe(true);
    expect(newer('0.2.0', '0.2.0')).toBe(false);
    expect(newer('0.10.0', '0.9.0')).toBe(true);
    expect(newer('0.1.0', '0.2.0')).toBe(false);
  });

  it('summarises the Facebook login in plain words', () => {
    const now = new Date('2026-10-09T10:00:00Z');
    expect(loginSummary({ busy: null, session: { status: 'ok', checked_at: 'x', paused_until: null } }, now)).toMatchObject({ connected: true });
    const paused = loginSummary({ busy: null, session: { status: 'ok', checked_at: null, paused_until: '2026-10-10T00:00:00Z' } }, now);
    expect(paused.message).toMatch(/paused until/);
    expect(loginSummary({ busy: null, session: { status: 'needs_reconnect', checked_at: null, paused_until: null } }, now).message).toMatch(/connect-facebook/);
    expect(loginSummary(null).connected).toBe(false);
  });

  it('builds the dashboard link with the token in the fragment', () => {
    expect(dashboardLink({ url: 'http://127.0.0.1:4737/', token: 'abc' })).toBe('http://127.0.0.1:4737/#token=abc');
  });
});
