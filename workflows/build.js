export const meta = {
  name: 'build',
  description: 'Leaf and integration waves of an app build, driven by a validated work manifest',
  whenToUse:
    'After the master has written the foundation files, the signature stubs, and a work manifest — the master writes those itself; a serial foundation agent re-buys a plan the master already holds and fails the Shield test. Pass the manifest as args: {typecheck, foundation: [...], units: [{id, owns, reads, builds}], root?, concurrency?, batch?}. The manifest is validated by plain code before anything spawns.',
  phases: [
    { title: 'Leaves', detail: 'Sonnet leaves fill signature bodies, each gated on its own reads' },
    { title: 'Integrate', detail: 'state re-derived from the tree; mechanic fixes compiler-graded issues; Opus only for judgment calls' },
  ],
}

// The runtime may deliver `args` as a JSON-encoded string (that is how the
// Workflow tool marshals a passed object). Normalize once.
let input = args
if (typeof input === 'string') {
  const s = input.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      input = JSON.parse(s)
    } catch (_) {
      /* falls through to validation, which fails loudly */
    }
  }
}
if (!input || typeof input !== 'object' || Array.isArray(input)) {
  return {
    status: 'invalid-manifest',
    violations: ['args must be a manifest object: {typecheck, foundation, units, root?, concurrency?, batch?}'],
  }
}

const ROOT = typeof input.root === 'string' && input.root.trim() ? input.root.trim() : '.'
const TYPECHECK = input.typecheck
const FOUNDATION = Array.isArray(input.foundation) ? input.foundation : []
const UNITS = Array.isArray(input.units) ? input.units : []

// The two dials, one tradeoff seen from two sides. CONCURRENCY bounds how many
// leaf agents run at once — backpressure the raw promise wiring below must
// supply itself, because pipeline()/parallel() applied it for us and Promise.all
// does not, and a wide manifest dispatching every ready unit at once would slam
// the per-run cap. BATCH merges units whose read-sets nest into one agent:
// fewer cold starts (cost down), longer serial chains inside a branch (wall up).
// Raise BATCH / lower CONCURRENCY to trade wall time for cost; the defaults
// favor wall time, which is what this workflow exists to buy.
//
// CONCURRENCY defaults to the unit count, not a constant. A fixed default
// throttles the only phase fan-out can speed up: the first measured run
// (evals/shakedown-results.md) decomposed into 14 units against a default of 8,
// so the leaf wave queued into roughly two slot-waves on a machine whose
// harness cap — min(16, cores-2) — allowed 14 at once. Since batching can only
// merge units into FEWER agents, the unit count is a safe upper bound on agents
// in flight, and this default therefore never queues; it only stops a very wide
// manifest from dispatching unboundedly. Set it explicitly to go LOWER, trading
// wall time for cost. The harness applies its own cap regardless, so a value
// above that is quietly moot rather than harmful.
const CONCURRENCY_CAP = 12
const CONCURRENCY =
  Number.isInteger(input.concurrency) && input.concurrency > 0
    ? input.concurrency
    : // max(...,1) matters: an empty manifest would otherwise yield 0, and
      // withSlot's `while (active >= CONCURRENCY)` would never admit anyone.
      Math.min(Math.max(UNITS.length, 1), CONCURRENCY_CAP)
const BATCH = Number.isInteger(input.batch) && input.batch > 0 ? input.batch : 1
if (input.concurrency != null && !(Number.isInteger(input.concurrency) && input.concurrency > 0))
  log(`ignoring invalid concurrency=${JSON.stringify(input.concurrency)}; using ${CONCURRENCY}`)
if (input.batch != null && !(Number.isInteger(input.batch) && input.batch > 0))
  log(`ignoring invalid batch=${JSON.stringify(input.batch)}; using ${BATCH}`)

// ---- Manifest validation: plain code, no model, before anything spawns ------
//
// The manifest comes out of a model, so it will occasionally be wrong in ways
// that are cheap to catch here and expensive to discover mid-wave. Every check
// fails loudly with the specific violation; nothing spawns unless all pass.

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '')

// Inside-the-project check on the path string alone (workflow scripts have no
// filesystem access): relative, and never net-above the root after resolving
// each `..` segment.
function insideProject(p) {
  if (typeof p !== 'string' || !p.trim()) return false
  if (p.startsWith('/') || p.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(p)) return false
  let depth = 0
  for (const part of norm(p).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      depth--
      if (depth < 0) return false
    } else depth++
  }
  return true
}

