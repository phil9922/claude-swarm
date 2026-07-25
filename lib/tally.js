#!/usr/bin/env node
/**
 * claude-swarm savings tally.
 *
 * Answers one question: what did the work we pushed down to cheaper agents
 * actually cost, and what would those same tokens have cost on Opus?
 *
 * The data is already on disk. Claude Code keeps one directory per project
 * under <configDir>/projects/<slug>/, and every subagent turn lands in
 * <sessionId>/subagents/agent-<id>.jsonl — one level deeper, under
 * subagents/workflows/wf_<runId>, when the Workflow tool spawned it. Each
 * assistant entry carries the model, the token usage, a timestamp, and an
 * `attributionAgent` naming the roster agent that ran it.
 *
 * We read usage metadata only — model, token counts, timestamps, agent names.
 * Never prompt or response text. That matters because the lifetime total walks
 * every project directory on the machine, not just this one.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *   1. Assistant entries are split per content block, and several entries share
 *      one message.id while reporting *cumulative* usage — one real message.id
 *      reports output_tokens as 5, 5, 5, 268. Summing rows double-counts.
 *      We dedup by message.id and keep the last write.
 *
 *   2. Sonnet 5 is on introductory pricing until 2026-08-31. Turns are priced
 *      by their own timestamp, so this keeps telling the truth afterwards
 *      instead of quietly drifting.
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// Bump when the on-disk shape changes; a mismatch discards rather than misreads.
const SCHEMA_VERSION = 1

/**
 * The roster agents that run below the Opus tier. `implementer` is deliberately
 * absent: it runs on Opus by design, so its counterfactual equals its actual
 * cost and including it would only dilute the percentage with zeroes.
 *
 * Workflow-spawned agents record the bare name; explicit subagent_type spawns
 * record it plugin-qualified ("claude-swarm:tracer"). We accept both, which
 * means a bare name is indistinguishable from an identically-named agent in the
 * user's own ~/.claude/agents/. Same roster, same tiers, so the arithmetic is
 * unaffected — but the README says so rather than overclaiming.
 */
const ROSTER = new Set(['scout', 'tracer', 'mechanic', 'verifier', 'scribe'])

// Per-MTok list prices. First match wins, so order matters.
const PRICES = [
  { match: /^claude-(fable|mythos)-5/, tier: 'fable', input: 10, output: 50 },
  { match: /^claude-opus-(5|4-8|4-7|4-6)/, tier: 'opus', input: 5, output: 25 },
  {
    match: /^claude-sonnet-5/,
    tier: 'sonnet',
    input: 3,
    output: 15,
    // Introductory pricing runs through 2026-08-31 inclusive.
    intro: { throughMonth: '2026-08', input: 2, output: 10 },
  },
  { match: /^claude-sonnet-4-6/, tier: 'sonnet', input: 3, output: 15 },
  { match: /^claude-haiku-4-5/, tier: 'haiku', input: 1, output: 5 },
]

// The counterfactual: the same tokens billed at Opus rates.
const BASELINE = { input: 5, output: 25 }

// Cache reads bill at 0.1x input. Writes bill at 1.25x for the 5-minute TTL
// and 2x for the 1-hour one.
const CACHE_READ_MULTIPLIER = 0.1
const CACHE_WRITE_5M_MULTIPLIER = 1.25
const CACHE_WRITE_1H_MULTIPLIER = 2

// --- paths ---------------------------------------------------------------

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

function stateDir() {
  return path.join(configDir(), 'claude-swarm')
}

// The summary the SessionStart hook reads. Deliberately its own small file so
// that read stays cheap no matter how large the watermark cache grows.
function summaryPath() {
  return path.join(stateDir(), 'usage.json')
}

// Per-file watermarks. Only this script ever reads it.
function cachePath() {
  return path.join(stateDir(), 'usage-cache.json')
}

/** Claude Code's slug for a project directory: every separator becomes a dash. */
function slugFor(dir) {
  return dir.replace(/[/.]/g, '-')
}

