<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/header-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="img/header-light.png">
  <img alt="claude-swarm — cost-tiered multi-agent delegation for Claude Code" src="img/header-light.png">
</picture>

A **Fable or Opus master** orchestrates; a **swarm of cheaper, specialized agents**
does the work below it. The master fans out *only when it pays* — the goal is spending less,
not spawning more. Fable is opt-in only: run it as the master if you've chosen it for your
session, but the swarm never routes to the expensive tier by accident.

## What you get

**Six tiered agents** — each pinned to the cheapest model that can do its job well:

| Agent | Model · effort | For |
|---|---|---|
| `claude-swarm:scout` | haiku | Where is it — paths and line numbers |
| `claude-swarm:tracer` | sonnet · xhigh | How does it work — reads a lot, returns a little |
| `claude-swarm:implementer` | opus · high | Production code where a mistake is expensive |
| `claude-swarm:mechanic` | sonnet · low | A decided change applied across N sites |
| `claude-swarm:verifier` | sonnet · xhigh | Adversarial: refute the claim, run the thing |
| `claude-swarm:scribe` | haiku | Docs, README, changelog, comments |

**An orchestration skill** (`claude-swarm`) — the playbook the master loads when deciding
how to spread work: when to fan out vs. stay solo, which agent to route to, how to author a
`Workflow` inline, and the rules that keep credit usage down.

**Two verify-by-default workflows**, served by the plugin as `claude-swarm:survey` and
`claude-swarm:audit`:
- **`survey`** — map an unfamiliar area: scouts locate across angles, tracers follow each,
  one map is synthesized.
- **`audit`** — find problems, then adversarially verify: findings are refuted by default,
  so only survivors are reported.

**An always-on delegation policy**, injected each session by a SessionStart hook, so the
routing rules are in context without editing your `CLAUDE.md`.

## Install

```
/plugin marketplace add phil9922/claude-swarm
/plugin install claude-swarm
```

Or from a local clone:

```
/plugin marketplace add /path/to/claude-swarm
/plugin install claude-swarm
```

Start a new session after installing. The agents, skill, and workflows are served by the
plugin directly; the SessionStart hook injects the delegation policy.

**Requirement:** the SessionStart hook is a small Node script, so `node` must be on your
`PATH`. If it isn't, the plugin still loads — you just won't get the injected policy. To
install it:

```
brew install node                  # macOS
sudo apt install nodejs            # Ubuntu/Debian
winget install OpenJS.NodeJS.LTS   # Windows
```

Or any other method from [nodejs.org](https://nodejs.org/en/download) — the hook has no
version requirement beyond a non-ancient Node.

### Post-install: keep `Explore` cheap

**This is the one step the plugin cannot do for you, and skipping it quietly undoes much of
the saving.**

Claude Code ships a built-in `Explore` agent and reaches for it constantly — it is usually
the most-spawned agent in a session by a wide margin. It used to always run on Haiku. Since
Claude Code v2.1.198 it **inherits the main conversation's model instead** (capped at Opus
on the Claude API). So on an Opus session, every ambient "go look that up" now bills at
Opus — exactly the cost this plugin exists to avoid.

A subagent named `Explore` overrides the built-in and keeps its own `model` field. But it
**must be a user or project agent** — a plugin cannot supply one, because plugin agents
register under a namespaced identifier (`claude-swarm:explore`, not `Explore`) and rank
lowest in scope precedence. That is why this is a manual step rather than a seventh agent
in `agents/`.

Create `~/.claude/agents/Explore.md`:

```markdown
---
name: Explore
description: Fast, read-only agent for searching and analyzing codebases.
model: haiku
tools: Read, Glob, Grep, Bash
---

Search and analyze the codebase. Return paths, line numbers, and short excerpts —
not full file dumps. Do not modify anything.
```

Restart the session afterwards. If you would rather not override it at all, set
`CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` to remove the built-in `Explore` and `Plan`
agents entirely — Claude then reads files directly instead of delegating to them.

The SessionStart hook mentions this once per session while that file is absent, and goes
quiet as soon as it exists.

### If you previously copied the agents into `~/.claude/agents/`

Remove them, or switch to the namespaced names. The plugin serves the roster itself as
`claude-swarm:scout` and friends. A bare-named copy in `~/.claude/agents/` does **not**
shadow the plugin's — it registers as a *separate* agent, so you end up with two rosters
under two sets of names, and a delegation policy naming one fails against the other with
`Agent type '<name>' not found`. The hook detects this and names the files.

## How it decides to fan out

Fan-out always uses more *total tokens* than one agent doing the same work — duplicated
context, plus a synthesis step. That's not the same as costing more *money*: when the work
fits, most of those tokens are billed at haiku/sonnet rates instead of Opus rates, so
the bill still shrinks (see "Cheaper and faster" below). The fan-out itself buys speed and
coverage; the cheap tiers are where the savings come from. So the master spends it
deliberately:

- **Swarm** — audits/reviews, multi-file features, "find every X", migrations, mapping an
  unfamiliar subsystem, anything touching 4+ files.
- **Stay solo** — single-file edits, questions answerable from loaded context, under ~3
  files, conversation. *This is the actual cost control.*