// Key vocabulary, for misspelling detection: a manifest key the validator does
// not recognize is silently inert, and an inert `foundations:` (for
// `foundation:`) would otherwise surface as N misleading "neither in foundation
// nor owned" violations instead of one accurate warning naming the typo.
const TOP_KEYS = ['typecheck', 'root', 'foundation', 'units', 'concurrency', 'batch']
// `status` is accepted silently so a round-tripped manifest (units come back
// with a status field) can be re-submitted without noise.
const UNIT_KEYS = ['id', 'owns', 'reads', 'builds', 'status']

function editDistance(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) m[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return m[a.length][b.length]
}

function unknownKeyWarning(key, valid, where) {
  let best = null
  let d = Infinity
  for (const v of valid) {
    const e = editDistance(key.toLowerCase(), v)
    if (e < d) {
      d = e
      best = v
    }
  }
  return `${where}: unknown key "${key}"${d <= 3 ? ` — did you mean "${best}"?` : ''} (valid keys: ${valid.join(', ')})`
}

// Shared files a leaf must never own — written during integration instead.
const RESERVED = [
  { re: /^index\.(js|jsx|ts|tsx|mjs|cjs)$/i, why: 'barrel' },
  { re: /^package(-lock)?\.json$/i, why: 'package manifest' },
  { re: /^(yarn\.lock|pnpm-lock\.yaml)$/i, why: 'lockfile' },
  { re: /^tsconfig(\..+)?\.json$/i, why: 'compiler config' },
]

function validateManifest() {
  const v = []
  const warnings = []
  const owner = new Map() // normalized path -> owning unit id

  for (const k of Object.keys(input)) {
    if (!TOP_KEYS.includes(k)) warnings.push(unknownKeyWarning(k, TOP_KEYS, 'manifest'))
  }
  for (const u of UNITS) {
    if (!u || typeof u !== 'object' || Array.isArray(u)) continue
    const where = typeof u.id === 'string' && u.id.trim() ? `unit "${u.id}"` : 'unit (no id)'
    for (const k of Object.keys(u)) {
      if (!UNIT_KEYS.includes(k)) warnings.push(unknownKeyWarning(k, UNIT_KEYS, where))
    }
  }

  if (typeof TYPECHECK !== 'string' || !TYPECHECK.trim()) v.push('typecheck: a non-empty command string is required')
  if (ROOT !== '.' && !insideProject(ROOT)) v.push(`root escapes the project: ${ROOT}`)
  if (UNITS.length === 0) v.push('units: at least one unit is required')

  const foundationSet = new Set(FOUNDATION.map(norm))
  for (const f of FOUNDATION) if (!insideProject(f)) v.push(`foundation path escapes the project: ${f}`)

  const ids = new Set()
  for (const u of UNITS) {
    if (!u || typeof u !== 'object' || typeof u.id !== 'string' || !u.id.trim()) {
      v.push(`unit without a usable id: ${JSON.stringify(u).slice(0, 80)}`)
      continue
    }
    if (ids.has(u.id)) v.push(`duplicate unit id: ${u.id}`)
    ids.add(u.id)
    if (typeof u.builds !== 'string' || !u.builds.trim()) v.push(`${u.id}: a builds description is required`)
    if (!Array.isArray(u.owns) || u.owns.length === 0) {
      v.push(`${u.id}: owns must be a non-empty array of paths`)
      continue
    }
    for (const p of u.owns) {
      const n = norm(p)
      if (!insideProject(p)) v.push(`${u.id}: owned path escapes the project: ${p}`)
      const base = n.split('/').pop()
      for (const r of RESERVED)
        if (r.re.test(base)) v.push(`${u.id}: owns a shared file reserved for integration (${r.why}): ${p}`)
      if (foundationSet.has(n)) v.push(`${u.id}: owns a foundation file: ${p} — foundation is read-only for leaves`)
      if (owner.has(n) && owner.get(n) !== u.id)
        v.push(`path owned by more than one unit: ${p} (${owner.get(n)} and ${u.id})`)
      owner.set(n, u.id)
    }
  }

  for (const u of UNITS) {
    if (!u || typeof u.id !== 'string') continue
    if (u.reads != null && !Array.isArray(u.reads)) {
      v.push(`${u.id}: reads must be an array when present`)
      continue
    }
    for (const p of u.reads || []) {
      const n = norm(p)
      if (!insideProject(p)) v.push(`${u.id}: reads path escapes the project: ${p}`)
      else if (owner.get(n) === u.id)
        v.push(`${u.id}: reads a path it owns: ${p} — reads is for foundation and cross-unit dependencies`)
      else if (!foundationSet.has(n) && !owner.has(n))
        v.push(`${u.id}: reads ${p}, which is neither in foundation nor owned by any unit`)
    }
  }

  // Acyclic read/own graph, or the wave gating below would deadlock.
  const depsOf = new Map(
    UNITS.filter((u) => u && typeof u.id === 'string').map((u) => [
      u.id,
      [...new Set((u.reads || []).map(norm).map((n) => owner.get(n)).filter((d) => d && d !== u.id))],
    ]),
  )
  const state = new Map()
  const stack = []
  const visit = (id) => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      v.push(`dependency cycle: ${[...stack.slice(stack.indexOf(id)), id].join(' → ')}`)
      return
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const d of depsOf.get(id) || []) visit(d)
    stack.pop()
    state.set(id, 'done')
  }
  for (const id of depsOf.keys()) visit(id)

  return { violations: v, warnings, owner }
}