// --- pricing -------------------------------------------------------------

/** Strip a date suffix and any context-window marker, e.g. "claude-opus-5[1m]". */
function normalizeModel(model) {
  return String(model || '').replace(/\[.*$/, '')
}

/**
 * Rates for a model in a given month ("YYYY-MM"), or null if we have no list
 * price for it. Unknown models are reported rather than silently dropped — the
 * plugin's own "no silent truncation" rule applies to its own tooling.
 */
function ratesFor(model, month) {
  const id = normalizeModel(model)
  for (const row of PRICES) {
    if (!row.match.test(id)) continue
    if (row.intro && month && month <= row.intro.throughMonth) {
      return { tier: row.tier, input: row.intro.input, output: row.intro.output }
    }
    return { tier: row.tier, input: row.input, output: row.output }
  }
  return null
}

/**
 * Cache-write tokens split by TTL. Newer entries break the total out under
 * `cache_creation`; older ones only have the flat field, which we treat as 5m.
 */
function splitCacheWrites(usage) {
  const cc = usage.cache_creation
  if (
    cc &&
    (typeof cc.ephemeral_5m_input_tokens === 'number' ||
      typeof cc.ephemeral_1h_input_tokens === 'number')
  ) {
    return {
      write5m: cc.ephemeral_5m_input_tokens || 0,
      write1h: cc.ephemeral_1h_input_tokens || 0,
    }
  }
  return { write5m: usage.cache_creation_input_tokens || 0, write1h: 0 }
}

function emptyTokens() {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, write5m: 0, write1h: 0 }
}

function addTokens(into, from) {
  into.turns += from.turns
  into.input += from.input
  into.output += from.output
  into.cacheRead += from.cacheRead
  into.write5m += from.write5m
  into.write1h += from.write1h
  return into
}

/** Dollar cost of a token bundle at the given per-MTok rates. */
function costOf(tokens, rates) {
  return (
    (tokens.input * rates.input +
      tokens.output * rates.output +
      tokens.cacheRead * rates.input * CACHE_READ_MULTIPLIER +
      tokens.write5m * rates.input * CACHE_WRITE_5M_MULTIPLIER +
      tokens.write1h * rates.input * CACHE_WRITE_1H_MULTIPLIER) /
    1e6
  )
}

// --- parsing -------------------------------------------------------------

/**
 * Bucket key. Month granularity is what lets us cache token sums rather than
 * dollars: pricing (including date-dependent pricing) is applied at report
 * time, so a rate change re-prices without re-reading a single transcript.
 * It assumes price changes land on month boundaries — true of the Sonnet 5
 * intro window. A mid-month change would need SCHEMA_VERSION bumped.
 */
const BUCKET_SEP = '\u0001'

function bucketKey(agent, model, month) {
  return [agent, model, month].join(BUCKET_SEP)
}

function parseBucketKey(key) {
  const [agent, model, month] = key.split(BUCKET_SEP)
  return { agent, model, month }
}

/**
 * Parse one agent transcript into token buckets.
 *
 * `fallbackAgent` comes from the sibling agent-<id>.meta.json and is used only
 * when an entry carries no attributionAgent of its own.
 */
