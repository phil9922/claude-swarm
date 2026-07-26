#!/usr/bin/env node
/**
 * claude-swarm subagentStatusLine renderer.
 *
 * Receives every visible subagent row as one JSON object on stdin ("The command
 * runs once per refresh tick and receives all visible subagent rows as a single
 * JSON object on stdin" — statusline docs) and emits one `{"id", "content"}` JSON
 * line per row; any task whose id is omitted keeps Claude Code's default rendering.
 *
 * The badge names the model TIER, because that is the only identity the payload
 * actually carries. Captured live on Claude Code 2.1.220, every row looks like:
 *
 *   {"id":"a009e10f…","type":"local_agent","status":"running",
 *    "description":"Count evals files","label":"Count evals files",
 *    "startTime":1785047874285,"model":"claude-haiku-4-5-20251001",
 *    "effort":"xhigh","contextWindowSize":200000,"tokenCount":9431,"cwd":"…"}
 *
 * `type` is the constant "local_agent" on every row, `name` is absent (it is
 * populated from Claude Code's agent-name registry — a user-assigned name, not the
 * agent type — and Task-dispatched subagents have no entry), and description/label
 * carry the caller's Task description. So a scout, a tracer and a leaf are
 * indistinguishable here, which retired two earlier design ideas: the
 * per-agent badge (SCOUT/TRACE/LEAF) and the red "leaf resolved off Sonnet"
 * anomaly. Neither is derivable, so neither is faked. Tier color still reads as a
 * cost heat map, which is most of what the panel was for.
 *
 * Because rows cannot be attributed, this renders EVERY subagent row, not only
 * this plugin's — an unavoidable consequence of the payload, and the reason the
 * rows stay tier-generic rather than claiming swarm ownership.
 *
 * Cadence is fixed at 5s (Claude Code 2.1.220 ticks the panel on a hardcoded
 * 5000ms timer, first tick at 300ms; the subagentStatusLine settings object takes
 * only `type` and `command` — `refreshInterval` is the main statusLine's knob).
 * So elapsed steps in 5s jumps, and the aggregate cache below is rewritten at that
 * same rate, which is what the reader's 10s staleness cutoff allows for: two ticks.
 *
 * Side effect: writes a ~100-byte per-session aggregate (running count by tier)
 * to the OS temp dir. The main statusLine's stdin carries no task data, so this
 * cache is the only bridge to an aggregate segment there — same pattern as the
 * docs' "cache expensive operations" example, keyed by session_id.
 *
 * MUST never crash and never exit non-zero: a failing script would blank the
 * display. Every failure degrades to "print nothing" = default rendering.
 */

'use strict'

// Standard 8/bright ANSI only — 256-color and truecolor read too differently
// across terminal themes. Black foreground on bright backgrounds stays readable
// on both light and dark themes.
const TIER_BG = {
  haiku: '\x1b[106;30m', // bright cyan: cheap / cool
  sonnet: '\x1b[102;30m', // bright green: the workhorse
  opus: '\x1b[103;30m', // bright yellow: expensive / warm
}
const NEUTRAL_BG = '\x1b[7m' // reverse video: model unresolved, no tier to claim
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'

// Fixed-width badge codes so rows align into a column.
const TIER_BADGE = {
  haiku: 'HAIKU',
  sonnet: 'SONNET',
  opus: 'OPUS',
}
const BADGE_W = 6
const BAR_CELLS = 8
const MIN_LABEL = 6
const MAX_LABEL = 24
// Elapsed uses weight, not color, so it never fights the tier badge:
// dim under normal duration, default past typical, bold approaching the
// leaf turn cap (25 turns; empirically ~6 turns per repair cycle).
const ELAPSED_NORMAL_S = 180
const ELAPSED_BOLD_S = 360

const AGG_STALE_NOTE = 'read by scripts/swarm-statusline.js with a 10s cutoff'

function tierOf(model) {
  if (typeof model !== 'string' || !model) return null
  if (/haiku/i.test(model)) return 'haiku'
  if (/sonnet/i.test(model)) return 'sonnet'
  if (/opus/i.test(model)) return 'opus'
  return 'other' // resolved, but none of the three routed tiers (e.g. fable)
}

// A model id that resolved to none of the three routed tiers still deserves a
// name rather than a shrug: "claude-fable-5" reads as FABLE. Provider prefixes
// (us.anthropic.claude-…) are skipped so the badge names the model, not the
// region it was billed through.
const MODEL_PREFIX_WORDS = new Set(['claude', 'anthropic', 'us', 'eu', 'apac', 'bedrock', 'vertex'])

function otherBadge(model) {
  const words = String(model).toLowerCase().match(/[a-z]+/g) || []
  const word = words.find((w) => !MODEL_PREFIX_WORDS.has(w)) || words[0] || 'model'
  return word.toUpperCase().slice(0, BADGE_W)
}

function elapsedSeconds(startTime) {
  const t = typeof startTime === 'number' ? startTime : Date.parse(startTime)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((Date.now() - t) / 1000))
}

