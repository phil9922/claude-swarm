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

// Async checks must be awaited before the report runs, or a rejected assertion
// would be an unhandled rejection and the check would silently "pass".
const pending = []
function checkAsync(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(
        () => results.push(['ok', name]),
        (e) => {
          failures++
          results.push(['FAIL', `${name} — ${e.message}`])
        },
      ),
  )
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

// --- 3b. audit.js verification logic actually runs -------------------------

/**
 * Execute a workflow body with stubbed runtime globals.
 *
 * The checks above only compile the workflows. That leaves the part most worth
 * guarding — whether a finding is confirmed or refuted — untested. Running the
 * body against canned agent responses exercises the real control flow.
 */
async function runWorkflow(file, { args, onAgent }) {
  const src = read(`workflows/${file}`).replace(/export\s+const\s+meta/, 'const meta')
  const body = new AsyncFunction(
    'args', 'agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', 'workflow', src,
  )
  const parallel = (thunks) =>
    Promise.all(thunks.map((t) => Promise.resolve().then(() => t()).catch(() => null)))
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item, i) => {
        let value = item
        for (const stage of stages) value = await stage(value, item, i)
        return value
      }),
    )
  return body(args, onAgent, parallel, pipeline, () => {}, () => {},
    { total: null, spent: () => 0, remaining: () => Infinity }, () => {})
}

checkAsync('audit confirms survivors and refutes the rest, unchanged by batching', async () => {
  // Two findings: index 0 survives every skeptic, index 1 is refuted by the
  // first. VOTES defaults to 2, so confirmation needs 2 of 3.
  const counts = { verify: 0 }
  const out = await runWorkflow('audit.js', {
    args: { target: 't', lenses: [{ key: 'only', lens: 'L' }] },
    onAgent: async (prompt, opts) => {
      if (opts.phase === 'Find') {
        return {
          findings: [
            { title: 'real', file: 'a.js:1', claim: 'c', failure: 'f' },
            { title: 'bogus', file: 'a.js:2', claim: 'c', failure: 'f' },
          ],
        }
      }
      counts.verify++
      const n = (prompt.match(/^\[\d+\]/gm) || []).length
      return {
        verdicts: Array.from({ length: n }, (_, i) => ({
          index: i, refuted: n > 1 && i === 1, reason: 'because', tested: true,
        })),
      }
    },
  })
  assert(out.confirmed.length === 1, `expected 1 confirmed, got ${out.confirmed.length}`)
  assert(out.confirmed[0].title === 'real', `wrong finding confirmed: ${out.confirmed[0].title}`)
  assert(out.refutedCount === 1, `expected 1 refuted, got ${out.refutedCount}`)
  // Wave 1 over the batch + 2 escalation waves over the lone survivor = 3.
  // One spawn per finding per skeptic would have been 6.
  assert(counts.verify === 3, `expected 3 verifier calls, got ${counts.verify}`)
})

checkAsync('audit escalates only survivors, so a refuted finding costs one pass', async () => {
  const counts = { verify: 0 }
  const out = await runWorkflow('audit.js', {
    args: { target: 't', lenses: [{ key: 'only', lens: 'L' }] },
    onAgent: async (prompt, opts) => {
      if (opts.phase === 'Find') {
        return { findings: [{ title: 'bogus', file: 'a.js:1', claim: 'c', failure: 'f' }] }
      }
      counts.verify++
      return { verdicts: [{ index: 0, refuted: true, reason: 'no', tested: false }] }
    },
  })
  assert(out.confirmed.length === 0, 'a refuted finding must not be confirmed')
  assert(counts.verify === 1, `escalation must be skipped; expected 1 call, got ${counts.verify}`)
})

checkAsync('audit still buckets a finding as unverified when its skeptics fail', async () => {
  // A verifier that failed to run must never be scored as a refutation.
  const out = await runWorkflow('audit.js', {
    args: { target: 't', lenses: [{ key: 'only', lens: 'L' }] },
    onAgent: async (prompt, opts) =>
      opts.phase === 'Find'
        ? { findings: [{ title: 'orphan', file: 'a.js:1', claim: 'c', failure: 'f' }] }
        : null,
  })
  assert(out.unverified.length === 1, `expected 1 unverified, got ${out.unverified.length}`)
  assert(out.refutedCount === 0, 'a failed skeptic must not count as a refutation')
  assert(out.confirmed.length === 0, 'a failed skeptic must not confirm either')
})

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

// --- Report ----------------------------------------------------------------

Promise.all(pending).then(() => {
  for (const [status, name] of results) {
    console.log(`${status === 'ok' ? '  ok  ' : ' FAIL '}${name}`)
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  process.exit(failures ? 1 : 0)
})
