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
 * A wave that has just finished is the exception. For 30s afterwards the segment
 * still renders — dimmed, backgrounds dropped, clock frozen (`· ran 1:23` rather
 * than `· oldest 1:23`). Without it the segment vanished the instant the last
 * agent exited: agents routinely finish in 15-45s, one measured wave gave a
 * 12-second window, and a wave ending while you read code left no evidence it
 * had run.
 *
 * The segment renders three states, and the distinction between the last two is
 * epistemic rather than cosmetic:
 *
 *   `· oldest 1:23`  live    — the writer is ticking; agents are running now.
 *   `· ran 1:23`     ended   — the writer observed its count reach zero and
 *                              stamped `endedAt`. The wave is known to be over.
 *   `· last 1:23`    unheard — the record went stale while still counting running
 *                              agents. Usually the wave ended between two ticks
 *                              and the stamp was missed; but a stalled panel
 *                              looks identical, so this state claims only what is
 *                              actually known: nothing has updated it since 1:23.
 *
 * The third state exists because the stamp cannot be relied on — it requires a
 * tick after the last agent exits, and Claude Code stops invoking the panel once
 * the rows clear. Do NOT be tempted to render `unheard` as `ended`: a previous
 * release did exactly that, reasoning that a live wave cannot let mtime fall
 * behind, and it turned a harmless vanishing act into a confident false claim
 * whenever a tick stalled. All three states are covered by smoke checks.
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
// Past this age the record is no longer evidence of anything happening *now*.
// It says the writer has not ticked recently — NOT that the wave has ended.
// Those are different claims and conflating them is what broke 0.2.6.
const STALE_MS = 10000
// How long a wave stays on screen after it stops being live, dimmed. Agents
// routinely finish in 15-45s, so a segment that disappeared the instant the last
// one exited was invisible in ordinary use — measured at one 12-second window.
// Applied from whichever instant ended the live state: from `endedAt` for a
// stamped wave, and from the staleness cutoff for an unheard one, so both get
// the same 30 seconds rather than the unheard case silently getting ~20.
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

  // THREE states, not two. The distinction that matters is epistemic: there is a
  // difference between knowing a wave ended and merely not having heard from it.
  //
  //   live    — the writer is still ticking. Agents are running now.
  //   ended   — the writer observed its running count fall to zero and stamped
  //             `endedAt`. The wave is known to be over.
  //   unheard — the record has gone stale while still counting running agents.
  //             Nothing has updated it recently. Most often that means the wave
  //             ended between two ticks and the stamp was missed, but it can
  //             equally mean the panel simply stalled and the wave is still
  //             running. This state does not claim to know which.
  //
  // 0.2.6 collapsed `unheard` into `ended` and rendered it as `· ran`, on the
  // reasoning that the panel ticks every ~5s while any row exists, so a stale
  // record must describe a finished wave. That inference is false: any tick
  // stall past 10s — heavy load, a long blocking call, sleep/resume — produces
  // exactly this state mid-wave, and the segment then asserted a finish that had
  // not happened, with a duration frozen at the stall rather than the end. That
  // is worse than the vanishing it replaced: silence is merely unhelpful, a
  // confident wrong answer is misleading. So `unheard` now says what is actually
  // known — "no update since M:SS" — which is true under both readings.
  const endedAt = Number.isFinite(cached.endedAt) ? cached.endedAt : null
  const age = Date.now() - stat.mtimeMs

  let state
  if (endedAt !== null) {
    // A stamped wave lingers for GRACE_MS from the stamp, regardless of how
    // stale the file has since become — the panel stops rewriting once its rows
    // clear, so a finished record goes stale (10s) well before the window (30s).
    if (Date.now() - endedAt > GRACE_MS) return
    state = 'ended'
  } else if (age <= STALE_MS) {
    state = 'live'
  } else if (age <= STALE_MS + GRACE_MS) {
    // Measured while writing this: a wave whose stamp was missed sat unwritten
    // for 35 minutes still counting one running agent. Without this branch the
    // segment vanishes at STALE_MS and the wave leaves no trace at all.
    // The window is GRACE_MS *after staleness begins*, so an unheard wave gets
    // the same 30 seconds on screen as a stamped one rather than the ~20s that
    // anchoring the cutoff at mtime alone would give it.
    state = 'unheard'
  } else {
    return
  }

  const counts = cached.counts || {}
  const chips = []
  for (const [tier, [letter, color]] of Object.entries(TIER_CHIP)) {
    const n = counts[tier]
    // Anything not live drops the tier backgrounds and goes dim, so neither a
    // finished wave nor a silent one is mistaken at a glance for a running one.
    if (Number.isFinite(n) && n > 0) chips.push(`${state === 'live' ? color : DIM} ${n}${letter} ${RESET}`)
  }
  if (!chips.length) return

  // The clock is computed here, not read from the cache: with refreshInterval 1
  // this segment runs every second while the cache behind it is only rewritten
  // every five, so a stored elapsed would advance in visible 5s jumps. From the
  // raw start timestamp the seconds tick smoothly between cache writes.
  let clock = ''
  const oldest = cached.oldestStart
  if (Number.isFinite(oldest)) {
    // Each state measures to a different instant, and each label says which:
    //   live    → now.        `oldest 1:23` — the running clock of the oldest agent.
    //   ended   → endedAt.    `ran 1:23`    — how long the wave lasted. A clock
    //                          still climbing after the last agent exited is a lie.
    //   unheard → mtime.      `last 1:23`   — where the clock stood at the final
    //                          update. Not a claim about when the wave ended,
    //                          because that is exactly what is not known. If the
    //                          panel merely stalled, this is still true: it is
    //                          the last thing anybody actually observed.
    const anchor = state === 'live' ? Date.now() : state === 'ended' ? endedAt : stat.mtimeMs
    const label = state === 'live' ? 'oldest' : state === 'ended' ? 'ran' : 'last'
    const s = Math.max(0, Math.floor((anchor - oldest) / 1000))
    const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    clock = ` ${DIM}· ${label} ${mmss}${RESET}`
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
