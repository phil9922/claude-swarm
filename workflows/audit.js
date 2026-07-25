export const meta = {
  name: 'audit',
  description: 'Find problems across multiple lenses, then adversarially verify each one so only real findings survive',
  whenToUse: 'Reviewing a diff, auditing a subsystem, or hunting bugs. Pass args as a string (what to audit) or {target, lenses, votes}. Findings are refuted by default — survivors are worth trusting.',
  phases: [
    { title: 'Find', detail: 'one deep reader per lens, in parallel' },
    { title: 'Verify', detail: 'independent skeptics try to refute each finding' },
  ],
}

// The runtime may deliver `args` as a JSON-encoded string (that is how the Workflow
// tool marshals a passed object). Normalize once: a string that parses to an object
// becomes structured input; a plain non-JSON string stays as the bare target.
let input = args
if (typeof input === 'string') {
  const s = input.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      input = JSON.parse(s)
    } catch (_) {
      /* not JSON — keep the plain string as the target */
    }
  }
}

const target =
  typeof input === 'string' ? input : (input && input.target) || 'the uncommitted changes on this branch'
// Required surviving (non-refuting) votes to confirm. Validate explicitly so an
// intentional 0 is not swallowed by `||`, and a negative/non-integer does not wedge
// the threshold. Any coercion is logged, never silent.
const rawVotes = input && typeof input === 'object' ? input.votes : undefined
let VOTES = 2
if (rawVotes != null) {
  if (Number.isInteger(rawVotes) && rawVotes >= 0) VOTES = rawVotes
  else log(`ignoring invalid votes=${JSON.stringify(rawVotes)}; using default ${VOTES}`)
}

const DEFAULT_LENSES = [
  { key: 'correctness', lens: 'Logic errors: off-by-one, inverted conditions, wrong operator, unhandled nil/empty/zero, incorrect early return, state mutated in the wrong order.' },
  { key: 'errors', lens: 'Error handling: errors swallowed or logged-and-ignored, failures that leave partial state, misleading fallbacks that hide the real cause, missing cleanup on the error path.' },
  { key: 'concurrency', lens: 'Concurrency: data races, unsynchronized shared state, lock ordering, goroutine/thread leaks, work started but never awaited, context not propagated or not honored.' },
  { key: 'boundaries', lens: 'Boundaries and edge cases: empty collections, zero values, very large inputs, malformed input, already-exists, permission denied, resource exhaustion, the second call rather than the first.' },
  { key: 'tests', lens: 'Test coverage: paths with no test, tests that pass for an unrelated reason, tests that would still pass if the code under test were reverted, fixtures that mask the real condition.' },
  { key: 'contract', lens: 'Contract drift: code that does not do what its name, comment, or docs claim; a default that contradicts documentation; an invariant asserted in one place and violated in another.' },
]

// Only use provided lenses when it is a non-empty array; an empty array must not
// silently produce a zero-lens (false-clean) audit.
const lenses =
  input && Array.isArray(input.lenses) && input.lenses.length ? input.lenses : DEFAULT_LENSES

const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'claim', 'failure'],
        properties: {
          title: { type: 'string', description: 'short label, under 60 chars' },
          file: { type: 'string', description: 'path:line where it lives' },
          claim: { type: 'string', description: 'one sentence stating the defect' },
          failure: { type: 'string', description: 'concrete inputs or state, and the wrong result they produce' },
        },
      },
    },
  },
}

// One verdict per finding in a batch. Batching is the whole point: a skeptic reads
// the file once and judges every claim against it, instead of one spawn per claim
// each re-establishing the same context. Context re-establishment was measured at
// ~34% of this plugin's delegated spend.
const BATCH_VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      description: 'exactly one entry per finding, identified by the [index] it was given',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'refuted', 'reason', 'tested'],
        properties: {
          index: { type: 'integer', description: 'the [index] of the finding this verdict is for' },
          refuted: { type: 'boolean', description: 'true if the claim does not hold. Default true when genuinely unsure.' },
          reason: { type: 'string', description: 'the evidence, anchored to what you read or ran' },
          tested: { type: 'boolean', description: 'true only if you actually executed something rather than reasoning' },
        },
      },
    },
  },
}

