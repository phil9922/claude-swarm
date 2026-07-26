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
 * A wave that has just finished is the exception. The writer stamps `endedAt`
 * when its running count falls to zero, and for 30s after that the segment still
 * renders — dimmed, backgrounds dropped, clock frozen at how long the wave ran
 * (`· ran 1:23` rather than `· oldest 1:23`). Without it the segment vanished the
 * instant the last agent exited: agents routinely finish in 15-45s, one measured
 * wave gave a 12-second window, and a wave ending while you read code left no
 * evidence it had run. The grace window is anchored to `endedAt`, NOT to mtime,
 * because the panel stops rewriting the cache once its rows clear — a finished
 * record goes stale (10s) well before the window (30s) closes.
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
 * (call it and append its output), e.g.:  claude-swarm  2H  5S  1O  · oldest 1:23
 * Chips count running subagents by model tier; `?` counts rows whose model has
 * not resolved yet, or resolved to none of the three routed tiers. The clock is
 * the longest-running agent's, and it is the reason this segment is worth a
 * `refreshInterval: 1`: the subagent panel itself only ticks every 5s (hardcoded
 * in Claude Code 2.1.220), so this line is the one part of the display that can
 * move every second.
 *
 * The label is branded once, here, rather than per row: the subagent payload
 * carries no agent identity, so an individual row cannot honestly claim to be a
 * claude-swarm agent — see scripts/subagent-statusline.js.
 *
 * MUST never crash and never exit non-zero; failure degrades to empty output.
 */

'use strict'

const TIER_CHIP = {
  haiku: ['H', '\x1b[106;30m'],
  sonnet: ['S', '\x1b[102;30m'],
  opus: ['O', '\x1b[103;30m'],
  unresolved: ['?', '\x1b[7m'],
}
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
// The subagent panel stops ticking when the wave ends, so the cache's mtime is
// the liveness signal: past this age the counts describe a finished wave.
const STALE_MS = 10000
// How long a finished wave stays on screen, dimmed. Agents routinely finish in
// 15-45s, so a segment that disappeared the instant the last one exited was
// invisible in ordinary use — measured at one 12-second window in practice.
// The writer stamps `endedAt` on the transition to zero; this window is anchored
// to that stamp rather than to mtime, because the panel stops rewriting the file
// once its rows clear and the record would otherwise go stale before the window
// closed.
const GRACE_MS = 30000

function main(raw) {
  const input = JSON.parse(raw)
  const sid = String(input.session_id || '').replace(/[^A-Za-z0-9._-]/g, '')
  if (!sid) return

  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const file = path.join(os.tmpdir(), `claude-swarm-status-${sid}.json`)

  const stat = fs.statSync(file) // throws if absent → empty output
  const cached = JSON.parse(fs.readFileSync(file, 'utf8'))

  // Two different liveness questions, and only one of them is about mtime. A
  // live record is trusted while the writer is still ticking. A finished record
  // carries its own clock and is trusted for a fixed window after the wave
  // ended, whether or not anything is still refreshing the file.
  const endedAt = Number.isFinite(cached.endedAt) ? cached.endedAt : null
  if (endedAt === null) {
    if (Date.now() - stat.mtimeMs > STALE_MS) return
  } else if (Date.now() - endedAt > GRACE_MS) {
    return
  }

  const counts = cached.counts || {}
  const chips = []
  for (const [tier, [letter, color]] of Object.entries(TIER_CHIP)) {
    const n = counts[tier]
    // A finished wave drops the tier backgrounds and goes dim, so "just ran" is
    // never mistaken at a glance for "running right now".
    if (Number.isFinite(n) && n > 0) chips.push(`${endedAt === null ? color : DIM} ${n}${letter} ${RESET}`)
  }
  if (!chips.length) return

  // The clock is computed here, not read from the cache: with refreshInterval 1
  // this segment runs every second while the cache behind it is only rewritten
  // every five, so a stored elapsed would advance in visible 5s jumps. From the
  // raw start timestamp the seconds tick smoothly between cache writes.
  let clock = ''
  const oldest = cached.oldestStart
  if (Number.isFinite(oldest)) {
    // Live: the clock runs, so it is computed against now. Finished: it stops at
    // the moment the wave ended and reports how long the wave lasted — a clock
    // still climbing after the last agent exited would be a lie.
    const end = endedAt === null ? Date.now() : endedAt
    const s = Math.max(0, Math.floor((end - oldest) / 1000))
    const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    clock = ` ${DIM}· ${endedAt === null ? 'oldest' : 'ran'} ${mmss}${RESET}`
  }
  process.stdout.write(`${DIM}claude-swarm${RESET} ${chips.join(' ')}${clock}`)
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