Either way, bulk reading is delegated: if answering needs more than ~3 files or ~500 lines,
a `scout` or `tracer` reads it and returns a summary, rather than pulling source into the
main context where it's re-sent every turn.

## What a fan-out looks like

`audit` is the pattern in miniature: the master fans cheap readers across lenses,
then throws independent skeptics at whatever they find — only survivors are reported.

```
  $ /audit "the uncommitted diff"

  master · Fable or Opus
  │
  ├─ FIND ── fan out one cheap tracer per lens (parallel)
  │    ├─ tracer: correctness ┐
  │    ├─ tracer: errors      ├─ candidate findings
  │    └─ tracer: concurrency ┘
  │
  └─ VERIFY ── each finding → N verifiers try to refute it (parallel)
       ├─ ✗ refuted  → dropped
       └─ ✓ survived → confirmed
```

`survey` shares the skeleton with different muscles: scouts locate across angles, a
tracer follows each, and a final synthesis pass assembles one map. The master spends
this fan-out only when it pays (see below) — otherwise it stays solo.

## Cheaper and faster than a solo Opus master — without losing quality

Against a single Opus worker doing the same task set, claude-swarm wins on **both** cost
and speed for the work it's built to fan out — without giving up quality to get there — and
deliberately declines to fan out the work where it wouldn't:

- **Cheaper.** Most of a task is locating, reading, mechanical edits, and prose — none of it
  needs the top tier. Routing that to haiku- and sonnet-class agents means you stop paying
  Opus rates for haiku-grade work. (As above: the fan-out *itself* uses more total
  tokens — the saving comes from the cheaper model tier and from keeping the expensive main
  context small, not from fanning out.)
- **Faster.** On independent, multi-file work the agents run concurrently, so wall-clock is
  the *slowest single slice* rather than the sum; and the cheaper models are individually
  faster than Opus (higher throughput, quicker first token). A six-file audit that's ~six
  units solo is ~one unit fanned out.
- **No quality loss.** The tier drops only where the task doesn't need the reasoning, never
  where correctness is the constraint: production code stays with `implementer` on opus (the
  **never downgrade** rule also protects the main loop), mechanical edits are graded by the
  compiler and tests, and audit findings must survive adversarial verifiers that refute by
  default — a check a solo worker doesn't get at all.

**The catch, stated plainly:** for sequential or small work — one file, a question
answerable from context already loaded — fan-out only adds orchestration round-trips with no
parallelism to hide them, so it's *slower* and costs more. That is exactly why the routing
rules push that work back to solo. Follow them and the swarm is as-fast-or-faster than solo
Opus on the same task set; fan out inherently sequential work and you'll pay for the
overhead with nothing to show for it. Speed and savings appear only where there's real
parallelism or a cheaper tier that can do the job — and spending the swarm *only* there is
the plugin's entire job.

## Cost model

- **Master** = the main loop / a Workflow script on **Opus** — or **Fable** if
  you've opted your session into it.
- **Swarm** = haiku and sonnet agents, picked per task.
- **The routing depends on one thing: the ordering `haiku < sonnet < opus < fable`.**
  That holds on every plan and every provider, which is why it's what the rules are
  written against.
- **Fable is opt-in only.** It sits above Opus at the top of that ladder and is never
  routed to automatically — it's proposed only for a task Opus has actually failed at,
  with the cost named.

Deliberately absent: per-token dollar figures. On a subscription plan there is no
per-token price to reason about, and on API billing the published rates move — a number
baked into this README would be wrong for some readers and stale for the rest. See
[Anthropic's pricing](https://www.anthropic.com/pricing) for current rates; nothing in this
plugin's routing needs them.

One thing worth knowing, because it makes every agent cost more than it used to: since
Claude Code v2.1.198 subagents **inherit the main conversation's extended thinking
configuration**. Previously they ran with it off unconditionally. Same roster, same task,
higher bill when thinking is on — and turning it down in the main session turns it down for
the whole swarm.

## Layout

```
claude-swarm/
  .claude-plugin/
    plugin.json          # plugin manifest
    marketplace.json     # single-repo marketplace (this repo is both)
  agents/                # the six tiered agents
  skills/claude-swarm/   # the orchestration playbook
  workflows/             # survey.js, audit.js (auto-discovered by Claude Code)
  hooks/                 # SessionStart: inject the delegation policy
  test/smoke.js          # manifests + hook + workflows load (npm test)
  .github/workflows/     # CI: runs the smoke test on push/PR
  img/                   # README header banner (light/dark)
```

> `workflows/` is auto-discovered the same way `agents/` and `skills/` are, so the scripts
> resolve as `claude-swarm:survey` and `claude-swarm:audit` without being copied anywhere.
> Versions up to 0.1.1 copied them into `~/.claude/workflows/` instead; if you installed one
> of those, the leftovers are inert duplicates and the hook will point them out.

## Support

claude-swarm is free and open source, built and maintained by one person. If it
saved you some tokens, you can [buy me a coffee](https://ko-fi.com/phil9922). ☕

## License

MIT — see [LICENSE](./LICENSE).
