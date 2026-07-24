# claude-swarm

A cost-tiered multi-agent delegation system for [Claude Code](https://claude.com/claude-code).

An **Opus 4.8 master** orchestrates; a **swarm of cheaper, specialized agents** does the
work below it. The master fans out *only when it pays* — the goal is spending less, not
spawning more. Fable is opt-in only, so the expensive tier never gets used by accident.

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

**Two verify-by-default workflows**, installed into `~/.claude/workflows/` on first run:
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

Start a new session after installing. On first run the hook copies `survey.js` and
`audit.js` into `~/.claude/workflows/` (only if absent — it never overwrites your own
copies) and injects the delegation policy.

**Requirement:** the SessionStart hook is a small Node script, so `node` must be on your
`PATH`. If it isn't, the plugin still loads — you just won't get the auto-installed
workflows or the injected policy.

## How it decides to fan out

Fan-out costs more *total* tokens than one agent doing the same work — it buys speed and
coverage, not savings. So the master spends it deliberately:

- **Swarm** — audits/reviews, multi-file features, "find every X", migrations, mapping an
  unfamiliar subsystem, anything touching 4+ files.
- **Stay solo** — single-file edits, questions answerable from loaded context, under ~3
  files, conversation. *This is the actual cost control.*

Either way, bulk reading is delegated: if answering needs more than ~3 files or ~500 lines,
a `scout` or `tracer` reads it and returns a summary, rather than pulling source into the
main context where it's re-sent every turn.

## Cost model

- **Master** = the main loop / a Workflow script on **Opus 4.8**.
- **Swarm** = haiku and sonnet agents, picked per task.
- **Fable 5 is opt-in only.** It is 2x Opus 4.8's price ($10/$50 vs $5/$25 per 1M) and is
  never routed to automatically — it's proposed only for a task Opus 4.8 has actually failed
  at, with the cost named.
- Sonnet 5 is on introductory pricing until **2026-08-31** ($2/$10 vs $3/$15), making the
  sonnet-tier agents ~2.5x cheaper than Opus rather than 1.67x.

## Layout

```
claude-swarm/
  .claude-plugin/
    plugin.json          # plugin manifest
    marketplace.json     # single-repo marketplace (this repo is both)
  agents/                # the six tiered agents
  skills/claude-swarm/   # the orchestration playbook
  workflows/             # survey.js, audit.js (installed to ~/.claude/workflows/)
  hooks/                 # SessionStart: install workflows + inject policy
```

> Workflows live under `workflows/` and are installed by the hook because Claude Code
> plugins cannot serve Workflow scripts natively — they resolve only from
> `~/.claude/workflows/` or a project's `.claude/workflows/`.

## License

MIT — see [LICENSE](./LICENSE).
