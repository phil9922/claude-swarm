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
const { execFileSync, spawnSync } = require('child_process')

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

check('hooks.json registers a SubagentStop feed hook with no matcher', () => {
  const h = readJSON('hooks/hooks.json')
  const ss = h.hooks && h.hooks.SubagentStop
  assert(Array.isArray(ss) && ss.length >= 1, 'SubagentStop entry required')
  // The feed catches everything, deliberately: no matcher rather than an
  // enumerated agent-type list that would drift as the roster changes.
  assert(!('matcher' in ss[0]), 'the feed must have no matcher (catch every agent)')
  const cmd = ss[0].hooks && ss[0].hooks[0]
  assert(cmd && cmd.type === 'command', 'hook must be type "command"')
  assert(/subagent-stop\.js/.test(cmd.command), 'hook must invoke subagent-stop.js')
})

// --- 2. Hook script compiles (CommonJS — node --check is correct here) ------

const HOOK = path.join(root, 'hooks/session-start.js')
const FEED_HOOK = path.join(root, 'hooks/subagent-stop.js')

check('hooks/subagent-stop.js is syntactically valid', () => {
  execFileSync(process.execPath, ['--check', FEED_HOOK], { stdio: 'pipe' })
})

check('subagent-stop appends a feed line and exits 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'))
  try {
    const res = spawnSync(process.execPath, [FEED_HOOK], {
      input: JSON.stringify({
        agent_type: 'claude-swarm:leaf',
        last_assistant_message: 'done: header\nfilled and type-checked',
        cwd: tmp,
      }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
    })
    assert(res.status === 0, `must exit 0, got ${res.status}`)
    const feed = fs.readFileSync(path.join(tmp, '.claude-swarm-feed.log'), 'utf8')
    assert(/claude-swarm:leaf/.test(feed), 'agent type must appear in the feed line')
    assert(/done: header filled/.test(feed), 'message must be flattened into the line')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// Runs the feed hook against a scratch project dir and returns the message column
// of the single line it appended. `transcript` (if given) is written as the
// subagent's own transcript and its path handed to the hook the way Claude Code
// does. Asserts the exit-0 contract on every call, since every case must hold it.
function feedMessage(payload, transcript) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'))
  try {
    if (transcript) {
      const p = path.join(tmp, 'agent-abc.jsonl')
      fs.writeFileSync(p, transcript.map((r) => JSON.stringify(r)).join('\n') + '\n')
      payload = { ...payload, agent_transcript_path: p }
    }
    const res = spawnSync(process.execPath, [FEED_HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
    })
    assert(res.status === 0, `must exit 0, got ${res.status}`)
    const feed = fs.readFileSync(path.join(tmp, '.claude-swarm-feed.log'), 'utf8')
    return feed.trim().split('\t')[2]
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// Shaped after transcripts captured live from Claude Code 2.1.220. Two facts the
// fix turns on: the transcript writes ONE assistant message as a record per
// content block (same `message.id`), and a schema-constrained agent ends its turn
// with a `StructuredOutput` tool_use rather than prose.
const asst = (id, content) => ({
  type: 'assistant',
  isSidechain: true,
  message: { id, type: 'message', role: 'assistant', content, stop_reason: 'tool_use' },
})
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })

check('subagent-stop recovers the final message when the payload omits it', () => {
  // The bug this guards: on 2.1.220 a subagent that ends its turn via
  // StructuredOutput gets NO `last_assistant_message` key in the SubagentStop
  // payload at all — verbatim from a live capture, the keys were
  // session_id, transcript_path, cwd, prompt_id, permission_mode, agent_id,
  // agent_type, effort, hook_event_name, stop_hook_active, agent_transcript_path,
  // background_tasks, session_crons. Every line of a 15-agent build wave read
  // "(no output)" as a result. The final message is still in the agent's own
  // transcript, which the payload does always name.
  const said = feedMessage({ agent_type: 'claude-swarm:mechanic' }, [
    asst('msg_1', [{ type: 'text', text: 'earlier narration that is not the final word' }]),
    toolResult(),
    asst('msg_2', [{ type: 'text', text: 'Build and typecheck both pass cleanly with no changes required.' }]),
    asst('msg_2', [{ type: 'tool_use', id: 't1', name: 'StructuredOutput', input: { typecheck: 'pass' } }]),
    toolResult(),
  ])
  assert(
    said === 'Build and typecheck both pass cleanly with no changes required.',
    `the final message must be recovered from the transcript, got "${said}"`,
  )
})

check('subagent-stop reports a structured return rather than calling it silence', () => {
  // 11 of the 15 agents in that wave closed with StructuredOutput and no prose.
  // They returned a full result — logging that as "(no output)" is what made the
  // eval's `unknown` rate uncollectable.
  const said = feedMessage({ agent_type: 'claude-swarm:leaf' }, [
    asst('msg_1', [
      { type: 'tool_use', id: 't1', name: 'StructuredOutput', input: { results: [{ unit: 'expense-row', status: 'done' }] } },
    ]),
    toolResult(),
  ])
  assert(said !== '(no output)', 'a structured return is output, not silence')
  assert(/expense-row/.test(said) && /done/.test(said), `the structured result must be summarized, got "${said}"`)
})

check('subagent-stop still reports a genuinely silent agent as silent', () => {
  // A turn-capped subagent stops inside a tool call and returns nothing. build.js
  // scores that as `unknown`, so the feed must not manufacture a message out of
  // mid-run narration — the last message is the only thing that counts.
  const said = feedMessage({ agent_type: 'claude-swarm:leaf' }, [
    asst('msg_1', [{ type: 'text', text: 'Now I will write the component.' }]),
    toolResult(),
    asst('msg_2', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/a.ts' } }]),
    toolResult(),
  ])
  assert(said === '(no output)', `a turn-capped agent must stay distinguishable, got "${said}"`)
})

check('subagent-stop prefers the payload message and survives a missing transcript', () => {
  const said = feedMessage({ agent_type: 'claude-swarm:leaf', last_assistant_message: 'BANANA SPLIT' }, [
    asst('msg_1', [{ type: 'text', text: 'transcript text that must not win' }]),
  ])
  assert(said === 'BANANA SPLIT', `the payload message must win when present, got "${said}"`)
  const gone = feedMessage({
    agent_type: 'claude-swarm:leaf',
    agent_transcript_path: '/nonexistent/dir/agent-nope.jsonl',
  })
  assert(gone === '(no output)', `an unreadable transcript must not crash the hook, got "${gone}"`)
  const junk = feedMessage({ agent_type: 'claude-swarm:leaf' }, [{ type: 'assistant' }, { type: 'user' }])
  assert(junk === '(no output)', `a transcript with no usable message must not crash, got "${junk}"`)
})

check('subagent-stop swallows garbage input — exit 2 would block the subagent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'))
  try {
    const res = spawnSync(process.execPath, [FEED_HOOK], {
      input: 'not json at all',
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
    })
    assert(res.status === 0, `must exit 0 on garbage input, got ${res.status}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

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

// --- 2c. Hook detections: each fires only on its own trigger ----------------

// Runs the hook against a scratch config dir and returns its additionalContext.
// `seed` populates the dir; `env` overrides the environment.
function hookContext({ seed = () => {}, env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'))
  try {
    seed(tmp)
    const out = execFileSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: tmp,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_CODE_SUBAGENT_MODEL: '',
        ...env,
      },
    })
    return JSON.parse(out).hookSpecificOutput.additionalContext
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const ROSTER = ['scout', 'tracer', 'implementer', 'mechanic', 'verifier', 'scribe', 'leaf']
const seedAgents = (names) => (tmp) => {
  fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true })
  for (const n of names) fs.writeFileSync(path.join(tmp, 'agents', `${n}.md`), '# copy\n')
}
// An installed Explore override silences that notice — the "correctly configured"
// baseline the other detection tests want, so they see only their own branch.
const seedExplore = seedAgents(['Explore'])

check('hook reports a duplicate roster without prescribing an unverified cure', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-'))
  try {
    seedAgents([...ROSTER, 'Explore'])(tmp)
    const out = execFileSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmp, CLAUDE_PLUGIN_ROOT: root },
    })
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext
    for (const n of ROSTER) {
      assert(new RegExp(`\`${n}\``).test(ctx), `duplicate "${n}" must be named in the notice`)
    }
    assert(/Agent type not found/.test(ctx), 'the notice must explain the failure mode')
    // Reporting only: every seeded file must survive byte-for-byte.
    for (const n of ROSTER) {
      assert(
        fs.readFileSync(path.join(tmp, 'agents', `${n}.md`), 'utf8') === '# copy\n',
        'the hook must never modify or delete a file in the config dir',
      )
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

check('hook stays silent about duplicates when the agents dir is clean', () => {
  const ctx = hookContext({ seed: seedExplore })
  assert(!/share this plugin's roster names/.test(ctx), 'no duplicates must mean no notice')
})

check('hook warns when CLAUDE_CODE_SUBAGENT_MODEL overrides the tier pins', () => {
  const ctx = hookContext({ seed: seedExplore, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } })
  assert(/CLAUDE_CODE_SUBAGENT_MODEL=opus/.test(ctx), 'the offending value must be named')
  assert(/cost tiering is inactive/.test(ctx), 'the consequence must be stated plainly')
})

check('hook stays silent when CLAUDE_CODE_SUBAGENT_MODEL is inherit or unset', () => {
  const warned = /overrides the `model:` pin/
  assert(
    !warned.test(hookContext({ seed: seedExplore, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'inherit' } })),
    '`inherit` is equivalent to unset — must not warn',
  )
  assert(!warned.test(hookContext({ seed: seedExplore })), 'unset must not warn')
})

