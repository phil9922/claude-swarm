export const meta = {
  name: 'audit',
  description: 'Find problems across multiple lenses, then adversarially verify each one so only real findings survive',
  whenToUse: 'Reviewing a diff, auditing a subsystem, or hunting bugs. Pass args as a string (what to audit) or {target, lenses, votes}. Findings are refuted by default — survivors are worth trusting.',
  phases: [
    { title: 'Find', detail: 'one deep reader per lens, in parallel' },
    { title: 'Verify', detail: 'independent skeptics try to refute each finding' },
  ],
}

const target =
  typeof args === 'string' ? args : (args && args.target) || 'the uncommitted changes on this branch'
const VOTES = (args && args.votes) || 2

const DEFAULT_LENSES = [
  { key: 'correctness', lens: 'Logic errors: off-by-one, inverted conditions, wrong operator, unhandled nil/empty/zero, incorrect early return, state mutated in the wrong order.' },
  { key: 'errors', lens: 'Error handling: errors swallowed or logged-and-ignored, failures that leave partial state, misleading fallbacks that hide the real cause, missing cleanup on the error path.' },
  { key: 'concurrency', lens: 'Concurrency: data races, unsynchronized shared state, lock ordering, goroutine/thread leaks, work started but never awaited, context not propagated or not honored.' },
  { key: 'boundaries', lens: 'Boundaries and edge cases: empty collections, zero values, very large inputs, malformed input, already-exists, permission denied, resource exhaustion, the second call rather than the first.' },
  { key: 'tests', lens: 'Test coverage: paths with no test, tests that pass for an unrelated reason, tests that would still pass if the code under test were reverted, fixtures that mask the real condition.' },
  { key: 'contract', lens: 'Contract drift: code that does not do what its name, comment, or docs claim; a default that contradicts documentation; an invariant asserted in one place and violated in another.' },
]

const lenses = (args && args.lenses) || DEFAULT_LENSES

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

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'reason', 'tested'],
  properties: {
    refuted: { type: 'boolean', description: 'true if the claim does not hold. Default true when genuinely unsure.' },
    reason: { type: 'string', description: 'the evidence, anchored to what you read or ran' },
    tested: { type: 'boolean', description: 'true only if you actually executed something rather than reasoning' },
  },
}

const LENSES_OF_DOUBT = [
  'Does this actually reproduce? Construct the failing case and run it if you can. If the code path cannot be reached with real inputs, the finding is refuted.',
  'Is the stated cause the real cause? Check whether something upstream already prevents this, or whether the described mechanism is merely correlated with a different one.',
  'Is this contradicted by the tests or by existing behavior? If a test already covers this and passes, work out why — either the finding is wrong or the test is.',
]

log(`Auditing ${target} across ${lenses.length} lenses, ${VOTES}-vote refutation`)

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
    log(`  ${l.key}: ${findings.length} candidate${findings.length === 1 ? '' : 's'} → verifying`)

    return parallel(
      findings.map((f) => () =>
        parallel(
          LENSES_OF_DOUBT.slice(0, VOTES + 1).map((doubt, i) => () =>
            agent(
              `A finding has been reported. Your job is to REFUTE it.

Title: ${f.title}
Location: ${f.file}
Claim: ${f.claim}
Claimed failure: ${f.failure}

Your angle of attack: ${doubt}

Check the artifact, not the story. Read the actual code. Run the actual case where
you can. Default to refuted=true if you genuinely cannot establish the claim —
an unproven finding must not survive as a confirmed one.`,
              { agentType: 'claude-swarm:verifier', label: `refute:${f.title.slice(0, 32)}#${i}`, phase: 'Verify', schema: VERDICT },
            ),
          ),
        ).then((votes) => {
          const cast = votes.filter(Boolean)
          const survived = cast.filter((v) => !v.refuted).length
          return {
            ...f,
            lens: l.key,
            survived,
            cast: cast.length,
            executed: cast.some((v) => v.tested),
            verdicts: cast.map((v) => ({ refuted: v.refuted, reason: v.reason })),
          }
        }),
      ),
    )
  },
)

const judged = perLens.flat().filter(Boolean)
const confirmed = judged.filter((f) => f.survived >= VOTES)
const killed = judged.length - confirmed.length

log(`${judged.length} candidates → ${confirmed.length} confirmed, ${killed} refuted`)

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
  refutedCount: killed,
  lensesClean: emptyLenses,
  note: `Findings surviving ${VOTES} of ${VOTES + 1} independent refutation attempts. Lenses returning nothing: ${emptyLenses.length ? emptyLenses.join(', ') : 'none'}.`,
}
