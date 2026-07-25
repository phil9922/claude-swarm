#!/usr/bin/env node
/**
 * claude-swarm SessionStart hook.
 *
 * Two jobs, both best-effort — this must never break a session:
 *
 *   1. Inject a compact delegation policy as additionalContext, giving the main
 *      loop always-on routing rules without a user-level CLAUDE.md. The verbose
 *      playbook lives in the claude-swarm skill; this is deliberately small to
 *      keep the per-session token cost low.
 *
 *   2. Warn when the plugin's own premises don't hold — a duplicate roster, an
 *      env var that voids tier pinning, ambient exploration running at top tier,
 *      stale workflow copies from an old version.
 *
 * The bar for (2) is deliberately high:
 *
 *      Warn only about a MISCONFIGURATION or an ACTIONABLE COST.
 *      Never about correct default state.
 *
 * Everything here is injected into every session, forever. A notice describing a
 * condition the user did not cause and does not need to change is a permanent
 * tax for no benefit, so every check below is false on a correctly configured
 * machine and the common case adds nothing at all.
 *
 * Worked example, because this was a real mistake: an earlier cut warned that
 * CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH was unset. That is stock Claude Code
 * default *and* correct for this plugin, which dispatches every agent from the
 * main loop — so it fired for every user on every session to report a non-issue,
 * costing ~190 tokens a session between it and one other. The fact itself is
 * worth knowing, so it moved into POLICY as a one-clause routing rule: stated
 * once as a rule, not repeated forever as a fault. Apply that same test before
 * adding a notice here. test/smoke.js pins the injected byte budget so this
 * cannot regress silently.
 *
 * Nothing in this file writes, creates, or deletes anything. Every probe is
 * read-only and reporting is the whole contract: silently changing a user's
 * config dir is not a SessionStart hook's call to make.
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// Closed list: the workflow files v0.1.1 and earlier copied into the user's config
// dir. It is a historical record, not a registry — a new workflow goes in workflows/
// and is discovered from there, so it must NOT be added here.
const LEGACY_COPIES = ['survey.js', 'audit.js']

// Closed list: this plugin's roster names. Unlike LEGACY_COPIES this one DOES track
// agents/ — a same-named file in the user's agents/ dir is the conflict we detect,
// so the two must stay in sync.
//
// Why it is a conflict rather than a harmless duplicate: a plugin agent resolves
// under a scoped identifier (`claude-swarm:scout`), a user agent under its bare
// `name` (`scout`). They are therefore two *different* agents, not a shadowed pair,
// so a delegation policy naming one is invalid against the other and the Agent tool
// answers `Agent type '<name>' not found`. The main loop absorbs that error and does
// the work itself — which looks, from outside, like the swarm silently refusing to
// spawn.
const ROSTER = ['scout', 'tracer', 'implementer', 'mechanic', 'verifier', 'scribe']

const notices = []

// Each probe runs inside this: one failing check must never cost the user the
// policy, which is the hook's actual job.
const probe = (fn) => {
  try {
    fn()
  } catch (_) {
    /* swallow — a failed check must not abort the session */
  }
}

// Resolved in a probe so a throw here (e.g. os.homedir() failing) still leaves the
// policy shipping below. Honors an override if the user set one.
let configDir = null
probe(() => {
  configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
})

const list = (names) => '`' + names.join('`, `') + '`'

// Stale workflow copies from v0.1.1 and earlier, which wrote survey.js/audit.js into
// ~/.claude/workflows/ believing plugins could not serve Workflow scripts natively.
// Claude Code auto-discovers a plugin's workflows/ dir, so the copies are inert — and
// because the old code never overwrote an existing file, frozen at first install.
probe(() => {
  if (!configDir) return
  const stale = LEGACY_COPIES.filter((n) => fs.existsSync(path.join(configDir, 'workflows', n)))
  if (stale.length === 0) return
  notices.push(
    `${list(stale)} in \`~/.claude/workflows/\` ${stale.length > 1 ? 'are leftovers' : 'is a leftover'}` +
      ' from v0.1.1 and earlier. The plugin serves these itself as `claude-swarm:survey` /' +
      ' `claude-swarm:audit`, so the copies are inert and no longer updated — safe to delete' +
      ' unless you edited them.',
  )
})

