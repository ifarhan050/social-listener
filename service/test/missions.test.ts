import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDb, type Repos } from '../src/db/index.js';
import { ConfigStore, StateStore } from '../src/config/store.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { HttpClient, RssFeedAdapter } from '../src/adapters/feeds/index.js';
import { Capturer, type CaptureMeta } from '../src/capture/index.js';
import { Runner } from '../src/scheduler/runner.js';
import { ReviewService } from '../src/review/index.js';
import { createApp } from '../src/api/server.js';
import { syncSearchTargets, dueTargets } from '../src/scheduler/searchTargets.js';
import { LEGACY_MISSION_NAME, MissionMatcher, TEMPLATES, ensureLegacyMission, withTemplateDefaults } from '../src/missions/index.js';
import { bundledInstaller, runInstaller } from '../../plugin-mcp/src/installer.js';

const opts = { fuzzyMaxDistance: 1, fuzzyMinLength: 6 };
const NOW = new Date();

const leadsMission = (repos: Repos, extra: Record<string, unknown> = {}) =>
  repos.missions.create(
    withTemplateDefaults({
      name: 'Tuition leads Lahore',
      template: 'leads',
      goal: 'Find parents in Lahore looking for O/A-level maths tutors.',
      match: TEMPLATES.leads.match_example,
      search_queries: ['need home tutor Lahore', 'tutor chahiye'],
      ...extra,
    }),
  );

// --- Matching ----------------------------------------------------------------------------

describe('mission matching', () => {
  const repos = openDb(':memory:');
  const leads = leadsMission(repos);
  const topic = repos.missions.create(withTemplateDefaults({ name: 'E-bikes', template: 'topic', goal: 'E-bikes in Pakistan', match: { any: ['electric bike', 'e-bike'] }, search_queries: ['electric bike'] }));
  const mm = new MissionMatcher(repos.missions.list(), [], opts);

  it.each([
    'Need a home tutor for O level maths in DHA Lahore',
    'Looking for tuition teacher for my son, A levels physics',
    'Maths tutor chahiye Johar Town',
  ])('leads: matches request "%s"', (text) => {
    expect(mm.match(text).map((h) => h.mission_id)).toEqual([leads.id]);
  });

  it.each(['Experienced tutor available for tuition, contact me', 'We offer O level classes, academy admissions open', 'I love teaching'])(
    'leads: ignores offers / unrelated "%s"',
    (text) => expect(mm.match(text)).toEqual([]),
  );

  it('one text can match several missions', () => {
    const hits = mm.match('Need a tutor who can also explain how an electric bike motor works');
    expect(hits.map((h) => h.mission_name).sort()).toEqual(['E-bikes', 'Tuition leads Lahore']);
    expect(hits.find((h) => h.mission_id === topic.id)!.terms).toEqual(['electric bike']);
  });

  it('respects per-mission sources and target restrictions', () => {
    repos.missions.update(leads.id, { sources: { ...leads.sources, facebook: false }, target_ids: [7] });
    const mm2 = new MissionMatcher(repos.missions.list(), [], opts);
    const t = 'need home tutor in Gulberg';
    expect(mm2.match(t, { platform: 'facebook', targetId: 7 })).toEqual([]);
    expect(mm2.match(t, { platform: 'rss', targetId: 8, targetKind: 'feed' })).toEqual([]);
    expect(mm2.match(t, { platform: 'rss', targetId: 7, targetKind: 'feed' })).toHaveLength(1);
    expect(mm2.match(t, { platform: 'reddit', targetId: 99, targetKind: 'search' })).toHaveLength(1); // searches aren't restricted by target_ids
    expect(mm2.match(t, { platform: 'news', targetId: 99, targetKind: 'search' })).toEqual([]); // leads template has news off
  });

  it('missions without rules match nothing', () => {
    const r2 = openDb(':memory:');
    r2.missions.create({ name: 'empty', template: 'custom', goal: 'nothing yet', match: {} });
    expect(new MissionMatcher(r2.missions.list(), [], opts).match('anything at all')).toEqual([]);
  });
});

// --- Upgrade path ------------------------------------------------------------------------

