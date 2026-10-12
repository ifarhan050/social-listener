---
description: List, pause/resume, edit, duplicate or delete missions
argument-hint: "[pause|resume|edit|delete mission-name]"
---

Follow the `missions` skill.

**No arguments:** call `list_missions` and show a table with these columns:
- name
- template
- status
- search phrases (first 5)
- sources
- to review / kept

Under the table, a one-line hint: "Say e.g. *pause Tuition leads*, *edit XYZ complaints: add 'XYZ app'*, or */new-mission*."

**With arguments** (`$ARGUMENTS`): do that action with the matching tool.
- Confirm before deleting, or before replacing match rules or search phrases.
- Show before → after for edits.
