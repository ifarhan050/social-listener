# Mission prompt: topic or market watch

Paste into Claude Cowork (with the social-listener plugin installed). Fill in the `<<…>>` values; leave a line blank to skip it.

```text
Set up a social-listener mission using the setup-wizard skill. Use only the social-listener tools.

=== MISSION ===
Template:            topic
Mission name:        <<e.g. Electric bikes Pakistan>>
Topic:               <<e.g. electric bikes and scooters>>
Other words for it:  <<e.g. e-bike, EV bike, electric scooter>>
I care most about:   <<e.g. prices, brands, problems, demand>>
Ignore:              <<e.g. toy bikes, unrelated "electric" posts>>
Location:            <<e.g. Pakistan>>
Languages:           <<e.g. English, Urdu, Roman Urdu>>

=== SOURCES ===
Platforms:           <<e.g. news, youtube, reddit, facebook, rss>>
Facebook groups:     <<URLs>>
RSS feeds:           <<news/blog feeds>>
YouTube channels:    <<URLs>>
Subreddits:          <<e.g. r/pakistan>>

=== OUTPUT ===
Summary every:       <<e.g. week>>
Report folder:       <<e.g. D:\Research\ebikes>>

Show me the mission (goal, search phrases, match rules, keep/exclude rules, sources, schedule) and wait for my "yes" before creating anything. Never invent URLs. Finish with what's left for me to do.
```