describe('existing installs become mission #1', () => {
  it('turns keywords into the brand mission once and links old captures', () => {
    const repos = openDb(':memory:');
    repos.keywords.add({ keyword: 'xyzbank', variants: ['xyz bank'], negatives: ['hiring'] });
    repos.seen.insert({ item_key: 'fb:post:1', type: 'post', first_seen: NOW.toISOString(), is_match: 1, review_status: 'kept', matched_keyword: 'xyzbank' });
    const m = ensureLegacyMission(repos)!;
    expect(m).toMatchObject({ name: LEGACY_MISSION_NAME, template: 'complaints', match: { use_keywords: true } });
    expect(repos.missions.forItem('fb:post:1')).toEqual([expect.objectContaining({ mission_id: m.id, review_status: 'kept' })]);
    // Live keywords: later keyword changes apply without editing the mission.
    repos.keywords.add({ keyword: 'abcbank' });
    const mm = new MissionMatcher(repos.missions.list(), repos.keywords.list(), opts);
    expect(mm.match('abcbank app down')[0]).toMatchObject({ mission_id: m.id, folder: 'abcbank' });
    expect(mm.match('xyz bank is hiring')).toEqual([]); // keyword negatives still apply
    // Runs once: deleting it doesn't bring it back.
    repos.missions.remove(m.id);
    expect(ensureLegacyMission(repos)).toBeNull();
  });

  it('fresh installs start without placeholder keywords or missions', () => {
    const repos = openDb(':memory:');
    expect(ensureLegacyMission(repos)).toBeNull();
    expect(repos.missions.count()).toBe(0);
  });
});

// --- Search targets -------------------------------------------------------------------------

describe('search targets per mission', () => {
  it('creates searches for each mission phrase, caps Facebook across missions, keeps paused rows', () => {
    const repos = openDb(':memory:');
    const config = new ConfigStore(repos.settings);
    const leads = leadsMission(repos, { sources: { facebook: true, news: true } });
    repos.missions.create(withTemplateDefaults({ name: 'Topic', template: 'topic', goal: 'e-bikes', match: { any: ['e-bike'] }, search_queries: ['e-bike price', 'electric scooter'] }));
    syncSearchTargets(repos, ['facebook', 'news'], { facebookMaxQueries: 3 });
    const names = (p: string) => repos.targets.list().filter((t) => t.platform === p && t.kind === 'search').map((t) => t.name);
    expect(names('facebook')).toEqual(['Search: need home tutor Lahore', 'Search: tutor chahiye', 'Search: e-bike price']);
    expect(names('news')).toHaveLength(4);

    repos.missions.update(leads.id, { status: 'paused' });
    syncSearchTargets(repos, ['facebook', 'news'], { facebookMaxQueries: 3 });
    expect(names('news')).toHaveLength(4); // paused mission's rows kept…
    const due = dueTargets(config.get(), repos, NOW, ['facebook', 'news'], { facebookMaxQueries: 3 }).map((t) => t.name);
    expect(due.some((n) => n?.includes('tutor'))).toBe(false); // …but not scanned
  });
});

// --- End to end: runner + review + API ---------------------------------------------------------

