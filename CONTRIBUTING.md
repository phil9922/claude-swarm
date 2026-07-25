# Contributing

Thanks for taking a look. claude-swarm is a small, opinionated plugin, so this is
short.

## The one idea to preserve

Every change should keep the plugin's reason for existing intact: **a Fable or Opus
master orchestrates; cheaper, specialized agents do the work below it; you fan out
only when it pays.** Concretely — don't route production code off the top tier,
don't make the swarm the default for work that a single agent should do, and keep
Fable opt-in only. If a change blurs those lines, it needs a good argument.

## Running the checks

There is no build step. The smoke test validates that the plugin would load:

```
npm test        # or: node test/smoke.js
```

It checks the three JSON manifests, runs the SessionStart hook and asserts it ships
its policy (even when config-dir resolution fails), compiles both workflow scripts,
and validates every agent's and the skill's frontmatter. CI runs the same thing on
every push and pull request — **keep it green.** Requires `node` on your `PATH`.

## Adding to the roster

- **A new agent** — add `agents/<name>.md` with frontmatter (`name`, `description`,
  `model`, and `tools`). Add the expected name to `EXPECTED_AGENTS` in
  `test/smoke.js` so it's covered. Pin it to the cheapest model that does its job.
- **A new workflow** — add `workflows/<name>.js`. Claude Code auto-discovers the
  directory, so it resolves as `claude-swarm:<name>` with no wiring. It must begin
  with a pure-literal `export const meta = { name, description, phases }`. Leave the
  `LEGACY_COPIES` list in `hooks/session-start.js` alone — that is a fixed record of
  what v0.1.1 and earlier copied into `~/.claude/workflows/`, not a registry.
- **The delegation policy** — the compact version injected each session lives in
  `hooks/session-start.js`; the full playbook is `skills/claude-swarm/SKILL.md`.
  Keep them consistent when you change routing rules.

## Commits, versions, and releases

- Keep commits focused and their messages explaining *why*, not just *what*.
- **Versioning is SemVer.** Bump `version` in `.claude-plugin/plugin.json`, add a
  section to [`CHANGELOG.md`](./CHANGELOG.md), and tag the release commit `vX.Y.Z`
  to match — the tag and the manifest version must agree.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](./LICENSE).
