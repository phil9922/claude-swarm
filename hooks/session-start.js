#!/usr/bin/env node
/**
 * claude-swarm SessionStart hook.
 *
 * Two jobs, both best-effort — this must never break a session:
 *   1. Install the swarm workflows (survey, audit) into the user's
 *      ~/.claude/workflows/ directory, since plugins cannot serve
 *      Workflow scripts natively. Copies only when the file is absent,
 *      so it never clobbers a user's own edits.
 *   2. Inject a compact delegation policy as additionalContext, giving
 *      the main loop always-on routing rules without a user-level
 *      CLAUDE.md. The verbose playbook lives in the claude-swarm skill;
 *      this is deliberately small to keep the per-session token cost low.
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const WORKFLOWS = ['survey.js', 'audit.js']

const installed = []
try {
  // Resolve inside the try so a throw here (e.g. os.homedir() failing) is caught
  // and the policy below still ships — the whole point of "never break a session".
  // Plugin root: env var is set by Claude Code; fall back to __dirname.
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..')
  // User's Claude config dir (honor an override if the user set one).
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const workflowsDir = path.join(configDir, 'workflows')

  fs.mkdirSync(workflowsDir, { recursive: true })
  for (const name of WORKFLOWS) {
    const dest = path.join(workflowsDir, name)
    if (fs.existsSync(dest)) continue // never overwrite a user's copy
    const src = path.join(pluginRoot, 'workflows', name)
    if (!fs.existsSync(src)) continue
    fs.copyFileSync(src, dest)
    installed.push(name)
  }
} catch (_) {
  // Swallow: a failed install must not abort the session. The policy still ships below.
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
Saved workflows: \`survey\` (map an area), \`audit\` (find, then adversarially verify).

## Rules
- Cap at 6 concurrent by default; go wider only for genuinely per-item work.
- No silent truncation — if a cap or sampling dropped coverage, say so.
- Never downgrade the model writing production code, or the main loop.
- Verify before reporting done: run the build/tests, read the artifact on disk.
- **Fable is opt-in only** (2x Opus's price, $10/$50 vs $5/$25 per 1M). Never route
  to it automatically; propose it only for a task Opus has actually failed, and name
  the cost.

Load the \`claude-swarm\` skill for the full orchestration playbook (how to author a
Workflow inline, when to call \`survey\`/\`audit\`, model-routing rationale).`

const context =
  installed.length > 0
    ? `${POLICY}\n\n_(claude-swarm installed workflows: ${installed.join(', ')})_`
    : POLICY

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }),
)