const { violations, warnings, owner } = validateManifest()
for (const w of warnings) log(`  ⚠ ${w}`)
if (violations.length) {
  log(`manifest invalid — ${violations.length} violation(s); nothing was spawned:`)
  for (const x of violations) log(`  ✗ ${x}`)
  return { status: 'invalid-manifest', violations, warnings }
}

// ---- Leaf wave --------------------------------------------------------------

const LEAF_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      description: 'exactly one entry per unit you were given',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['unit', 'status', 'notes'],
        properties: {
          unit: { type: 'string', description: 'the unit id' },
          status: { type: 'string', enum: ['done', 'partial', 'failed'] },
          notes: { type: 'string', description: 'what remains or deserves integration attention; empty if nothing' },
        },
      },
    },
  },
}

// Batch by nested read-sets: cache benefit comes from a shared PREFIX, not set
// equality, so a unit may join a batch whose base read-set contains its own.
// Widest read-sets seed the batches so the broadest set defines each base; the
// prompt then lists shared reads first so the common portion is read before
// anything branch-specific.
const readsOf = (u) => [...new Set((u.reads || []).map(norm))]
const protoBatches = []
for (const u of [...UNITS].sort((a, b) => readsOf(b).length - readsOf(a).length)) {
  const rs = readsOf(u)
  const home = protoBatches.find((b) => b.units.length < BATCH && rs.every((r) => b.base.has(r)))
  if (home) home.units.push(u)
  else protoBatches.push({ base: new Set(rs), units: [u] })
}
// Subset merging can put an owner and its reader in the same agent, so order
// each batch owner-first — the prompt tells the leaf the list is build order.
const batches = protoBatches.map(({ units }) => {
  const ids = new Set(units.map((u) => u.id))
  const ordered = []
  const placed = new Set()
  const place = (u) => {
    if (placed.has(u.id)) return
    placed.add(u.id)
    for (const n of (u.reads || []).map(norm)) {
      const d = owner.get(n)
      if (d && ids.has(d) && d !== u.id) place(units.find((x) => x.id === d))
    }
    ordered.push(u)
  }
  units.forEach(place)
  return ordered
})

// One deferred per unit, so every batch gates on exactly the owners of its own
// reads — the partial ordering pipeline() cannot express. Owners settle whether
// they succeed or fail (signature stubs exist on disk either way), so a failed
// dependency delays nothing and deadlock is impossible on the validated acyclic
// graph.
const settle = new Map()
const done = new Map()
for (const u of UNITS) done.set(u.id, new Promise((res) => settle.set(u.id, res)))

// Backpressure for the raw wiring — see the CONCURRENCY comment above.
let active = 0
const waiters = []
async function withSlot(fn) {
  while (active >= CONCURRENCY) await new Promise((r) => waiters.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    const w = waiters.shift()
    if (w) w()
  }
}

// The project type check, sibling-filtered to one batch's owned files. Ten
// concurrent leaves against one project-wide tsc would each see errors from
// siblings' unfilled stubs; telling a leaf those aren't its problem is prompt
// discipline, pre-filtering the output is actual scoping — and chased sibling
// errors would inflate the repair-cycle metric with contamination that can't
// be separated from signature quality afterward.
//
// Capture-then-filter, not a bare pipe, because a pipe gets both edges wrong:
// its exit status is grep's, which is 1 exactly when the run is clean (a leaf
// checking $? sees failure and repairs nothing), and a tool that fails to run
// at all ("tsc: command not found", a config error) emits no line matching an
// owned path, so the pipe reads a broken grader as a clean pass. The script
// runs the unfiltered command first, then branches: exit > 1 or a fileless
// "error TS" diagnostic means the TOOL is broken (say so, dump the output);
// otherwise filter to owned files, with a positive marker for clean. The
// script's own exit status is always 0 — deliberately meaningless, so the
// verdict can only be read from the output.
function scopedCheck(batch) {
  const files = [...new Set(batch.flatMap((u) => u.owns.map(norm)))]
  const filter = files.map((f) => `-e "${f}"`).join(' ')
  return `OUT=$(${TYPECHECK} 2>&1); CODE=$?
if [ $CODE -gt 1 ] || printf '%s\\n' "$OUT" | grep -q "^error TS"; then
  echo "TYPECHECK-BROKEN exit=$CODE"; printf '%s\\n' "$OUT" | head -30
else
  printf '%s\\n' "$OUT" | grep -F ${filter} || echo "OWNED-FILES-CLEAN"
fi`
}

