#!/usr/bin/env node
/**
 * claude-swarm SubagentStop hook: the completion feed.
 *
 * Appends one line per finished subagent — timestamp, agent type, and what the
 * agent returned — to `.claude-swarm-feed.log` in the project directory. A
 * status window at zero token cost: `tail -f` it during a build wave instead of
 * polling agents.
 *
 * "What the agent returned" is the first line of its final message when that
 * message is prose, and a compact JSON of its `StructuredOutput` input when the
 * agent returned a structured result instead. The second case is not a fallback
 * for a missing message — for a schema-constrained `agent()` it IS the return
 * value, and treating it as silence is what made the whole leaf wave of the
 * first shakedown read as `(no output)` and cost that run its `unknown` metric.
 * A genuinely silent agent — turn-capped mid-tool-call — still logs
 * `(no output)`, because the build workflow acts on that signal and it has to
 * stay distinguishable from a quiet finish.
 *
 * MUST always exit 0. On SubagentStop, exit code 2 BLOCKS the subagent from
 * stopping ("Prevents the subagent from stopping" — hooks reference), so any
 * failure here is swallowed: a broken feed line must never wedge an agent.
 */

'use strict'

const MAX_TAIL = 512 * 1024 // agent transcripts run ~50-150KB; read the end only

/**
 * The last thing the subagent said, recovered from its own transcript.
 *
 * Measured on Claude Code 2.1.220: the payload carries `last_assistant_message`
 * only when the subagent's final turn ended with prose. When it ends by calling
 * a turn-ending tool — `StructuredOutput`, which every schema-constrained
 * workflow `agent()` uses — the key is ABSENT from the payload entirely, and a
 * whole build wave reads as "(no output)". The payload does always carry
 * `agent_transcript_path`, so read the final message out of that instead.
 *
 * Scoped to the final assistant message deliberately (the transcript splits one
 * message across a record per content block, so group by `message.id`): mid-run
 * narration is not a final message, and a turn-capped agent that stopped inside
 * a tool call really did return nothing. That silence is a signal the build
 * workflow acts on, so it has to stay distinguishable from a quiet finish.
 */
function fromTranscript(file) {
  const fs = require('fs')
  const fd = fs.openSync(file, 'r')
  let text
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - MAX_TAIL)
    const buf = Buffer.alloc(Math.min(size, MAX_TAIL))
    fs.readSync(fd, buf, 0, buf.length, start)
    text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1) // drop the partial line
  } finally {
    fs.closeSync(fd)
  }

  const msgs = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const rec = JSON.parse(line)
      if (rec && rec.type === 'assistant' && rec.message) msgs.push(rec.message)
    } catch (_) {
      /* a truncated or non-JSON line is not a message */
    }
  }
  if (!msgs.length) return ''

  const id = msgs[msgs.length - 1].id
  const blocks = []
  for (const m of msgs) {
    if (m.id === id && Array.isArray(m.content)) blocks.push(...m.content)
  }

  const said = blocks
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim()
  if (said) return said

  // No closing prose, but a structured return is still output — and reporting it
  // as silence is exactly what would inflate the "unknown" rate the eval reads.
  const structured = blocks.find((b) => b && b.type === 'tool_use' && b.name === 'StructuredOutput')
  return structured ? JSON.stringify(structured.input) : ''
}

let raw = ''
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  try {
    const o = JSON.parse(raw)
    // For plugin subagents agent_type is the scoped identifier
    // ("claude-swarm:leaf"), which is exactly what the feed should show.
    const who = o.agent_type || o.agent_id || '?'
    let said = String(o.last_assistant_message || '').trim()
    if (!said && o.agent_transcript_path) {
      try {
        said = fromTranscript(String(o.agent_transcript_path))
      } catch (_) {
        /* unreadable transcript — fall through to "(no output)" */
      }
    }
    said = said.replace(/\s+/g, ' ').trim().slice(0, 120)
    const line = `${new Date().toISOString()}\t${who}\t${said || '(no output)'}\n`
    const path = require('path')
    const fs = require('fs')
    const dir = process.env.CLAUDE_PROJECT_DIR || o.cwd || process.cwd()
    fs.appendFileSync(path.join(dir, '.claude-swarm-feed.log'), line)
  } catch (_) {
    /* swallow — see header */
  }
  process.exit(0)
})
// stdin never arriving must not leave a hung hook process behind.
setTimeout(() => process.exit(0), 5000).unref()