check('hook mentions the Explore override only while the file is absent', () => {
  const absent = hookContext()
  assert(/Explore\.md/.test(absent), 'a missing Explore override must be mentioned')
  assert(/bills at top tier/.test(absent), 'the cost consequence must be stated')
  assert(!/Explore\.md/.test(hookContext({ seed: seedExplore })), 'an installed override silences it')
})

check('hook never warns about correct default state', () => {
  // The design rule this plugin encodes. Spawn depth unset and nesting off are stock
  // Claude Code defaults AND correct here (the swarm dispatches from the main loop),
  // so they must not appear as notices — an earlier cut warned about them on every
  // session for every user. The fact lives in POLICY as a routing rule instead.
  const ctx = hookContext({ seed: seedExplore })
  assert(!/setup notices/.test(ctx), 'a correctly configured machine must get zero notices')
  assert(/can't delegate downward/.test(ctx), 'but the nesting rule must survive in POLICY')
})

check('injected payload stays within budget', () => {
  // The guard that matters most: an earlier cut shipped always-on notices about
  // correct default state (+~900B/session), which no other test would have caught.
  //
  // Budget decided deliberately (2026-07-25), not inherited: current content
  // (~2600B) plus one structural change of headroom. The previous 2600B ceiling
  // was set "just above current size" and then re-tightened twice in one
  // redesign — at that point the constant was doing the arguing instead of the
  // content. The policy now carries only decision rules (the three questions,
  // the roster, the rules block, a skill pointer); threshold tables and
  // arithmetic live in the skill. Growth past 3000B therefore means reference
  // material is accreting in the policy again — move it to SKILL.md rather than
  // raising this — and a notice regression still trips it long before that.
  const quiet = hookContext({ seed: seedExplore }).length
  const dayOne = hookContext().length // empty config dir — what a new user actually gets
  assert(quiet <= 3000, `quiet-path payload ${quiet}B exceeds its 3000B budget`)
  assert(dayOne <= 3300, `day-one payload ${dayOne}B exceeds its 3300B budget`)
  assert(dayOne > quiet, 'the day-one case must actually include the Explore notice')
})

check('policy describes how the ceilings behave and quotes no number', () => {
  // The invented "cap at 6" was replaced with the then-real 20/200, which was true but
  // still the wrong SHAPE of claim: both are env-tunable, the workflow limit is derived
  // from the machine's CPU count, and none of it is pinned by any contract we control. A
  // number baked into the policy is a claim that goes stale in silence, and the live
  // values are already in the Agent/Workflow tool descriptions. So the policy asserts the
  // behavioural difference that actually drives routing — ad-hoc dispatch FAILS past its
  // ceiling, workflow agent() spawns QUEUE — and states no figure at all.
  const ctx = hookContext({ seed: seedExplore })
  assert(!/Cap at 6|6 concurrent/.test(ctx), 'the invented 6-concurrent cap must be gone')
  assert(!/\d+\s*concurrent|\d+\s*\/\s*session|\d+ per session/.test(ctx), 'no hardcoded ceiling figures')
  assert(/fails?\b/.test(ctx), 'ad-hoc dispatch must be described as failing past its ceiling')
  assert(/queue/.test(ctx), 'workflow agent() spawns must be described as queueing instead')
})

check('policy carries no per-token dollar figures', () => {
  const ctx = hookContext({ seed: seedExplore })
  assert(!/\$\d/.test(ctx), 'dollar figures must not be load-bearing in the injected policy')
  assert(/haiku < sonnet < opus < fable/.test(ctx), 'the tier ordering must survive')
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

for (const wf of ['survey.js', 'audit.js', 'build.js']) {
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

// --- 3c. build.js: validator rejects bad manifests, waves run good ones -----

/** Run build.js with a manifest; assert it was rejected with zero spawns. */
async function buildViolations(manifest) {
  let spawned = 0
  const out = await runWorkflow('build.js', {
    args: manifest,
    onAgent: async () => {
      spawned++
      return null
    },
  })
  assert(out.status === 'invalid-manifest', `expected invalid-manifest, got ${out.status}`)
  assert(spawned === 0, 'an invalid manifest must spawn nothing')
  return out.violations.join('\n')
}

const goodManifest = () => ({
  typecheck: 'npx tsc --noEmit',
  foundation: ['src/types.ts'],
  units: [
    { id: 'a', owns: ['src/a.ts'], reads: ['src/types.ts'], builds: 'component a' },
    { id: 'b', owns: ['src/b.ts'], reads: ['src/types.ts', 'src/a.ts'], builds: 'component b' },
  ],
})

checkAsync('build runs leaves in dependency order, then integration', async () => {
  const labels = []
  const out = await runWorkflow('build.js', {
    args: goodManifest(),
    onAgent: async (prompt, opts) => {
      labels.push(opts.label)
      if (opts.phase === 'Leaves') {
        const ids = opts.label.replace('leaf:', '').split('+')
        return { results: ids.map((id) => ({ unit: id, status: 'done', notes: '' })) }
      }
      return {
        unitsVerified: [
          { unit: 'a', filesPresent: true, nonEmpty: true },
          { unit: 'b', filesPresent: true, nonEmpty: true },
        ],
        sharedFilesWritten: ['src/index.ts'],
        fixed: [],
        typecheck: 'pass',
        judgment: [],
      }
    },
  })
  assert(out.status === 'complete', `expected complete, got ${out.status}`)
  assert(out.units.every((u) => u.status === 'done'), 'both units must be done')
  // b reads a's owned file, so its leaf must not dispatch before a settles.
  assert(labels.indexOf('leaf:a') < labels.indexOf('leaf:b'), `leaf:a must precede leaf:b (${labels})`)
  assert(labels.includes('integrate:mechanic'), 'integration must run')
})

checkAsync('build batches units with an identical read-set into one leaf', async () => {
  let leafCalls = 0
  const m = {
    typecheck: 'tsc',
    foundation: ['src/types.ts'],
    units: [
      { id: 'a', owns: ['src/a.ts'], reads: ['src/types.ts'], builds: 'a' },
      { id: 'b', owns: ['src/b.ts'], reads: ['src/types.ts'], builds: 'b' },
    ],
    batch: 2,
  }
  await runWorkflow('build.js', {
    args: m,
    onAgent: async (prompt, opts) => {
      if (opts.phase === 'Leaves') {
        leafCalls++
        return { results: ['a', 'b'].map((id) => ({ unit: id, status: 'done', notes: '' })) }
      }
      return {
        unitsVerified: [
          { unit: 'a', filesPresent: true, nonEmpty: true },
          { unit: 'b', filesPresent: true, nonEmpty: true },
        ],
        sharedFilesWritten: [],
        fixed: [],
        typecheck: 'pass',
        judgment: [],
      }
    },
  })
  assert(leafCalls === 1, `batch=2 with one shared read-set must mean 1 leaf agent, got ${leafCalls}`)
})

checkAsync('build merges nested read-sets into one batch, owner listed first', async () => {
  // b's read-set strictly contains a's, and b reads the file a owns — the batch
  // must merge (prefix sharing, not set equality) and list a before b.
  let leafCalls = 0
  let leafPromptText = ''
  const m = {
    typecheck: 'tsc',
    foundation: ['src/types.ts'],
    units: [
      { id: 'a', owns: ['src/a.ts'], reads: ['src/types.ts'], builds: 'a' },
      { id: 'b', owns: ['src/b.ts'], reads: ['src/types.ts', 'src/a.ts'], builds: 'b' },
    ],
    batch: 2,
  }
  await runWorkflow('build.js', {
    args: m,
    onAgent: async (prompt, opts) => {
      if (opts.phase === 'Leaves') {
        leafCalls++
        leafPromptText = prompt
        return { results: ['a', 'b'].map((id) => ({ unit: id, status: 'done', notes: '' })) }
      }
      return {
        unitsVerified: [
          { unit: 'a', filesPresent: true, nonEmpty: true },
          { unit: 'b', filesPresent: true, nonEmpty: true },
        ],
        sharedFilesWritten: [],
        fixed: [],
        typecheck: 'pass',
        judgment: [],
      }
    },
  })
  assert(leafCalls === 1, `nested read-sets must merge under batch=2, got ${leafCalls} leaf calls`)
  assert(
    leafPromptText.indexOf('Unit a') !== -1 && leafPromptText.indexOf('Unit a') < leafPromptText.indexOf('Unit b'),
    'owner a must be listed before reader b in the batch prompt',
  )
  // The sibling filter: the leaf's type check must be scoped to its owned files,
  // or concurrent stubs' errors contaminate the repair-cycle metric.
  assert(/grep -F/.test(leafPromptText), 'leaf type check must be sibling-filtered')
  assert(/-e "src\/a\.ts"/.test(leafPromptText) && /-e "src\/b\.ts"/.test(leafPromptText),
    'the filter must name the batch-owned files')
})

/** Extract the leaf type-check script build.js generates for a given command. */
async function leafScriptFor(typecheck) {
  let promptText = ''
  await runWorkflow('build.js', {
    args: { typecheck, foundation: [], units: [{ id: 'a', owns: ['src/a.ts'], reads: [], builds: 'a' }] },
    onAgent: async (prompt, opts) => {
      if (opts.phase === 'Leaves') {
        promptText = prompt
        return { results: [{ unit: 'a', status: 'done', notes: '' }] }
      }
      return {
        unitsVerified: [{ unit: 'a', filesPresent: true, nonEmpty: true }],
        sharedFilesWritten: [],
        fixed: [],
        typecheck: 'pass',
        judgment: [],
      }
    },
  })
  const m = /```sh\n([\s\S]*?)```/.exec(promptText)
  assert(m, 'leaf prompt must carry the type check as a fenced sh block')
  return m[1]
}

checkAsync('leaf type-check script: broken tooling is loud, clean is positive, exit is irrelevant', async () => {
  // Executes the script build.js actually generates, against the two failure
  // modes a bare `cmd | grep` gets wrong: a tool that fails to run must not
  // read as a clean pass, and "grep found no errors" (grep exit 1) must not
  // read as a failure.
  const broken = spawnSync('bash', ['-c', await leafScriptFor('definitely-not-a-real-command-xyz --noEmit')], {
    encoding: 'utf8',
  })
  assert(broken.status === 0, `script exit must always be 0, got ${broken.status}`)
  assert(/TYPECHECK-BROKEN/.test(broken.stdout), 'a tool that failed to run must be reported broken')
  assert(!/OWNED-FILES-CLEAN/.test(broken.stdout), 'tooling failure must never read as clean')

  // Sibling-only errors with the tool exiting 1 (tsc's "diagnostics present"):
  // the run is clean FOR THIS LEAF, and the old pipe's inverted exit code is gone.
  const sibling = spawnSync(
    'bash',
    ['-c', await leafScriptFor(`sh -c 'echo "src/other.ts(1,1): error TS1111: sibling stub"; exit 1'`)],
    { encoding: 'utf8' },
  )
  assert(sibling.status === 0, `clean-for-this-leaf must exit 0, got ${sibling.status}`)
  assert(/OWNED-FILES-CLEAN/.test(sibling.stdout), 'sibling-only errors must yield the positive clean marker')
  assert(!/src\/other\.ts/.test(sibling.stdout), 'sibling error lines must be filtered out')

  // An error in an owned file must surface.
  const own = spawnSync(
    'bash',
    ['-c', await leafScriptFor(`sh -c 'echo "src/a.ts(3,1): error TS2304: boom"; exit 1'`)],
    { encoding: 'utf8' },
  )
  assert(own.status === 0, `own-error case must still exit 0, got ${own.status}`)
  assert(/src\/a\.ts\(3,1\): error TS2304/.test(own.stdout), 'owned-file errors must pass the filter')
  assert(!/OWNED-FILES-CLEAN/.test(own.stdout), 'an owned-file error must not read as clean')
})

checkAsync('build warns on a misspelled top-level key with the nearest valid one', async () => {
  // `foundations:` used to be silently ignored, cascading into N misleading
  // "neither in foundation nor owned" violations. The warning names the typo.
  const m = {
    typecheck: 'tsc',
    foundations: ['src/types.ts'],
    units: [{ id: 'a', owns: ['src/a.ts'], reads: ['src/types.ts'], builds: 'a' }],
  }
  let spawned = 0
  const out = await runWorkflow('build.js', {
    args: m,
    onAgent: async () => {
      spawned++
      return null
    },
  })
  assert(out.status === 'invalid-manifest', 'the cascade still fails the manifest')
  assert(spawned === 0, 'nothing may spawn')
  assert(
    out.warnings && /did you mean "foundation"/.test(out.warnings.join('\n')),
    'the warning must name the misspelled key and its nearest valid neighbour',
  )
})

checkAsync('build surfaces a unit-level unknown key without failing a valid run', async () => {
  const m = {
    typecheck: 'tsc',
    foundation: ['src/types.ts'],
    units: [{ id: 'a', owns: ['src/a.ts'], read: ['src/types.ts'], builds: 'a' }],
  }
  const out = await runWorkflow('build.js', {
    args: m,
    onAgent: async (prompt, opts) => {
      if (opts.phase === 'Leaves') return { results: [{ unit: 'a', status: 'done', notes: '' }] }
      return {
        unitsVerified: [{ unit: 'a', filesPresent: true, nonEmpty: true }],
        sharedFilesWritten: [],
        fixed: [],
        typecheck: 'pass',
        judgment: [],
      }
    },
  })
  assert(out.status === 'complete', `an unknown unit key alone must not fail the run, got ${out.status}`)
  assert(
    out.warnings && /unit "a": unknown key "read" — did you mean "reads"/.test(out.warnings.join('\n')),
    'the unit-level warning must name the unit, the key, and the nearest valid one',
  )
})

checkAsync('build treats a silent leaf as unknown, integrates from the tree, escalates judgment', async () => {
  const labels = []
  const out = await runWorkflow('build.js', {
    args: { typecheck: 'tsc', foundation: [], units: [{ id: 'a', owns: ['src/a.ts'], reads: [], builds: 'a' }] },
    onAgent: async (prompt, opts) => {
      labels.push(opts.label)
      // The measured behavior: a turn-capped leaf returns nothing, with no marker.
      if (opts.phase === 'Leaves') return null
      if (opts.label === 'integrate:mechanic')
        return {
          unitsVerified: [{ unit: 'a', filesPresent: true, nonEmpty: true }],
          sharedFilesWritten: [],
          fixed: ['import path in src/a.ts'],
          typecheck: 'pass',
          judgment: [{ issue: 'prop type contradicts the route contract', where: 'src/a.ts:12' }],
        }
      return 'resolved: widened the prop type, typecheck passes'
    },
  })
  assert(out.units[0].status === 'unknown', `a silent leaf must be unknown, got ${out.units[0].status}`)
  assert(labels.includes('integrate:judgment'), 'judgment items must escalate to opus')
  // The tree said the files are present and filled — leaf silence must not fail the run.
  assert(out.status === 'complete', `tree-verified run must be complete, got ${out.status}`)
})

checkAsync('build rejects a path owned by two units', async () => {
  const m = goodManifest()
  m.units[1].owns = ['src/a.ts']
  m.units[1].reads = ['src/types.ts']
  assert(/owned by more than one unit/.test(await buildViolations(m)), 'violation must name the collision')
})

checkAsync('build rejects a read/own dependency cycle', async () => {
  const m = goodManifest()
  m.units[0].reads = ['src/types.ts', 'src/b.ts']
  assert(/dependency cycle/.test(await buildViolations(m)), 'violation must name the cycle')
})

checkAsync('build rejects a path escaping the project', async () => {
  const m = goodManifest()
  m.units[0].owns = ['../evil.ts']
  assert(/escapes the project/.test(await buildViolations(m)), 'violation must name the escape')
})

checkAsync('build rejects a read that nothing provides', async () => {
  const m = goodManifest()
  m.units[0].reads = ['src/ghost.ts']
  assert(/neither in foundation nor owned/.test(await buildViolations(m)), 'violation must name the ghost read')
})

checkAsync('build rejects a unit owning a shared file reserved for integration', async () => {
  const m = goodManifest()
  m.units[0].owns = ['src/index.ts']
  assert(/reserved for integration/.test(await buildViolations(m)), 'violation must name the reserved file')
})

checkAsync('build rejects a unit owning a foundation file', async () => {
  const m = goodManifest()
  m.units[0].owns = ['src/types.ts']
  assert(/owns a foundation file/.test(await buildViolations(m)), 'violation must name the foundation collision')
})

check('the leaf import rule exists in both the agent and the dispatch prompt', () => {
  // The rule lives in two places on purpose — agents/leaf.md is the leaf's
  // system prompt, build.js's leafPrompt() the per-dispatch task prompt — and
  // duplicated prose with no test drifts. If either phrase is reworded, keep
  // the rule in BOTH files and update the matching pattern here.
  assert(
    /import line is not the signature/.test(read('agents/leaf.md')),
    'agents/leaf.md must carry the import-extension rule',
  )
  assert(
    /import line as you write/.test(read('workflows/build.js')),
    "build.js's leafPrompt must carry the import-extension rule",
  )
})

// --- 4. Agents and skill have usable frontmatter ---------------------------

const EXPECTED_AGENTS = ['scout', 'tracer', 'implementer', 'mechanic', 'verifier', 'scribe', 'leaf']

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

// --- 5. Status line scripts: settings ship them, they render and degrade ----

const SUB_SL = path.join(root, 'scripts/subagent-statusline.js')
const MAIN_SL = path.join(root, 'scripts/swarm-statusline.js')
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

check('settings.json ships only plugin-supported keys', () => {
  // "Only the `agent` and `subagentStatusLine` keys are currently supported"
  // (plugins reference) — anything else would be silently dead weight.
  const s = readJSON('settings.json')
  for (const k of Object.keys(s)) {
    assert(['agent', 'subagentStatusLine'].includes(k), `unsupported plugin settings key "${k}"`)
  }
  assert(s.subagentStatusLine && s.subagentStatusLine.type === 'command', 'subagentStatusLine must be a command')
  assert(/subagent-statusline\.js/.test(s.subagentStatusLine.command), 'must invoke scripts/subagent-statusline.js')
  // NOT ${CLAUDE_PLUGIN_ROOT}: plugin settings are merged verbatim (Claude Code
  // 2.1.220 copies each key straight across without the placeholder expansion it
  // applies to hooks, MCP, monitors and LSP), so the placeholder would reach the
  // shell as an undefined variable and the command would resolve to "/scripts/…".
  // The SessionStart hook leaves the real root in a temp-dir breadcrumb instead.
  assert(
    !/\$\{CLAUDE_PLUGIN_ROOT\}/.test(s.subagentStatusLine.command),
    'must not use ${CLAUDE_PLUGIN_ROOT}: it is never substituted in plugin settings',
  )
  assert(/claude-swarm-root/.test(s.subagentStatusLine.command), 'must locate the script via the hook-written breadcrumb')
})

check('the SessionStart hook leaves a plugin-root breadcrumb the settings command can use', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-root-'))
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'crumb', cwd: root }),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmp },
  })
  assert(res.status === 0, `hook must exit 0, got ${res.status}`)
  const crumb = path.join(tmp, 'claude-swarm-root')
  assert(fs.existsSync(crumb), 'the hook must write the breadcrumb')
  const pluginRoot = fs.readFileSync(crumb, 'utf8').trim()
  assert(pluginRoot === root, `breadcrumb must be the plugin root, got "${pluginRoot}"`)

  // The whole point: the shipped command, resolved against the breadcrumb, must
  // run the real renderer. Executed here rather than string-matched.
  const command = readJSON('settings.json').subagentStatusLine.command
  const payload = JSON.stringify({
    session_id: 'crumb', columns: 100,
    tasks: [{ id: 'k', type: 'local_agent', label: 'via breadcrumb', status: 'running',
      startTime: Date.now() - 61000, model: 'claude-sonnet-5', contextWindowSize: 200000, tokenCount: 40000 }],
  })
  const ran = spawnSync('sh', ['-c', command], { input: payload, encoding: 'utf8', env: { ...process.env, TMPDIR: tmp } })
  assert(ran.status === 0, `the shipped command must run, exit ${ran.status}: ${ran.stderr}`)
  const row = JSON.parse(ran.stdout.trim())
  assert(row.id === 'k' && /SONNET/.test(row.content), `must render a real row, got ${ran.stdout}`)
})

