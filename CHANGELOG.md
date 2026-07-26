# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): the git tag
`vX.Y.Z` matches the `version` in `.claude-plugin/plugin.json`.

## [Unreleased]

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

[Unreleased]: https://github.com/phil9922/claude-swarm/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/phil9922/claude-swarm/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/phil9922/claude-swarm/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/phil9922/claude-swarm/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/phil9922/claude-swarm/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/phil9922/claude-swarm/releases/tag/v0.1.0
