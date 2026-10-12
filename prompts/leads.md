# Mission prompt: leads (people asking for what you offer)

Paste into Claude Cowork (with the social-listener plugin installed). Fill in the `<<…>>` values; leave a line blank to skip it.

```text
Set up a social-listener mission using the setup-wizard skill. Use only the social-listener tools.

=== MISSION ===
Template:            leads
Mission name:        <<e.g. Tuition leads Lahore>>
What I offer:        <<e.g. home tuition for O/A-level maths and physics>>
Who I want to find:  <<e.g. parents or students asking for a tutor>>
Words people use:    <<e.g. tutor, tuition, home tutor, teacher, academy>>
Request words:       <<e.g. need, looking for, required, wanted, chahiye>>
Ignore:              <<e.g. "available for tuition", academies advertising, job posts>>
Location / areas:    <<e.g. Lahore — DHA, Gulberg, Johar Town>>
Languages:           <<e.g. English, Urdu, Roman Urdu>>
How fresh:           <<e.g. last 7 days>>

=== SOURCES ===
Platforms:           <<e.g. facebook, rss, reddit>>
Facebook groups:     <<e.g. area/parents/community groups — one URL per line>>
RSS feeds:           <<classifieds or forum feeds>>
Subreddits:          <<e.g. r/lahore>>

=== OUTPUT ===
Lead list every:     <<e.g. day at 08:00>>
Report folder:       <<e.g. D:\Leads>>

Show me the mission (goal, search phrases, match rules, keep/exclude rules, sources, schedule) and wait for my "yes" before creating anything. Never invent URLs. Never contact anyone — I will reply to leads myself. Finish with what's left for me to do.
```
