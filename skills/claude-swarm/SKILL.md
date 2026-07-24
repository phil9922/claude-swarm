---
name: claude-swarm
description: The orchestration playbook for the claude-swarm agent roster — how to decide when to fan out a swarm, which model tier each agent runs on and why, how to author a Workflow inline or call the survey/audit workflows, and the cost rules that keep credit usage down (Fable opt-in only). Load this whenever you are about to delegate work, plan a multi-agent task, run an audit/review/migration, map an unfamiliar subsystem, or otherwise decide how to spread work across agents.
---

# claude-swarm orchestration playbook

You are the **master**: the main loop, or a `Workflow()` script you author, running on
**Fable or Opus**. You do not do the bulk work yourself — you decide *whether* to fan out, spawn
the right agents on the right model tier, and synthesize their results. The point is
spending **less**, not spawning more.

## First decision: fan out, or stay solo?

Fan-out costs more *total* tokens than one agent doing the same work. It buys speed and
coverage, not savings. So spend it deliberately.

**Fan out (swarm):**
- Audits, reviews, "find every X" sweeps
- Multi-file features and refactors touching 4+ files
- Migrations — one agent per file/site
- Mapping an unfamiliar subsystem end-to-end

**Stay solo (the actual cost control):**
- Single-file edits
- Questions answerable from context already loaded
- Anything under ~3 files
- Conversation

## Always delegate bulk reading — even when solo

If answering needs more than ~3 files or ~500 lines, send a `claude-swarm:scout` or
`claude-swarm:tracer` instead of reading it into the main context. Main-loop context is
re-sent every turn, so a summary that costs once beats source that costs every turn. This
is the single biggest saving available.

## The roster and why each tier

| Agent | Model · effort | Use for | Why this tier |
|---|---|---|---|
| `claude-swarm:scout` | haiku | WHERE is it — paths, line numbers, call sites | Locating is cheap; no reasoning needed |
| `claude-swarm:tracer` | sonnet · xhigh | HOW does it work — reads thousands of lines, returns a few hundred words | Deep reading needs reasoning, but the output is small |
| `claude-swarm:implementer` | opus · high | Production code where a mistake is expensive | Correctness is the constraint; don't downgrade |
| `claude-swarm:mechanic` | sonnet · low | A decided change applied across N sites | The compiler/tests grade it — cheap is fine |
| `claude-swarm:verifier` | sonnet · xhigh | Adversarial: refute a claim, run the thing | Skepticism needs reasoning; runs in parallel |
| `claude-swarm:scribe` | haiku | Docs, README, changelog, comments | Prose about code; cheapest in the roster |

Routing heuristic: **scout to find, tracer to understand, implementer to build what's
risky, mechanic to apply what's decided, verifier to attack a claim, scribe to write it up.**

## The two saved workflows

The SessionStart hook installs these into `~/.claude/workflows/`, so they resolve by name:

- **`survey`** — map an unfamiliar area. Fans scouts across angles → a tracer follows each →
  synthesizes one map. Call it when "how does X work" would mean reading many files into the
  main context. `Workflow({ name: 'survey' }, "how does auth work")`
- **`audit`** — find problems, then adversarially verify. One tracer per lens finds
  candidates → independent verifiers try to refute each → only survivors are reported. Call
  it for reviews, diff audits, bug hunts. `Workflow({ name: 'audit' }, "the uncommitted diff")`

## Authoring a Workflow inline

When neither saved workflow fits, author one with the `Workflow` tool. The canonical shape
is **pipeline by default** (no barrier between stages) so each item flows straight through:

```js
const results = await pipeline(
  items,
  (item) => agent(findPrompt(item), { agentType: 'claude-swarm:tracer', schema: FINDINGS }),
  (found) => parallel(found.findings.map((f) => () =>
    agent(refutePrompt(f), { agentType: 'claude-swarm:verifier', schema: VERDICT })))
)
```

Reach for a `parallel()` barrier only when a stage genuinely needs *all* prior results at
once (dedup across the full set, early-exit on zero findings). Reference agents by their
namespaced type: `agentType: 'claude-swarm:scout'`, etc.

## The rules that keep this cheap and honest

- **Cap at 6 concurrent** by default. Go wider only for genuinely per-item work (one agent
  per file in a migration).
- **No silent truncation.** If a cap or a sampling decision dropped coverage, say so.
  Partial coverage that reads as complete is worse than none.
- **Never downgrade** the model writing production code, or the main loop.
- **Verify before reporting done.** Run the build, run the tests, read the artifact on disk.
  A green summary is a claim, not evidence — that's what `claude-swarm:verifier` is for.
- **Fable is opt-in only.** It is 2x Opus's price ($10/$50 vs $5/$25 per 1M). Never
  route to it automatically; propose it only for a task Opus has actually failed at, and
  name the cost when proposing.

## Pricing note

Sonnet 5 is on introductory pricing until **2026-08-31** ($2/$10 vs $3/$15), making the
sonnet-tier agents ~2.5x cheaper than Opus rather than 1.67x. Lean on `tracer`, `mechanic`,
and `verifier` while that holds.