check('status line scripts are syntactically valid', () => {
  execFileSync(process.execPath, ['--check', SUB_SL], { stdio: 'pipe' })
  execFileSync(process.execPath, ['--check', MAIN_SL], { stdio: 'pipe' })
})

// One synthetic payload covering the tier matrix; TMPDIR is pointed at a fresh
// dir so the aggregate cache the script writes is isolated and inspectable.
function runStatusline(script, stdin, tmpdir) {
  return spawnSync(process.execPath, [script], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmpdir },
  })
}

// Shaped after a payload captured live from Claude Code 2.1.220: `type` is the
// constant "local_agent" on every row, there is no `name` field, and label /
// description carry the caller's Task description — never a roster name. Rows
// therefore cannot be attributed to an agent, only to a model tier.
const SL_TASKS = {
  session_id: 'smoke-sess',
  columns: 100,
  tasks: [
    { id: 't-sonnet', type: 'local_agent', label: 'Fill PriceBreakdown', status: 'running',
      startTime: Date.now() - 84000, model: 'claude-sonnet-5', contextWindowSize: 200000, tokenCount: 84000 },
    { id: 't-opus', type: 'local_agent', label: 'Wire the integration', status: 'running',
      startTime: Date.now() - 123000, model: 'claude-opus-5', contextWindowSize: 200000, tokenCount: 142000 },
    { id: 't-haiku', type: 'local_agent', description: 'find call sites', status: 'running',
      startTime: Date.now() - 5000, model: 'claude-haiku-4-5-20251001', contextWindowSize: 200000, tokenCount: 9000 },
    { id: 't-nomodel', type: 'local_agent', label: 'wiring', status: 'running',
      startTime: Date.now() - 2000 },
    { id: 't-fable', type: 'local_agent', label: 'top of the ladder', status: 'running',
      startTime: Date.now() - 9000, model: 'claude-fable-5', contextWindowSize: 200000, tokenCount: 20000 },
  ],
}

