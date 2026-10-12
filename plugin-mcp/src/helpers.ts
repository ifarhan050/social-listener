/** Small pure helpers for the MCP tools (kept separate so they can be unit-tested). */

export interface StatusLite {
  busy: string | null;
  session: { status: string; checked_at: string | null; paused_until: string | null };
}

/** Plain-language Facebook login state from /status. */
export function loginSummary(s: StatusLite | null, now = new Date()) {
  if (!s) return { connected: false, status: 'unknown', message: 'Could not read the status from the agent.' };
  const st = s.session?.status;
  const paused = s.session?.paused_until && new Date(s.session.paused_until) > now ? s.session.paused_until : null;
  const connected = st === 'ok';
  const message = connected
    ? paused
      ? `Logged in. Facebook reading is paused until ${paused} (a safety pause); nothing to do.`
      : 'Logged in. The agent reuses this login; no need to log in again.'
    : st === 'needs_reconnect'
      ? 'Facebook asked to log in again. Use connect_facebook (or type /connect-facebook).'
      : 'Not logged in to Facebook yet. Use connect_facebook (or type /connect-facebook).';
  return { connected, status: st ?? 'unknown', last_checked: s.session?.checked_at ?? null, paused_until: paused, message };
}

/** True when version a is newer than b (x.y.z). */
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** The dashboard link (with this computer's access token in the fragment, never sent to the server). */
export const dashboardLink = (conn: { url: string; token: string }) => `${conn.url.replace(/\/+$/, '')}/#token=${conn.token}`;
