#!/usr/bin/env node
/**
 * claude-swarm SubagentStop hook: the completion feed.
 *
 * Appends one line per finished subagent — timestamp, agent type, first line of
 * its final message — to `.claude-swarm-feed.log` in the project directory. A
 * status window at zero token cost: `tail -f` it during a build wave instead of
 * polling agents.
 *
 * MUST always exit 0. On SubagentStop, exit code 2 BLOCKS the subagent from
 * stopping ("Prevents the subagent from stopping" — hooks reference), so any
 * failure here is swallowed: a broken feed line must never wedge an agent.
 */

'use strict'

let raw = ''
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  try {
    const o = JSON.parse(raw)
    // For plugin subagents agent_type is the scoped identifier
    // ("claude-swarm:leaf"), which is exactly what the feed should show.
    const who = o.agent_type || o.agent_id || '?'
    const said = String(o.last_assistant_message || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
    const line = `${new Date().toISOString()}\t${who}\t${said || '(no output)'}\n`
    const path = require('path')
    const fs = require('fs')
    const dir = process.env.CLAUDE_PROJECT_DIR || o.cwd || process.cwd()
    fs.appendFileSync(path.join(dir, '.claude-swarm-feed.log'), line)
  } catch (_) {
    /* swallow — see header */
  }
  process.exit(0)
})
// stdin never arriving must not leave a hung hook process behind.
setTimeout(() => process.exit(0), 5000).unref()
