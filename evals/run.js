#!/usr/bin/env node
/**
 * claude-swarm benchmark runner.
 *
 * Runs each case under three arms and records what each actually cost:
 *
 *   with     plugin enabled — the status quo
 *   without  plugin disabled — stock Claude Code, which still has its own
 *            Explore/general-purpose subagents
 *   solo     plugin disabled AND the Task tool denied, so one Opus context does
 *            everything. This is the arm the savings counter implicitly assumes.
 *
 * Arms differ ONLY in the settings file and whether Task is denied. Same model,
 * same effort, same allowed tools, same prompt, same working directory.
 *
 * Cost comes from Claude Code's own `total_cost_usd`, which is a process-global
 * accumulator that subagent calls feed into — so it covers Task-tool spend, not
 * just the main loop. We do not compute it ourselves (though lib/tally.js
 * reproduces it to the cent, which is how that pricing table was validated).
 *
 * Two things this runner is careful about:
 *
 *   1. Budget. Every run spends real money, so cumulative cost is checked before
 *      each run and the suite stops rather than starting one that could breach
 *      the ceiling.
 *   2. Contamination. Runs execute in a throwaway working directory with
 *      --add-dir granting access to the repo, so their subagent transcripts land
 *      under a scratch project slug instead of inflating this project's
 *      /claude-swarm:savings totals — the very number the benchmark exists to check.
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO = path.resolve(__dirname, '..')
const CASES_DIR = path.join(__dirname, 'cases')
const ARMS_DIR = path.join(__dirname, 'arms')

// Read-only tool set, identical across arms. Bash is deliberately excluded: the
// tasks are read-only reviews, and letting agents shell out would both risk
// mutating the repo and make the arms harder to compare.
//
// The delegation tools are `Task` (spawns a subagent) and `Workflow` (runs an
// orchestration script). These names are taken from the runtime's own
// system/init event, which is the only authority — the docs and the interactive
// tool surface disagree with each other on this, and naming a tool that does not
// exist fails SILENTLY. Get it wrong and the swarm arm can never spawn anything,
// leaving all three arms secretly identical and the benchmark measuring nothing.
// preflight() below asserts these names against a live run before spending
// anything, precisely so that failure mode cannot recur.
const BASE_TOOLS = ['Read', 'Glob', 'Grep']
const DELEGATION_TOOLS = ['Task', 'Workflow']

const ARMS = [
  { name: 'with', settings: 'with.json', delegate: true },
  { name: 'without', settings: 'without.json', delegate: true },
  { name: 'solo', settings: 'without.json', delegate: false },
]

function parseArgs(argv) {
  const opts = { runs: 3, maxCost: 15, caseFilter: null, arms: null, grade: false, model: 'opus', effort: 'high' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--runs') opts.runs = Number(argv[++i])
    else if (a === '--max-cost') opts.maxCost = Number(argv[++i])
    else if (a === '--case') opts.caseFilter = argv[++i]
    else if (a === '--arms') opts.arms = argv[++i].split(',')
    else if (a === '--grade') opts.grade = true
    else if (a === '--model') opts.model = argv[++i]
    else if (a === '--effort') opts.effort = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log('usage: node evals/run.js [--runs N] [--max-cost USD] [--case substr] [--arms with,without,solo] [--grade]')
      process.exit(0)
    }
  }
  return opts
}

function loadCases(filter) {
  return fs
    .readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(CASES_DIR, e.name)
      return {
        ...JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')),
        dir,
        prompt: fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8'),
        grader: fs.readFileSync(path.join(dir, 'grader.md'), 'utf8'),
      }
    })
    .filter((c) => !filter || c.name.includes(filter))
}

/** Claude Code's project-directory slug for a working directory. */
function slugFor(dir) {
  return dir.replace(/[/.]/g, '-')
}

/**
 * How many subagents a session spawned.
 *
 * A `with` run that spawned none is not a swarm run — enabling the plugin does
 * not force fan-out — and averaging it into the swarm arm would silently
 * understate the effect. Counted from the transcript tree rather than inferred.
 */
function countSpawns(workdir, sessionId) {
  const sessionDir = path.join(
    os.homedir(),
    '.claude',
    'projects',
    slugFor(workdir),
    sessionId,
    'subagents'
  )
  let n = 0
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name))
      else if (/^agent-.*\.jsonl$/.test(e.name)) n++
    }
  }
  walk(sessionDir)
  return n
}

/** Which agent types a session used, for reporting what the swarm actually did. */
function spawnedAgents(workdir, sessionId) {
  const base = path.join(os.homedir(), '.claude', 'projects', slugFor(workdir), sessionId, 'subagents')
  const found = new Map()
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/^agent-.*\.meta\.json$/.test(e.name)) {
        try {
          const t = JSON.parse(fs.readFileSync(p, 'utf8')).agentType || '?'
          found.set(t, (found.get(t) || 0) + 1)
        } catch (_) {
          /* ignore */
        }
      }
    }
  }
  walk(base)
  return Object.fromEntries(found)
}