function formatElapsed(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function contextBar(task) {
  const used = task.tokenCount
  const size = task.contextWindowSize // absent before v2.1.205 or while unresolved
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return null
  const pct = Math.min(100, Math.round((used / size) * 100))
  const filled = Math.round((pct / 100) * BAR_CELLS)
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)} ${pct}%`
}

// A running task is any visible task without a terminal status. Matching
// terminal words instead of one exact "running" string keeps the count honest
// if the harness names its states differently than we guess.
function isRunning(status) {
  return !(typeof status === 'string' && /complet|done|fail|error|stop|cancel/i.test(status))
}

function badgeFor(task) {
  const tier = tierOf(task.model)
  // No model yet (the field is omitted until the task's model resolves) — say
  // AGENT rather than guess a tier the row would then be colored by.
  if (tier === null) return { text: 'AGENT'.padEnd(BADGE_W), color: NEUTRAL_BG, tier }
  if (tier === 'other') return { text: otherBadge(task.model).padEnd(BADGE_W), color: NEUTRAL_BG, tier }
  return { text: TIER_BADGE[tier].padEnd(BADGE_W), color: TIER_BG[tier], tier }
}

function cleanLabel(task) {
  return String(task.label || task.description || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function renderRow(task, columns, sharedLabelW) {
  const badge = badgeFor(task)
  const badgePlain = ` ${badge.text} ` // 1 + BADGE_W + 1 visible columns
  const live = isRunning(task.status)

  // The payload carries startTime but no end time, so elapsed can only be
  // computed against now — which for a finished row would be a clock that keeps
  // counting after the agent stopped. Drop elapsed and the context bar once a
  // task reaches a terminal status rather than display a number that lies.
  const secs = live ? elapsedSeconds(task.startTime) : null
  const elapsedPlain = secs === null ? null : formatElapsed(secs)
  const elapsedWeight = secs === null ? '' : secs >= ELAPSED_BOLD_S ? BOLD : secs < ELAPSED_NORMAL_S ? DIM : ''

  const barPlain = live ? contextBar(task) : null
  const rawLabel = cleanLabel(task)

  // Drop order under a tight `columns`: context bar first, then the label,
  // then elapsed. The badge never drops.
  const width = Number.isFinite(columns) && columns > 0 ? columns : 80
  let bar = barPlain
  let elapsed = elapsedPlain
  let label = rawLabel || null
  // sharedLabelW is computed across all rows of this tick so labels pad to one
  // column and elapsed aligns; a too-narrow row shrinks its own copy below.
  let labelW = sharedLabelW

  // The badge never drops — but a panel narrower than the badge itself would then
  // render a row wider than the width it was handed, so it clips instead.
  const badgeShown = badgePlain.length > width ? badgePlain.slice(0, Math.max(0, width)) : badgePlain

  const cost = () =>
    badgeShown.length + (label ? 2 + labelW : 0) + (elapsed ? 2 + elapsed.length : 0) + (bar ? 2 + bar.length : 0)

  if (cost() > width) bar = null
  if (cost() > width) {
    // Shrink the label toward MIN_LABEL before dropping it outright.
    const spare = width - (cost() - (label ? 2 + labelW : 0))
    if (label && spare >= 2 + MIN_LABEL) labelW = spare - 2
    else label = null
  }
  if (cost() > width) elapsed = null

  let labelCol = null
  if (label) {
    labelCol = label.length > labelW ? `${label.slice(0, labelW - 1)}…` : label.padEnd(labelW)
  }

  const parts = [`${badge.color}${badgeShown}${RESET}`]
  if (labelCol) parts.push(live ? labelCol : `${DIM}${labelCol}${RESET}`)
  if (elapsed) parts.push(elapsedWeight ? `${elapsedWeight}${elapsed}${RESET}` : elapsed)
  if (bar) parts.push(bar)
  return parts.join('  ')
}

function writeAggregate(sessionId, counts, oldestStart) {
  // Keyed by session_id (a base hook field on this input) so concurrent
  // sessions never read each other's counts; sanitized because it feeds a path.
  const sid = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '')
  if (!sid) return
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const file = path.join(os.tmpdir(), `claude-swarm-status-${sid}.json`)
  // oldestStart is a raw timestamp, not an elapsed value, so the reader can
  // recompute the clock on ITS tick: the main status line refreshes every second
  // while this cache is only rewritten every five, and a stored elapsed would
  // visibly freeze for four ticks out of five.
  fs.writeFileSync(file, JSON.stringify({ note: AGG_STALE_NOTE, counts, oldestStart }))
}

function main(raw) {
  const input = JSON.parse(raw)
  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  const columns = input.columns
  const counts = { haiku: 0, sonnet: 0, opus: 0, unresolved: 0 }
  const lines = []

  // Every row, not a filtered subset: the payload carries nothing that says which
  // agent a row belongs to, so a filter here could only be a guess.
  const rows = tasks.filter((t) => t && typeof t === 'object' && t.id !== undefined)

  // One label column across all rows of this tick, so elapsed aligns.
  const sharedLabelW = Math.min(
    Math.max(MIN_LABEL, ...rows.map((t) => cleanLabel(t).length)),
    MAX_LABEL,
  )

  let oldestStart = null
  for (const task of rows) {
    if (isRunning(task.status)) {
      const tier = badgeFor(task).tier
      if (tier === null || tier === 'other') counts.unresolved++
      else counts[tier]++
      const t = typeof task.startTime === 'number' ? task.startTime : Date.parse(task.startTime)
      if (Number.isFinite(t) && (oldestStart === null || t < oldestStart)) oldestStart = t
    }

    let content
    try {
      content = renderRow(task, columns, sharedLabelW)
    } catch (_) {
      continue // one bad task falls back to default rendering, not a blank panel
    }
    lines.push(JSON.stringify({ id: task.id, content }))
  }

  try {
    writeAggregate(input.session_id, counts, oldestStart)
  } catch (_) {
    /* the aggregate is optional; rows still render */
  }

  if (lines.length) process.stdout.write(lines.join('\n') + '\n')
}

let raw = ''
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  try {
    main(raw)
  } catch (_) {
    /* print nothing: every row keeps its default rendering */
  }
  process.exit(0)
})
// stdin never arriving must not leave a hung process behind each tick.
setTimeout(() => process.exit(0), 3000).unref()