// Findings judged together in one context. Large enough to amortise the read,
// small enough that no single prompt turns into a wall of unrelated claims.
const BATCH_LIMIT = 8

function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const LENSES_OF_DOUBT = [
  'Does this actually reproduce? Construct the failing case and run it if you can. If the code path cannot be reached with real inputs, the finding is refuted.',
  'Is the stated cause the real cause? Check whether something upstream already prevents this, or whether the described mechanism is merely correlated with a different one.',
  'Is this contradicted by the tests or by existing behavior? If a test already covers this and passes, work out why — either the finding is wrong or the test is.',
]

// Run VOTES + 1 skeptics per finding, cycling the doubt angles when more are needed
// than the pool holds, so a higher `votes` raises scrutiny instead of making
// confirmation (survived >= VOTES) mathematically impossible.
const skeptics = Array.from(
  { length: VOTES + 1 },
  (_, i) => LENSES_OF_DOUBT[i % LENSES_OF_DOUBT.length],
)

/**
 * One skeptic, one batch of findings, one angle of attack. Returns a map of
 * finding-index -> verdict. A finding the skeptic does not return a verdict for
 * is deliberately absent rather than assumed refuted: an agent that failed to
 * run must never be scored as a refutation.
 */
async function judge(batch, doubt, l, wave) {
  const list = batch
    .map(
      (f, i) =>
        `[${i}] ${f.title}\n    Location: ${f.file}\n    Claim: ${f.claim}\n    Claimed failure: ${f.failure}`,
    )
    .join('\n\n')

  const res = await agent(
    `${batch.length} finding(s) have been reported against the same area. Your job is to REFUTE each one.

${list}

Your angle of attack: ${doubt}

Check the artifact, not the story. Read the actual code once, then judge every finding
above against what you read. Run the actual case where you can. Default to refuted=true
for any finding whose claim you genuinely cannot establish — an unproven finding must not
survive as a confirmed one.

Return exactly one verdict per finding, using the [index] shown above. Judge each finding
on its own evidence: these are unrelated claims that happen to share a file, so refuting
one says nothing about the next.`,
    {
      agentType: 'claude-swarm:verifier',
      label: `refute:${l.key}#${wave}`,
      phase: 'Verify',
      schema: BATCH_VERDICT,
    },
  )

  const byIndex = new Map()
  for (const v of (res && res.verdicts) || []) {
    if (Number.isInteger(v.index) && v.index >= 0 && v.index < batch.length) byIndex.set(v.index, v)
  }
  return byIndex
}

/**
 * Verify a batch, escalating only where it matters.
 *
 * Wave 1 sends a single skeptic. A refutation there is terminal — and since
 * skeptics refute by default when unsure, most weak candidates die in that one
 * cheap pass. Only survivors face the remaining angles.
 *
 * The confirmation threshold is unchanged: a finding still needs to survive
 * VOTES of VOTES+1 independent attempts. Escalation is skipped only for findings
 * that already cannot reach it, so this cuts cost without lowering the bar.
 */
async function verifyBatch(batch, l) {
  const first = await judge(batch, skeptics[0], l, 0)

  const state = batch.map((f, i) => {
    const v = first.get(i)
    return {
      f,
      cast: v ? 1 : 0,
      survived: v && !v.refuted ? 1 : 0,
      executed: !!(v && v.tested),
      verdicts: v ? [{ refuted: v.refuted, reason: v.reason }] : [],
      alive: !!v && !v.refuted,
    }
  })

  const survivors = state.filter((s) => s.alive)
  const remaining = skeptics.slice(1)

  if (survivors.length && remaining.length) {
    const subset = survivors.map((s) => s.f)
    const waves = await parallel(
      remaining.map((doubt, i) => () => judge(subset, doubt, l, i + 1)),
    )
    for (const res of waves.filter(Boolean)) {
      survivors.forEach((s, i) => {
        const v = res.get(i)
        if (!v) return
        s.cast += 1
        if (!v.refuted) s.survived += 1
        if (v.tested) s.executed = true
        s.verdicts.push({ refuted: v.refuted, reason: v.reason })
      })
    }
  }

  return state.map((s) => ({
    ...s.f,
    lens: l.key,
    survived: s.survived,
    cast: s.cast,
    executed: s.executed,
    verdicts: s.verdicts,
  }))
}