check('subagent statusline badges every row by model tier', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  const res = runStatusline(SUB_SL, JSON.stringify(SL_TASKS), tmp)
  assert(res.status === 0, `must exit 0, got ${res.status}`)
  assert(!/undefined/.test(res.stdout), 'no "undefined" may leak into a row')
  const rows = {}
  for (const line of res.stdout.trim().split('\n')) {
    const o = JSON.parse(line) // every stdout line must be a {"id","content"} object
    rows[o.id] = o.content
  }
  assert(Object.keys(rows).length === SL_TASKS.tasks.length, 'every row renders: none can be attributed, so none is filtered')
  assert(/\x1b\[102;30m/.test(rows['t-sonnet']) && /SONNET/.test(rows['t-sonnet']), 'Sonnet gets the green badge')
  assert(/1:24/.test(rows['t-sonnet']), 'elapsed renders m:ss from startTime')
  assert(/42%/.test(rows['t-sonnet']), 'context bar percentage from tokenCount/contextWindowSize')
  assert(/\x1b\[106;30m/.test(rows['t-haiku']) && /HAIKU/.test(rows['t-haiku']), 'Haiku gets the cyan badge')
  assert(/\x1b\[103;30m/.test(rows['t-opus']) && /OPUS/.test(rows['t-opus']), 'Opus gets the yellow badge')
  assert(!/\x1b\[101;97m/.test(res.stdout), 'no row may claim red: the anomaly it marked is not derivable from this payload')
  const fable = rows['t-fable']
  assert(/FABLE/.test(fable), 'a model off the three routed tiers is named, not shrugged at')
  assert(!/\x1b\[10[236];30m/.test(fable), 'and it is not colored as one of the three')
  const noModel = rows['t-nomodel']
  assert(noModel && /AGENT/.test(noModel), 'a task whose model has not resolved still renders a row')
  for (const bg of ['\x1b[106;30m', '\x1b[102;30m', '\x1b[103;30m']) {
    assert(!noModel.includes(bg), 'model absent → no tier badge that would be a guess')
  }
})

check('subagent statusline honors the drop order under narrow columns', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  // 5 and 3 are below the badge's own 8 visible columns: the badge still never
  // drops, but it clips rather than overflowing the width it was handed.
  for (const columns of [30, 14, 8, 5, 3]) {
    const res = runStatusline(SUB_SL, JSON.stringify({ ...SL_TASKS, columns }), tmp)
    assert(res.status === 0, `must exit 0 at columns=${columns}`)
    for (const line of res.stdout.trim().split('\n')) {
      const o = JSON.parse(line)
      const visible = stripAnsi(o.content)
      assert(!visible.includes('█'), `columns=${columns}: the context bar drops first`)
      assert(visible.length <= columns, `columns=${columns}: row "${visible}" is ${visible.length} wide`)
      assert(/[A-Z]/.test(visible), 'the badge never drops')
    }
  }
})

check('subagent statusline renders the payload Claude Code actually sends', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  // Verbatim from a live 2.1.220 capture, minus tokenSamples: no identity field
  // of any kind. An earlier renderer matched on task.type/name expecting a scoped
  // roster name, found none, and silently rendered nothing at all — this check
  // exists so a return to name-matching fails here instead of in a live wave.
  const realShape = {
    session_id: 'real', transcript_path: '/tmp/t.jsonl', cwd: '/repo', prompt_id: 'p1', columns: 148,
    tasks: [{
      id: 'a009e10f568045d3d', type: 'local_agent', status: 'running',
      description: 'Count evals files', label: 'Count evals files',
      startTime: Date.now() - 65000, model: 'claude-haiku-4-5-20251001',
      contextWindowSize: 200000, tokenCount: 9431, cwd: '/repo',
    }],
  }
  const res = runStatusline(SUB_SL, JSON.stringify(realShape), tmp)
  assert(res.status === 0, 'must exit 0')
  assert(res.stdout.trim() !== '', 'the real payload must produce a row, not silence')
  const row = JSON.parse(res.stdout.trim())
  assert(row.id === 'a009e10f568045d3d', 'the row is keyed by the task id')
  assert(/HAIKU/.test(row.content) && /1:05/.test(row.content), 'tier badge and clock both render')
  const agg = JSON.parse(fs.readFileSync(path.join(tmp, 'claude-swarm-status-real.json'), 'utf8'))
  assert(agg.counts.haiku === 1, 'and it counts toward the aggregate')
})

check('subagent statusline drops the clock on a finished task', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  // No end time exists in the payload, so elapsed on a terminal row would be a
  // clock still counting after the agent stopped.
  const done = {
    session_id: 'done', columns: 100,
    tasks: [{ id: 'd', type: 'local_agent', label: 'Finished', status: 'completed',
      startTime: Date.now() - 90000, model: 'claude-sonnet-5', contextWindowSize: 200000, tokenCount: 50000 }],
  }
  const res = runStatusline(SUB_SL, JSON.stringify(done), tmp)
  const row = JSON.parse(res.stdout.trim()).content
  assert(/SONNET/.test(row), 'a finished row keeps its tier badge')
  assert(!/\d:\d\d/.test(stripAnsi(row)), 'no elapsed clock on a terminal row')
  assert(!/█|░/.test(row), 'no stale context bar on a terminal row')
  const agg = JSON.parse(fs.readFileSync(path.join(tmp, 'claude-swarm-status-done.json'), 'utf8'))
  assert(Object.values(agg.counts).every((n) => n === 0), 'a finished task counts toward no tier')
})

check('subagent statusline swallows garbage input and exits 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  const res = runStatusline(SUB_SL, 'not json at all', tmp)
  assert(res.status === 0, 'must exit 0 on garbage stdin')
  assert(res.stdout === '', 'must print nothing (all rows fall back to default rendering)')
})

