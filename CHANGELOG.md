# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): the git tag
`vX.Y.Z` matches the `version` in `.claude-plugin/plugin.json`.

## [Unreleased]

## [0.2.9] — 2026-07-26

### Changed
- **`build` no longer throttles its own parallel phase.** `concurrency` defaulted to a fixed
  **8**. The first measured run decomposed into **14** independent units on a machine whose
  harness cap (`min(16, cores - 2)`) allowed 14, so the leaf wave queued into roughly two
  slot-waves for no reason — and the leaf-completion pattern shows it: the first five landed
  inside a 6-second span, then stragglers with gaps up to 104s.

  It now defaults to the unit count, bounded at 12. Batching can only merge units into *fewer*
  agents, so the unit count is a safe upper bound and this default never queues; the bound just
  stops a very wide manifest dispatching unboundedly. An explicit `concurrency` still wins and
  still throttles — that is its purpose, for trading wall time against cost.

- **Foundation guidance: keep implementations out of it.** Everything the master writes before
  dispatch is paid at full wall cost in a phase no fan-out can shorten, so the foundation's size
  sets the ceiling on the whole run. It should carry contracts, not implementations — a module
  with a clear contract and its own file is a *unit*, declared as something others `reads`, and
  the dependency gating orders it for free.

  Measured, not stylistic: run 1's foundation took **602s — 45% of the build and 60% of the
  entire solo baseline** — writing 26 files, of which 14 were stubs and 12 shared. Those 12
  included fully implemented cents math, balance folding, filtering, stats aggregation and
  validation, all five of which had contracts and could have been units. The serial phase did
  the algorithmic work while the parallel wave got presentational components, which is the shape
  that made the run land slower than solo.

- **Integration establishes file presence with one sweep** rather than reading every owned file.
  It runs alone, so each read is serial wall time spent before any fixing starts; it now opens
  only what the sweep flags as missing, small, or still carrying the placeholder.

### Fixed
- **The documented type-check command was a no-op on the commonest scaffold.** Both occurrences
  in `SKILL.md` showed `npx tsc --noEmit`. In a Vite project the root `tsconfig.json` is a
  solution file with `"files": []`, so that command **exits 0 on any source, including source
  with type errors** — proven by planting one. Since `typecheck` is the grader handed to every
  leaf, a vacuous one does not merely cost correctness: it relocates the errors into the serial
  integration pass, which is the phase fan-out cannot speed up. Replaced, with an instruction to
  prove the grader fails on a real error before dispatching.

### Tests
- **Smoke checks 71 → 72.** The concurrency check is **behavioural** — it counts leaves actually
  in flight rather than reading the logged number — and is mutation-tested three ways: reverting
  the default to 8, dropping the bound, and ignoring the explicit override each fail their own
  distinct assertion.

### Docs
- `evals/shakedown-results.md` records where the serial time went, and an adjustment for unequal
  work: ~215s of the build arm's time was post-workflow verification the solo arm never did,
  which moves the ratio from 0.71x to ~0.83x. The falsification stands either way; the headline
  figures are left as measured and the adjustment is labelled as one.
- `evals/shakedown-2.md` adds a second spec sized so the wall question is answerable at all
  (~12–18% serial against run 1's 69.7%), with its prediction pre-registered.

## [0.2.8] — 2026-07-26

### Fixed
- **The completion feed recorded `(no output)` for every schema-constrained agent.** In the
  first shakedown run all 15 workflow agents logged `(no output)` — including the integration
  mechanic, which certainly produced output. That blinded the eval's `unknown` rate, which had
  to be recorded as *not collected* rather than guessed.

  Captured from the live payload on 2.1.220 rather than inferred: `SubagentStop` carries
  `last_assistant_message` **only when the subagent's final turn ends in prose**. When the turn
  ends by calling `StructuredOutput` — which every schema-constrained workflow `agent()` does —
  the key is **absent from the payload entirely**, not empty. The one entry in that run which
  did carry text was a plain `Task` spawn, which is exactly the predicted split.

  The payload does always carry `agent_transcript_path`. The hook now reads the tail of that
  transcript when the message is missing and takes the **final** assistant message, grouped by
  `message.id` because the transcript splits one message across a record per content block. If
  that message carries no prose but does carry a `StructuredOutput` call, its input is logged as
  compact JSON — for a schema-constrained agent that *is* the return value, and calling it
  silence is what broke the metric.

  Scoping to the final message is load-bearing: a turn-capped agent that stopped inside a tool
  call has mid-run narration in its transcript, and scanning the whole file would manufacture a
  message for an agent that genuinely returned nothing. Real silence still logs `(no output)`,
  because the build workflow acts on that signal and it must stay distinguishable from a quiet
  finish.

  Verified by replaying the fixed hook over the 16 transcripts preserved from the shakedown:
  **16 lines, 0 still `(no output)`**, and the per-unit `status` is now greppable off the feed.
  That recovered the run's unit counts — 14 units, all `done`, **0 unknown** — which scores a
  pre-registered prediction line that had been unscoreable.

  The hook's hard contracts are unchanged: it still exits 0 unconditionally (exit 2 on
  `SubagentStop` blocks the subagent), still swallows every failure, and the transcript read is
  wrapped in its own `try` inside the existing one. It reads only; it writes nothing outside the
  project directory.

### Changed
- **The feed's documented contract widened**, deliberately and not silently: a line is now the
  first line of the final message *or* a compact JSON of the structured return. The header
  states both cases and why.

