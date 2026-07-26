---
name: claude-swarm
description: The orchestration playbook for the claude-swarm roster — the three delegation modes (Shield keeps high-volume output out of the main context, Route puts one agent on the cheapest tier a grader can check, Build is gated wide fan-out), which model tier each agent runs on and why, how to author a Workflow inline or call the saved workflows, and the rules that keep spending honest (Fable opt-in only). Load this whenever you are about to delegate work, plan a multi-agent task, run an audit/review/migration, map an unfamiliar subsystem, or otherwise decide how to spread work across agents.
---

# claude-swarm orchestration playbook

You are the **master**: the main loop, or a `Workflow()` script you author, running on
**Fable or Opus**. Delegation is three different moves with three different payoffs, and
they are decided in order:

1. **Shield** — does this work need to leave the main context at all?
2. **Route** — if it leaves, what is the cheapest tier that can do it?
3. **Build** — only then: is it wide enough to fan out?

Fan-out is the *last* question, not the first. It multiplies input tokens across N
uncached contexts, so it never saves money on work one context can do — it buys
wall-clock time and coverage, and only when the branches are genuinely independent.

## 1. Shield — keep volume out of the main context

The main-loop context is re-sent on every turn, so anything high-volume that lands in
it is a tax on every turn that follows. The question is about **volume of output, not
difficulty of work**:

- Bulk reading — more than ~3 files or ~500 lines — goes to `claude-swarm:scout` or
  `claude-swarm:tracer`, which return a summary that costs once.
- Output-heavy commands — test suites, builds, wide greps — go to an agent that
  returns the verdict and the relevant lines only.
- Anything whose intermediate product you will never reference again.

Shielding is roughly cost-neutral on the turn where it happens and compounds over a
long session: it is the difference between a session that hits auto-compaction and one
that doesn't.

If nothing needs to leave — the answer is in loaded context, the edit is one file,
it's conversation — stay solo. Delegation with nothing to shield is pure overhead.

### `tracer` or a fork?

Both keep bulk reading out of the main context, but they bill differently.

A **fork** inherits the parent conversation's system prompt and tool definitions
*unchanged*, so it reuses the parent's prompt cache instead of paying to build a new
one. It also receives the main conversation's exact tool pool — forks skip both of the
filters that narrow a normal subagent's tools.

- **Prefer a fork** when the task needs context this session has *already loaded* —
  continuing a line of reasoning, working against files already in the window,
  anything where starting clean would just repurchase what you have.
- **Prefer `claude-swarm:tracer`** when the work is bulk reading of files *not yet* in
  context. That is the entire point: the source never enters the main window, and
  tracer runs a tier cheaper than the main loop.

A fork is not free. It runs at the parent's model and counts against the session
subagent budget like any other spawn, so it is a cache-warm shortcut, not a cheaper
tier.

## 2. Route — the cheapest tier that can do it

This is the cost lever, and it has one gate:

> **A cheaper tier is safe when something other than a model grades the output** — a
> compiler, a type checker, a test suite, a linter. The agent must run that grader
> itself before returning, so a silent failure cannot escape to be diagnosed and
> rewritten at Opus rates.

No external grader — design decisions, judgment calls, production code without tests,
prose whose wrongness only a reader would notice — means the tier stays matched to the
cost of a mistake. That is what `implementer` on opus is for.

| Agent | Model · effort | Use for | Why this tier |
|---|---|---|---|
| `claude-swarm:scout` | haiku | WHERE is it — paths, line numbers, call sites | Locating is cheap; no reasoning needed |
| `claude-swarm:tracer` | sonnet · xhigh | HOW does it work — reads thousands of lines, returns a few hundred words | Deep reading needs reasoning, but the output is small |
| `claude-swarm:implementer` | opus · high | Production code where a mistake is expensive | Correctness is the constraint; don't downgrade |
| `claude-swarm:mechanic` | sonnet · low | A decided change applied across N sites | The compiler/tests grade it — cheap is fine |
| `claude-swarm:verifier` | sonnet · xhigh | Adversarial: refute a claim, run the thing | Skepticism needs reasoning; runs in parallel |
| `claude-swarm:scribe` | haiku | Docs, README, changelog, comments | Prose about code; cheapest in the roster |

Routing heuristic: **scout to find, tracer to understand, implementer to build what's
risky, mechanic to apply what's decided and graded, verifier to attack a claim, scribe
to write it up.**

## 3. Build — fan out behind a disjointness gate

Two identities govern this decision:

```
cost ≈ N × (cold start + work per branch)     — monotonic in branch count
wall ≈ dispatch + max(branch duration)        — roughly flat in branch count
```