check('subagent statusline writes the per-session aggregate cache', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  runStatusline(SUB_SL, JSON.stringify(SL_TASKS), tmp)
  const agg = JSON.parse(fs.readFileSync(path.join(tmp, 'claude-swarm-status-smoke-sess.json'), 'utf8'))
  assert(agg.counts.sonnet === 1, 'one running Sonnet')
  assert(agg.counts.haiku === 1 && agg.counts.opus === 1, 'one Haiku, one Opus')
  assert(!('anomaly' in agg.counts), 'no anomaly count: the payload cannot identify a leaf')
  assert(agg.counts.unresolved === 2, 'model-absent and off-ladder models both count as unresolved')
  // A raw timestamp, not an elapsed value: the reader ticks 5x more often than
  // this cache is written and must be able to advance the clock itself.
  const oldestTask = Math.min(...SL_TASKS.tasks.map((t) => t.startTime))
  assert(agg.oldestStart === oldestTask, `oldestStart is the longest-running task's startTime, got ${agg.oldestStart}`)
})

// A payload that is valid JSON but wrong in shape must degrade to Claude Code's
// default rendering, never to a crash: exit 2 or a stack trace on stdout would
// take the whole panel down, and these are the shapes a future payload change is
// most likely to arrive in.
check('subagent statusline degrades on a malformed task list rather than crashing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))

  const noTasks = runStatusline(SUB_SL, JSON.stringify({ session_id: 'shape-a', columns: 80 }), tmp)
  assert(noTasks.status === 0, `absent tasks array must exit 0, got ${noTasks.status}`)
  assert(noTasks.stdout === '', 'absent tasks array renders no rows')
  const agg = JSON.parse(fs.readFileSync(path.join(tmp, 'claude-swarm-status-shape-a.json'), 'utf8'))
  assert(Object.values(agg.counts).every((n) => n === 0), 'and still writes a zeroed aggregate')

  const notArray = runStatusline(SUB_SL, JSON.stringify({ session_id: 'shape-b', tasks: 'nope' }), tmp)
  assert(notArray.status === 0 && notArray.stdout === '', 'non-array tasks → no rows, exit 0')

  // One good row among entries the filter must drop: null, a primitive, and an
  // object with no id (an id is what Claude Code keys the row back to).
  const mixed = {
    session_id: 'shape-c',
    columns: 80,
    tasks: [
      null,
      42,
      { type: 'local_agent', label: 'no id at all', status: 'running', startTime: Date.now() - 3000 },
      { id: 't-good', type: 'local_agent', label: 'survivor', status: 'running',
        startTime: Date.now() - 7000, model: 'claude-sonnet-5', contextWindowSize: 200000, tokenCount: 5000 },
    ],
  }
  const res = runStatusline(SUB_SL, JSON.stringify(mixed), tmp)
  assert(res.status === 0, `mixed payload must exit 0, got ${res.status}`)
  const lines = res.stdout.trim().split('\n').filter(Boolean)
  assert(lines.length === 1, `only the well-formed row renders, got ${lines.length}`)
  assert(JSON.parse(lines[0]).id === 't-good', 'and it is the row that had an id')
})