function runOnce({ testCase, arm, workdir, opts }) {
  const tools = arm.delegate ? [...BASE_TOOLS, ...DELEGATION_TOOLS] : BASE_TOOLS
  const args = [
    '-p',
    testCase.prompt,
    '--output-format',
    'json',
    '--model',
    opts.model,
    '--effort',
    opts.effort,
    '--settings',
    path.join(ARMS_DIR, arm.settings),
    '--add-dir',
    REPO,
    '--allowedTools',
    ...tools,
    '--max-turns',
    String(testCase.maxTurns || 40),
  ]
  // Belt and braces: the allowlist above already omits them, but a bare tool
  // name in --disallowedTools removes the tool from Claude's context entirely.
  if (!arm.delegate) args.push('--disallowedTools', ...DELEGATION_TOOLS)

  const started = Date.now()
  const res = spawnSync('claude', args, {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: (testCase.timeoutSeconds || 900) * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Without this the user's global CLAUDE.md loads into every arm — and on a
    // machine where claude-swarm is in use, that file typically carries its own
    // copy of the delegation policy and roster. The no-plugin arms would then be
    // told to delegate to agents that do not exist, which is both a wasted turn
    // and a confound: "without the plugin" would still have the plugin's
    // guidance. Claude Code's own eval sandbox sets this for the same reason.
    // The `with` arm still receives the policy through the plugin's SessionStart
    // hook, which is the mechanism actually under test.
    env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
  })

  if (res.error) return { ok: false, error: String(res.error), wall: Date.now() - started }

  let parsed
  try {
    parsed = JSON.parse(res.stdout)
  } catch (_) {
    return {
      ok: false,
      error: `unparseable output: ${(res.stdout || res.stderr || '').slice(0, 300)}`,
      wall: Date.now() - started,
    }
  }

  const spawns = countSpawns(workdir, parsed.session_id)
  return {
    ok: !parsed.is_error,
    subtype: parsed.subtype,
    cost: parsed.total_cost_usd,
    durationMs: parsed.duration_ms,
    turns: parsed.num_turns,
    sessionId: parsed.session_id,
    output: parsed.result || '',
    usage: parsed.usage,
    modelUsage: parsed.modelUsage,
    spawns,
    agents: spawns ? spawnedAgents(workdir, parsed.session_id) : {},
    wall: Date.now() - started,
  }
}

/** Cheap LLM grading of an answer against the case rubric. */
function grade(testCase, output, workdir) {
  if (!output.trim()) return { score: 0, reasoning: 'empty output' }
  const prompt = `${testCase.grader}\n\n---\n\nHere is the answer to grade:\n\n${output}`
  const res = spawnSync(
    'claude',
    [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--model',
      'haiku',
      '--settings',
      path.join(ARMS_DIR, 'without.json'),
      '--allowedTools',
      'Read',
      '--max-turns',
      '3',
    ],
    {
      cwd: workdir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
    }
  )
  try {
    const outer = JSON.parse(res.stdout)
    const m = /\{[\s\S]*\}/.exec(outer.result || '')
    const verdict = m ? JSON.parse(m[0]) : { score: null }
    return { ...verdict, graderCost: outer.total_cost_usd || 0 }
  } catch (_) {
    return { score: null, reasoning: 'grader output unparseable', graderCost: 0 }
  }
}

/**
 * Cheap sanity check before spending the budget.
 *
 * Asks each arm's configuration for its system/init event, which reports the
 * tools, agents and plugins actually loaded. Verifies that the arms differ in
 * the way we think they do:
 *
 *   - the delegation tool really exists under the name we pass,
 *   - the plugin is loaded in `with` and absent in `without`/`solo`,
 *   - the roster agents are actually offered in `with`.
 *
 * Every one of these has already failed silently once during development. A run
 * that produces plausible numbers from a broken configuration is worse than a
 * run that refuses to start.
 */