log(
  `Auditing ${target} across ${lenses.length} lenses, ${VOTES}-vote refutation ` +
    `(batched ${BATCH_LIMIT}/verifier, escalating only survivors)`,
)

const perLens = await pipeline(
  lenses,

  (l) =>
    agent(
      `Audit target: ${target}

Your lens: ${l.lens}

Report only defects you can point at a specific line for, with a concrete failure
scenario — real inputs or state, and the wrong output or crash they produce.
"This could be fragile" is not a finding. Read the tests and the surrounding code
before concluding something is broken; a lot of odd-looking code is deliberate.

Report everything that meets that bar, including ones you are unsure about — a
separate verification stage will filter. Your job here is coverage, not judgement.
If the lens finds nothing, return an empty list rather than padding.`,
      { agentType: 'claude-swarm:tracer', label: `find:${l.key}`, phase: 'Find', schema: FINDINGS },
    ),

  (result, l) => {
    const findings = (result && result.findings) || []
    if (findings.length === 0) {
      log(`  ${l.key}: clean`)
      return []
    }
    const batches = chunk(findings, BATCH_LIMIT)
    log(
      `  ${l.key}: ${findings.length} candidate${findings.length === 1 ? '' : 's'} → verifying ` +
        `in ${batches.length} batch${batches.length === 1 ? '' : 'es'}`,
    )

    return parallel(batches.map((batch) => () => verifyBatch(batch, l))).then((groups) =>
      groups.filter(Boolean).flat(),
    )
  },
)

const judged = perLens.flat().filter(Boolean)
// A finding whose skeptics all failed to run (cast === 0) is unverified, NOT refuted —
// bucket it separately so a transient verifier outage is never scored as a refutation.
const verified = judged.filter((f) => f.cast > 0)
const unverified = judged.filter((f) => f.cast === 0)
const confirmed = verified.filter((f) => f.survived >= VOTES)
const refuted = verified.filter((f) => f.survived < VOTES)

log(
  `${judged.length} candidates → ${confirmed.length} confirmed, ${refuted.length} refuted` +
    (unverified.length ? `, ${unverified.length} unverified (skeptics failed to run)` : ''),
)

const emptyLenses = lenses
  .map((l) => l.key)
  .filter((k) => !judged.some((f) => f.lens === k))

return {
  target,
  confirmed: confirmed
    .sort((a, b) => b.survived - a.survived)
    .map((f) => ({
      title: f.title,
      file: f.file,
      claim: f.claim,
      failure: f.failure,
      lens: f.lens,
      confidence: `${f.survived}/${f.cast} skeptics failed to refute`,
      executed: f.executed,
    })),
  refutedCount: refuted.length,
  unverified: unverified.map((f) => ({ title: f.title, file: f.file, lens: f.lens })),
  lensesClean: emptyLenses,
  note: `Findings surviving ${VOTES} of ${VOTES + 1} independent refutation attempts. A first
skeptic judges every candidate; only those it fails to refute face the remaining angles, so
the threshold is unchanged while refuted candidates cost one pass instead of ${VOTES + 1}.${
    unverified.length
      ? ` ${unverified.length} finding(s) could not be verified (all skeptics failed) and are reported separately, not as refuted.`
      : ''
  } Lenses returning nothing: ${emptyLenses.length ? emptyLenses.join(', ') : 'none'}.`,
}