check('main statusline segment stays quiet when the payload carries no session id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  runStatusline(SUB_SL, JSON.stringify(SL_TASKS), tmp) // a live cache exists...
  const res = runStatusline(MAIN_SL, JSON.stringify({ model: { display_name: 'Opus 5' } }), tmp)
  assert(res.status === 0, `must exit 0 without a session id, got ${res.status}`)
  assert(res.stdout === '', '...but with no session id there is no cache to key on, so no segment')
})

check('main statusline segment reads the cache, goes quiet when stale or absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  const stdin = JSON.stringify({ session_id: 'smoke-sess' })
  const missing = runStatusline(MAIN_SL, stdin, tmp)
  assert(missing.status === 0 && missing.stdout === '', 'no cache → empty output, exit 0')

  runStatusline(SUB_SL, JSON.stringify(SL_TASKS), tmp) // fresh cache
  const live = runStatusline(MAIN_SL, stdin, tmp)
  assert(live.status === 0, 'must exit 0 with a live cache')
  const seg = stripAnsi(live.stdout)
  assert(/claude-swarm/.test(seg), 'segment carries the claude-swarm label, branded once')
  assert(!/claude-swarm.*claude-swarm/.test(seg), 'and only once — the chips are not individually branded')
  // The oldest task in the fixture started 123s ago; the segment must derive the
  // clock from the cached timestamp rather than reprinting a stored elapsed.
  assert(/· oldest 2:0\d/.test(seg), `clock comes from oldestStart, got "${seg}"`)
  assert(/1S/.test(seg) && /1H/.test(seg) && /1O/.test(seg) && /2\?/.test(seg), `all tiers counted, got "${seg}"`)
  assert(!/\x1b\[101;97m/.test(live.stdout), 'no red chip: the anomaly it counted is not derivable')

  const cache = path.join(tmp, 'claude-swarm-status-smoke-sess.json')
  const past = new Date(Date.now() - 60000)
  fs.utimesSync(cache, past, past)
  const stale = runStatusline(MAIN_SL, stdin, tmp)
  assert(stale.status === 0 && stale.stdout === '', 'stale cache → empty output (the wave is over)')

  const garbage = runStatusline(MAIN_SL, 'not json', tmp)
  assert(garbage.status === 0 && garbage.stdout === '', 'garbage stdin → empty output, exit 0')
})