function preflight(arms, workdir) {
  console.log('preflight:')
  let ok = true
  for (const arm of arms) {
    const res = spawnSync(
      'claude',
      [
        '-p',
        'hi',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        'haiku',
        '--settings',
        path.join(ARMS_DIR, arm.settings),
        '--max-turns',
        '1',
      ],
      {
        cwd: workdir,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 180000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
      }
    )

    let init = null
    for (const line of (res.stdout || '').split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (o.type === 'system' && o.subtype === 'init') {
          init = o
          break
        }
      } catch (_) {
        /* keep looking */
      }
    }
    if (!init) {
      console.log(`  ${arm.name.padEnd(9)} FAILED — no init event; cannot verify configuration`)
      ok = false
      continue
    }

    const tools = init.tools || []
    const agents = init.agents || []
    const plugins = (init.plugins || []).map((p) => p.name)
    const hasPlugin = plugins.includes('claude-swarm')
    const hasRoster = agents.some((a) => a.startsWith('claude-swarm:'))
    const missingTools = DELEGATION_TOOLS.filter((t) => !tools.includes(t))

    const problems = []
    if (missingTools.length) problems.push(`delegation tool(s) not in runtime tool list: ${missingTools.join(', ')}`)
    if (arm.name === 'with' && !hasPlugin) problems.push('plugin NOT loaded in the with arm')
    if (arm.name === 'with' && !hasRoster) problems.push('roster agents not offered in the with arm')
    if (arm.name !== 'with' && hasPlugin) problems.push('plugin IS loaded in a no-plugin arm')

    if (problems.length) ok = false
    console.log(
      `  ${arm.name.padEnd(9)} plugin=${hasPlugin ? 'yes' : 'no '}  roster=${hasRoster ? 'yes' : 'no '}  ` +
        `delegation=${missingTools.length ? 'MISSING' : 'ok'}  ${problems.length ? '✗ ' + problems.join('; ') : '✓'}`
    )
  }
  console.log()
  return ok
}

/**
 * How an arm reads in a results table: whether claude-swarm was enabled, and —
 * for the arm where it matters — that delegation itself was denied. `without`
 * and `solo` are both plugin-disabled, so "disabled" alone understates the
 * difference between them.
 */
function armPluginState(arm) {
  if (arm.name === 'with') return 'enabled'
  return arm.delegate ? 'disabled' : 'disabled, no delegation'
}

/** Why each arm exists, so a results table can be read without the README. */
const ARM_QUESTION = {
  with: 'status quo',
  without: 'vs stock Claude Code',
  solo: 'the savings assumption',
}

