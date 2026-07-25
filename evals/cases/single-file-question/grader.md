You are grading a short factual answer about a specific file. Score 0.0–1.0.

The question was: what is the `LEGACY_COPIES` constant in `hooks/session-start.js` for, and
why must a newly added workflow not be added to it?

A fully correct answer (1.0) contains **both** halves:

1. **What it is** — a fixed historical record of the workflow files that claude-swarm
   v0.1.1 and earlier copied into the user's `~/.claude/workflows/`. The hook now only
   *reports* those leftovers so the user can delete them; it does not copy, overwrite, or
   remove anything.

2. **Why new workflows must not be added** — because it is not a registry. Claude Code
   auto-discovers a plugin's `workflows/` directory, so a new workflow resolves as
   `claude-swarm:<name>` with no wiring at all. Adding a name to `LEGACY_COPIES` would
   falsely mark it as a stale leftover and tell users to delete a live file.

Scoring:

- **1.0** — both halves, correct and specific.
- **0.6–0.8** — one half fully right, the other vague or partial.
- **0.3–0.5** — identifies it as legacy/historical but misses why adding to it is wrong,
  or vice versa.
- **0.0–0.2** — describes it as a registry or list of active workflows, claims the hook
  deletes or copies files, or is otherwise wrong.

Judge only correctness and completeness. Do **not** reward length — this question deserves
a short paragraph, and a long answer padded with unrelated detail about the plugin is not
better than a tight correct one. Do not reward the answer for describing its own process.

Reply with ONLY a JSON object, no prose around it:

{"score": 0.0, "has_what_it_is": false, "has_why_not_add": false, "reasoning": "one sentence"}
