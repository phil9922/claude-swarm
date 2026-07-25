---
name: savings
description: Report what delegating to the cheaper swarm agents actually cost, against what the same tokens would have cost on Opus. Defaults to the current project; pass --all for a lifetime breakdown across every project.
argument-hint: "[--all]"
allowed-tools: Bash(node:*)
---

Run the claude-swarm savings tally and show the user its output.

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/tally.js" $ARGUMENTS
```

Print the result verbatim in a code block. It is already formatted as a report —
do not reformat it into a table, re-derive the arithmetic, or restate the figures
in prose above or below it.

Two things to preserve if the user asks follow-up questions:

- The savings figure is an **upper bound**. It prices the tokens the swarm
  actually spent at Opus rates, and a solo Opus run would have spent fewer
  tokens overall. The footer says so; don't drop that caveat when summarizing.
- `implementer` is excluded on purpose — it runs on Opus, so there is no tier
  delta to count.

The command refreshes the cached totals as a side effect, which is also what the
SessionStart hook reads for its one-line summary. If the user says that line looks
stale, running this is the fix.
