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
 * A wave that has just finished is the exception. For 30s after a wave ends the
 * segment still renders — dimmed, backgrounds dropped, clock frozen at how long
 * the wave ran (`· ran 1:23` rather than `· oldest 1:23`). Without it the segment
 * vanished the instant the last agent exited: agents routinely finish in 15-45s,
 * one measured wave gave a 12-second window, and a wave ending while you read
 * code left no evidence it had run.
 *
 * "When did the wave end" has two answers and this reader accepts either, because
 * the authoritative one is not always produced. The writer stamps `endedAt` when
 * it observes its running count fall to zero — but that requires a tick after the
 * last agent exits, and Claude Code stops invoking the panel once the rows clear.
 * If the last agent exits between two ticks, the transition is never seen and the
 * stamp never lands. So a record that has gone stale while still counting running
 * agents is read as a finished wave anchored at its last write: the panel ticks
 * every ~5s for as long as any row exists, so mtime cannot lag behind a live wave.
 * Both paths are covered by smoke checks; see the comments at the liveness test.
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
// the liveness signal: past this age the counts describe a finished wave. That
// implication is load-bearing in both directions — it is also what lets a stale
// record stand in for a missing `endedAt` stamp.
const STALE_MS = 10000
// How long a finished wave stays on screen, dimmed. Agents routinely finish in
// 15-45s, so a segment that disappeared the instant the last one exited was
// invisible in ordinary use — measured at one 12-second window in practice.
// Anchored to when the wave ended, never to "how stale the file is": a stamped
// record must keep lingering after it goes stale (10s < 30s), and an unstamped
// one is anchored at its final write. Staleness gates liveness, not this window.
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
  const age = Date.now() - stat.mtimeMs

  // When did this wave end? Prefer the writer's own stamp, but do not depend on
  // it: the writer can only stamp `endedAt` on a tick where it observes the
  // running count at zero, and that tick is not guaranteed to happen. Claude
  // Code stops invoking the subagent panel once the rows clear, so if the last
  // agent exits between two ticks the transition is never seen.
  //
  // Measured 2026-07-26: a 256s agent's final tick landed at 04:27:59 still
  // counting one Sonnet; the agent exited ~04:28:00 and no further tick ever
  // came. `endedAt` was never stamped and the record sat unwritten for 35
  // minutes still claiming an agent was running — so the segment went quiet at
  // the 10s staleness cutoff, which is precisely the vanishing act the grace
  // window exists to prevent.
  //
  // A stale record that still counts running agents is therefore itself the
  // end-of-wave signal: the panel ticks every ~5s for as long as any row
  // exists, so mtime cannot fall behind while the wave is live. Anchor to the
  // last write. It costs at most one tick of accuracy on the reported duration
  // (the wave really ended somewhere in the following 5s) and, unlike the
  // stamp, it cannot be missed.
  let finishedAt = endedAt
  if (finishedAt === null && age > STALE_MS) finishedAt = stat.mtimeMs
  if (finishedAt !== null && Date.now() - finishedAt > GRACE_MS) return

  const counts = cached.counts || {}
  const chips = []
  for (const [tier, [letter, color]] of Object.entries(TIER_CHIP)) {
    const n = counts[tier]
    // A finished wave drops the tier backgrounds and goes dim, so "just ran" is
    // never mistaken at a glance for "running right now".
    if (Number.isFinite(n) && n > 0) chips.push(`${finishedAt === null ? color : DIM} ${n}${letter} ${RESET}`)
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
    const end = finishedAt === null ? Date.now() : finishedAt
    const s = Math.max(0, Math.floor((end - oldest) / 1000))
    const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    clock = ` ${DIM}· ${finishedAt === null ? 'oldest' : 'ran'} ${mmss}${RESET}`
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
