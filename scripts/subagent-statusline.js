#!/usr/bin/env node
/**
 * claude-swarm subagentStatusLine renderer.
 *
 * Receives every visible subagent row as one JSON object on stdin ("The command
 * runs once per refresh tick and receives all visible subagent rows as a single
 * JSON object on stdin" — statusline docs) and overrides only the rows belonging
 * to this plugin's agents. Emits one `{"id", "content"}` JSON line per overridden
 * row; any task whose id is omitted keeps Claude Code's default rendering.
 *
 * Background color encodes the model TIER, not the agent name — in a build wave
 * every row is claude-swarm:leaf, so per-agent color would convey nothing. Red is
 * reserved for one anomaly: a leaf resolved to anything other than Sonnet. That is
 * the void condition of the build prediction in evals/README.md, and it should
 * look wrong, not merely expensive.
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
// on both light and dark themes (anomaly uses bright white on bright red).
const TIER_BG = {
  haiku: '\x1b[106;30m', // bright cyan: cheap / cool
  sonnet: '\x1b[102;30m', // bright green: the workhorse
  opus: '\x1b[103;30m', // bright yellow: expensive / warm
}
const ANOMALY_BG = '\x1b[101;97m'
const NEUTRAL_BG = '\x1b[7m' // reverse video: model unresolved, no tier to claim
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'

// Fixed-width badge codes so rows align into a column.
const BADGE = {
  scout: 'SCOUT',
  tracer: 'TRACE',
  implementer: 'IMPL',
  mechanic: 'MECH',
  verifier: 'VERIF',
  scribe: 'SCRIBE',
  leaf: 'LEAF',
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

// Which field carries the agent identity, and in what form, is not specified for
// the tasks array — SubagentStop's agent_type is the scoped "claude-swarm:leaf",
// so that is the expected shape, but a bare roster name is accepted as a fallback
// rather than letting the whole feature no-op on a naming mismatch. `scoped`
// records which form matched: only a scoped match may raise the red anomaly, so a
// user's own agent that happens to be called "leaf" can't fire our one alarm.
function agentKey(task) {
  for (const field of [task.type, task.name, task.agent_type, task.subagent_type]) {
    if (typeof field !== 'string' || !field) continue
    if (field.startsWith('claude-swarm:')) {
      return { key: field.slice('claude-swarm:'.length), scoped: true }
    }
    if (Object.prototype.hasOwnProperty.call(BADGE, field)) {
      return { key: field, scoped: false }
    }
  }
  return null
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

function badgeFor(key, task, scoped) {
  const tier = tierOf(task.model)
  const text = (BADGE[key] || key.toUpperCase().slice(0, BADGE_W)).padEnd(BADGE_W)
  if (tier === null) return { text, color: NEUTRAL_BG, tier, anomaly: false }
  // The one reserved use of red: a leaf off Sonnet.
  if (scoped && key === 'leaf' && tier !== 'sonnet') return { text, color: ANOMALY_BG, tier, anomaly: true }
  if (tier === 'other') return { text, color: NEUTRAL_BG, tier, anomaly: false }
  return { text, color: TIER_BG[tier], tier, anomaly: false }
}

function cleanLabel(task) {
  return String(task.label || task.description || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function renderRow(task, key, columns, sharedLabelW, scoped) {
  const badge = badgeFor(key, task, scoped)
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

  const cost = () =>
    badgePlain.length + (label ? 2 + labelW : 0) + (elapsed ? 2 + elapsed.length : 0) + (bar ? 2 + bar.length : 0)

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

  const parts = [`${badge.color}${badgePlain}${RESET}`]
  if (labelCol) parts.push(live ? labelCol : `${DIM}${labelCol}${RESET}`)
  if (elapsed) parts.push(elapsedWeight ? `${elapsedWeight}${elapsed}${RESET}` : elapsed)
  if (bar) parts.push(bar)
  return parts.join('  ')
}

function writeAggregate(sessionId, counts) {
  // Keyed by session_id (a base hook field on this input) so concurrent
  // sessions never read each other's counts; sanitized because it feeds a path.
  const sid = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '')
  if (!sid) return
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const file = path.join(os.tmpdir(), `claude-swarm-status-${sid}.json`)
  fs.writeFileSync(file, JSON.stringify({ note: AGG_STALE_NOTE, counts }))
}

function main(raw) {
  const input = JSON.parse(raw)
  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  const columns = input.columns
  const counts = { haiku: 0, sonnet: 0, opus: 0, anomaly: 0, unresolved: 0 }
  const lines = []

  const ours = []
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || task.id === undefined) continue
    const match = agentKey(task)
    if (match !== null) ours.push([task, match.key, match.scoped])
  }
  // One label column across all rows of this tick, so elapsed aligns.
  const sharedLabelW = Math.min(
    Math.max(MIN_LABEL, ...ours.map(([t]) => cleanLabel(t).length)),
    MAX_LABEL,
  )

  for (const [task, key, scoped] of ours) {
    if (isRunning(task.status)) {
      const badge = badgeFor(key, task, scoped)
      if (badge.anomaly) counts.anomaly++
      else if (badge.tier === null || badge.tier === 'other') counts.unresolved++
      else counts[badge.tier]++
    }

    let content
    try {
      content = renderRow(task, key, columns, sharedLabelW, scoped)
    } catch (_) {
      continue // one bad task falls back to default rendering, not a blank panel
    }
    lines.push(JSON.stringify({ id: task.id, content }))
  }

  try {
    writeAggregate(input.session_id, counts)
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
