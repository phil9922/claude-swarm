# Benchmark: does delegating actually cost less?

The README argues that routing work to cheaper tiers beats doing it solo on Opus, and
`/claude-swarm:savings` reports a dollar figure for it. That figure is an **upper bound**:
it prices the tokens the swarm actually spent at Opus rates, but a solo run would not have
spent those same tokens. The gap cannot be closed from transcripts — it needs the
counterfactual to actually be run.

This suite runs it. The same task, three ways, measured.

## The three arms

| Arm | Plugin | Subagents | What it answers |
|---|---|---|---|
| `with` | enabled | claude-swarm roster + built-ins | The status quo |
| `without` | disabled | Claude Code's built-ins only | What the plugin adds over stock Claude Code |
| `solo` | disabled | none (`Task` denied) | One Opus context doing everything — the assumption behind the savings figure |

`with` vs `solo` is the comparison the savings counter implicitly makes. `with` vs
`without` is the honest product question, since uninstalling the plugin does not take
Claude Code's own `Explore`/`general-purpose` agents away with it.

Arms differ **only** in the settings file and whether `Task` is denied. Same model, same
effort, same allowed tools, same prompt, same working directory.

## The two cases

- **`multi-file-audit`** — audit four real files (~1,500 lines) for correctness bugs.
  Fan-out shaped: independent files, parallelisable, more source than one context wants to
  hold. The swarm should win here.

- **`single-file-question`** — one question answerable from ~110 lines in a single read.
  **The swarm is expected to LOSE this one**, because spawning an agent to read one short
  file costs more than reading it. The README says as much: fan-out buys speed and
  coverage, not savings, and on small sequential work it is pure overhead.

That second case is not padding. A benchmark that can only produce a favourable result is
marketing. If the control ever starts favouring the swarm, distrust the harness before
believing the number — and do not "fix" the case to make it win.

## Running it

```bash
node evals/run.js                 # all cases, all arms, 3 runs each
node evals/run.js --case audit    # filter cases by substring
node evals/run.js --runs 1        # fewer repetitions
node evals/run.js --max-cost 5    # lower the ceiling (default 15)
node evals/run.js --grade         # add LLM grading of output quality
```

Runs spend real money. The runner enforces a hard ceiling: it checks cumulative cost after
every run and stops before starting one that could breach it. Results land in
`evals/results/<timestamp>/` (gitignored).

## Reading the output

Cost per run comes from Claude Code's own `total_cost_usd`, which includes subagent and
Task-tool spend. It is not our arithmetic — though it agrees with `lib/tally.js` to the
cent, which is how that pricing table was validated in the first place.

Two things the runner reports that you should look at before trusting any average:

- **Spawn count per run.** A `with` run that spawned zero subagents is not a swarm run.
  Enabling the plugin does not force fan-out, and averaging a solo-behaving run into the
  swarm arm silently understates the effect. Those runs are flagged.
- **Spread across runs.** These are stochastic. A mean of three runs with a wide range is
  a hint, not a measurement.

Runs execute in a temp working directory with `--add-dir` granting access to the repo, so
their subagent turns land under a throwaway project slug and **do not contaminate this
project's `/claude-swarm:savings` totals** — which would otherwise inflate the very number
the benchmark exists to check.
