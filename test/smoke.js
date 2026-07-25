#!/usr/bin/env node
/**
 * claude-swarm smoke test.
 *
 * Validates that the plugin would load — the manifests parse and are
 * well-formed, the SessionStart hook is syntactically valid, the two
 * Workflow scripts compile, and every agent + the skill has usable
 * frontmatter. Pure static checks; nothing here executes plugin code.
 *
 * Run: `node test/smoke.js` (or `npm test`). Exit 0 = green.
 *
 * Note on workflows: survey.js/audit.js use top-level `return`/`await`,
 * which is the shape the Workflow runtime provides (the body runs inside
 * an async function). That is illegal in a standalone ES module, so
 * `node --check` false-fails them. We instead compile each body via the
 * AsyncFunction constructor — which legalizes top-level return/await —
 * to catch real syntax errors without running anything.
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const readJSON = (p) => JSON.parse(read(p))
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

const results = []
let failures = 0
function check(name, fn) {
  try {
    fn()
    results.push(['ok', name])
  } catch (e) {
    failures++
    results.push(['FAIL', `${name} — ${e.message}`])
  }
}

// --- 1. Manifests parse and are well-formed --------------------------------

check('plugin.json is well-formed', () => {
  const m = readJSON('.claude-plugin/plugin.json')
  assert(m.name === 'claude-swarm', 'name must be "claude-swarm"')
  assert(/^\d+\.\d+\.\d+$/.test(m.version || ''), 'version must be semver')
  assert(m.description && m.description.length > 0, 'description required')
})

check('marketplace.json lists the claude-swarm plugin', () => {
  const m = readJSON('.claude-plugin/marketplace.json')
  assert(Array.isArray(m.plugins) && m.plugins.length >= 1, 'plugins[] required')
  const p = m.plugins.find((x) => x.name === 'claude-swarm')
  assert(p, 'must list a plugin named "claude-swarm"')
  assert(p.source === './', 'source must be "./" (this repo is the plugin)')
})

check('hooks.json registers a SessionStart command hook', () => {
  const h = readJSON('hooks/hooks.json')
  const ss = h.hooks && h.hooks.SessionStart
  assert(Array.isArray(ss) && ss.length >= 1, 'SessionStart entry required')
  const cmd = ss[0].hooks && ss[0].hooks[0]
  assert(cmd && cmd.type === 'command', 'hook must be type "command"')
  assert(/session-start\.js/.test(cmd.command), 'hook must invoke session-start.js')
})

// --- 2. Hook script compiles (CommonJS — node --check is correct here) ------

const HOOK = path.join(root, 'hooks/session-start.js')

check('hooks/session-start.js is syntactically valid', () => {
  execFileSync(process.execPath, ['--check', HOOK], { stdio: 'pipe' })
})

// --- 2b. Hook runtime contract: always ships the policy ---------------------

check('hook emits policy JSON and writes nothing (happy path)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'))
  try {
    const out = execFileSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmp, CLAUDE_PLUGIN_ROOT: root },
    })
    const o = JSON.parse(out)
    assert(o.hookSpecificOutput.hookEventName === 'SessionStart', 'SessionStart output required')
    assert(/delegation policy/.test(o.hookSpecificOutput.additionalContext), 'policy must be present')
    // The plugin serves workflows/ natively, so the hook must no longer copy
    // anything into the config dir — nor create the directory to copy into.
    assert(fs.readdirSync(tmp).length === 0, 'hook must not write to the config dir')
    assert(
      !/leftovers from v0\.1\.1/.test(o.hookSpecificOutput.additionalContext),
      'a clean config dir must not trigger the stale-copy notice',
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

check('hook reports pre-0.1.2 leftover workflow copies without deleting them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'))
  try {
    // Simulate an install upgraded from <=0.1.1, which copied these in.
    const wfDir = path.join(tmp, 'workflows')
    fs.mkdirSync(wfDir, { recursive: true })
    fs.writeFileSync(path.join(wfDir, 'survey.js'), '// stale\n')
    const out = execFileSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmp, CLAUDE_PLUGIN_ROOT: root },
    })
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext
    assert(/survey\.js/.test(ctx), 'the leftover must be named in the notice')
    assert(!/audit\.js/.test(ctx), 'an absent leftover must not be reported')
    // Reporting only — the user's file must survive untouched.
    assert(
      fs.readFileSync(path.join(wfDir, 'survey.js'), 'utf8') === '// stale\n',
      'the hook must never modify or delete a file in the config dir',
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

check('hook still ships the policy when config-dir resolution throws', () => {
  // Regression guard for the fix moving os.homedir()/env resolution inside the
  // install try/catch: force homedir() to throw and confirm the hook does not
  // abort the session but still emits the policy.
  const out = execFileSync(
    process.execPath,
    ['-e', "require('os').homedir=()=>{throw new Error('boom')};require(process.argv[1])", HOOK],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: '' } },
  )
  const o = JSON.parse(out)
  assert(
    /delegation policy/.test(o.hookSpecificOutput.additionalContext),
    'policy must ship even when homedir() throws',
  )
})

// --- 3. Workflows compile, and their meta is well-formed -------------------

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Grab the `meta` object literal by brace-matching from its opening `{`.
function extractMetaLiteral(src) {
  const eq = src.indexOf('=', src.indexOf('meta'))
  const open = src.indexOf('{', eq)
  assert(eq !== -1 && open !== -1, 'no meta object literal found')
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1)
  }
  throw new Error('unbalanced braces in meta literal')
}

for (const wf of ['survey.js', 'audit.js']) {
  check(`workflows/${wf} body compiles`, () => {
    const src = read(`workflows/${wf}`)
    assert(/export\s+const\s+meta\s*=/.test(src), 'must begin with `export const meta =`')
    // Strip the ESM export so the file is a legal async-function body, then
    // compile (do not run) it. The runtime globals are passed as params so
    // their references resolve during compilation.
    const body = src.replace(/export\s+const\s+meta/, 'const meta')
    // eslint-disable-next-line no-new
    new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', 'workflow', body)
  })

  check(`workflows/${wf} meta declares name/description/phases`, () => {
    const meta = new Function(`return (${extractMetaLiteral(read(`workflows/${wf}`))})`)()
    assert(meta.name, 'meta.name required')
    assert(meta.description, 'meta.description required')
    assert(Array.isArray(meta.phases) && meta.phases.length >= 1, 'meta.phases[] required')
  })
}

// --- 4. Agents and skill have usable frontmatter ---------------------------

const EXPECTED_AGENTS = ['scout', 'tracer', 'implementer', 'mechanic', 'verifier', 'scribe']

function frontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  assert(m, 'YAML frontmatter block required')
  return m[1]
}

for (const a of EXPECTED_AGENTS) {
  check(`agents/${a}.md has valid frontmatter`, () => {
    const front = frontmatter(read(`agents/${a}.md`))
    assert(new RegExp(`name:\\s*${a}\\b`).test(front), `name: ${a} required`)
    assert(/description:\s*\S/.test(front), 'description required')
    assert(/model:\s*\S/.test(front), 'model required')
  })
}

check('skills/claude-swarm/SKILL.md has valid frontmatter', () => {
  const front = frontmatter(read('skills/claude-swarm/SKILL.md'))
  assert(/name:\s*claude-swarm\b/.test(front), 'name: claude-swarm required')
  assert(/description:\s*\S/.test(front), 'description required')
})

// --- 5. Savings tally ------------------------------------------------------

const TALLY = path.join(root, 'lib/tally.js')

check('lib/tally.js is syntactically valid', () => {
  execFileSync(process.execPath, ['--check', TALLY], { stdio: 'pipe' })
})

const tally = require('../lib/tally.js')

/** One assistant line as Claude Code writes it. */
function entry({ agent, model, id, ts, usage }) {
  return (
    JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      attributionAgent: agent,
      timestamp: ts || '2026-07-01T00:00:00.000Z',
      uuid: `${id}-${Math.random()}`,
      message: { id, model, role: 'assistant', usage },
    }) + '\n'
  )
}

