# Mission prompt: complaints, issues and scams

Paste into Claude Cowork (with the social-listener plugin installed). Fill in the `<<…>>` values; leave a line blank to skip it.

```text
Set up a social-listener mission using the setup-wizard skill. Use only the social-listener tools.

=== MISSION ===
Template:            complaints
Mission name:        <<e.g. XYZ Bank complaints>>
Brand / product:     <<e.g. XYZ Bank>>
Other spellings:     <<e.g. xyzbank, XYZB, ایکس وائی زیڈ بینک>>
Ignore posts about:  <<e.g. hiring, jobs, HBL Engineering>>
Our own pages:       <<e.g. XYZ Bank Official>>
Location:            <<e.g. Pakistan>>
Languages:           <<e.g. English, Urdu, Roman Urdu>>

=== SOURCES ===
Platforms:           <<facebook, news, rss, youtube, reddit — remove any you don't want>>
Facebook groups:     <<one URL per line>>
Facebook pages:      <<one URL per line>>
RSS feeds:           <<forum/news feed URLs>>
YouTube channels:    <<URLs>>
Subreddits:          <<e.g. r/pakistan>>

=== OUTPUT ===
Report every:        <<e.g. week (Monday 09:00)>>
Report looks back:   <<e.g. 30 days>>
Top N in report:     <<e.g. 5>>
Report folder:       <<e.g. D:\Reports\complaints>>

Show me the mission (goal, search phrases, match rules, keep/exclude rules, sources, schedule) and wait for my "yes" before creating anything. Never invent URLs. Finish with what's left for me to do.
```
