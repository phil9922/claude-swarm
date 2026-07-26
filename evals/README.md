# Benchmark: does delegating actually cost less?

The README argues that routing work to cheaper tiers beats doing it solo on Opus. This
suite measures whether that holds, by running the same task with the plugin, without it,
and with delegation denied outright.

## The three arms

| arm | claude-swarm | Subagents | Answers |
|---|---|---|---|
| `with` | enabled, **from this working tree** | roster + built-ins | The status quo |
| `without` | disabled | Claude Code's built-ins only | What the plugin adds over stock Claude Code |
| `solo` | disabled | none (`Task` denied) | One Opus context doing everything |

`with` vs `without` is the honest product question, since uninstalling the plugin does not
take Claude Code's own `Explore`/`general-purpose` agents away with it. `with` vs `solo`
isolates delegation itself.

Arms differ **only** in `--plugin-dir` and whether `Task` is denied. Same settings file,
same model, same effort, same allowed tools, same working directory — and, except where
noted below, the same prompt.

## Which copy of the plugin is under test

**The working tree, not the version installed on your machine.** Every arm starts from a
settings file that disables all installed plugins; the `with` arm then loads this
repository for that session only, via `--plugin-dir`. Edit `workflows/`, `agents/` or the
`SessionStart` hook and the next run measures the edit — no reinstall, and never two copies
of the plugin loaded at once.

This was not true at first, and the mistake was expensive. The runner enabled the installed
marketplace plugin through settings, so a batch of numbers described the released `0.1.2`
while the changes they were meant to evaluate sat unmeasured in the working tree.
`preflight` now asserts the loaded plugin's **path**, because "a plugin named claude-swarm
is loaded" says nothing about which claude-swarm.

`--plugin-dir PATH` overrides the source, but preflight still demands the working tree, so
pointing it anywhere else **fails the run** rather than quietly measuring something else. A
deliberate off-tree run needs `--skip-preflight`.

## The cases

- **`multi-file-audit`** — audit the repository's JavaScript for correctness bugs, with the
  file set left for the agent to discover. Open-scope and parallelisable.

- **`single-file-question`** — one question answerable from ~110 lines in a single read.
  **The swarm is expected to LOSE this one**, because spawning an agent to read one short
  file costs more than reading it. A benchmark that can only produce a favourable result is
  marketing. If the control ever starts favouring the swarm, distrust the harness before
  believing the number — and do not "fix" the case to make it win.

- **`survey-subsystem`** — map the `audit` workflow end to end. The `with` arm is told to
  invoke `claude-swarm:survey`; the other arms do the same job by hand.

### Why the third case exists, and why it breaks a rule

The first two cases produced an unexpected result: **the swarm never delegated.** Across
19 of 20 runs — with the plugin loaded, the roster offered and the `Task` tool available —
Opus read the files itself. So those cases measure the cost of *carrying* the plugin
(~1,600 tokens of policy and roster per session), not the benefit of using it.

`survey-subsystem` tests the roster by invoking it explicitly. It is the only case where
the prompts **differ by arm**: `without` and `solo` cannot be asked to run a workflow they
do not have, so the `with` arm carries one extra instruction. The graded deliverable is
identical; only the route to it differs, and that route is the intervention.

This is a deliberate, documented exception. The runner prints a warning for any case that
uses it, so the result cannot be quietly read as like-for-like.

## Recorded prediction: audit loses to solo on cost

*Written 2026-07-25, before any benchmark of the audit workflow has run. Do not edit this
section after one has; score it.*

The shared-input rule (SKILL.md, the Build gate) predicts `claude-swarm:audit` costs
**more** than the same audit done solo at equal tier. Reasoning: audit's lenses sweep the
same codebase, so each finder re-buys the read a solo pass pays once — the exact mechanism
measured on `survey-subsystem`, where angles reading the same files produced a 3.95x cost
loss. Batched verification cuts the verifier count but not the sign: verifiers re-read the
same code the finders read.

What audit buys instead is quality — independent adversarial verification a solo pass
doesn't perform. The honest claim is *better, not cheaper*, possibly also *faster*.

If a benchmark comes back with audit **cheaper** than solo at equal tier and comparable
quality, the shared-input rule is wrong. Treat that as a finding about the rule and revisit
the gate; do not bank it as a win and move on.

### The quality arm of the same prediction

"Audit is a quality play" is itself unmeasured — the same species of claim as the "cheaper"
claims that were removed, and it gets the same treatment. Prediction: on the existing
graders, audited output scores **at least as high as solo, with fewer false or unverifiable
findings**, because independent refutation is something a solo pass structurally lacks — a
context that produced a finding is biased toward confirming it. If graded quality comes
back no better than solo, audit has no measured claim left, neither cheaper nor better, and
the workflow-labels table in `SKILL.md` must say so.

## Running it

```bash
node evals/run.js                 # all cases, all arms, 3 runs each
node evals/run.js --case audit    # filter cases by substring
node evals/run.js --runs 1        # fewer repetitions
node evals/run.js --max-cost 5    # lower the ceiling (default 15)
node evals/run.js --grade         # add LLM grading of output quality
node evals/run.js --arms with     # one arm only — iterating on the plugin
node evals/run.js --runs 0        # preflight only, spends nothing
```

Runs spend real money. The runner checks cumulative cost after every run and stops before
starting one that could breach the ceiling. Results land in `evals/results/<timestamp>/`
(gitignored).

## Reading the output

Cost per run comes from Claude Code's own `total_cost_usd`, which includes subagent and
Task-tool spend — not our arithmetic.

Three things to look at before trusting any average:

- **Spawn count per run.** A `with` run that spawned zero subagents is not a swarm run.
  Enabling the plugin does not force fan-out, and averaging a solo-behaving run into the
  swarm arm silently understates the effect. Those runs are flagged.
- **Time per arm**, mean and total. The README claims the swarm is *faster*, not only
  cheaper, so a cost-only reading cannot confirm or refute half the argument.
- **Spread across runs.** These are stochastic. A mean of three runs with a wide range is a
  hint, not a measurement — and one run is an anecdote.

`preflight` runs before any budget is spent and asserts that the arms differ the way they
claim to: the plugin loaded in `with` and absent elsewhere, the loaded plugin's path being
this repository, and the delegation tool present under the name being passed. All three
have failed silently before; a run that produces plausible numbers from a broken
configuration is worse than one that refuses to start. It prints the loaded plugin's path,
version and source on every run, so the copy under test is never something you have to
infer.

Runs execute in a temp working directory with `--add-dir` granting access to the repo, so
their transcripts stay out of this project's own history.