Cost only rises with N, so **fan-out is never the cheaper option at equal tier** —
there is no width at which a cost overhead is outrun. Width buys wall time only; the
cost lever is tier (mode 2), and a fan-out breaks even on cost only when its branches
run a cheaper tier than the solo alternative would.

The gate, asked in order:

1. **Is the input disjoint across branches?** This is the variable that explains
   every number this repo has measured. If branches share their input, one context
   reads it once and a fan-out re-buys it per branch: the benchmarked three-stage
   survey's angles all read the same handful of files, and it cost **3.95x** solo
   ($2.1953 vs $0.5555) at **4.63x** the wall time (426s vs 92s). A *twenty*-angle
   survey over the same files would lose by more — which is why no width-based bar
   survives this case; width was a proxy. If instead each branch reads and writes
   its own material — one component per agent, one file per migration — the work is
   irreducibly per-item and fan-out duplicates nothing. Disjointness covers
   **writes as well as reads**: two branches with disjoint inputs can still collide
   on an output path, and a collision means the branches were never independent —
   the build manifest validator rejects exactly this.
2. **Only if disjoint: is it wide enough to win on wall time?** One wave pays when
   the serial time it removes (the sum of the branches minus the slowest) clearly
   exceeds the dispatch-and-collect round it adds. With branches of similar size
   that is satisfied at a handful of branches — *provided each branch's work is at
   least cold-start-sized* (measured at benchmark task size: ~$0.23 per agent, ~42%
   of the whole survey job's solo price). A branch smaller than its own cold start
   never pays, at any width.
3. **Depth: a linear penalty per added wave.** Each chained wave adds a constant —
   one more dispatch round, one more slowest-branch wait, and, when its input
   overlaps the previous wave's, one more full re-read of the same material. The
   measured mechanism is per-wave and linear, so the penalty is too. Extra waves
   worsen the wall-time case, and no width repays a wave whose input is shared.

Two consequences that fall out of rule 1, rather than standing beside it:

- **A trailing synthesizer is cheap because its input is small, not because it is
  single.** The duplication penalty scales with the volume of shared input re-read;
  a synthesizer re-reads the wave's summaries — new, small material — so it adds one
  small cold start, linearly.
- **A width-1 serial stage cannot duplicate input across branches — but it is not
  free.** Parent-to-child duplication remains: the stage reads into a fresh context
  material the caller may already hold — the measured ~$0.23 cold start. So a
  serial stage costs one cold start and has to earn it on Shield's own test: is the
  output volume it keeps out of the main window worth that? A stage that produces
  dense output from a compact input the caller already holds fails the test —
  which is why the build foundation is written by the master, not by a foundation
  agent.

### What the shipped workflows are, honestly

| Workflow | Branch input | Classification |
|---|---|---|
| `survey` (three-stage, historical) | shared, re-read across three chained waves | Measured loss on both axes: 3.95x cost, 4.63x wall. Collapsed to one wave in response. |
| `survey` (current, one wave) | still shared — the angles read the same files | **Latency-and-shield play, not a cost win.** Returns sooner than solo and keeps the sources out of the main window, at higher cost — the angles share their input however the waves are arranged, and the workflow's own `whenToUse` says so. |
| `audit` | shared — the lenses sweep the same code | **Quality play — currently unmeasured.** The mechanism is plausible (a context that produced a finding is biased toward confirming it; independent refutation is structurally unavailable to a solo pass) but it is asserted, not shown. Cost *and* quality predictions recorded in `evals/README.md` before the benchmark runs. |
| `build` | disjoint — each leaf owns its paths | **The fan-out case.** Per-item work; the wall-time win scales with width; cost neutrality comes from the Sonnet leaf tier, not from width. Runs the leaf and integration waves only — the master writes the foundation, signatures, and manifest itself (see below). |

A workflow that is faster-not-cheaper or better-not-cheaper is legitimate to ship as
long as it says so. The illegitimate move is selling either as cost control.

**User intent overrides the judgment, not the arithmetic.** An explicit invocation of
a saved workflow means the user has decided to spend — don't second-guess it. It does
not mean the workflow escapes the math: a saved workflow whose own numbers don't
support its shape is mis-designed, and the fix is to redesign the workflow, not to
exempt it.

### The saved workflows

The plugin serves these itself — Claude Code auto-discovers a plugin's `workflows/`
directory — so they resolve under the plugin's namespace:

- **`claude-swarm:survey`** — map an area in one wave: one locate-and-read agent per
  angle, one synthesis. Call it when "how does X work" would mean reading many files
  into the main context. If you already know the relevant files, pass them — readers
  skip discovery: `Workflow({ name: 'claude-swarm:survey', args: { question: 'how
  does auth work', files: ['src/auth/session.ts'] } })`. A bare string works too.
- **`claude-swarm:audit`** — find problems, then adversarially verify. One tracer per
  lens finds candidates → independent verifiers try to refute each → only survivors
  are reported. Call it for reviews, diff audits, bug hunts.
  `Workflow({ name: 'claude-swarm:audit', args: 'the uncommitted diff' })`
- **`claude-swarm:build`** — the leaf and integration waves of an app build from a
  finalized plan. The master writes the foundation, the signature stubs, and a work
  manifest first, then:
  `Workflow({ name: 'claude-swarm:build', args: { typecheck: 'npx tsc --noEmit', foundation: [...], units: [...] } })`

Pass the target through `args`, not as a second positional argument — `Workflow` takes
a single input object.

### The build workflow

The foundation stays with the master, deliberately. The main session is already Opus
and already holds the finalized plan; a serial foundation agent would re-pay the plan
into a fresh context (one cold start) to produce dense output from compact input —
which fails Shield's test — with no tier win either, since foundation work is Opus
regardless. So the master writes the schema, tokens, routing skeleton, shared utils,
data layer, **signature files** (real files, exact names and types, and *compiling*
placeholder bodies — `throw new Error('not implemented')`, never an empty body: a
stub that doesn't type-check starts its leaf from red, and leaves fill blanks
instead of interpreting prose), and the manifest. The manifest is the public
interface between master and workflow:

```js
Workflow({ name: 'claude-swarm:build', args: {
  typecheck: 'npx tsc --noEmit',   // the grader; leaves and integration both run it
  root: '.',                       // optional
  foundation: ['src/types.ts'],    // shared read-only files the master wrote, on disk
  units: [{
    id: 'header',
    owns: ['src/components/Header.tsx'], // exclusive write scope; stubs already on disk
    reads: ['src/tokens.css'],           // foundation or other units' paths — drives ordering
    builds: 'site header with nav',
  }],
  concurrency: 8,                  // max leaf agents in flight
  batch: 1,                        // units per agent when one read-set contains another's
}})
```

**Precondition — the validator structurally cannot check this.** Every `foundation`
path, and every owned signature stub, must exist on disk *before* invoking: workflow
scripts have no filesystem access, so a file the master forgot to write passes
validation and the failure surfaces only after N leaves have spawned to read a
nonexistent stub. The master has filesystem access — verify each `foundation` path
and each unit's `owns` stub exists (one `ls`/`test -f` sweep) as the last step
before calling `Workflow`.

`concurrency` and `batch` are one tradeoff seen from two sides: raise `batch` /
lower `concurrency` to trade wall time for cost. Batching merges units whose
read-sets nest (one contains the other — cache benefit comes from a shared prefix,
not set equality), and each batch reads the shared portion first, owners before the
units that read them. The workflow validates the manifest
with plain code before anything spawns — no duplicate ownership, no unit owning
foundation or shared files (barrels, package manifests, lockfiles, tsconfig:
integration writes those), acyclic read/own graph, every path inside the project,
every read resolving to foundation or an owned path — and a bad manifest fails
loudly with the specific violations, spending nothing.

Mechanics worth knowing:

- Leaves run as `claude-swarm:leaf` (sonnet·low — measured against medium across
  four typed units: identical first-attempt type-check rate, equal turns, cheaper
  and faster — with `maxTurns: 25`, because a wave's clock is its slowest branch).
  Measured: a turn-capped subagent returns
  *silently* — "(Subagent completed but returned no output.)", no cap marker — so a
  leaf without a structured return is recorded `unknown`, never `failed`, and
  integration re-derives every unit's truth from the tree: files present, filled,
  type-checked. Leaf gating uses the partial-order promise wiring above, on each
  unit's own `reads` set. Each leaf's type check is **sibling-filtered** — the
  project command runs unfiltered, then its captured output is filtered to the
  leaf's own files, with a broken tool reported as `TYPECHECK-BROKEN` rather than
  read as clean — so concurrent stubs' errors can't burn a leaf's turns, and a
  grader that failed to run can't book a unit as done.
- Integration is split by grader: `mechanic` (sonnet·low) does everything the
  compiler grades — barrels, imports, seams — and only surfaced judgment calls
  escalate to `implementer` on opus. Shrinking that Opus tail is what raises the
  ceiling on the whole run.
- The SubagentStop hook appends one line per completed agent to
  `.claude-swarm-feed.log` in the project directory — `tail -f` it during a wave.
  Zero token cost, no polling agent.

### Authoring a Workflow inline

When no saved workflow fits, author one with the `Workflow` tool. The canonical shape
is **pipeline by default** (no barrier between stages) so each item flows straight
through:

```js
const results = await pipeline(
  items,
  (item) => agent(findPrompt(item), { agentType: 'claude-swarm:tracer', schema: FINDINGS }),
  (found) => parallel(found.findings.map((f) => () =>
    agent(refutePrompt(f), { agentType: 'claude-swarm:verifier', schema: VERDICT })))
)
```

Reach for a `parallel()` barrier only when a stage genuinely needs *all* prior results
at once (dedup across the full set, early-exit on zero findings).

`pipeline()` cannot express **cross-item dependencies** — item B waiting on some but
not all of the agents item A's stage started. For that, hold `agent()` promises and
gate each item on exactly what it needs; every call still queues through the run's
concurrency cap, so firing many at once is safe:

```js
const done = {}
done.tokens = agent('build the design tokens…', OPTS)
done.schema = done.tokens.then(() => agent('build the schema…', OPTS)) // serial chain
const leaves = units.map((u) =>
  Promise.all(u.reads.map((r) => done[r]))      // gate on this unit's actual deps
    .then(() => agent(leafPrompt(u), OPTS))
    .catch(() => null)                          // pipeline/parallel null-out failures; raw wiring must too
)
const results = await Promise.all(leaves)
```

Reference agents by their namespaced type: `agentType: 'claude-swarm:scout'`, etc.

## The rules that keep this cheap and honest

- **Know how the ceilings behave, not what they equal.** Ad-hoc `Agent` dispatch is
  bounded two ways — how many subagents may run at once, and how many a session may
  spawn in total. Both are tunable (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`,
  `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`), and past either the tool *fails*
  (`Concurrent subagent limit reached` / `Subagent spawn limit reached`) rather than
  queueing — so a wide hand-dispatched fan-out can hit a wall mid-task with agents
  already spent and no results.
  Agents a **workflow** spawns with `agent()` are exempt from both: the sub-agents
  documentation states that agents a workflow script spawns with `agent()` don't
  count toward the session limit, and that workflow agents follow their own per-run
  limits instead — a machine-derived concurrency cap plus a large per-run total,
  under which spawns **queue** where ad-hoc dispatch fails. That is the concrete
  argument for routing wide fan-outs through a workflow rather than dispatching
  dozens of agents by hand.
  Do not quote a specific ceiling from memory or from this file. They are env-tunable
  and machine-dependent, and the live values are stated in the `Agent` and `Workflow`
  tool descriptions in context. A number written down here is a claim that goes stale
  in silence — which is exactly how this plugin came to advertise an invented "cap
  at 6".
- **Agents can't delegate downward.** Nesting is off by default, so the `Agent` tool
  is withheld from every subagent except a fork. Dispatch each agent from the main
  loop; an agent asked to sub-delegate will just do the work itself and return one
  summary.
- **No silent truncation.** If a cap or a sampling decision dropped coverage, say so.
  Partial coverage that reads as complete is worse than none.
- **Never downgrade the main loop, or work no grader will catch.** The Route gate in
  reverse: cheap tiers go only where a compiler, test suite, or adversarial verifier
  checks the result.
- **Verify before reporting done.** Run the build, run the tests, read the artifact
  on disk. A green summary is a claim, not evidence — that's what
  `claude-swarm:verifier` is for.
- **Fable is opt-in only.** It sits at the top of the price ladder, above Opus. Never
  route to it automatically; propose it only for a task Opus has actually failed at,
  and say plainly that it is the most expensive tier when proposing.

## What the tiers actually cost

The routing above depends on one fact only: **haiku < sonnet < opus < fable**. That
ordering is what makes `scout` cheap and `implementer` expensive, and it holds on
every plan and every provider. Route on the ordering, not on a number.

Absolute prices are deliberately not quoted here. On a subscription plan there is no
per-token figure to reason about at all; on API billing the published rates move, so a
number baked into this file would be wrong for some readers and stale for the rest. If
you need current rates, read Anthropic's pricing page.

One consumption note that *is* worth knowing: since Claude Code v2.1.198 subagents
**inherit the main conversation's extended thinking configuration** — there is no
per-subagent thinking setting, so the only toggle is the session-level one. The same
roster on the same task consumes more than older intuitions suggest when thinking is
on in your session. Per-agent `effort` pins (tracer and verifier run `xhigh`,
mechanic and leaf run `low`) still apply; turning thinking down in the main session
turns it down for every agent below it.

Effort pins also degrade silently: if a pinned level isn't supported by the model an
agent resolves to, Claude Code falls back to the highest supported level at or below
the pin — so a pin invalidated by a future model change will never announce itself.
Re-check the pins against the model-config effort table when a model alias moves.