function leafPrompt(batch) {
  const shared =
    batch.length > 1 ? readsOf(batch[0]).filter((r) => batch.every((u) => readsOf(u).includes(r))) : []
  const units = batch
    .map(
      (u) =>
        `## Unit ${u.id}\nBuilds: ${u.builds}\nOwns (write ONLY these): ${u.owns.join(', ')}\nReads (contracts to build against): ${(u.reads || []).join(', ') || '(none)'}`,
    )
    .join('\n\n')
  return `You are one leaf of a build wave. Project root: ${ROOT}.
${shared.length ? `\nRead these shared contract files first — every unit below builds against them:\n${shared.map((s) => `- ${s}`).join('\n')}\n` : ''}
${units}

Units are listed in build order: if a unit's owned file appears in a later unit's
reads, complete the owner before starting the reader.

The owned files already exist with exact signatures and compiling placeholder
bodies. Fill the bodies. Do not change any signature. Do not create or edit any
file outside the owned paths above — barrels, route registries, and package
manifests are written during integration, and other units' files are being filled
concurrently.

Extend each owned file's import line as you write: implementations routinely need
types the signature never names — that is what your reads list is for — and a
missing import is an expected, avoidable repair cycle, cheapest fixed at write
time.

Before returning, run this sibling-filtered type check (from ${ROOT}), exactly as
written:

\`\`\`sh
${scopedCheck(batch)}
\`\`\`

Judge it by its OUTPUT ONLY — the script's exit status is deliberately meaningless:
- "OWNED-FILES-CLEAN" → your files are type-clean; that is the bar for "done".
- Error lines naming your files → yours to fix.
- "TYPECHECK-BROKEN" → the type-check tooling itself failed. Do NOT claim done:
  report status "failed" with the tool output in your notes.
Sibling stubs' errors are pre-filtered out: they are not yours, never chase them.

Return one result per unit above, by id. Be honest: "done" only if complete and
type-clean in your files.`
}

phase('Leaves')
log(`${UNITS.length} unit(s) in ${batches.length} leaf agent(s); concurrency ${CONCURRENCY}, batch ${BATCH}`)

const waves = batches.map((batch) => {
  const inBatch = new Set(batch.map((u) => u.id))
  const deps = [
    ...new Set(
      batch
        .flatMap((u) => (u.reads || []).map(norm))
        .map((n) => owner.get(n))
        .filter((d) => d && !inBatch.has(d)),
    ),
  ]
  return Promise.all(deps.map((d) => done.get(d)))
    .then(() =>
      withSlot(() =>
        agent(leafPrompt(batch), {
          agentType: 'claude-swarm:leaf',
          label: `leaf:${batch.map((u) => u.id).join('+')}`,
          phase: 'Leaves',
          schema: LEAF_RESULT,
        }),
      ),
    )
    .then((res) => {
      const reported = new Map((((res && res.results) || [])).map((r) => [r.unit, r]))
      for (const u of batch) {
        const r = reported.get(u.id)
        // A missing structured return is SILENT — measured: a turn-capped agent
        // comes back as "(Subagent completed but returned no output.)" with no
        // cap marker at all. So absence is 'unknown', never 'failed': the leaf
        // may have finished the files and died reporting. Integration re-derives
        // the truth from the tree either way.
        settle.get(u.id)(
          r
            ? { unit: u.id, status: r.status, notes: r.notes }
            : { unit: u.id, status: 'unknown', notes: 'no structured return — possibly turn-capped; disk state is authoritative' },
        )
      }
    })
    .catch((e) => {
      // Status object, not null: a missing component is a broken app, and
      // integration must be able to tell failure from silence.
      for (const u of batch) settle.get(u.id)({ unit: u.id, status: 'failed', error: String((e && e.message) || e) })
    })
})
await Promise.all(waves)
const leafStatus = await Promise.all(UNITS.map((u) => done.get(u.id)))