// The cache is rewritten on every tick, including idle ones, so mtime cannot say
// whether a wave just ended or nothing has run all session. The writer records the
// transition; these checks pin the contract both scripts depend on.
check('subagent statusline stamps the end of a wave and keeps the last live counts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  const cache = path.join(tmp, 'claude-swarm-status-smoke-sess.json')

  runStatusline(SUB_SL, JSON.stringify(SL_TASKS), tmp)
  const live = JSON.parse(fs.readFileSync(cache, 'utf8'))
  assert(!('endedAt' in live), 'a running wave carries no end stamp')

  runStatusline(SUB_SL, JSON.stringify({ session_id: 'smoke-sess', columns: 100, tasks: [] }), tmp)
  const ended = JSON.parse(fs.readFileSync(cache, 'utf8'))
  assert(Number.isFinite(ended.endedAt), 'the tick that drops to zero stamps endedAt')
  assert(ended.counts.sonnet === 1 && ended.counts.haiku === 1 && ended.counts.opus === 1,
    'and retains the last live counts rather than the zeroes that replaced them')
  assert(ended.oldestStart === live.oldestStart, 'and the original start, so the clock can be frozen')

  // Idle ticks keep arriving while the panel still shows terminal rows; the anchor
  // must not move, or the segment lingers for as long as the panel keeps ticking.
  runStatusline(SUB_SL, JSON.stringify({ session_id: 'smoke-sess', columns: 100, tasks: [] }), tmp)
  const again = JSON.parse(fs.readFileSync(cache, 'utf8'))
  assert(again.endedAt === ended.endedAt, 'a later idle tick must not restamp endedAt')

  // A session that has never run anything is idle, not "just finished".
  const cold = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  runStatusline(SUB_SL, JSON.stringify({ session_id: 'cold', columns: 100, tasks: [] }), cold)
  const coldRec = JSON.parse(fs.readFileSync(path.join(cold, 'claude-swarm-status-cold.json'), 'utf8'))
  assert(!('endedAt' in coldRec), 'no prior wave → no end stamp → nothing to linger')
})