function money(n) {
  return '$' + Number(n).toFixed(4)
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const arms = opts.arms ? ARMS.filter((a) => opts.arms.includes(a.name)) : ARMS
  const cases = loadCases(opts.caseFilter)
  if (cases.length === 0) {
    console.error('no cases matched')
    process.exit(1)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(__dirname, 'results', stamp)
  fs.mkdirSync(outDir, { recursive: true })

  // Runs execute here, NOT in the repo, so their transcripts do not pollute this
  // project's savings tally. --add-dir still grants read access to the repo.
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bench-'))

  console.log(`claude-swarm benchmark`)
  console.log(`  cases:    ${cases.map((c) => c.name).join(', ')}`)
  console.log(`  arms:     ${arms.map((a) => a.name).join(', ')}`)
  console.log(`  runs:     ${opts.runs} per arm`)
  console.log(`  model:    ${opts.model} (effort ${opts.effort})`)
  console.log(`  ceiling:  $${opts.maxCost}`)
  console.log(`  workdir:  ${workdir}`)
  console.log(`  results:  ${outDir}\n`)

  if (!preflight(arms, workdir)) {
    console.error('preflight failed — refusing to spend the budget on a configuration that is not what it claims.')
    console.error('Re-run with --skip-preflight only if you understand why a check failed.')
    if (!process.argv.includes('--skip-preflight')) process.exit(1)
  }

  const records = []
  let spent = 0
  let stoppedEarly = null

  // Worst observed single run so far, used to decide whether the NEXT run could
  // breach the ceiling. Seeded low; grows as we learn what runs actually cost.
  let worstRun = 0.05

  // Run index is the OUTERMOST loop so that a budget stop leaves every arm with
  // the same number of completed runs. Iterating case-then-arm-then-run instead
  // would spend the whole ceiling on the first arm and leave later arms with
  // nothing to compare against — a partial run that can still be read is worth
  // far more than a complete first arm.
  outer: for (let i = 1; i <= opts.runs; i++) {
    for (const testCase of cases) {
      for (const arm of arms) {
        if (spent + worstRun > opts.maxCost) {
          stoppedEarly = `would exceed $${opts.maxCost} (spent ${money(spent)}, worst run so far ${money(worstRun)})`
          break outer
        }
        process.stdout.write(`  ${testCase.name} / ${arm.name} / run ${i}… `)
        const r = runOnce({ testCase, arm, workdir, opts })
        if (!r.ok) {
          console.log(`FAILED (${r.subtype || r.error})`)
          records.push({ case: testCase.name, arm: arm.name, run: i, ok: false, error: r.error || r.subtype })
          continue
        }
        spent += r.cost
        worstRun = Math.max(worstRun, r.cost)

        let graded = null
        if (opts.grade) {
          graded = grade(testCase, r.output, workdir)
          if (graded.graderCost) spent += graded.graderCost
        }

        console.log(
          `${money(r.cost)}  ${(r.durationMs / 1000).toFixed(1)}s  ${r.turns} turns  ` +
            `${r.spawns} spawns${graded && graded.score != null ? `  score ${graded.score}` : ''}`
        )

        records.push({
          case: testCase.name,
          arm: arm.name,
          run: i,
          ok: true,
          cost: r.cost,
          durationMs: r.durationMs,
          turns: r.turns,
          spawns: r.spawns,
          agents: r.agents,
          sessionId: r.sessionId,
          grade: graded,
          usage: r.usage,
          modelUsage: r.modelUsage,
        })
        fs.writeFileSync(
          path.join(outDir, `${testCase.name}--${arm.name}--${i}.txt`),
          r.output
        )
      }
    }
  }

  const summary = summarize(cases, arms, records)
  fs.writeFileSync(
    path.join(outDir, 'results.json'),
    JSON.stringify({ opts, spent, stoppedEarly, records, summary }, null, 2) + '\n'
  )

  report(cases, arms, records, spent, stoppedEarly, outDir)
}

function summarize(cases, arms, records) {
  const out = {}
  for (const c of cases) {
    out[c.name] = { expect: c.expect, arms: {} }
    for (const a of arms) {
      const rs = records.filter((r) => r.ok && r.case === c.name && r.arm === a.name)
      if (rs.length === 0) continue
      const costs = rs.map((r) => r.cost)
      out[c.name].arms[a.name] = {
        runs: rs.length,
        meanCost: mean(costs),
        minCost: Math.min(...costs),
        maxCost: Math.max(...costs),
        meanDurationS: mean(rs.map((r) => r.durationMs)) / 1000,
        meanTurns: mean(rs.map((r) => r.turns)),
        meanSpawns: mean(rs.map((r) => r.spawns)),
        zeroSpawnRuns: rs.filter((r) => r.spawns === 0).length,
        meanScore: rs.some((r) => r.grade && r.grade.score != null)
          ? mean(rs.filter((r) => r.grade && r.grade.score != null).map((r) => r.grade.score))
          : null,
      }
    }
  }
  return out
}

function report(cases, arms, records, spent, stoppedEarly, outDir) {
  console.log('\n' + '='.repeat(76))
  const summary = summarize(cases, arms, records)

  for (const c of cases) {
    const s = summary[c.name]
    if (!s || Object.keys(s.arms).length === 0) continue
    console.log(`\n${c.name}   (expected: ${c.expect})\n`)
    console.log(
      '  arm       claude-swarm             answers                  runs   mean cost      range            time   turns  spawns  score'
    )
    for (const a of arms) {
      const m = s.arms[a.name]
      if (!m) continue
      // Spell out what each arm switched off and why it exists. "without" and
      // "solo" are both plugin-disabled and differ only in whether Claude Code's
      // own built-in subagents stayed reachable — which the arm name alone hides.
      const pluginState = armPluginState(a)
      const answers = ARM_QUESTION[a.name] || ''
      console.log(
        `  ${a.name.padEnd(9)} ${pluginState.padEnd(24)} ${answers.padEnd(24)} ${String(m.runs).padStart(4)}   ${money(m.meanCost).padStart(9)}  ` +
          `${(money(m.minCost) + '–' + money(m.maxCost)).padStart(19)}  ` +
          `${m.meanDurationS.toFixed(0).padStart(4)}s  ${m.meanTurns.toFixed(1).padStart(5)}  ` +
          `${m.meanSpawns.toFixed(1).padStart(6)}  ${m.meanScore == null ? '  —' : m.meanScore.toFixed(2)}`
      )
      if (a.name === 'with' && m.zeroSpawnRuns > 0) {
        console.log(
          `            ⚠  ${m.zeroSpawnRuns}/${m.runs} run(s) spawned nothing — not swarm runs, treat the mean with suspicion`
        )
      }
    }

    const withArm = s.arms.with
    const soloArm = s.arms.solo
    if (withArm && soloArm) {
      const ratio = soloArm.meanCost / withArm.meanCost
      const verdict =
        ratio > 1 ? `solo cost ${ratio.toFixed(2)}x the swarm` : `the swarm cost ${(1 / ratio).toFixed(2)}x solo`
      console.log(`\n  → ${verdict}`)
    }
  }

  console.log('\n' + '='.repeat(76))
  console.log(`\nTotal spent: ${money(spent)}`)
  if (stoppedEarly) console.log(`STOPPED EARLY: ${stoppedEarly}`)
  console.log(`Results: ${outDir}\n`)
}

if (require.main === module) main()

module.exports = { slugFor, countSpawns, summarize }