function parseTranscript(file, fallbackAgent) {
  const buckets = Object.create(null)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (_) {
    return buckets
  }

  // message.id -> the latest usage seen for it. Entries are split per content
  // block with cumulative usage, so the last one wins and earlier partials are
  // discarded rather than added.
  const byMessage = new Map()

  for (const line of text.split('\n')) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch (_) {
      continue // A half-written trailing line while a session is live.
    }
    if (entry.type !== 'assistant') continue
    const message = entry.message
    if (!message || !message.usage) continue

    const rawAgent = entry.attributionAgent || fallbackAgent || ''
    const agent = String(rawAgent).replace(/^claude-swarm:/, '')
    if (!ROSTER.has(agent)) continue

    const id = message.id || `${file}:${entry.uuid}`
    byMessage.set(id, {
      agent,
      model: normalizeModel(message.model),
      month: String(entry.timestamp || '').slice(0, 7),
      usage: message.usage,
    })
  }

  for (const row of byMessage.values()) {
    const key = bucketKey(row.agent, row.model, row.month)
    const bucket = (buckets[key] = buckets[key] || emptyTokens())
    const { write5m, write1h } = splitCacheWrites(row.usage)
    bucket.turns += 1
    bucket.input += row.usage.input_tokens || 0
    bucket.output += row.usage.output_tokens || 0
    bucket.cacheRead += row.usage.cache_read_input_tokens || 0
    bucket.write5m += write5m
    bucket.write1h += write1h
  }

  return buckets
}

// --- scanning ------------------------------------------------------------

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return []
  }
}

/** Every agent-*.jsonl beneath a subagents/ tree, at any depth. */
function collectAgentFiles(dir, out) {
  for (const entry of readdirSafe(dir)) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectAgentFiles(full, out)
    else if (/^agent-.*\.jsonl$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Transcripts for one project. Main-loop transcripts are skipped: the main loop
 * runs on Opus, so it has no tier delta to contribute, and skipping it avoids
 * reading by far the largest files.
 */
function projectTranscripts(projectDir) {
  const files = []
  for (const session of readdirSafe(projectDir)) {
    if (!session.isDirectory()) continue
    collectAgentFiles(path.join(projectDir, session.name, 'subagents'), files)
  }
  return files
}

function agentTypeFromMeta(file) {
  try {
    const meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
    return meta.agentType || ''
  } catch (_) {
    return ''
  }
}

// --- cache ---------------------------------------------------------------

function readJSONSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_) {
    return null
  }
}

function loadCache() {
  const cache = readJSONSafe(cachePath())
  if (!cache || cache.schemaVersion !== SCHEMA_VERSION || !cache.files) {
    return { schemaVersion: SCHEMA_VERSION, files: {} }
  }
  return cache
}

function writeJSONSafe(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
    return true
  } catch (_) {
    return false
  }
}

/**
 * Token buckets for a project, reusing cached per-file results.
 *
 * Files are keyed on (size, mtimeMs). Transcripts of finished sessions never
 * change, so in practice only the live session's files are re-parsed. Caching
 * whole files rather than tailing byte offsets is deliberate: a message.id's
 * cumulative entries can straddle any offset we picked, and re-parsing one
 * small file is far cheaper than getting that boundary wrong.
 */
function tallyProject(projectDir, cache) {
  const buckets = Object.create(null)
  const unknownModels = Object.create(null)

  for (const file of projectTranscripts(projectDir)) {
    let stat
    try {
      stat = fs.statSync(file)
    } catch (_) {
      continue
    }

    const cached = cache.files[file]
    let fileBuckets
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      fileBuckets = cached.buckets
    } else {
      fileBuckets = parseTranscript(file, agentTypeFromMeta(file))
      cache.files[file] = { size: stat.size, mtimeMs: stat.mtimeMs, buckets: fileBuckets }
    }

    for (const [key, tokens] of Object.entries(fileBuckets)) {
      buckets[key] = addTokens(buckets[key] || emptyTokens(), tokens)
    }
  }

  // Price the buckets.
  const agents = Object.create(null)
  let actual = 0
  let opus = 0

  for (const [key, tokens] of Object.entries(buckets)) {
    const { agent, model, month } = parseBucketKey(key)
    const rates = ratesFor(model, month)
    if (!rates) {
      unknownModels[model] = (unknownModels[model] || 0) + tokens.turns
      continue
    }
    const row = (agents[agent] = agents[agent] || {
      tier: rates.tier,
      tokens: emptyTokens(),
      actual: 0,
      opus: 0,
    })
    // An agent seen on more than one tier is labelled by its priciest.
    if (rates.tier === 'opus' || rates.tier === 'fable') row.tier = rates.tier
    addTokens(row.tokens, tokens)
    row.actual += costOf(tokens, rates)
    row.opus += costOf(tokens, BASELINE)
    actual += costOf(tokens, rates)
    opus += costOf(tokens, BASELINE)
  }

  return { agents, actual, opus, saved: opus - actual, unknownModels }
}

