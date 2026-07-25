# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): the git tag
`vX.Y.Z` matches the `version` in `.claude-plugin/plugin.json`.

## [Unreleased]

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

[Unreleased]: https://github.com/phil9922/claude-swarm/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/phil9922/claude-swarm/releases/tag/v0.1.0
