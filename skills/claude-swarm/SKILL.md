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

### `tracer` or a fork?

Both keep bulk reading out of the main context, but they bill differently.

A **fork** inherits the parent conversation's system prompt and tool definitions
*unchanged*, so it reuses the parent's prompt cache instead of paying to build a new one.
It also receives the main conversation's exact tool pool — forks skip both of the filters
that narrow a normal subagent's tools.

- **Prefer a fork** when the task needs context this session has *already loaded* —
  continuing a line of reasoning, working against files already in the window, anything
  where starting clean would just repurchase what you have.
- **Prefer `claude-swarm:tracer`** when the work is bulk reading of files *not yet* in
  context. That is the entire point: the source never enters the main window, and tracer
  runs a tier cheaper than the main loop.

A fork is not free. It runs at the parent's model and counts against the session subagent
budget like any other spawn, so it is a cache-warm shortcut, not a cheaper tier.

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

The plugin serves these itself — Claude Code auto-discovers a plugin's `workflows/`
directory — so they resolve under the plugin's namespace:

- **`claude-swarm:survey`** — map an unfamiliar area. Fans scouts across angles → a tracer
  follows each → synthesizes one map. Call it when "how does X work" would mean reading many
  files into the main context.
  `Workflow({ name: 'claude-swarm:survey', args: 'how does auth work' })`
- **`claude-swarm:audit`** — find problems, then adversarially verify. One tracer per lens
  finds candidates → independent verifiers try to refute each → only survivors are reported.
  Call it for reviews, diff audits, bug hunts.
  `Workflow({ name: 'claude-swarm:audit', args: 'the uncommitted diff' })`

Pass the target through `args`, not as a second positional argument — `Workflow` takes a
single input object.

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

- **Know how the ceilings behave, not what they equal.** Ad-hoc `Agent` dispatch is bounded
  two ways — how many subagents may run at once, and how many a session may spawn in total.
  Both are tunable (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`,
  `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`), and past either the tool *fails*
  (`Concurrent subagent limit reached` / `Subagent spawn limit reached`) rather than
  queueing — so a wide hand-dispatched fan-out can hit a wall mid-task with agents already
  spent and no results.
  Agents a **workflow** spawns with `agent()` are counted separately, against a semaphore
  sized to the machine's CPU count plus a large per-run total. The load-bearing difference
  is not the numbers: it is that workflow spawns **queue** where ad-hoc dispatch fails.
  That is the concrete argument for routing big fan-outs through `claude-swarm:survey` /
  `claude-swarm:audit`, or an inline `Workflow`, rather than dispatching dozens of agents
  by hand.
  Do not quote a specific ceiling from memory or from this file. They are env-tunable and
  machine-dependent, and the live values are stated in the `Agent` and `Workflow` tool
  descriptions in context. A number written down here is a claim that goes stale in
  silence — which is exactly how this plugin came to advertise an invented "cap at 6".
- **Agents can't delegate downward.** Nesting is off by default, so the `Agent` tool is
  withheld from every subagent except a fork. Dispatch each agent from the main loop; an
  agent asked to sub-delegate will just do the work itself and return one summary.
- **No silent truncation.** If a cap or a sampling decision dropped coverage, say so.
  Partial coverage that reads as complete is worse than none.
- **Never downgrade** the model writing production code, or the main loop.
- **Verify before reporting done.** Run the build, run the tests, read the artifact on disk.
  A green summary is a claim, not evidence — that's what `claude-swarm:verifier` is for.
- **Fable is opt-in only.** It sits at the top of the price ladder, above Opus. Never
  route to it automatically; propose it only for a task Opus has actually failed at, and
  say plainly that it is the most expensive tier when proposing.

## What the tiers actually cost

The routing above depends on one fact only: **haiku < sonnet < opus < fable**. That
ordering is what makes `scout` cheap and `implementer` expensive, and it holds on every
plan and every provider. Route on the ordering, not on a number.

Absolute prices are deliberately not quoted here. On a subscription plan there is no
per-token figure to reason about at all; on API billing the published rates move, so a
number baked into this file would be wrong for some readers and stale for the rest. If you
need current rates, read Anthropic's pricing page.

One consumption note that *is* worth knowing: since Claude Code v2.1.198 subagents
**inherit the main conversation's extended thinking configuration**. Before that they ran
with extended thinking off unconditionally. So the same roster on the same task consumes
more than older intuitions suggest when thinking is on in your session. The tier ordering
is unchanged; the per-agent bill is higher. Turning thinking down in the main session turns
it down for every agent below it.
