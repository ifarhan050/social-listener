---
description: Review captured posts and keep only negative, non-promotional mentions
argument-hint: "[max captures, default all]"
---

Review the social-listener queue, following the `review-captures` skill.

1. Call `get_status`. If `review.pending` is 0 or missing, say there's nothing to review, show the kept and rejected totals, and stop.
2. Loop: call `get_review_queue`, label every pending item, and call `submit_reviews`. Repeat until `remaining_in_queue` is 0, or until you've reviewed the number of captures given in `$ARGUMENTS`.
3. Summarize:
   - totals reviewed, kept, kept as context, and rejected (promotional vs. not negative);
   - the kept complaints grouped by theme (for example app/login, cards, fees, support, fraud), each with source, a short excerpt, and link;
   - anything borderline you'd like the user to double-check, with its `item_key`.