// Duplicate roster. Deliberately describes the conflict rather than prescribing a
// cure: the two-roster collision is documented and reproducible, but *why* the
// registered set differs between sessions is not yet understood, so promising that
// deleting the copies restores delegation would be overclaiming.
probe(() => {
  if (!configDir) return
  const dupes = ROSTER.filter((n) => fs.existsSync(path.join(configDir, 'agents', `${n}.md`)))
  if (dupes.length === 0) return
  notices.push(
    `${list(dupes)} in \`~/.claude/agents/\` share this plugin's roster names. Those register` +
      " under bare names, the plugin's under `claude-swarm:*` — two rosters, two sets of names," +
      ' so a policy naming one fails against the other with `Agent type not found`. Prefer the' +
      ' namespaced names, and remove the copies if you did not write them yourself.',
  )
})

// CLAUDE_CODE_SUBAGENT_MODEL sits ABOVE frontmatter in the model resolution order, so
// any value other than `inherit` silently overrides every tier pin in agents/. As of
// Claude Code v2.1.196, `inherit` is equivalent to leaving it unset.
probe(() => {
  const m = (process.env.CLAUDE_CODE_SUBAGENT_MODEL || '').trim()
  if (!m || m === 'inherit') return
  notices.push(
    `\`CLAUDE_CODE_SUBAGENT_MODEL=${m}\` overrides the \`model:\` pin on every agent, so the` +
      ' whole roster runs on that one model and cost tiering is inactive. Unset it, or set' +
      ' `inherit`, to restore per-agent tiers.',
  )
})

// Since Claude Code v2.1.198 the built-in Explore inherits the main conversation's
// model instead of always running Haiku, so ambient exploration bills at the session
// tier — and Explore is typically the most-spawned agent in a session. Only a *user or
// project* agent named Explore overrides the built-in; a plugin agent cannot, because
// plugin agents register under a scoped name and rank lowest in scope precedence.
// Hence a documented post-install step, and this one-line reminder while it is absent.
probe(() => {
  if (!configDir) return
  if (fs.existsSync(path.join(configDir, 'agents', 'Explore.md'))) return
  notices.push(
    'No `~/.claude/agents/Explore.md`: the built-in `Explore` inherits your session model, so' +
      ' exploration bills at top tier. A one-file `model: haiku` override fixes it — see the' +
      ' claude-swarm README.',
  )
})

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
costs once beats source re-sent every turn. If the task instead needs context already
loaded here, prefer a fork: it reuses the parent's prompt cache.

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
- Ceilings: 20 concurrent, 200/session. Workflow \`agent()\` spawns are exempt — route
  big fan-outs through \`claude-swarm:survey\`/\`audit\`, not ad-hoc dispatch.
- Agents can't delegate downward (nesting is off by default) — dispatch each from here.
- No silent truncation — if a cap or sampling dropped coverage, say so.
- Never downgrade the model writing production code, or the main loop.
- Verify before reporting done: run the build/tests, read the artifact on disk.
- **Fable is opt-in only** — top of the ladder (haiku < sonnet < opus < fable). Never
  route to it automatically; propose it only for a task Opus has actually failed.

Load the \`claude-swarm\` skill for the full orchestration playbook (how to author a
Workflow inline, when to call \`claude-swarm:survey\`/\`claude-swarm:audit\`,
model-routing rationale).`

const context =
  notices.length > 0
    ? `${POLICY}\n\n## claude-swarm setup notices\n${notices.map((n) => `- ${n}`).join('\n')}`
    : POLICY

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }),
)
