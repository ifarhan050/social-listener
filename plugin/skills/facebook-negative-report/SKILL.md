---
name: facebook-negative-report
description: Build a report of the most negative recent brand mentions in monitored Facebook groups (default last 30 days, top 5), with comment evidence and links, saved as facebook-negative-mentions.md in the working folder. Use when the user asks for a negative-mentions report, the worst complaints in Facebook groups, a weekly or monthly Facebook complaint digest, or runs /negative-report.
---

# Facebook negative-mentions report

This report uses the **social-listener service's own browser**: Playwright driving your installed Chrome on its dedicated, logged-in profile. It is read-only and human-paced: it reads before scrolling, pauses before clicks, takes breaks between groups, and stays within page budgets. **Don't use OpenCLI, the agent-reach skill, or any other browser tool for this, and don't browse Facebook yourself.** Only use the social-listener MCP tools.

**Read-only:** never like, comment, join, share, message or post anything. The service only clicks "See more", comment counts, "View more comments" and comment sorting.

## Inputs
- **Days:** from the user or the command argument; default 30.
- **Groups:** default is every monitored Facebook group. Say which groups were included.

## Steps

1. **Pre-flight** (replaces `opencli doctor`).
   - Call `doctor` and `get_status`.
   - Continue only if `platforms.facebook` is `"yes"` and `session.status` is `"ok"`.
   - Otherwise **stop and tell the user why**, with the fix. Possible causes:
     - not connected or needs reconnect → offer `/connect-facebook` (`connect_facebook`, after the risk notice and a yes);
     - paused after a checkpoint or soft block → wait until `paused_until`;
     - outside active hours;
     - Facebook switched off → `/platforms facebook on`;
     - risk notice not acknowledged;
     - no Facebook groups added → `/add-group`.
2. **Collect.** Call `start_facebook_group_report` with `days`. If there are several missions, pass the complaints mission's `mission_id` (`list_missions`); its search phrases and rules are used.
   - Poll `get_facebook_group_report` about every 30 s until the status isn't `running`. Tell the user it's working; it paces itself like a person, so it can take a while.
   - **`partial`** (page budget reached): continue with the posts collected so far. Mark the report **partial** and say how many groups are left. Resume later with `resume_job_id` (a scheduled run can do this).
   - **`aborted`:** Facebook showed a checkpoint or soft block and is now paused. Report what was collected, if anything, and stop. Never retry right away.
   - **No posts:** say so plainly. Don't invent results.
3. **Classify** each post and each of its comments, judging by its own text. Use the `review-captures` rules.
   - **Negative:** complaints, refunds, scams or fraud, delays, poor service, money loss, warnings to others, account or card problems. This includes sarcasm and polite reports of a real problem.
   - **Exclude:**
     - promotional posts: ads, offers, agents or resellers, giveaways, job posts, competitor ads;
     - posts by the brand's own pages (`brand.own_pages` in `get_config`), or posts clearly written by the brand itself.
4. **Rank** the remaining posts by negative signal:
   - the number of negative comments, plus the post itself if it's negative;
   - weighted by severity: scam or fraud = 3, money loss or refund = 2, delays or poor service or other complaints = 1.

   Break ties by total comments. Take the **top 5**, or fewer if there aren't 5.
5. **For each of the 5:**
   - group name;
   - post date;
   - author (**first name only**);
   - post excerpt (≤ 2 sentences);
   - **top 3 negative comments**, each quoted briefly (≤ 20 words) with the commenter's first name only;
   - negative vs total comments (e.g. "9 negative of 14");
   - the direct post link.
6. **Write `facebook-negative-mentions.md`** in the working folder (overwrite if it exists), using the template below. Then summarize it in chat in 3–6 lines: the top themes, the most severe item, and whether the result is partial.

## File template

```markdown
# Facebook negative mentions — <date>

**Scope:** <N> groups, last <days> days, keywords: <keywords>. **Status:** complete | partial (<x> groups not yet scanned)
**Method:** collected read-only by the social-listener service; sentiment judged by Claude; promotional and own-page posts excluded.

## 1. <short title of the issue>
- **Group:** <group name>
- **Posted:** <YYYY-MM-DD> by <FirstName>
- **Post:** "<excerpt>"
- **Negative comments:** <n> of <total>
  - "<quote>" — <FirstName>
  - "<quote>" — <FirstName>
  - "<quote>" — <FirstName>
- **Link:** <post url>

…(up to 5)

## Themes
- <theme>: <count> posts
```

## Privacy
- First names only, short quotes, and no profile links.
- Don't add phone numbers, account numbers or other personal details, even if they appear in the text.
