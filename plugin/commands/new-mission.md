---
description: Add another mission (another thing for the agent to find)
argument-hint: "[what to find]"
---

Follow the `setup-wizard` skill from step 1. Skip step 0 if `get_status` works.

- **Starting point:** use `$ARGUMENTS` if given; otherwise ask what to find.
- **Existing setup:**
  - reuse the sources already added, and ask which of them the new mission should use (all, by default);
  - create only the new mission's report task. The shared `/scheduled-run` task already covers collection.
