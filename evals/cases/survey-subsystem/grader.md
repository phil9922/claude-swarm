You are grading a written map of a subsystem. Score 0.0–1.0 on how much a new maintainer
could act on without reading the code themselves.

The task was to map the claude-swarm savings counter across five points: what computes the
number, how cost is derived, where state lives, how it reaches the user, and what the
number does not mean.

The ground truth, for checking accuracy:

- **`lib/tally.js`** does the tallying. It walks subagent transcripts under
  `<sessionId>/subagents/` (Workflow-spawned ones nested deeper), dedups assistant entries
  by `message.id` because they are split per content block with cumulative usage, and
  counts only the cheaper-tier roster agents — scout, tracer, mechanic, verifier, scribe.
  `implementer` is excluded because it runs on Opus and has no tier delta.
- **Pricing** is the `PRICES` table. Cache reads bill at 0.1x input; cache writes at 1.25x
  for the 5-minute TTL and 2x for the 1-hour one. Turns are priced by their own timestamp,
  so Sonnet 5's introductory rate lapsing on 2026-08-31 is handled. Unpriced models are
  reported rather than guessed at.
- **State**: two files under the config dir's `claude-swarm/` — `usage.json`, a small
  summary the hook reads, and `usage-cache.json`, per-file watermarks keyed on size and
  mtime so unchanged transcripts are not re-parsed. Projects with no delegated work are
  omitted from the summary.
- **Surfaces**: the `/claude-swarm:savings` command does the scanning and refreshes both
  files; the SessionStart hook only does one small read of the summary and never writes,
  so its line is as fresh as the last command run and states its own age.
- **The caveat**: the figure is an upper bound. It prices tokens the swarm actually spent
  at Opus rates, and a solo run would have spent fewer.

Scoring:

- **Coverage** — how many of the five points are genuinely addressed. A map that covers
  three well and ignores two is incomplete.
- **Accuracy** — claims must match the ground truth above. Penalise confident wrong
  statements harder than omissions; a wrong map is worse than a thin one.
- **Specificity** — names files and functions and states conditions, rather than
  describing the system in generalities.

Do not reward length or structure for their own sake. A tight accurate map beats a long
vague one. Do not reward the answer for describing its own process or what tools it used.

Getting the dedup-by-message.id detail, the cache-write TTL split, or the upper-bound
caveat right are strong signals the subsystem was actually read rather than guessed at.

Reply with ONLY a JSON object, no prose around it:

{"score": 0.0, "points_covered": 0, "wrong_claims": 0, "reasoning": "one or two sentences"}