/** Every project directory Claude Code has recorded. */
function allProjectSlugs() {
  const root = path.join(configDir(), 'projects')
  return readdirSafe(root)
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}

/**
 * Tally one project (by slug) or all of them, refreshing the cache and the
 * hook's summary file as a side effect.
 */
function run({ slug = null, all = false } = {}) {
  const cache = loadCache()
  const root = path.join(configDir(), 'projects')
  const slugs = all ? allProjectSlugs() : slug ? [slug] : []

  const projects = Object.create(null)
  const lifetime = { actual: 0, opus: 0, saved: 0 }
  const unknownModels = Object.create(null)

  for (const s of slugs) {
    const result = tallyProject(path.join(root, s), cache)
    projects[s] = result
    lifetime.actual += result.actual
    lifetime.opus += result.opus
    lifetime.saved += result.saved
    for (const [model, turns] of Object.entries(result.unknownModels)) {
      unknownModels[model] = (unknownModels[model] || 0) + turns
    }
  }

  return { projects, lifetime, unknownModels, cache }
}

/**
 * Persist the watermark cache and the small summary the hook reads.
 *
 * A partial run (one project) must not clobber the other projects' summaries,
 * so we merge into whatever is already recorded.
 */
function persist({ projects, cache }) {
  writeJSONSafe(cachePath(), cache)

  const previous = readJSONSafe(summaryPath())
  const merged =
    previous && previous.schemaVersion === SCHEMA_VERSION && previous.projects
      ? previous.projects
      : {}

  for (const [slug, result] of Object.entries(projects)) {
    // Most projects have never used the swarm. Recording a row of zeroes for
    // each of them would bloat the file the SessionStart hook parses on every
    // start, for no information — so only keep projects with something to say.
    if (result.opus <= 0) {
      delete merged[slug]
      continue
    }
    merged[slug] = {
      actual: round(result.actual),
      opus: round(result.opus),
      saved: round(result.saved),
    }
  }

  const lifetime = Object.values(merged).reduce(
    (acc, p) => ({
      actual: acc.actual + p.actual,
      opus: acc.opus + p.opus,
      saved: acc.saved + p.saved,
    }),
    { actual: 0, opus: 0, saved: 0 }
  )

  writeJSONSafe(summaryPath(), {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    lifetime: {
      actual: round(lifetime.actual),
      opus: round(lifetime.opus),
      saved: round(lifetime.saved),
    },
    projects: merged,
  })
}

function round(n) {
  return Math.round(n * 100) / 100
}

// --- reporting -----------------------------------------------------------

function money(n) {
  return `$${n.toFixed(2)}`
}

function percent(saved, opus) {
  if (!opus) return '0%'
  return `${Math.round((saved / opus) * 100)}%`
}

function pad(s, width) {
  return String(s).padEnd(width)
}

function padLeft(s, width) {
  return String(s).padStart(width)
}

function formatProject(title, result) {
  const lines = [`claude-swarm — ${title}`, '']
  const rows = Object.entries(result.agents).sort((a, b) => b[1].opus - a[1].opus)

  if (rows.length === 0) {
    lines.push('  No delegated work recorded yet.')
    lines.push('')
    lines.push('  Nothing has been routed to scout, tracer, mechanic, verifier')
    lines.push('  or scribe here, so there is no tier delta to measure.')
    return lines.join('\n')
  }

  const nameWidth = Math.max(...rows.map(([name]) => name.length), 9)
  for (const [name, row] of rows) {
    lines.push(
      `  ${pad(name, nameWidth)}  ${pad(row.tier, 6)}  ${padLeft(money(row.actual), 8)}` +
        `   → ${padLeft(money(row.opus), 8)} on Opus`
    )
  }

  lines.push(`  ${'─'.repeat(nameWidth + 38)}`)
  lines.push(
    `  ${pad('spent', nameWidth)}  ${pad('', 6)}  ${padLeft(money(result.actual), 8)}` +
      `   vs ${padLeft(money(result.opus), 8)}`
  )
  lines.push('')
  lines.push(`  saved ${money(result.saved)} (${percent(result.saved, result.opus)})`)
  return lines.join('\n')
}

