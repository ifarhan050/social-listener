import 'dotenv/config';
import { readConnectionFile } from '../app.js';

/**
 * `npm run doctor [-- --live]`: print the health/risk report.
 * Asks the running service when available (it has live state); otherwise reads the DB directly.
 */
async function main() {
  const live = process.argv.includes('--live');
  let report: { summary: Record<string, number>; checks: { area: string; check: string; status: string; detail: string; fix?: string }[] };
  const conn = readConnectionFile();
  try {
    if (!conn) throw new Error('no service');
    const r = await fetch(`${conn.url}/api/doctor${live ? '?live=true' : ''}`, { headers: { authorization: `Bearer ${conn.token}` } });
    if (!r.ok) throw new Error(String(r.status));
    report = (await r.json()) as typeof report;
  } catch {
    const { createService } = await import('../app.js');
    const { doctorReport } = await import('../api/server.js');
    const svc = createService();
    report = await doctorReport(
      { ...svc, token: '', port: 0, connectFacebook: svc.connectFacebook, startedAt: new Date() },
      live,
    );
    await svc.shutdown();
    console.log('(service not running — report built from the local database)\n');
  }
  const icon: Record<string, string> = { ok: '✔', warn: '!', fail: '✖', info: '·' };
  for (const c of report.checks) {
    console.log(`${icon[c.status] ?? '?'} [${c.area}] ${c.check}: ${c.detail}`);
    if (c.fix && c.status !== 'ok') console.log(`    → ${c.fix}`);
  }
  console.log(`\n${report.summary.ok} ok, ${report.summary.warn} warnings, ${report.summary.fail} failures`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
