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

## Cheaper and faster than one Opus 4.8 — when the work fits

Against a single Opus 4.8 worker doing the same task set, claude-swarm wins on **both** cost
and speed for the work it's built to fan out — and deliberately declines to fan out the work
where it wouldn't:

- **Cheaper.** Most of a task is locating, reading, mechanical edits, and prose — none of it
  needs the top tier. Routing that to haiku- and sonnet-class agents means you stop paying
  Opus rates for haiku-grade work. (The fan-out *itself* uses more total tokens than one
  agent — duplicated context, a synthesis step — so the saving comes from the cheaper model
  tier and from keeping the expensive main context small, not from fanning out.)
- **Faster.** On independent, multi-file work the agents run concurrently, so wall-clock is
  the *slowest single slice* rather than the sum; and the cheaper models are individually
  faster than Opus (higher throughput, quicker first token). A six-file audit that's ~six
  units solo is ~one unit fanned out.

**The catch, stated plainly:** for sequential or small work — one file, a question
answerable from context already loaded — fan-out only adds orchestration round-trips with no
parallelism to hide them, so it's *slower* and costs more. That is exactly why the routing
rules push that work back to solo. Follow them and the swarm is as-fast-or-faster than solo
Opus on the same task set; fan out inherently sequential work and you'll pay for the
overhead with nothing to show for it. Speed and savings appear only where there's real
parallelism or a cheaper tier that can do the job — and spending the swarm *only* there is
the plugin's entire job.

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
  test/smoke.js          # manifests + hook + workflows load (npm test)
  .github/workflows/     # CI: runs the smoke test on push/PR
```

> Workflows live under `workflows/` and are installed by the hook because Claude Code
> plugins cannot serve Workflow scripts natively — they resolve only from
> `~/.claude/workflows/` or a project's `.claude/workflows/`.

## Support

claude-swarm is free and open source, built and maintained by one person. If it
saved you some tokens, you can [buy me a coffee](https://ko-fi.com/phil9922). ☕

## License

MIT — see [LICENSE](./LICENSE).
