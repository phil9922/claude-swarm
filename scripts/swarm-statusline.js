#!/usr/bin/env node
/**
 * claude-swarm main-statusLine segment: running swarm agents by tier.
 *
 * The main statusLine's stdin carries session data only — no task array — so
 * this segment reads the per-session aggregate that scripts/subagent-statusline.js
 * caches in the OS temp dir each refresh tick (the docs' "cache expensive
 * operations" pattern, keyed by session_id). If the cache is missing or stale,
 * it prints nothing: no swarm running, no segment.
 *
 * This is a POST-INSTALL script: a plugin's settings.json may only ship the
 * `agent` and `subagentStatusLine` keys ("Only the `agent` and
 * `subagentStatusLine` keys are currently supported" — plugins reference), so
 * `statusLine` itself must live in user or project settings. See the README's
 * "Live swarm display" section for the settings block, including
 * `refreshInterval: 1` — the event-driven statusline triggers go quiet exactly
 * while the master waits on background subagents.
 *
 * Prints one compact segment that composes with an existing status line
 * (call it and append its output), e.g.:  swarm  2H  5S  1O
 * Red appears only for the anomaly count: leaves resolved off Sonnet.
 *
 * MUST never crash and never exit non-zero; failure degrades to empty output.
 */

'use strict'

const TIER_CHIP = {
  haiku: ['H', '\x1b[106;30m'],
  sonnet: ['S', '\x1b[102;30m'],
  opus: ['O', '\x1b[103;30m'],
  anomaly: ['!', '\x1b[101;97m'],
  unresolved: ['?', '\x1b[7m'],
}
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
// The subagent panel stops ticking when the wave ends, so the cache's mtime is
// the liveness signal: past this age the counts describe a finished wave.
const STALE_MS = 10000

function main(raw) {
  const input = JSON.parse(raw)
  const sid = String(input.session_id || '').replace(/[^A-Za-z0-9._-]/g, '')
  if (!sid) return

  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const file = path.join(os.tmpdir(), `claude-swarm-status-${sid}.json`)

  const stat = fs.statSync(file) // throws if absent → empty output
  if (Date.now() - stat.mtimeMs > STALE_MS) return

  const counts = JSON.parse(fs.readFileSync(file, 'utf8')).counts || {}
  const chips = []
  for (const [tier, [letter, color]] of Object.entries(TIER_CHIP)) {
    const n = counts[tier]
    if (Number.isFinite(n) && n > 0) chips.push(`${color} ${n}${letter} ${RESET}`)
  }
  if (chips.length) process.stdout.write(`${DIM}swarm${RESET} ${chips.join(' ')}`)
}

let raw = ''
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  try {
    main(raw)
  } catch (_) {
    /* empty output is the degraded state, never an error */
  }
  process.exit(0)
})
setTimeout(() => process.exit(0), 3000).unref()