const CAVEAT = [
  '  Upper bound: this prices the tokens your swarm actually spent at Opus',
  '  rates. A solo Opus run would have spent fewer tokens overall, so real',
  '  savings are lower. implementer (opus) is not counted — no tier delta.',
].join('\n')

function formatUnknown(unknownModels) {
  const entries = Object.entries(unknownModels)
  if (entries.length === 0) return ''
  const list = entries.map(([m, t]) => `${m} (${t} turns)`).join(', ')
  return `\n  Not priced — no list price on file for: ${list}`
}

function main(argv) {
  const all = argv.includes('--all')
  const asJSON = argv.includes('--json')
  const cwd = process.cwd()
  const slug = slugFor(cwd)

  const result = run(all ? { all: true } : { slug })
  persist(result)

  if (asJSON) {
    process.stdout.write(
      JSON.stringify(
        {
          lifetime: result.lifetime,
          projects: result.projects,
          unknownModels: result.unknownModels,
        },
        null,
        2
      ) + '\n'
    )
    return
  }

  const out = []
  if (all) {
    const rows = Object.entries(result.projects)
      .filter(([, r]) => r.opus > 0)
      .sort((a, b) => b[1].saved - a[1].saved)

    out.push('claude-swarm — all projects', '')
    if (rows.length === 0) {
      out.push('  No delegated work recorded on this machine yet.')
    } else {
      const width = Math.max(...rows.map(([s]) => s.length))
      for (const [s, r] of rows) {
        out.push(
          `  ${pad(s, width)}  ${padLeft(money(r.actual), 9)} → ${padLeft(money(r.opus), 9)}` +
            `   saved ${padLeft(money(r.saved), 9)}`
        )
      }
      out.push(`  ${'─'.repeat(width + 46)}`)
      out.push(
        `  ${pad('lifetime', width)}  ${padLeft(money(result.lifetime.actual), 9)} → ` +
          `${padLeft(money(result.lifetime.opus), 9)}   saved ` +
          `${padLeft(money(result.lifetime.saved), 9)}` +
          ` (${percent(result.lifetime.saved, result.lifetime.opus)})`
      )
    }
  } else {
    const here = result.projects[slug] || {
      agents: {},
      actual: 0,
      opus: 0,
      saved: 0,
      unknownModels: {},
    }
    out.push(formatProject('this project', here))
    const summary = readJSONSafe(summaryPath())
    if (summary && summary.lifetime && summary.lifetime.saved > 0) {
      out.push('')
      out.push(
        `  Lifetime across all recorded projects: ${money(summary.lifetime.saved)} saved` +
          ` (run with --all to refresh and break down)`
      )
    }
  }

  out.push('')
  out.push(CAVEAT)
  const unknown = formatUnknown(result.unknownModels)
  if (unknown) out.push(unknown)
  process.stdout.write(out.join('\n') + '\n')
}

module.exports = {
  SCHEMA_VERSION,
  ROSTER,
  BASELINE,
  ratesFor,
  normalizeModel,
  splitCacheWrites,
  costOf,
  emptyTokens,
  addTokens,
  parseTranscript,
  projectTranscripts,
  tallyProject,
  slugFor,
  summaryPath,
  cachePath,
  loadCache,
  run,
  persist,
  main,
}

if (require.main === module) main(process.argv.slice(2))
