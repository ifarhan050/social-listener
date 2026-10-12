---
description: One scheduled collection pass (for a Cowork scheduled task) — scan what's due, review, report briefly
---

This runs on a schedule. Be brief, and don't ask questions; nobody is watching.

Scheduled runs are **off by default** (manual runs only: `/scan`, `/find`). The service refuses scheduled scans until `scheduler.scheduled_runs` is turned on.

1. Call `get_status`. It starts the service if it isn't running. If it still fails, report "service not running: <reason>" in one line and stop.
2. If `busy` isn't null, a scan or report is already running. Say so in one line and stop.
3. If no platform in `next_due` is `"now"` and `review.pending` is 0 or missing, reply "Nothing due; next: <earliest next_due>" and stop.
4. If something is due, call `run_scan` with `scheduled: true` (only due targets are scanned). If it's refused because scheduled runs are off, reply "Scheduled runs are off (manual mode); use /scan or /find." and stop. Skip review in that case too. Poll `get_status` about every 30 s until `busy` is null, for at most 20 minutes. Then call `get_run_report` with the run id.
5. Review every pending capture, following the `review-captures` skill: `get_review_queue`, then `submit_reviews` (one verdict per item per pending mission), until `remaining_in_queue` is 0.
6. Reply with a short summary:
   - one line of totals (scanned, new, kept, rejected);
   - **per mission**, the new kept items: source, a short excerpt, link (at most 10 per mission; say how many more). For leads missions, list the hottest first;
   - alerts (checkpoint or soft-block pauses, budget exhausted, sources failing), each with its fix.

Never change settings, add targets, or turn platforms on or off from a scheduled run. Never retry Facebook after a pause or soft block; the service handles timing.
