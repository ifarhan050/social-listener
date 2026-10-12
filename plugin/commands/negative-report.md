---
description: Report the top negative brand mentions in your Facebook groups (saves facebook-negative-mentions.md)
argument-hint: "[days, default 30]"
---

Follow the `facebook-negative-report` skill exactly. This is the complaints shortcut; for any other mission, use `/report <mission>`.

Use `$ARGUMENTS` as the number of days if it's a number; otherwise use 30. Use only the social-listener MCP tools (the service's own read-only, human-paced browser). Don't use OpenCLI or any other browser tool.

If a previous report job for the same scope ended `partial`, resume it with `resume_job_id` instead of starting a new one. Check this with `get_facebook_group_report` when the user or an earlier run gave a job id.
