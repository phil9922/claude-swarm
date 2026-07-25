#!/usr/bin/env node
/**
 * claude-swarm SessionStart hook.
 *
 * Two jobs, both best-effort — this must never break a session:
 *   1. Flag stale copies of the swarm workflows left in the user's
 *      ~/.claude/workflows/ by v0.1.1 and earlier. Those versions copied
 *      survey.js/audit.js there on the belief that plugins could not serve
 *      Workflow scripts natively; Claude Code in fact auto-discovers a
 *      plugin's workflows/ directory, so the plugin serves them itself as
 *      claude-swarm:survey / claude-swarm:audit. The copies are now pure
 *      duplicates — and because the old code never overwrote an existing
 *      file, they are frozen at whatever version first installed them.
 *      We only report them: silently deleting from a user's config dir is
 *      not a SessionStart hook's call to make.
 *   2. Inject a compact delegation policy as additionalContext, giving
 *      the main loop always-on routing rules without a user-level
 *      CLAUDE.md. The verbose playbook lives in the claude-swarm skill;
 *      this is deliberately small to keep the per-session token cost low.
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// Closed list: the workflow files v0.1.1 and earlier copied into the user's config
// dir. It is a historical record, not a registry — a new workflow goes in workflows/
// and is discovered from there, so it must NOT be added here.
const LEGACY_COPIES = ['survey.js', 'audit.js']

const stale = []
try {
  // Resolve inside the try so a throw here (e.g. os.homedir() failing) is caught
  // and the policy below still ships — the whole point of "never break a session".
  // User's Claude config dir (honor an override if the user set one).
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const workflowsDir = path.join(configDir, 'workflows')

  // Read-only: no mkdir, no copy. If the directory does not exist there is
  // nothing left over to report.
  for (const name of LEGACY_COPIES) {
    if (fs.existsSync(path.join(workflowsDir, name))) stale.push(name)
  }
} catch (_) {
  // Swallow: a failed check must not abort the session. The policy still ships below.
}

const POLICY = `# claude-swarm delegation policy

Master = the main loop / a Workflow script on **Fable or Opus**. It orchestrates; a swarm
of cheaper, specialized agents does the work below it. The goal is spending *less*,
not spawning more.

## Fan out only when it pays
Fan-out costs more total tokens than one agent doing the same work — it buys speed and
coverage, not savings.
- **Swarm:** audits/reviews, multi-file features, "find every X", migrations, mapping an
  unfamiliar subsystem, anything touching 4+ files.
- **Stay solo:** single-file edits, questions answerable from loaded context, <~3 files,
  conversation. This is the actual cost control.

## Always delegate bulk reading
If answering needs >~3 files or >~500 lines, send \`claude-swarm:scout\` or
\`claude-swarm:tracer\` rather than reading it into the main context — a summary that
costs once beats source re-sent every turn. Applies even when working solo.

## The roster
| Agent | Tier | For |
|---|---|---|
| claude-swarm:scout | haiku | Where is it — paths and line numbers |
| claude-swarm:tracer | sonnet·xhigh | How does it work — reads a lot, returns a little |
| claude-swarm:implementer | opus·high | Production code where a mistake is expensive |
| claude-swarm:mechanic | sonnet·low | A decided change applied across N sites |
| claude-swarm:verifier | sonnet·xhigh | Adversarial: refute the claim, run the thing |
| claude-swarm:scribe | haiku | Docs, README, changelog, comments |
Saved workflows: \`claude-swarm:survey\` (map an area), \`claude-swarm:audit\` (find,
then adversarially verify).

## Rules
- Cap at 6 concurrent by default; go wider only for genuinely per-item work.
- No silent truncation — if a cap or sampling dropped coverage, say so.
- Never downgrade the model writing production code, or the main loop.
- Verify before reporting done: run the build/tests, read the artifact on disk.
- **Fable is opt-in only** (2x Opus's price, $10/$50 vs $5/$25 per 1M). Never route
  to it automatically; propose it only for a task Opus has actually failed, and name
  the cost.

Load the \`claude-swarm\` skill for the full orchestration playbook (how to author a
Workflow inline, when to call \`claude-swarm:survey\`/\`claude-swarm:audit\`,
model-routing rationale).`

const context =
  stale.length > 0
    ? `${POLICY}\n\n_(claude-swarm: \`${stale.join('`, `')}\` in your ~/.claude/workflows/ are` +
      ' leftovers from v0.1.1 and earlier. The plugin now serves these itself as' +
      ' `claude-swarm:survey` / `claude-swarm:audit`, so the copies are duplicates that no' +
      ' longer receive updates — safe to delete unless you edited them yourself.)_'
    : POLICY

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }),
)