### Tests
- **Smoke checks 67 → 71**: recovery from the transcript, a structured return not being counted
  as silence, a turn-capped agent staying silent, and the payload message winning over the
  transcript with an unreadable/junk transcript tolerated. All four mutation-tested — deleting
  the fallback fails two, scanning all assistant text instead of the final message fails two
  (it manufactures mid-run narration), dropping the structured summary fails one, and removing
  the inner `try` fails one by writing no feed line at all.

## [0.2.7] — 2026-07-26

### Fixed
- **A stalled panel tick is no longer reported as a finished wave.** 0.2.6 reasoned that since
  the panel ticks every ~5s while any row exists, a record that had gone stale while still
  counting running agents *must* describe a wave that ended — and rendered it as `· ran 1:04`.
  That inference is false. Any tick stall past 10 seconds (heavy load, a long blocking call,
  sleep/resume) produces exactly that state **mid-wave**, and the segment then asserted an ending
  that had not happened, with a duration frozen at the stall rather than at any real finish.
  An adversarial pass reproduced it directly: backdate a live record's mtime by 20s and 0.2.6
  prints `· ran 1:04` for a wave that is, by construction, still running. 0.2.5 printed nothing
  for the same input — so 0.2.6 turned a harmless vanishing act into a confident wrong answer,
  which is worse.

  The segment now renders **three** states rather than two, and the new distinction is epistemic
  rather than cosmetic:

  | rendering | state | meaning |
  |---|---|---|
  | `· oldest 1:23` | live | the writer is ticking; agents are running now |
  | `· ran 1:23` | ended | the writer observed its count reach zero and stamped `endedAt` |
  | `· last 1:23` | unheard | the record went stale while still counting agents — nothing has updated it since 1:23 |

  `unheard` is the honest reading of evidence that cannot distinguish "ended between two ticks"
  from "the panel stalled". It claims only what is known. Both non-live states stay dimmed with
  tier backgrounds dropped, so neither is mistaken for a running wave.

- **The unheard window is a real 30 seconds.** In 0.2.6 that path only rendered while
  `10s < age ≤ 30s` — an effective 20-second window, while the header comment claimed 30 and a
  stamped wave genuinely got 30 from its stamp. The window now runs `GRACE_MS` from the staleness
  cutoff, so both states get the same 30 seconds.

### Tests
- **Smoke checks 66 → 67**, and the previous check was rewritten. The 0.2.6 check could not catch
  the 0.2.6 defect: it only ever built records for waves that had genuinely stopped for good, so
  it passed both before and after the regression it was supposed to guard. The new check stalls a
  **live** wave, asserts the segment never says `ran`, then lets the panel recover and asserts it
  returns to live — and separately asserts a genuinely stamped end still reads as `ran`, so the
  honest wording did not cost the confident wording where it is earned.
- Both behaviours mutation-tested: collapsing `unheard` into `ended` fails exactly the two new
  checks, and shrinking the window back to ~20s fails the 38-second assertion.

## [0.2.6] — 2026-07-26

### Fixed
- **The 30-second grace window now actually fires.** 0.2.5 shipped it, and it worked in the
  session that built it, but it depended on something Claude Code does not reliably do. The
  writer can only stamp `endedAt` on a tick where it *observes* the running count at zero —
  and the panel stops being invoked once its rows clear. If the last agent exits between two
  ticks, that observation never happens.

  Measured 2026-07-26: a 256-second agent's final tick landed at 04:27:59 still counting one
  Sonnet; the agent exited about a second later and no further tick ever came. `endedAt` was
  never stamped, and the record sat unwritten for 35 minutes still claiming an agent was
  running. The segment went quiet at the 10-second staleness cutoff — the exact vanishing act
  the grace window was built to prevent, in the exact case that motivated it.

  The fix is in the reader, because the writer cannot report a transition it is never invoked
  to see. A record that has gone stale *while still counting running agents* is now itself the
  end-of-wave signal: the panel ticks every ~5s for as long as any row exists, so mtime cannot
  fall behind a live wave. Such a record is read as a wave that ended at its last write. The
  stamp is still preferred when present; this is a fallback, not a replacement. Cost is at most
  one tick of accuracy on the reported duration, since the wave really ended somewhere in the
  5 seconds after that final write — and unlike the stamp, it cannot be missed.

  Staleness now gates *liveness only*, never the grace window itself. Both anchors are covered
  by smoke checks, and the new one was mutation-tested: restoring the pre-fix branch fails
  exactly that check and nothing else.

### Tests
- **Smoke checks 65 → 66.** An unstamped finished wave lingers dimmed, reads as `· ran` rather
  than `· oldest`, drops its tier backgrounds, freezes its clock near the last write, goes quiet
  past the window, and does not swallow a genuinely live record.

## [0.2.5] — 2026-07-26

### Added
- **A finished wave lingers on the main status line for 30 seconds instead of
  vanishing.** The segment only ever rendered while an agent was actually running,
  and agents routinely finish in 15–45s — one wave measured live gave a **12-second
  window**, so in ordinary use the summary flashed and disappeared, leaving no
  evidence a swarm had run at all. A finished wave now renders dimmed with its tier
  backgrounds dropped and the clock frozen at how long it ran (`· ran 1:23` rather
  than `· oldest 1:23`), so "just finished" is never mistaken at a glance for
  "running right now".

  The obvious implementation is wrong and was rejected: widening the reader's 10s
  staleness cutoff does nothing, because `scripts/subagent-statusline.js` rewrites
  the cache on **every** tick including idle ones (before the `lines.length` check),
  so a finished wave looks exactly as fresh as an hour of silence. The writer is the
  only party that can see the transition, so it now retains the last live counts and
  stamps `endedAt` when the running count falls to zero — never restamping it on
  later idle ticks, or the segment would linger as long as the panel kept ticking.
  The reader anchors the window to `endedAt` rather than to mtime, because the panel
  stops rewriting the cache once its rows clear and a finished record goes stale well
  before the window closes. A new wave starting inside the window replaces the
  lingering state outright. The aggregate grows from ~150 to ~180 bytes while
  lingering.

