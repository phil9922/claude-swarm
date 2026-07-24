export const meta = {
  name: 'survey',
  description: 'Map an unfamiliar area of a codebase: fan out readers across angles, then synthesize one answer',
  whenToUse: 'When answering "how does X work" would mean reading many files into the main context. Pass the question as args (a string, or {question, angles, focus}).',
  phases: [
    { title: 'Locate', detail: 'cheap scouts find the surface area, one per angle' },
    { title: 'Trace', detail: 'a deep reader follows each angle it found' },
    { title: 'Synthesize', detail: 'one map assembled from every thread' },
  ],
}

// The runtime may deliver `args` as a JSON-encoded string (that is how the Workflow
// tool marshals a passed object). Normalize once: a string that parses to an object
// becomes structured input; a plain non-JSON string stays as the bare question.
let input = args
if (typeof input === 'string') {
  const s = input.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      input = JSON.parse(s)
    } catch (_) {
      /* not JSON — keep the plain string as the question */
    }
  }
}

const question =
  typeof input === 'string' ? input : (input && input.question) || 'How does this codebase work?'
const focus = (input && input.focus) || ''

const DEFAULT_ANGLES = [
  { key: 'entry', lens: 'Entry points and public API — how callers get in, what the exported surface is.' },
  { key: 'core', lens: 'Core implementation and data flow — where the real work happens and what it operates on.' },
  { key: 'state', lens: 'Configuration, persisted state, and defaults — what is read at startup and written at runtime.' },
  { key: 'tests', lens: 'Tests and invariants — what behavior is deliberately locked down, and what edge cases are named.' },
  { key: 'errors', lens: 'Error paths, edge cases, and failure handling — what happens when things go wrong.' },
]

// Only use provided angles when it is a non-empty array; an empty array must not
// collapse into the "nothing found" path below and mislabel a misconfig as a no-match.
const angles =
  input && Array.isArray(input.angles) && input.angles.length ? input.angles : DEFAULT_ANGLES

const LOCATIONS = {
  type: 'object',
  additionalProperties: false,
  required: ['locations', 'notes'],
  properties: {
    locations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'why'],
        properties: {
          path: { type: 'string', description: 'file path, with :line when known' },
          why: { type: 'string', description: 'one clause on why this is relevant' },
        },
      },
    },
    notes: { type: 'string', description: 'what was searched for and not found, or ambiguity worth flagging' },
  },
}

const THREAD = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'path', 'matters', 'gaps'],
  properties: {
    answer: { type: 'string', description: 'two or three sentences answering this angle' },
    path: { type: 'array', items: { type: 'string' }, description: 'the actual sequence as file:line steps' },
    matters: { type: 'array', items: { type: 'string' }, description: 'invariants, surprises, edge cases' },
    gaps: { type: 'string', description: 'what could not be determined, and what would settle it' },
  },
}

log(`Surveying ${angles.length} angles: ${question}`)

const threads = await pipeline(
  angles,

  (angle) =>
    agent(
      `Question under investigation: ${question}\n${focus ? `Focus area: ${focus}\n` : ''}
Your angle: ${angle.lens}

Find the files and lines relevant to THIS angle only. Search several ways before
concluding something is absent. Return locations, not explanations.`,
      { agentType: 'claude-swarm:scout', label: `locate:${angle.key}`, phase: 'Locate', schema: LOCATIONS },
    ),

  (found, angle) => {
    if (!found || !found.locations || found.locations.length === 0) {
      log(`  ${angle.key}: nothing found — ${(found && found.notes) || 'no detail'}`)
      return null
    }
    const list = found.locations.map((l) => `- ${l.path} — ${l.why}`).join('\n')
    return agent(
      `Question under investigation: ${question}

Your angle: ${angle.lens}

A scout found these starting points:
${list}
${found.notes ? `\nScout notes: ${found.notes}` : ''}

Read them and whatever they lead to. Follow the real control flow through
interfaces and indirection to the concrete implementation. Answer the angle.
The caller cannot see anything you read — your summary is all they get.`,
      { agentType: 'claude-swarm:tracer', label: `trace:${angle.key}`, phase: 'Trace', schema: THREAD },
    ).then((t) => {
      if (!t) {
        // Distinguish a tracer failure (the scout DID find locations) from an angle
        // that genuinely located nothing — otherwise the coverage line below lies.
        log(`  ${angle.key}: located, but tracing failed — dropped`)
        return null
      }
      return { angle: angle.key, lens: angle.lens, ...t }
    })
  },
)

const found = threads.filter(Boolean)

if (found.length === 0) {
  log('No angle produced a result.')
  return { question, answer: 'Nothing found — every angle either located nothing or failed to trace.', threads: [] }
}

if (found.length < angles.length) {
  log(`Coverage: ${found.length}/${angles.length} angles returned — the rest found nothing or failed to trace.`)
}

phase('Synthesize')

const brief = found
  .map(
    (t) =>
      `## ${t.angle} — ${t.lens}\n${t.answer}\n\nPath:\n${(t.path || []).map((s) => `- ${s}`).join('\n')}\n\nMatters:\n${(t.matters || []).map((m) => `- ${m}`).join('\n')}\n\nGaps: ${t.gaps}`,
  )
  .join('\n\n')

const map = await agent(
  `Assemble one coherent answer to this question from ${found.length} independent readings.

Question: ${question}

${brief}

Write the map the caller actually needs:
- Lead with a direct answer to the question, in a few sentences.
- Then the structure: how the pieces fit, as a followable path with file:line anchors.
- Then what matters: invariants, surprises, edge cases, anything deliberate-looking.
- Then gaps: what none of the readings established, and what would settle it.

Where two readings conflict, say so rather than averaging them — a conflict is a
finding. Do not invent connections the readings do not support. Do not restate
the obvious.`,
  { agentType: 'claude-swarm:tracer', label: 'synthesize', phase: 'Synthesize' },
)

return {
  question,
  // If synthesis itself failed, fall back to the raw readings rather than returning null.
  answer: map || `Synthesis failed; here are the ${found.length} raw readings:\n\n${brief}`,
  anglesCovered: found.map((t) => t.angle),
  anglesEmpty: angles.map((a) => a.key).filter((k) => !found.some((t) => t.angle === k)),
  threads: found,
}
