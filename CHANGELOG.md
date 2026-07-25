# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): the git tag
`vX.Y.Z` matches the `version` in `.claude-plugin/plugin.json`.

## [Unreleased]

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

[Unreleased]: https://github.com/phil9922/claude-swarm/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/phil9922/claude-swarm/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/phil9922/claude-swarm/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/phil9922/claude-swarm/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/phil9922/claude-swarm/releases/tag/v0.1.0
