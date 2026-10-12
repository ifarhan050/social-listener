import 'dotenv/config';
import { createService, readConnectionFile } from '../app.js';

/**
 * `npm run connect`: open a visible browser to log in to Facebook.
 * If the service is running, ask it to do so (it owns the browser profile);
 * otherwise run the flow directly.
 */
async function main() {
  const conn = readConnectionFile();
  if (conn) {
    try {
      const r = await fetch(`${conn.url}/api/session/connect`, {
        method: 'POST',
        headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      const body = (await r.json()) as { message?: string; error?: string };
      console.log(r.ok ? body.message : `Service refused: ${body.error}`);
      return;
    } catch {
      /* service not running — fall through */
    }
  }

  const svc = createService();
  try {
    if (!svc.state.get().risk_acknowledged) {
      console.log(
        'Automated access may conflict with Meta\'s Terms; your account could be restricted.\n' +
          'Acknowledge this in the dashboard (npm run start) before connecting.',
      );
      process.exitCode = 1;
      return;
    }
    console.log('A browser window will open. Log in to Facebook there (including 2FA), then close the window to finish.');
    const res = await svc.connectFacebook();
    console.log('Result:', res);
  } finally {
    await svc.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