/** Build <dir>/<session>/subagents/agent-<n>.jsonl from groups of lines. */
function fixtureProject(transcripts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tally-'))
  const sub = path.join(dir, 'sesn-1', 'subagents')
  fs.mkdirSync(sub, { recursive: true })
  transcripts.forEach((lines, i) => {
    fs.writeFileSync(path.join(sub, `agent-${i}.jsonl`), lines.join(''))
  })
  return dir
}

function freshCache() {
  return { schemaVersion: tally.SCHEMA_VERSION, files: {} }
}

check('tally dedups the cumulative entries that share one message.id', () => {
  // Claude Code splits an assistant turn across content blocks, repeating the
  // message.id with cumulative usage. Summing the rows would roughly double
  // every figure, so this is the check that protects the headline number.
  const lines = [5, 5, 5, 268].map((out) =>
    entry({
      agent: 'tracer',
      model: 'claude-sonnet-5',
      id: 'msg_same',
      usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0 },
    }),
  )
  const dir = fixtureProject([lines])
  try {
    const r = tally.tallyProject(dir, freshCache())
    assert(r.agents.tracer, 'tracer must be counted')
    assert(r.agents.tracer.tokens.turns === 1, `expected 1 turn, got ${r.agents.tracer.tokens.turns}`)
    assert(
      r.agents.tracer.tokens.output === 268,
      `expected 268 output tokens (the final cumulative value), got ${r.agents.tracer.tokens.output}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('Sonnet 5 introductory pricing lapses after 2026-08-31', () => {
  const intro = tally.ratesFor('claude-sonnet-5', '2026-08')
  const standard = tally.ratesFor('claude-sonnet-5', '2026-09')
  assert(intro.input === 2 && intro.output === 10, 'August 2026 must bill at the $2/$10 intro rate')
  assert(standard.input === 3 && standard.output === 15, 'September 2026 must bill at $3/$15')
})

check('model ids resolve to the right tier and rates', () => {
  assert(tally.ratesFor('claude-haiku-4-5-20251001', '2026-07').input === 1, 'haiku input is $1')
  assert(tally.ratesFor('claude-opus-5', '2026-07').output === 25, 'opus output is $25')
  // The context-window marker appears in config but not in transcripts; strip it anyway.
  assert(tally.ratesFor('claude-opus-5[1m]', '2026-07').output === 25, 'the [1m] suffix must be stripped')
  assert(tally.ratesFor('claude-fable-5', '2026-07').input === 10, 'fable input is $10')
  assert(tally.ratesFor('claude-invented-9', '2026-07') === null, 'an unknown model has no rates')
})

check('cache reads and both cache-write TTLs price correctly', () => {
  const rates = { input: 4, output: 0 }
  const t = tally.emptyTokens()
  t.cacheRead = 1e6
  assert(Math.abs(tally.costOf(t, rates) - 0.4) < 1e-9, 'cache reads bill at 0.1x input')

  const w5 = tally.emptyTokens()
  w5.write5m = 1e6
  assert(Math.abs(tally.costOf(w5, rates) - 5) < 1e-9, '5-minute cache writes bill at 1.25x input')

  const w1 = tally.emptyTokens()
  w1.write1h = 1e6
  assert(Math.abs(tally.costOf(w1, rates) - 8) < 1e-9, '1-hour cache writes bill at 2x input')
})

check('cache-write TTLs are split when broken out, and default to 5m when not', () => {
  const split = tally.splitCacheWrites({
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
  })
  assert(split.write5m === 100 && split.write1h === 200, 'the broken-out split must win')

  const flat = tally.splitCacheWrites({ cache_creation_input_tokens: 300 })
  assert(flat.write5m === 300 && flat.write1h === 0, 'a flat total is treated as 5-minute')
})

check('only cheaper-tier roster agents are counted', () => {
  const lines = [
    // Counted: roster, below Opus. Both the bare and plugin-qualified spellings.
    entry({ agent: 'scout', model: 'claude-haiku-4-5-20251001', id: 'a', usage: { output_tokens: 10 } }),
    entry({ agent: 'claude-swarm:verifier', model: 'claude-sonnet-5', id: 'b', usage: { output_tokens: 10 } }),
    // Not counted: runs on Opus by design, so there is no tier delta.
    entry({ agent: 'implementer', model: 'claude-opus-5', id: 'c', usage: { output_tokens: 10 } }),
    // Not counted: not part of this plugin's roster.
    entry({ agent: 'Explore', model: 'claude-sonnet-5', id: 'd', usage: { output_tokens: 10 } }),
    entry({ agent: 'general-purpose', model: 'claude-sonnet-5', id: 'e', usage: { output_tokens: 10 } }),
  ]
  const dir = fixtureProject([lines])
  try {
    const r = tally.tallyProject(dir, freshCache())
    const counted = Object.keys(r.agents).sort()
    assert(
      counted.join(',') === 'scout,verifier',
      `expected only scout and verifier, got: ${counted.join(',') || '(none)'}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('an unpriced model is reported rather than silently dropped', () => {
  const lines = [
    entry({ agent: 'tracer', model: 'claude-from-the-future-7', id: 'x', usage: { output_tokens: 999 } }),
  ]
  const dir = fixtureProject([lines])
  try {
    const r = tally.tallyProject(dir, freshCache())
    assert(r.unknownModels['claude-from-the-future-7'] === 1, 'the unknown model must be reported')
    assert(r.actual === 0 && r.opus === 0, 'an unpriced turn must not be guessed at')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('end-to-end tally produces the expected dollar figures', () => {
  // 1M output tokens on haiku ($5/MTok out) against Opus ($25/MTok out),
  // plus 1M cache-read tokens (haiku 0.1x$1 = $0.10; opus 0.1x$5 = $0.50).
  const lines = [
    entry({
      agent: 'scout',
      model: 'claude-haiku-4-5-20251001',
      id: 'only',
      usage: { input_tokens: 0, output_tokens: 1e6, cache_read_input_tokens: 1e6 },
    }),
  ]
  const dir = fixtureProject([lines])
  try {
    const r = tally.tallyProject(dir, freshCache())
    assert(Math.abs(r.actual - 5.1) < 1e-6, `expected $5.10 actual, got ${r.actual}`)
    assert(Math.abs(r.opus - 25.5) < 1e-6, `expected $25.50 on Opus, got ${r.opus}`)
    assert(Math.abs(r.saved - 20.4) < 1e-6, `expected $20.40 saved, got ${r.saved}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('workflow-spawned transcripts nested under subagents/workflows are found', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tally-'))
  try {
    const deep = path.join(dir, 'sesn-1', 'subagents', 'workflows', 'wf_abc123')
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(
      path.join(deep, 'agent-deep.jsonl'),
      entry({ agent: 'verifier', model: 'claude-sonnet-5', id: 'deep', usage: { output_tokens: 100 } }),
    )
    const found = tally.projectTranscripts(dir)
    assert(found.length === 1, `expected 1 nested transcript, found ${found.length}`)
    const r = tally.tallyProject(dir, freshCache())
    assert(r.agents.verifier, 'a Workflow-spawned agent must be counted')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('the per-file cache is reused when a transcript looks unchanged', () => {
  // Prove the cache is actually consulted rather than merely populated: swap
  // the file contents for a different figure while holding size and mtime
  // fixed, and a cached pass must still report the ORIGINAL number. A fresh
  // cache over the same bytes must report the new one — which is what shows
  // the rewrite was real and the first assertion wasn't vacuous.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tally-'))
  try {
    const sub = path.join(dir, 'sesn-1', 'subagents')
    fs.mkdirSync(sub, { recursive: true })
    const file = path.join(sub, 'agent-0.jsonl')

    const line = (out) =>
      JSON.stringify({
        type: 'assistant',
        attributionAgent: 'scout',
        timestamp: '2026-07-01T00:00:00.000Z',
        uuid: 'fixed-uuid',
        message: {
          id: 'q',
          model: 'claude-haiku-4-5-20251001',
          role: 'assistant',
          usage: { output_tokens: out },
        },
      }) + '\n'

    const before = line(10)
    const after = line(99) // same byte length: 10 and 99 are both two digits
    assert(before.length === after.length, 'the fixture rewrite must not change the file size')

    fs.writeFileSync(file, before)
    const cache = freshCache()
    const first = tally.tallyProject(dir, cache)
    assert(Object.keys(cache.files).length === 1, 'the file must be recorded in the cache')

    // Rewrite the contents, then point the cache's watermark at the new stat
    // while leaving the previously-parsed buckets in place. Restoring mtime on
    // disk instead would be flakier — utimes does not round-trip the
    // sub-millisecond precision statSync reports.
    fs.writeFileSync(file, after)
    const st = fs.statSync(file)
    cache.files[file].size = st.size
    cache.files[file].mtimeMs = st.mtimeMs

    const cached = tally.tallyProject(dir, cache)
    assert(
      cached.agents.scout.tokens.output === first.agents.scout.tokens.output,
      'an unchanged size+mtime must serve the cached result, not re-read the file',
    )

    const reread = tally.tallyProject(dir, freshCache())
    assert(
      reread.agents.scout.tokens.output === 99,
      'a fresh cache must see the new contents — otherwise the check above proves nothing',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('benchmark scratch directories are excluded from the lifetime sweep', () => {
  // evals/run.js spawns real roster agents in temp working dirs. Counting those
  // would mean the benchmark inflates the savings figure it was built to check.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = tmp
    const projects = path.join(tmp, 'projects')
    fs.mkdirSync(path.join(projects, '-tmp-cs-bench-abc123'), { recursive: true })
    fs.mkdirSync(path.join(projects, '-home-user-real-project'), { recursive: true })

    const result = tally.run({ all: true })
    const slugs = Object.keys(result.projects)
    assert(slugs.includes('-home-user-real-project'), 'a real project must be swept')
    assert(
      !slugs.some((s) => s.startsWith('-tmp-cs-bench-')),
      `benchmark scratch must be skipped, got: ${slugs.join(', ')}`,
    )
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

check('the summary omits projects that never used the swarm', () => {
  // The hook parses this file on every session start, and most projects on a
  // machine have no swarm usage at all. A row of zeroes each would be pure bloat.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = tmp
    tally.persist({
      cache: freshCache(),
      projects: {
        'used-it': { actual: 1, opus: 5, saved: 4 },
        'never-used-it': { actual: 0, opus: 0, saved: 0 },
      },
    })
    const summary = JSON.parse(fs.readFileSync(path.join(tmp, 'claude-swarm', 'usage.json'), 'utf8'))
    assert(summary.projects['used-it'], 'a project with savings must be recorded')
    assert(!('never-used-it' in summary.projects), 'a project with no delegated work must be omitted')
    assert(summary.lifetime.saved === 4, `lifetime must sum the kept rows, got ${summary.lifetime.saved}`)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// --- 5b. Hook surfaces the savings line without losing its contract ---------

function writeSummary(configDir, projects, lifetime) {
  fs.mkdirSync(path.join(configDir, 'claude-swarm'), { recursive: true })
  fs.writeFileSync(
    path.join(configDir, 'claude-swarm', 'usage.json'),
    JSON.stringify({
      schemaVersion: tally.SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      lifetime,
      projects,
    }),
  )
}

function runHook(configDir) {
  return JSON.parse(
    execFileSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_PLUGIN_ROOT: root },
    }),
  ).hookSpecificOutput.additionalContext
}

check('hook reports savings when the summary file has them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'))
  try {
    writeSummary(
      tmp,
      { [tally.slugFor(root)]: { actual: 10, opus: 50, saved: 40 } },
      { actual: 20, opus: 120, saved: 100 },
    )
    const ctx = runHook(tmp)
    assert(/\$40\.00 saved in this project/.test(ctx), 'the project figure must appear')
    assert(/\$100\.00 lifetime/.test(ctx), 'the lifetime figure must appear when it differs')
    assert(/Upper bound/.test(ctx), 'the caveat must travel with the figure')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

check('hook omits the lifetime figure when it would just repeat the project one', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'))
  try {
    writeSummary(
      tmp,
      { [tally.slugFor(root)]: { actual: 10, opus: 50, saved: 40 } },
      { actual: 10, opus: 50, saved: 40 },
    )
    const ctx = runHook(tmp)
    assert(/\$40\.00 saved in this project/.test(ctx), 'the project figure must appear')
    assert(!/lifetime/.test(ctx), 'an identical lifetime figure must not be repeated')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

check('hook still ships the policy when the savings summary is corrupt', () => {
  // The hook's contract is that nothing it reads can break a session. A
  // half-written summary file must degrade to no savings line, not to a crash.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'))
  try {
    fs.mkdirSync(path.join(tmp, 'claude-swarm'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'claude-swarm', 'usage.json'), '{"schemaVersion":1,"projects":')
    const ctx = runHook(tmp)
    assert(/delegation policy/.test(ctx), 'the policy must still ship')
    assert(!/saved in this project/.test(ctx), 'a corrupt summary must not produce a figure')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// --- 6. Commands ------------------------------------------------------------

check('commands/savings.md has valid frontmatter', () => {
  const src = read('commands/savings.md')
  const front = frontmatter(src)
  assert(/name:\s*savings\b/.test(front), 'name: savings required')
  assert(/description:\s*\S/.test(front), 'description required')
  assert(/allowed-tools:\s*\S/.test(front), 'allowed-tools required to run the tally')
  assert(/CLAUDE_PLUGIN_ROOT/.test(src), 'must invoke the tally via CLAUDE_PLUGIN_ROOT')
  assert(/lib\/tally\.js/.test(src), 'must invoke lib/tally.js')
})

// --- Report ----------------------------------------------------------------

for (const [status, name] of results) {
  console.log(`${status === 'ok' ? '  ok  ' : ' FAIL '}${name}`)
}
console.log(`\n${results.length - failures}/${results.length} checks passed`)
process.exit(failures ? 1 : 0)
