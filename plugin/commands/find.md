---
description: Find N posts of given types in a date range, from given groups or a general search (e.g. /find 20 negative acme bank last month)
argument-hint: "count types subject [in group URLs] [period]"
---

Follow the `find` skill. The request is: $ARGUMENTS

Examples of what users type:
- `/find 20 negative acme bank last month`
- `/find 10 scam posts in https://www.facebook.com/groups/123456 this year`
- `/find 15 leads tuition last 7 days`
- `/find 5 complaints from 2026-03-01 to 2026-03-31 facebook only`
- `/find continue 12` resumes find job 12.
- `/find export 12` saves job 12's results as CSV (`/find export 12 labelled` includes rejected items too).

If `$ARGUMENTS` is empty, ask in one message: how many, what kind (negative, scam, promotional, lead...), about what (mission), where (groups or general search), and when.
