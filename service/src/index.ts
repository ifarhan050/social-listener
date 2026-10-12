import 'dotenv/config';
import { createApp } from './api/server.js';
import { fileURLToPath } from 'node:url';
import { createService, currentLaunchSpec, loadOrCreateToken, readConnectionFile, writeConnectionFile } from './app.js';
import { SERVICE_ROOT } from './util/paths.js';
import { logger } from './util/logger.js';

const DEFAULT_PORT = 4737;

async function main() {
  const port = Number(process.env.SOCIAL_LISTENER_PORT ?? DEFAULT_PORT);
  const existing = readConnectionFile();
  if (existing && existing.pid !== process.pid) {
    try {
      process.kill(existing.pid, 0);
      const r = await fetch(`${existing.url}/api/status`, { headers: { authorization: `Bearer ${existing.token}` } });
      if (r.ok) {
        logger.error({ url: existing.url, pid: existing.pid }, 'service already running — refusing to start a second scheduler');
        process.exit(1);
      }
    } catch {
      /* stale connection file */
    }
  }

  const svc = createService();
  const token = loadOrCreateToken();
  const startedAt = new Date();
  const app = createApp({
    repos: svc.repos,
    config: svc.config,
    state: svc.state,
    runner: svc.runner,
    review: svc.review,
    registry: svc.registry,
    http: svc.http,
    youtubeQuota: svc.youtubeQuota,
    groupReport: svc.groupReport,
    find: svc.find,
    facebookSnapshot: svc.facebookSnapshot,
    updateSecrets: svc.updateSecrets,
    token,
    port,
    connectFacebook: svc.connectFacebook,
    startedAt,
  });

  const server = app.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    writeConnectionFile({ url, token, pid: process.pid, launch: currentLaunchSpec(SERVICE_ROOT, fileURLToPath(import.meta.url)) });
    svc.loop.start();
    logger.info({ url }, 'social-listener service started');
    // Fragment is never sent to the server or written to access logs.
    console.log(`\nDashboard: ${url}/#token=${token}\n`);
  });

  const stop = async () => {
    logger.info('shutting down');
    server.close();
    await svc.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
