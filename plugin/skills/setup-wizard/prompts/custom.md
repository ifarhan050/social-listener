# Mission prompt: custom

Paste into Claude Cowork (with the social-listener plugin installed). Fill in the `<<…>>` values; leave a line blank to skip it.

```text
Set up a social-listener mission using the setup-wizard skill. Use only the social-listener tools.

=== MISSION ===
Template:            custom
Mission name:        <<short name>>
What to find:        <<describe it in one or two sentences>>
Keep when:           <<what makes a post/comment useful to you>>
Drop when:           <<what to ignore>>
Words to look for:   <<terms people would use>>
Location:            <<if it matters>>
Languages:           <<e.g. English, Urdu>>

=== SOURCES ===
Platforms:           <<facebook, news, rss, youtube, reddit>>
Groups / pages / feeds / channels / subreddits: <<URLs, one per line>>

=== OUTPUT ===
Report every:        <<e.g. week>>
Report should show:  <<e.g. newest items with link and a one-line summary>>
Report folder:       <<path>>

Show me the mission (goal, search phrases, match rules, keep/exclude rules, sources, schedule) and wait for my "yes" before creating anything. Never invent URLs. Finish with what's left for me to do.
```