### Fixed
- **Corrected the documented size of the aggregate cache.** README, CHANGELOG and the
  renderer's own header all claimed `~100 bytes`; measured, it is 148 (now 153, and
  177 while a finished wave lingers). The 55-character human-readable `note` string
  in the file accounts for most of the gap.
- **`package.json` version caught up to the release**, 0.2.2 → 0.2.4. It is not
  covered by the semver rule above (which scopes to `.claude-plugin/plugin.json`) but
  had drifted two releases behind.

### Tests
- **Smoke checks 61 → 65.** The grace window's writer contract (stamps on the
  transition, retains the last live counts and start, never restamps, and a session
  that never ran anything is idle rather than "just finished") and its reader
  behaviour (lingers dimmed, freezes the clock, survives a stale file, goes quiet
  past the window, and yields to a new wave). Both new checks were mutation-tested —
  zeroing the window and restamping the anchor each fail exactly one check. Also
  added the crash-resilience cases the panel depended on but never covered: an absent
  `tasks` array, a non-array `tasks`, `null`/primitive/id-less entries mixed with a
  good row, and a main-segment payload carrying no `session_id`.

## [0.2.4] — 2026-07-26

### Fixed
- **The plugin-shipped subagent panel works again, by not needing
  `${CLAUDE_PLUGIN_ROOT}`.** 0.2.3 documented the default as broken and told users to
  register the renderer themselves. Reading Claude Code 2.1.220 settled why: plugin
  settings *are* honored, but they are merged **verbatim** — the merge copies each key
  straight across and never applies the placeholder expansion it applies to hooks, MCP
  servers, monitors and LSP configs. So `${CLAUDE_PLUGIN_ROOT}` reached the shell as an
  undefined variable, the command resolved to `node "/scripts/subagent-statusline.js"`,
  node exited non-zero, and Claude Code fell back to default rows — exactly the silent
  failure measured earlier. **A plugin can never point that setting at a script inside
  itself**, which makes the documented feature unusable as documented.

  The SessionStart hook does not have that problem: it runs from inside the plugin and
  knows its own location from `__dirname`. It now writes that path to
  `$TMPDIR/claude-swarm-root` on every session start, and the shipped command reads the
  breadcrumb. This follows the plugin across updates, works identically for a
  marketplace install and a `--plugin-dir` working tree, and needs nothing from the
  user. A smoke check executes the shipped command against the breadcrumb and asserts a
  real rendered row, so the two cannot drift apart.

  Documented limits, both benign: `disableAllHooks` leaves no breadcrumb and the rows
  fall back to defaults; and with two sessions on different copies of the plugin, the
  last to start owns the breadcrumb. The hook's "writes nothing" contract is amended
  rather than quietly broken — it still touches nothing in a user's config dir.

  Reported upstream on 2026-07-26 as
  [anthropics/claude-code#81320](https://github.com/anthropics/claude-code/issues/81320).
  One correction to the wording above, made while writing that report: the docs do not
  actually *promise* substitution in plugin settings. The plugins reference carries a
  placeholder-resolution table naming five components — skill/agent content, hook and
  monitor commands, MCP stdio, MCP http/sse/ws, LSP — and settings is not among them.
  So this is an unnoted gap plus a docs omission rather than a contradiction, and
  "unusable as documented" above should be read as "unusable for the only purpose the
  key has", not as the docs contradicting themselves.

## [0.2.3] — 2026-07-26

**First live run of the swarm display, and both of 0.2.2's open risks resolved — one
of them against us.** Nothing outside the two status line scripts, their tests, and
their docs changed; the shakedown protocol and the pre-registered predictions are
still untouched.

### Added
- **A once-per-second segment on the main status line**, the only part of the display
  that can move faster than 5s: `claude-swarm 2H 5S 1O · oldest 1:23`. The subagent
  renderer now caches the longest-running agent's raw `startTime` alongside the tier
  counts, and the segment recomputes the clock on its own tick — a stored elapsed
  would visibly freeze for four ticks out of five. Verified by running the segment
  twice 1.2s apart with no cache write in between: `1:35` → `1:36`.
- **A compose recipe in the README for anyone who already has a status line.** Only
  one `statusLine` wins, so the entry feeds the same stdin to both commands and prints
  this segment on its own line — the main status line renders multi-line output as a
  column, and this script prints nothing while no subagents run. Also flags that
  `refreshInterval: 1` re-runs *both* commands every second.
- The segment's label is branded once, on that line, rather than per row: with no
  agent identity in the payload, an individual row cannot honestly claim to be a
  claude-swarm agent.
- **Rows are indented so the two displays read as one block** — the status line
  renders directly above the agent panel, so the segment becomes the header and the
  agents nest under it. The indent comes out of the row's own width budget, not out of
  `columns`, and yields before the badge does: at `columns: 8` and below it is dropped
  entirely, since an indent of spaces would otherwise clip the badge to whitespace.

### Fixed
- **The badge names the model tier instead of the agent, because the payload carries
  no agent identity.** Captured live from Claude Code 2.1.220: every row's `type` is
  the constant `"local_agent"`, `name` is **absent** (the builder fills it from Claude
  Code's agent-name registry — a user-assigned name, not the agent type — and
  Task-dispatched subagents have no entry), and `label`/`description` carry the
  caller's Task description. A scout, a tracer and a leaf are indistinguishable. The previous
  renderer matched `task.type`/`task.name` against scoped roster names, matched
  nothing, and silently rendered **no rows at all** — the panel showed Claude Code's
  defaults and looked merely unstyled. Rows now badge `HAIKU`/`SONNET`/`OPUS` from
  `model`, name an off-ladder model for what it is (`FABLE`), and say `AGENT` while the
  model is unresolved. A smoke check now renders a verbatim captured payload, so a
  return to name-matching fails in the suite rather than in a live wave.
- **Retired the red anomaly.** Bright red marked "a `leaf` resolved off Sonnet", the
  void condition of the build prediction in `evals/README.md`. Identifying a leaf
  requires an identity the payload does not have, so the alarm cannot fire and is gone
  rather than faked — from the rows, from the aggregate counts, and from the main-line
  segment. The build prediction still needs a check; the subagent panel is not it.
- **Every subagent row is rendered, not only this plugin's.** Filtering to swarm rows
  required the same missing identity, so the rows stay tier-generic instead of claiming
  ownership they cannot verify.

- **A row no longer overflows a panel narrower than its own badge.** The badge is
  fixed at 8 visible columns and never drops, so `columns: 5` rendered an 8-wide row —
  found by an adversarial pass, not by the suite, whose narrow-columns check stopped
  at 14. The badge now clips to the width it was handed; the check covers 8, 5 and 3.

- **The shakedown protocol is executable as written** (`evals/shakedown.md`). Six
  defects, all in the mechanics rather than the design — the frozen plan, the arms,
  the spec and the pre-registered predictions are untouched:
  - **The build arm was missing `--plugin-dir`.** Its command carried `--settings` but
    never loaded the working tree, so the roster, the SessionStart policy and
    `claude-swarm:build` would not have existed: the "build" arm would have run as an
    expensive second solo arm and died at the Workflow call. Nothing in the recorded
    numbers would have said so.
  - `/path/to/claude-swarm` appeared literally in five commands, and the two scaffolds
    had no parent directory — `cd ledgerline-solo` was the first command to fail
    verbatim. Both are now `$SWARM` and `$RUN_ROOT`, exported once in Preconditions,
    with `$RUN_ROOT` required to sit outside the repo so the arms' own source cannot
    land in the plugin's git tree or its `git diff --stat`.
  - The build arm was never told to re-run `npx tsc --noEmit` and `npm run build` by
    hand, though the solo arm was and the results table has a column for both.
  - Two template fields asked for numbers the run does not produce: repair cycles
    (the feed log carries no turn data — the subagent transcripts must be copied aside
    before the next arm, else the field is `not collected`) and manifest violations
    (`--output-format json` returns the final text only, so they are captured live or
    explicitly marked as reproduced afterward).

### Changed
- **The panel's refresh cadence is fixed at 5 seconds and documented as such.** Read
  out of the Claude Code 2.1.220 binary: the subagent panel ticks on a hardcoded
  5000ms timer (first tick at 300ms), and the `subagentStatusLine` settings object is
  `{type, command}` only — `refreshInterval` (min 1s) belongs to the main `statusLine`
  and cannot speed this up, since that segment reads a cache written on the same 5s
  tick. Elapsed therefore steps in 5s jumps. The reader's 10s staleness cutoff is
  exactly two ticks, which is now a measured number rather than a guess.
- **Enabling the subagent panel is documented as a manual step.** The plugin's shipped
  `subagentStatusLine` default does not take effect on 2.1.220: under the plugin
  default alone the renderer never ran across 60s and two live agents (its per-session
  aggregate cache was never written), while the identical script registered by absolute
  path in project settings wrote the cache within one second. Whether
  `${CLAUDE_PLUGIN_ROOT}` fails to substitute there or the key is not honored from a
  plugin at all is still unseparated. The README's "there is nothing to configure" was
  wrong and now carries the manual settings block plus the symptom to look for: no
  `m:ss` and no context bar means the renderer isn't running.

## [0.2.2] — 2026-07-26

**Display-only, safe before the shakedown.** Everything here reads data Claude Code
already tracks and renders it locally: nothing in `build.js`, the agents, the policy,
or the eval protocol changes, and status line scripts consume no API tokens. The
pre-registered predictions and the frozen shakedown protocol are untouched.

### Added
- **Live per-agent rows in the subagent panel.** The plugin ships a default
  [`subagentStatusLine`](https://code.claude.com/docs/en/statusline#subagent-status-lines)
  in `settings.json` (one of the two settings keys a plugin may ship, per the plugins
  reference). Each swarm agent renders as a fixed-width badge whose background encodes
  the **model tier** — bright cyan Haiku, bright green Sonnet, bright yellow Opus —
  plus label, elapsed (`m:ss`, weight not color: dim young, bold near the turn cap),
  and an 8-cell context bar from `tokenCount`/`contextWindowSize`. Bright red is
  reserved for one anomaly: a `leaf` resolved off Sonnet, the void condition of the
  build prediction in `evals/README.md`. Unresolved models get a neutral badge, never
  a guessed tier (`model`/`contextWindowSize` need Claude Code v2.1.205+). Under
  narrow `columns` the bar drops first, then the label, then elapsed — never the
  badge. Non-swarm rows keep the default rendering. The script never exits non-zero;
  every failure degrades to default rendering.
- **`scripts/swarm-statusline.js`, a post-install main-status-line segment** showing
  running swarm agents by tier (`swarm 2H 5S 1O`, red only for anomalies). Manual
  step because a plugin cannot ship `statusLine` ("Only the `agent` and
  `subagentStatusLine` keys are currently supported" — plugins reference). The README
  documents the settings block with `refreshInterval: 1`, since the event-driven
  triggers go quiet exactly while a master waits on background subagents.
- **One deviation from "no state file", forced by the harness:** the main status
  line's stdin carries session data only — the `tasks` array goes exclusively to
  `subagentStatusLine` — so the subagent renderer caches a ~150-byte per-session
  aggregate in the OS temp dir (the statusline docs' own caching pattern, keyed by
  sanitized `session_id`) and the segment reads it with a 10s staleness cutoff.
- **Smoke checks (51 → 60)** run both scripts against synthetic payloads: the tier
  matrix incl. the red anomaly badge, model-absent degradation, narrow-columns drop
  order with ANSI-stripped width asserted, garbage stdin, aggregate cache contents,
  the segment's live/stale/missing cache behavior, bare-name identity, and the
  terminal-status row.

### Fixed before first use
Two silent failures found by re-reading the payload contract against the shipped
renderer, both fixed under this same unreleased version:
- **A finished row's clock kept counting.** The tasks payload carries `startTime`
  but no end time, so elapsed can only be computed against now — on a terminal
  status that is a clock still ticking after the agent stopped. Terminal rows now
  drop elapsed and the context bar (both stale) and dim the label, keeping only the
  tier badge.
- **Identity matching was single-shaped.** The field carrying a subagent's identity
  in the tasks array is unspecified; only `SubagentStop`'s scoped `agent_type`
  ("claude-swarm:leaf") is documented elsewhere. A mismatch would have silently
  no-op'd the entire feature. Matching now also accepts a bare roster name across
  `type`/`name`/`agent_type`/`subagent_type` — but **only a scoped match may raise
  the red anomaly**, so a user's own agent named `leaf` cannot fire the one alarm
  that is supposed to mean something.

Tier detection is substring-based rather than an ID whitelist, so provider-prefixed
IDs (`us.anthropic.claude-sonnet-4-…-v1:0`) resolve correctly, and a leaf resolved
to Fable — which contains no tier word — trips the anomaly rather than falling
through to neutral. Both verified by hand against the renderer.

### Known first-contact risk
- Whether `${CLAUDE_PLUGIN_ROOT}` substitutes inside a plugin `settings.json`
  command is not documented (the substitution table lists hooks, monitors, MCP, LSP,
  and skill/agent content only). If it does not resolve, the failure mode is the
  default row rendering, not a broken panel.

## [0.2.1] — 2026-07-26

Everything between the 0.2.0 reframe and the first real build run: deferred decisions
settled on measurement, the shakedown protocol, and the fixes that keep its metrics clean.
Matters for marketplace installs in particular — the shakedown loads the working tree via
`--plugin-dir`, but organic installs read the cached version and see none of this without
the bump.

### Changed
- **`leaf` drops to `effort: low`, measured rather than defaulted.** Writing: low vs
  medium across four units with real type surface, self-repair disabled, tied 3/4 on
  first-attempt type check — the same unit failing with the same missing-import error at
  both levels — with equal turns, low ~9% cheaper and ~27% faster. Repair, the thing that
  actually makes the tier drop safe: the shipped typecheck-and-fix path cleared the known
  failing artifact at low in 6 turns for $0.15. The evidence and the turn arithmetic
  (write 5–6 of 25, ~6 per repair cycle) are recorded above the pin.
- **Extending the import line is explicitly the leaf's job**, stated next to "never change
  a signature" in the agent definition and in the dispatch prompt. Implementations
  routinely need types the signature never names — the observed failure used a type
  internal to the contract's structure, so no correctly specified stub could have
  pre-imported it. A smoke check pins the rule's presence in both homes.
- **Batching merges nested read-sets** (prefix sharing, not set equality), reads the
  shared portion first, and orders each batch owner-before-reader, since subset merging
  can co-locate a dependency with its dependent.
- **Each leaf's type check is sibling-filtered and hardened.** The project command runs
  unfiltered with output and exit captured, then the output is filtered to the leaf's
  owned files: `OWNED-FILES-CLEAN` is the positive marker, `TYPECHECK-BROKEN` reports a
  tool that failed to run (exit > 1 or a fileless `error TS` diagnostic), and the script's
  own exit status is always 0 — the verdict is output-only. The naive pipe it replaces had
  an inverted exit code (grep exits 1 exactly when clean) and read a broken grader as a
  clean pass. A smoke check executes the generated script against all three cases.
- **Wave 1 stubs must compile**: "empty bodies" became compiling placeholder bodies
  (`throw new Error('not implemented')`) in the skill, the README, and the leaf prompt,
  so the only errors a leaf sees are ones it caused.
- **The injected-policy byte budget is decided, not inherited**: 3000B quiet / 3300B
  day-one — current content plus one structural change of headroom — after the old 2600B
  ceiling was re-tightened twice in one redesign. The test comment carries the reasoning:
  growth past the budget means reference material is accreting in the policy and should
  move to the skill.

### Added
- **`validateManifest` warns on unknown manifest keys**, top-level and per-unit, naming
  the key and the nearest valid one. A misspelled `foundations:` was silently inert and
  cascaded into misleading per-read violations; it now gets one accurate warning first.
  A round-tripped `status` field on units is accepted silently.
- **Pre-registered predictions in `evals/README.md`**: audit's quality arm (better, not
  cheaper — or no measured claim at all), and the first build run — wall 1.5–2.5x, cost
  within ~±25% (void, not falsified, if leaves book to Opus), integration rework under a
  third of leaf files, repair cycles ~1 per unit, `unknown` at most ~1 in 6 — with three
  repair cycles named as the silent-cap threshold.
- **`evals/shakedown.md`**: the frozen Ledgerline spec (ten leaf units with real type
  surface, expected serial fraction stated at ~35–40%), the identical-plan rule, the
  solo-first procedure with a Sonnet-booking probe before the build arm, a recording
  template matching the predictions field for field, and the first-contact risk list.
- **A skill note that effort pins degrade silently** — Claude Code falls back to the
  highest supported level at or below the pin, so a pin invalidated by a future model
  change never announces itself.
- Smoke coverage grew from 46 to 51 checks.

## [0.2.0] — 2026-07-25

Reframes the plugin around what the benchmark actually supports. The old pitch sold the
swarm as cost control; the measurements said fan-out never saves money on work one context
can do (it multiplies input tokens across uncached contexts), and the one multi-wave
workflow measured lost to a solo run 3.95x on cost and 4.63x on wall time. What survives,
measured or honestly labeled: keeping volume out of the main context (Shield), tier
routing into graded environments (Route), and wide waves over genuinely disjoint work
(Build). Every claim about harness behaviour was re-verified against the Claude Code docs
(`workflows`, `sub-agents`, `hooks`, `plugins-reference`, `model-config`).

### Changed
- **The delegation policy and skill now ask three questions in order** instead of "should
  I fan out": does the work need to leave the main context at all (volume, not
  difficulty); what is the cheapest tier that can do it (safe only when something other
  than a model — compiler, tests, linter — grades the output, and the agent runs that
  grader itself); and only then, should it fan out. Fan-out sits behind a disjointness
  gate: branches must not share reads *or* writes (shared input is re-bought per branch —
  fan-out is never cheaper at equal tier), the wave must be wide enough to win on wall
  time, and each chained wave adds a linear penalty. An explicit user invocation
  overrides the judgment, not the arithmetic.
- **`claude-swarm:survey` collapsed from three waves to one.** The shipped shape
  (locate → trace → synthesize) bought the same files three times and measured 3.95x solo
  cost at 4.63x wall time. Each angle is now a single locate-and-read agent, and a caller
  who already knows the relevant files passes them as `files` to skip discovery. Labeled
  honestly in the skill and its own `whenToUse`: a latency-and-shield play, not a cost
  win — the angles still share their input.
- **Workflow labels are honest and predictions are pre-registered.** `audit` is labeled a
  quality play and *currently unmeasured*; `evals/README.md` records, before any
  benchmark run, the prediction that audit loses to solo on cost (shared input) and the
  quality prediction that has to hold for the label to survive.
- **README rewritten** around the three modes, with the build expectation stated plainly:
  the ceiling is the serial fraction, so ~2x over a solo draft is the realistic target.

### Added
- **`claude-swarm:build`** — the wide-wave workflow for drafting an app from a finalized
  plan. The master writes the foundation, signature files, and a work manifest itself (a
  serial foundation agent would re-buy a plan the master already holds); the workflow
  validates the manifest with plain code before spending anything (exclusive ownership,
  acyclic read/own graph, paths inside the project, shared files reserved for
  integration), runs a wide Sonnet leaf wave with per-unit dependency gating, a
  concurrency ceiling, and read-set batching (both exposed as dials), then integrates
  split by grader: a sonnet mechanic re-derives state from the tree and fixes what the
  compiler grades; only judgment calls escalate to opus.
- **`claude-swarm:leaf`** — the turn-capped Sonnet agent the build wave runs. The cap is
  load-bearing and its behaviour was measured, not assumed: a capped subagent returns
  *silently* ("Subagent completed but returned no output.", no marker), so the workflow
  records a missing structured return as `unknown` — never `failed` — and integration
  trusts the tree, not the reports.
- **A completion feed.** A SubagentStop hook (no matcher: it catches every agent rather
  than enumerating types that would drift) appends timestamp, agent type, and final
  message to `.claude-swarm-feed.log` in the project directory. It always exits 0 —
  exit code 2 on SubagentStop would block the subagent from stopping.
- **16 new smoke checks**: the manifest validator's rejection cases, leaf dependency
  ordering and read-set batching, silent-leaf handling with tree-derived completion,
  judgment escalation, and the feed hook's append and never-crash contracts. 46 total.

## [0.1.4] — 2026-07-25

Cuts the cost of the `audit` workflow without moving its confirmation bar, and stops the
delegation policy from asserting a concurrency figure it cannot keep true.

### Changed
- **`claude-swarm:audit` batches verification instead of spawning one agent per claim.**
  The old shape was `findings × (VOTES + 1)` spawns, each re-establishing context to judge
  a single finding; on this project it was 86% of delegated spend across 114 verifier
  spawns, a third of it cache writes alone. A skeptic now reads once and returns a verdict
  per finding, up to 8 per batch. Escalation is adaptive: wave 1 sends a single skeptic
  over the whole batch, and because skeptics refute by default when unsure, most weak
  candidates die in that one cheap pass — only survivors face the remaining angles.
  **The confirmation threshold is unchanged.** A finding still has to survive `VOTES` of
  `VOTES + 1` independent attempts, and escalation is skipped only where it could not
  change the outcome. The invariant that a skeptic which *failed to run* is bucketed
  `unverified` rather than refuted is preserved, and is now covered by a test.
  Roughly 80–87% fewer verifier agents on representative shapes — a figure from the
  stubbed tests, not from a live run.
- **Workflows are now executed by the test suite, not merely compiled.** The confirm/refute
  logic had no runtime coverage; three checks run `workflows/audit.js` against stubbed
  agents and assert both the outcomes and the verifier call counts. This needed an
  async-aware `check()` — the previous one would have let a rejected assertion pass
  silently.

### Fixed
- **The delegation policy no longer quotes any concurrency figure.** 0.1.3 replaced the
  invented "cap at 6" with 20 concurrent / 200 per session. Those numbers were right —
  verified in the shipped CLI, where they are literals (`gty=20`, `yty=200`) behind
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` / `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` — but a
  figure was still the wrong *shape* of claim: both are env-tunable, neither is pinned by
  any contract this plugin controls, and the routing rules never actually depended on the
  value. A number written down here is a claim that goes stale in silence, which is how
  "cap at 6" survived as long as it did.
  The same entry said workflow `agent()` spawns are "exempt from both", which reads as
  *uncapped*. They are not: they run against their own semaphore, sized from the machine's
  CPU count (`Math.min(16, Math.max(2, cores - 2))`), plus a per-run ceiling. The
  difference that actually drives routing is behavioural — ad-hoc `Agent` dispatch **fails**
  past its ceiling, workflow spawns **queue** — and that is a stronger argument for
  `claude-swarm:survey`/`audit` than "exempt" ever was.
  The policy and `skills/claude-swarm/SKILL.md` now state the behaviour, name the env vars,
  and point at the live `Agent`/`Workflow` tool descriptions for current values. A test
  asserts the policy contains no ceiling figure at all, so the next stale number cannot
  ship the way the last two did.

## [0.1.3] — 2026-07-25

Corrects claims about the harness that were invented or had gone stale, and teaches the
SessionStart hook to detect the conditions that silently defeat this plugin's design. Every
behavioural claim here was verified against the Claude Code documentation
(`sub-agents`, `plugins-reference`, `model-config`) rather than assumed — including against
this plugin's own workflows, which are not a source of truth about the harness.

### Fixed
- **The delegation policy advertised a concurrency cap that does not exist.** "Cap at 6
  concurrent" was invented rather than measured, and it was the only ceiling the routing
  rules offered — so fan-outs were being sized against a fiction. The real limits are **20
  concurrent** and **200 per session**, tunable via `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
  and `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`; past either, the `Agent` tool fails rather
  than queueing. Agents a workflow spawns with `agent()` are exempt from both, which is a
  concrete reason to route wide fan-outs through `claude-swarm:survey`/`audit` instead of
  dispatching by hand. Corrected in both places it appeared: `skills/claude-swarm/SKILL.md`
  and the hook's injected policy.

### Added
- **The hook now warns when the plugin's premises don't hold.** Four read-only probes, each
  one line, each **false on a correctly configured machine** — a clean setup gets the policy
  and nothing else. Same never-throw contract as before: every probe is individually
  guarded, so a failing check can never cost you the policy, and nothing is written,
  created, or deleted.
  - **Duplicate roster.** Agent files in `~/.claude/agents/` sharing the plugin's roster
    names are named back to you. These do *not* shadow the plugin's agents — a plugin agent
    registers under a namespaced identifier (`claude-swarm:scout`) and a user agent under
    its bare `name` (`scout`), so the two coexist as **different agents**. A policy naming
    one is then invalid against the other, the `Agent` tool answers
    `Agent type '<name>' not found`, and the main loop absorbs that error by doing the work
    itself — indistinguishable, from outside, from the swarm refusing to spawn. The notice
    describes the conflict rather than prescribing a fix: *why* the registered set differs
    between sessions is not yet understood, and promising a cure would overclaim.
  - **`CLAUDE_CODE_SUBAGENT_MODEL`** set to anything other than `inherit`: it sits *above*
    frontmatter in the model resolution order, so it silently voids every tier pin in
    `agents/` and cost tiering stops working.
  - **Missing `Explore` override** (below), and **stale workflow copies** from ≤0.1.1.
- **A payload budget test.** `test/smoke.js` now pins the injected context size. The hook's
  output is billed every session forever, so growth needs to be deliberate; this makes an
  accidental increase a test failure instead of an invisible cost.
- **README: a post-install step to keep `Explore` cheap.** Since Claude Code v2.1.198 the
  built-in `Explore` agent inherits the main conversation's model rather than always running
  Haiku — and `Explore` is typically the most-spawned agent in a session, so ambient
  exploration now bills at your top tier. Only a **user or project** agent named `Explore`
  overrides the built-in; a plugin cannot supply one, because plugin agents register
  namespaced and rank lowest in scope precedence. Hence a documented one-file step rather
  than a seventh agent in `agents/`, with `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` noted as
  the alternative.
- **`SKILL.md`: when to prefer a fork over `tracer`.** A fork inherits the parent's system
  prompt and tool definitions unchanged, so it reuses the parent's prompt cache and skips
  both subagent tool filters. Prefer it when the task needs context already loaded; prefer
  `claude-swarm:tracer` for bulk reading of files not yet in context. A fork is a cache-warm
  shortcut, not a cheaper tier — it runs at the parent's model and counts against the
  session budget.
- **Nesting is documented.** Subagents cannot spawn subagents by default, so every agent is
  dispatched from the main loop. Stated once as a routing rule in the policy and expanded in
  `SKILL.md`.

### Changed
- **Per-token dollar figures removed from the routing prose.** The `$10/$50 vs $5/$25` and
  Sonnet-introductory-pricing figures in the README, `SKILL.md`, and the injected policy were
  only ever illustrative, but they read as load-bearing: on a subscription plan there is no
  per-token price to reason about, and on API billing the published rates move. The tier
  *ordering* — `haiku < sonnet < opus < fable` — is what the routing actually depends on and
  is all that remains. Fable stays opt-in as the top of that ladder.
- **Cost prose now accounts for extended thinking.** As of v2.1.198 subagents inherit the
  main conversation's extended thinking configuration; previously they ran with it off
  unconditionally. Same roster, same task, more tokens — and turning thinking down in the
  main session turns it down for the whole swarm.

### Note on measurement
Earlier benchmarking suggested the swarm rarely self-delegates and that the injected policy
is therefore mostly wasted. That result is **not** treated as established here: it was
collected while the roster-name conflict above was live, so delegation would have failed
regardless, and the harness loaded the plugin from the install cache rather than the working
tree. The policy has not yet been measured under conditions where it could have worked.

## [0.1.2] — 2026-07-24

### Changed
- The SessionStart hook no longer copies `survey.js`/`audit.js` into
  `~/.claude/workflows/`. It never needed to: Claude Code auto-discovers a plugin's
  `workflows/` directory exactly as it does `agents/` and `skills/` — a plain
  directory-existence check in the plugin loader, with no feature gate — so the plugin
  has been serving `claude-swarm:survey` and `claude-swarm:audit` all along. The copy
  was a duplicate whose `if (exists) continue` guard also froze it forever: it was
  written once and never refreshed, so every later release silently left a stale
  second copy behind. The hook now only *reports* leftovers from 0.1.1 and earlier;
  deleting files from a user's config dir is not a SessionStart hook's call to make.
- The injected policy and the skill now name the workflows `claude-swarm:survey` /
  `claude-swarm:audit`, matching how the agents are already namespaced.

### Fixed
- Skill: the documented invocation was `Workflow({ name: 'survey' }, "…")`, which
  passes the target as a second positional argument. `Workflow` takes a single input
  object — corrected to `Workflow({ name: 'claude-swarm:survey', args: '…' })`.
- Docs: README and CONTRIBUTING asserted that "Claude Code plugins cannot serve
  Workflow scripts natively." They can; the claim is removed.

## [0.1.1] — 2026-07-24

### Fixed
- `audit`/`survey`: accept `args` delivered as a JSON-encoded string (how the Workflow
  tool marshals a passed object), not only as a live object. Previously a JSON string was
  mistaken for the bare target/question, so `lenses` / `votes` / `angles` were silently
  discarded and the workflow ran its full defaults.
- `audit`: `votes >= 4` no longer makes confirmation mathematically impossible — the
  skeptic pool now scales to `votes + 1` by cycling the doubt angles, and `votes` is
  validated (an explicit `0` is honored; negative/non-integer values coerce to the
  default *with a log*, not silently).
- `audit`: findings whose verifiers all failed to run are now reported as `unverified`
  rather than silently miscounted as refuted.
- `audit`/`survey`: an empty `lenses` / `angles` array falls back to the defaults
  instead of producing a false-clean audit or a misleading "no match" survey.
- `survey`: a trace-stage failure is now logged (not silently dropped, which made the
  coverage line lie), and a failed synthesis falls back to the raw readings instead of
  returning `null`.

### Added
- README: a fan-out diagram showing the `audit`/`survey` shape.

### Changed
- README: model wording swept to versionless tier names ("Fable or Opus"), matching the
  hook, skill, CONTRIBUTING, and manifests. Prompted by the Claude Opus 5 release: the
  agents pin tiers (`model: opus`), not model IDs, so they picked up Opus 5 with no
  config change — and versionless prose means the docs don't go stale at the next
  release either. Pricing figures are unchanged (Opus 5 costs the same $5/$25 as
  Opus 4.8; Fable stays 2x that). The Sonnet 5 introductory-pricing note keeps its
  version name, since that promo is specific to the model.

_Found by running the plugin's own `survey` and `audit` workflows against itself._

## [0.1.0] — 2026-07-24

Initial release.

### Added
- **Six cost-tiered agents**, each pinned to the cheapest model that does its job
  well: `scout` (haiku), `tracer` (sonnet·xhigh), `implementer` (opus·high),
  `mechanic` (sonnet·low), `verifier` (sonnet·xhigh), `scribe` (haiku).
- **`claude-swarm` orchestration skill** — the playbook for deciding when to fan
  out vs. stay solo, which tier to route to, and how to author a `Workflow` inline.
- **Two verify-by-default workflows**, `survey` (map an unfamiliar area) and
  `audit` (find, then adversarially refute), installed into `~/.claude/workflows/`
  by the SessionStart hook.
- **SessionStart hook** that best-effort installs the workflows (never overwriting
  a user's own copies) and injects a compact delegation policy as context.
- **Smoke test and GitHub Actions CI** — static validation of the manifests,
  runtime checks of the hook contract, and compile checks of the workflow scripts.

[Unreleased]: https://github.com/phil9922/claude-swarm/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/phil9922/claude-swarm/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/phil9922/claude-swarm/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/phil9922/claude-swarm/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/phil9922/claude-swarm/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/phil9922/claude-swarm/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/phil9922/claude-swarm/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/phil9922/claude-swarm/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/phil9922/claude-swarm/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/phil9922/claude-swarm/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/phil9922/claude-swarm/releases/tag/v0.1.0