check('main statusline segment lingers dimmed after a wave, then goes quiet', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  const stdin = JSON.stringify({ session_id: 'smoke-sess' })
  const cache = path.join(tmp, 'claude-swarm-status-smoke-sess.json')

  runStatusline(SUB_SL, JSON.stringify(SL_TASKS), tmp)
  const running = stripAnsi(runStatusline(MAIN_SL, stdin, tmp).stdout)
  assert(/· oldest /.test(running), `a live wave reports the oldest agent's clock, got "${running}"`)

  runStatusline(SUB_SL, JSON.stringify({ session_id: 'smoke-sess', columns: 100, tasks: [] }), tmp)
  const res = runStatusline(MAIN_SL, stdin, tmp)
  const seg = stripAnsi(res.stdout)
  assert(res.status === 0, 'lingering must exit 0')
  assert(/1S/.test(seg) && /1H/.test(seg) && /1O/.test(seg), `the finished wave's counts still show, got "${seg}"`)
  assert(/· ran 2:0\d/.test(seg), `the clock freezes at how long the wave ran, got "${seg}"`)
  assert(!/· oldest/.test(seg), 'and no longer claims anything is running')
  assert(!/\x1b\[10[236];30m/.test(res.stdout), 'tier backgrounds are dropped while lingering')

  // The panel stops rewriting the cache once its rows clear, so a finished record
  // goes stale long before the grace window closes. Staleness must not preempt it.
  const past = new Date(Date.now() - 60000)
  fs.utimesSync(cache, past, past)
  const stale = stripAnsi(runStatusline(MAIN_SL, stdin, tmp).stdout)
  assert(/· ran /.test(stale), `a stale but recently-ended record still lingers, got "${stale}"`)

  // Past the window it is gone, however fresh the file is.
  const rec = JSON.parse(fs.readFileSync(cache, 'utf8'))
  rec.endedAt -= 45000
  fs.writeFileSync(cache, JSON.stringify(rec))
  const expired = runStatusline(MAIN_SL, stdin, tmp)
  assert(expired.status === 0 && expired.stdout === '', 'past the grace window the segment goes quiet')

  // A new wave inside the window replaces the lingering state outright.
  runStatusline(SUB_SL, JSON.stringify(SL_TASKS), tmp)
  const revived = stripAnsi(runStatusline(MAIN_SL, stdin, tmp).stdout)
  assert(/· oldest /.test(revived), `a new wave renders live again, got "${revived}"`)
})

// A wave whose end-stamp was missed must still leave evidence. Observed live
// 2026-07-26: a 256s agent's final panel tick landed 1s before it exited, no
// further tick came, `endedAt` was never stamped, and the segment vanished at the
// staleness cutoff — the exact failure the grace window exists to prevent.
check('main statusline segment still shows a wave whose end-stamp was missed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  const stdin = JSON.stringify({ session_id: 'smoke-sess' })
  const cache = path.join(tmp, 'claude-swarm-status-smoke-sess.json')

  runStatusline(SUB_SL, JSON.stringify(SL_TASKS), tmp)
  const rec = JSON.parse(fs.readFileSync(cache, 'utf8'))
  assert(!('endedAt' in rec), 'precondition: a live record carries no end stamp')
  assert((rec.counts.sonnet || 0) > 0, 'precondition: the record still counts running agents')

  const justStale = new Date(Date.now() - 15000)
  fs.utimesSync(cache, justStale, justStale)
  const res = runStatusline(MAIN_SL, stdin, tmp)
  const seg = stripAnsi(res.stdout)
  assert(res.status === 0, 'must exit 0')
  assert(seg !== '', 'an unheard wave must not vanish at the staleness cutoff')
  assert(!/· oldest/.test(seg), `must not claim anything is running, got "${seg}"`)
  assert(!/\x1b\[10[236];30m/.test(res.stdout), 'tier backgrounds dropped — not live')

  // It reports the last thing observed, and does NOT assert an ending it cannot
  // know about. `ran` is a claim the evidence does not support; `last` is not.
  assert(/· last /.test(seg), `an unheard wave reports "last", got "${seg}"`)
  assert(!/· ran /.test(seg), `it must not claim the wave ended, got "${seg}"`)
  assert(/· last 1:4\d|· last 1:5\d/.test(seg), `clock frozen at the last write, got "${seg}"`)

  // The unheard window runs GRACE_MS from the staleness cutoff, so it gets the
  // same 30s a stamped wave gets — not ~20s.
  const nearEdge = new Date(Date.now() - 38000)
  fs.utimesSync(cache, nearEdge, nearEdge)
  assert(/· last /.test(stripAnsi(runStatusline(MAIN_SL, stdin, tmp).stdout)), 'still shown at 38s')

  const longGone = new Date(Date.now() - 45000)
  fs.utimesSync(cache, longGone, longGone)
  const expired = runStatusline(MAIN_SL, stdin, tmp)
  assert(expired.status === 0 && expired.stdout === '', 'past the window an unheard wave goes quiet')
})

// The regression that 0.2.6 shipped and its own test could not catch: a stale
// record proves the writer has not ticked, NOT that the wave ended. 0.2.6 read
// the two as equivalent and rendered `· ran` — a confident false claim — whenever
// a tick stalled mid-wave. The previous check passed throughout, because it only
// ever built records for waves that had genuinely stopped for good.
check('a stalled tick mid-wave is never reported as a finished wave', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'))
  const stdin = JSON.stringify({ session_id: 'smoke-sess' })
  const cache = path.join(tmp, 'claude-swarm-status-smoke-sess.json')

  // A wave that is running, whose panel then stalls for 20s.
  runStatusline(SUB_SL, JSON.stringify(SL_TASKS), tmp)
  const stalled = new Date(Date.now() - 20000)
  fs.utimesSync(cache, stalled, stalled)
  const seg = stripAnsi(runStatusline(MAIN_SL, stdin, tmp).stdout)
  assert(!/· ran /.test(seg), `a stall must not be reported as an ending, got "${seg}"`)

  // The wave is in fact still alive: the panel recovers and writes again. The
  // segment must return to live rather than staying stuck in a finished state.
  runStatusline(SUB_SL, JSON.stringify(SL_TASKS), tmp)
  const revived = stripAnsi(runStatusline(MAIN_SL, stdin, tmp).stdout)
  assert(/· oldest /.test(revived), `a recovered tick reads as live again, got "${revived}"`)

  // And a genuinely stamped end is still reported as one — the honest wording of
  // the unheard state must not have cost us the confident wording where it is
  // earned.
  runStatusline(SUB_SL, JSON.stringify({ session_id: 'smoke-sess', columns: 100, tasks: [] }), tmp)
  const ended = stripAnsi(runStatusline(MAIN_SL, stdin, tmp).stdout)
  assert(/· ran /.test(ended), `a stamped end still reads as "ran", got "${ended}"`)
})

// --- Report ----------------------------------------------------------------

Promise.all(pending).then(() => {
  for (const [status, name] of results) {
    console.log(`${status === 'ok' ? '  ok  ' : ' FAIL '}${name}`)
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  process.exit(failures ? 1 : 0)
})