const claimed = { done: 0, partial: 0, failed: 0, unknown: 0 }
for (const s of leafStatus) claimed[s.status] = (claimed[s.status] || 0) + 1
log(
  `leaf wave settled: ${claimed.done} done, ${claimed.partial} partial, ${claimed.failed} failed, ` +
    `${claimed.unknown} unknown (claims only — integration re-derives from the tree)`,
)

// ---- Integration ------------------------------------------------------------

phase('Integrate')

const INTEGRATION = {
  type: 'object',
  additionalProperties: false,
  required: ['unitsVerified', 'sharedFilesWritten', 'fixed', 'typecheck', 'judgment'],
  properties: {
    unitsVerified: {
      type: 'array',
      description: 'one entry per unit, derived from the tree, not from reports',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['unit', 'filesPresent', 'nonEmpty'],
        properties: {
          unit: { type: 'string' },
          filesPresent: { type: 'boolean', description: 'every owned path exists' },
          nonEmpty: { type: 'boolean', description: 'no owned file is an unfilled stub' },
          notes: { type: 'string' },
        },
      },
    },
    sharedFilesWritten: { type: 'array', items: { type: 'string' } },
    fixed: { type: 'array', items: { type: 'string' }, description: 'compiler-graded fixes applied' },
    typecheck: { type: 'string', enum: ['pass', 'fail'], description: 'the final state, as it actually ended' },
    judgment: {
      type: 'array',
      description: 'issues needing a design decision — NOT compiler-fixable. Leave them untouched.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'where'],
        properties: { issue: { type: 'string' }, where: { type: 'string' } },
      },
    },
  },
}

const unitTable = UNITS.map((u) => {
  const s = leafStatus.find((x) => x.unit === u.id)
  return `- ${u.id} [leaf claimed: ${s.status}]: ${u.owns.join(', ')}`
}).join('\n')

const integ = await agent(
  `The leaf wave of a build has finished. Project root: ${ROOT}.

Re-derive the actual state from the tree — leaf claims may be missing or wrong (a
turn-capped leaf returns nothing at all):

${unitTable}

1. Per unit: do all its owned files exist, and are they filled rather than stubs?
   Establish this with ONE cheap sweep over the owned paths — sizes plus a search
   for the placeholder marker ("not implemented") — not by reading each file. You
   are the only agent running at this point, so every file you read is serial wall
   time spent before any fixing starts. Open only what the sweep flags: missing,
   suspiciously small, or still carrying the placeholder.
2. Write the shared files leaves were forbidden to touch: barrels/index files, the
   route registry, anything that aggregates the units. List what you wrote.
3. Run \`${TYPECHECK}\` from ${ROOT}. Fix what the compiler grades — imports, paths,
   missing exports, type mismatches at unit seams — and re-run until it passes or
   the remaining errors need a design decision.
4. Anything needing a design decision — contradictory contracts, a signature that
   cannot work as declared — goes in judgment, untouched. Do NOT redesign.

Report typecheck as it actually ended, not as it should have.`,
  { agentType: 'claude-swarm:mechanic', label: 'integrate:mechanic', phase: 'Integrate', schema: INTEGRATION },
)

let judgmentReport = null
if (integ && integ.judgment.length) {
  log(`${integ.judgment.length} judgment call(s) escalated to opus`)
  judgmentReport = await agent(
    `Integration of a freshly built app surfaced issues that need judgment — the
mechanical pass already fixed everything compiler-graded. Project root: ${ROOT};
type check: \`${TYPECHECK}\`.

${integ.judgment.map((j) => `- ${j.issue} (${j.where})`).join('\n')}

Resolve each with the smallest correct change, run the type check, and report what
you decided and why.`,
    { agentType: 'claude-swarm:implementer', label: 'integrate:judgment', phase: 'Integrate' },
  )
}

const verifiedOk =
  integ && integ.typecheck === 'pass' && integ.unitsVerified.every((x) => x.filesPresent && x.nonEmpty)

return {
  status: !integ ? 'unverified' : verifiedOk && !(integ.judgment.length && !judgmentReport) ? 'complete' : 'partial',
  ...(warnings.length ? { warnings } : {}),
  units: leafStatus,
  integration: integ || 'integration agent failed to run — tree state is unverified, run the type check yourself',
  judgment: judgmentReport,
  note:
    'Unit truth is the tree, not the leaf claims: integration re-checked every owned path and the type check. ' +
    'Live completions were appended to .claude-swarm-feed.log by the SubagentStop feed.',
}
