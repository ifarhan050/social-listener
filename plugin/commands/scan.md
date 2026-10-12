---
description: Run an ad-hoc social-listening scan and report results
argument-hint: "[target ids, comma-separated]"
---

Run an ad-hoc scan with the social-listener MCP tools.

1. Call `get_status`. If `can_run` isn't `"yes"`, explain why (outside active hours, budget exhausted, session needs reconnect, risk notice not acknowledged, already busy) and stop.
2. Call `run_scan`. If the user gave target IDs in `$ARGUMENTS`, pass them as `target_ids`. Don't set `wait`. Without IDs, only **due** targets are scanned. If nothing is due, say so and give the times from `next_due` in `get_status`. For recurring scans, suggest a Cowork scheduled task running `/scheduled-run`; the service doesn't scan on its own.
3. Tell the user the scan started. Poll `get_status` a few times, about 30 seconds apart, until `busy` is null, or until about 5 minutes pass.
4. When it finishes, call `get_run_report` with the run's `run_id` and summarize: page loads used, posts scanned, new captures, duplicates skipped, errors, and any per-target errors or alerts.
5. If there were new captures, they wait in the review queue. Review them now, following the `review-captures` skill (same loop as `/review`), so that only negative, non-promotional mentions are kept. Then list the kept ones briefly: source, keyword, a short excerpt, and the link.
