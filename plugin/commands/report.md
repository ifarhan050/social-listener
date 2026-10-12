---
description: Write a mission's report (e.g. /report Tuition leads 7) and save it to the working folder
argument-hint: "mission-name [days]"
---

Follow the `missions` skill, section "/report <mission>".

Take the mission from `$ARGUMENTS`; a trailing number is the days to look back.
- **No mission given:** if there's exactly one active mission, use it. Otherwise list the missions and ask which one.
- **Scheduled run:** if this runs as a scheduled task, don't ask. Report on all active missions, one file each.