describe('missions end to end (mock RSS)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-missions-'));
  const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toUTCString();
  const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Lahore Parents Forum</title>
    <item><title>Need home tutor for O level maths in DHA</title><link>https://forum.pk/t/1</link><guid>1</guid><pubDate>${ago(30)}</pubDate><description>Son in O2, need tutor 4 days a week, DHA phase 5</description></item>
    <item><title>XYZ Bank froze my card and no one answers - also need a maths tutor for my daughter</title><link>https://forum.pk/t/2</link><guid>2</guid><pubDate>${ago(40)}</pubDate></item>
    <item><title>Experienced tutor available for tuition, contact me</title><link>https://forum.pk/t/3</link><guid>3</guid><pubDate>${ago(50)}</pubDate></item>
    <item><title>Cricket tonight?</title><link>https://forum.pk/t/4</link><guid>4</guid><pubDate>${ago(60)}</pubDate></item>
  </channel></rss>`;
  let repos: Repos;
  let config: ConfigStore;
  let runner: Runner;
  let review: ReviewService;
  let server: Server;
  let base: string;
  let leadsId: number;
  let brandId: number;
  const TOKEN = 'm'.repeat(40);

  beforeAll(async () => {
    repos = openDb(':memory:');
    config = new ConfigStore(repos.settings);
    const state = new StateStore(repos.settings);
    config.update({ active_hours: { start: '00:00', end: '00:00' } });
    repos.keywords.add({ keyword: 'XYZ Bank' });
    brandId = ensureLegacyMission(repos)!.id;
    leadsId = leadsMission(repos).id;
    repos.targets.add({ platform: 'rss', kind: 'feed', url: 'https://forum.pk/feed', name: 'Lahore Parents Forum' });

    const http = new HttpClient({
      fetch: (async () => new Response(RSS)) as typeof fetch,
      sleep: async () => undefined,
      minHostIntervalMs: 0,
    });
    const registry = new AdapterRegistry();
    registry.register(new RssFeedAdapter(http, () => config.get()));
    runner = new Runner({ repos, config, state, registry, capturer: new Capturer(repos, () => config.get(), dir), closeBrowser: async () => undefined });
    review = new ReviewService(repos, () => config.get(), dir);
    server = createApp({
      repos, config, state, runner, review, registry, http,
      token: TOKEN, port: 0, connectFacebook: async () => undefined, startedAt: NOW,
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    await runner.start({ trigger: 'manual' }).done;
  });

  afterAll(() => {
    server?.close();
    repos?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const api = async (p: string, init: RequestInit = {}) => {
    const r = await fetch(base + p, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
    return { status: r.status, body: (await r.json()) as any };
  };

  it('captures each post for the missions it matches, in per-mission folders', () => {
    const forItem = (guidN: string) => {
      const row = repos.db.prepare("SELECT item_key FROM seen_items WHERE type='post' AND is_match=1").all() as { item_key: string }[];
      return row.map((r) => r.item_key);
    };
    expect(forItem('x')).toHaveLength(2); // the offer and the cricket post are not captured
    const rows = repos.db.prepare('SELECT mission_id, COUNT(*) n FROM item_missions GROUP BY mission_id ORDER BY mission_id').all();
    expect(rows).toEqual([
      { mission_id: brandId, n: 1 },
      { mission_id: leadsId, n: 2 },
    ]);
    const leadOnly = repos.seen.queryCaptures({ review_status: 'all' }).find((r) => repos.missions.forItem(r.item_key).length === 1 && repos.missions.forItem(r.item_key)[0].mission_id === leadsId)!;
    expect(leadOnly.capture_path).toMatch(/Tuition-leads-Lahore/);
    const meta = JSON.parse(fs.readFileSync(path.join(leadOnly.capture_path!, 'meta.json'), 'utf8')) as CaptureMeta;
    expect(meta.missions).toEqual([{ id: leadsId, name: 'Tuition leads Lahore', template: 'leads', terms: expect.arrayContaining(['tutor']) }]);
  });

  it('the review queue carries each mission\'s goal and rules, per item', async () => {
    const { body } = await api('/review/queue');
    const both = body.captures.find((c: any) => c.post.missions_pending.length === 2);
    expect(both.missions.map((m: any) => m.name).sort()).toEqual([LEGACY_MISSION_NAME, 'Tuition leads Lahore']);
    expect(both.missions.find((m: any) => m.template === 'leads')).toMatchObject({ labels: ['hot', 'warm', 'cold'], keep_rules: expect.stringContaining('ASKING FOR') });
  });

  it('verdicts are per mission; an item is stored if any mission keeps it', async () => {
    const { body: q } = await api('/review/queue');
    const both = q.captures.find((c: any) => c.post.missions_pending.length === 2).post.item_key;
    const lead = q.captures.find((c: any) => c.post.missions_pending.length === 1).post.item_key;

    // Ambiguous without mission_id.
    const amb = await api('/review', { method: 'POST', body: JSON.stringify({ decisions: [{ item_key: both, keep: true, reason: 'x' }] }) });
    expect(amb.body.problems[0].problem).toMatch(/give mission_id/);
    // Needs keep or sentiment.
    expect((await api('/review', { method: 'POST', body: JSON.stringify({ decisions: [{ item_key: lead, reason: 'x' }] }) })).status).toBe(400);

    const r = await api('/review', {
      method: 'POST',
      body: JSON.stringify({
        decisions: [
          { item_key: lead, keep: true, label: 'hot', score: 3, reason: 'O-level maths tutor wanted in DHA' },
          { item_key: both, mission_id: brandId, sentiment: 'negative', promotional: false, reason: 'card frozen' },
          { item_key: both, mission_id: leadsId, keep: false, label: 'cold', reason: 'side remark, no details' },
        ],
      }),
    });
    expect(r.body).toMatchObject({ applied: 3, kept: 2, remaining_in_queue: 0, problems: [] });
    expect(repos.missions.forItem(both).map((m) => [m.mission_id, m.review_status])).toEqual([
      [brandId, 'kept'],
      [leadsId, 'rejected'],
    ]);
    expect(repos.seen.get(both)!.review_status).toBe('kept');
  });

  it('get_mission_items returns what each mission kept', async () => {
    const leads = await api(`/missions/${leadsId}/items`);
    expect(leads.body.items).toHaveLength(1);
    expect(leads.body.items[0]).toMatchObject({ verdict: { status: 'kept', label: 'hot', score: 3 }, source: 'Lahore Parents Forum', url: 'https://forum.pk/t/1' });
    const brand = await api(`/missions/${brandId}/items`);
    expect(brand.body.items.map((i: any) => i.url)).toEqual(['https://forum.pk/t/2']);
  });

  it('mission CRUD via the API', async () => {
    expect((await api('/templates')).body.map((t: any) => t.id)).toEqual(['complaints', 'leads', 'businesses', 'topic', 'custom']);
    const bad = await api('/missions', { method: 'POST', body: JSON.stringify({ name: 'x1', template: 'leads', goal: 'find things', match: {}, search_queries: ['a'] }) });
    expect(bad.status).toBe(400);
    const created = await api('/missions', {
      method: 'POST',
      body: JSON.stringify({ name: 'Competitors', template: 'businesses', goal: 'Tuition providers in Lahore', match: TEMPLATES.businesses.match_example, search_queries: ['tuition available Lahore'] }),
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ template: 'businesses', keep_rules: expect.stringContaining('OFFERS'), effective_queries: ['tuition available Lahore'] });
    expect((await api('/missions', { method: 'POST', body: JSON.stringify({ ...created.body, id: undefined, counts: undefined }) })).status).toBe(400);
    const dup = await api('/missions', {
      method: 'POST',
      body: JSON.stringify({ name: 'competitors', template: 'businesses', goal: 'dup dup', match: { any: ['x'] }, search_queries: ['x'] }),
    });
    expect(dup.status).toBe(409);
    const paused = await api(`/missions/${created.body.id}/status`, { method: 'POST', body: '{"status":"paused"}' });
    expect(paused.body.status).toBe('paused');
    const edited = await api(`/missions/${brandId}`, { method: 'PATCH', body: JSON.stringify({ match: { any: ['XYZ Bank', 'XYZB'] }, search_queries: ['XYZ Bank'] }) });
    expect(edited.body).toMatchObject({ uses_keywords: false, effective_queries: ['XYZ Bank'] });
    expect((await api(`/missions/${created.body.id}`, { method: 'DELETE' })).body.ok).toBe(true);
    const status = await api('/status');
    expect(status.body.missions.map((m: any) => m.name)).toEqual([LEGACY_MISSION_NAME, 'Tuition leads Lahore']);
  });
});

// --- Installer tool ---------------------------------------------------------------------

describe('install_service', () => {
  const pluginServer = path.resolve(__dirname, '..', '..', 'plugin', 'server');

  it('refuses when the installer is not bundled or the repo is invalid', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-inst-'));
    fs.mkdirSync(path.join(tmp, 'server'));
    expect(bundledInstaller(path.join(tmp, 'server'), 'win32')).toBeNull();
    expect((await runInstaller(undefined, { serverDir: path.join(tmp, 'server') })).output).toMatch(/not bundled/);
    fs.mkdirSync(path.join(tmp, 'install'));
    fs.writeFileSync(path.join(tmp, 'install', 'install.ps1'), '#');
    expect((await runInstaller('not a repo', { serverDir: path.join(tmp, 'server'), platform: 'win32' })).output).toMatch(/owner\/repo/);
  });

  it('runs the bundled script with the repo argument', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-inst-'));
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.mkdirSync(path.join(tmp, 'install'));
    fs.writeFileSync(path.join(tmp, 'install', 'install.ps1'), '#');
    const handlers: Record<string, (x?: unknown) => void> = {};
    const spawn = vi.fn(() => ({
      stdout: { on: (_e: string, cb: (b: Buffer) => void) => setTimeout(() => cb(Buffer.from('==> Done')), 1) },
      stderr: { on: () => undefined },
      on: (e: string, cb: (x?: unknown) => void) => {
        handlers[e] = cb;
        if (e === 'close') setTimeout(() => cb(0), 5);
      },
      kill: () => undefined,
    }));
    const r = await runInstaller('me/social-agent', { serverDir: path.join(tmp, 'server'), platform: 'win32', spawn: spawn as never });
    expect(r).toEqual({ ok: true, output: '==> Done' });
    const [cmd, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('powershell.exe');
    expect(args).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tmp, 'install', 'install.ps1'), '-Repo', 'me/social-agent']);
    void pluginServer;
  });
});
