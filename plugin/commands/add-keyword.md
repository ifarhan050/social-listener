---
description: Add a brand keyword (with optional variants) to social-listener
argument-hint: "keyword [variant1, variant2, ...]"
---

Add a keyword using the social-listener tools, following the `manage-config` skill.

Arguments: `$ARGUMENTS`. The first item is the keyword; anything after it is a comma-separated list of variants.

1. Call `list_keywords`. If the keyword already exists (ignoring case), offer to add the new variants to it with `update_keyword`, sending the full merged list, instead of creating a duplicate.
2. Drop variants that differ only by case, spaces, punctuation, `#`, or `@`. They already match. Mention that you dropped them.
3. Call `add_keyword` and show the result.
4. Suggest useful variants the user may want, such as other scripts, transliterations, or common abbreviations. Don't add them without asking.
