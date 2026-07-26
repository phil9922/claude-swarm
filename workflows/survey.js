export const meta = {
  name: 'survey',
  description: 'Map an area of a codebase in one wave: one reader per angle, one synthesis',
  whenToUse:
    'When "how does X work" would mean reading many files into the main context. Pass args as a string question, or {question, angles, focus, files}. If the relevant files are already known, pass them as files — readers skip discovery and go straight to them. This is a latency-and-shield play, not a cost win: it returns sooner than reading solo and keeps the sources out of the main window, but the angles share their input, so it costs more than one context reading once.',
  phases: [
    { title: 'Read', detail: 'one locate-and-read agent per angle' },
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
// Files the caller already knows are relevant. When present, readers skip
// discovery entirely — the master usually already knows where to look, and
// paying five agents to re-discover a known file list is pure overhead.
const files = input && Array.isArray(input.files) && input.files.length ? input.files : null

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

log(`Surveying ${angles.length} angles${files ? ` across ${files.length} known files` : ''}: ${question}`)

// One wave: each angle is a single agent that locates (unless the caller already
// did) and reads. The old shape — a scout wave feeding a tracer wave — bought the
// same files three times across three chained stages and measured 3.95x solo cost
// at 4.63x the wall time; merged readers pay for them once.
const threads = await parallel(
  angles.map((angle) => () =>
    agent(
      `Question under investigation: ${question}
${focus ? `Focus area: ${focus}\n` : ''}
Your angle: ${angle.lens}
${
  files
    ? `\nThe caller already knows the relevant files — start from these, do not re-discover them:\n${files.map((f) => `- ${f}`).join('\n')}\n`
    : `\nFirst find the files relevant to THIS angle — search several ways before concluding something is absent — then read them.`
}
Read what you find and whatever it leads to. Follow the real control flow through
interfaces and indirection to the concrete implementation. Answer the angle.
The caller cannot see anything you read — your summary is all they get.`,
      { agentType: 'claude-swarm:tracer', label: `read:${angle.key}`, phase: 'Read', schema: THREAD },
    ).then((t) => (t ? { angle: angle.key, lens: angle.lens, ...t } : null)),
  ),
)

const found = threads.filter(Boolean)

if (found.length === 0) {
  log('No angle produced a result.')
  return { question, answer: 'Nothing found — every angle either located nothing or failed.', threads: [] }
}

if (found.length < angles.length) {
  log(`Coverage: ${found.length}/${angles.length} angles returned — the rest found nothing or failed.`)
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
