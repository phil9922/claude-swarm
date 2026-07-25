You are grading a written map of a subsystem. Score 0.0–1.0 on how much a new maintainer
could act on without reading the code themselves.

The task was to map the claude-swarm `audit` workflow across five points: the find stage,
the verify stage, the confirmation rule, the failure modes it guards against, and where
the tests exercise it.

The ground truth, for checking accuracy:

- **Find stage** (`workflows/audit.js`) — the target comes from a string arg or
  `input.target`; args arrive JSON-encoded and are normalised at the top of the script. An
  empty `lenses` array falls back to the six defaults rather than producing a false-clean
  audit. One `claude-swarm:tracer` reads per lens, in parallel, returning candidate
  findings against a schema.
- **Verify stage** — findings are batched (up to 8) and judged by `claude-swarm:verifier`
  agents that refute by default. A first skeptic judges the whole batch; only findings it
  fails to refute are escalated to the remaining doubt angles. Skeptics come from a pool of
  three angles, cycled to `votes + 1` so a higher `votes` raises scrutiny rather than making
  confirmation impossible.
- **Confirmation rule** — a finding is confirmed when it survives at least `VOTES` of
  `VOTES + 1` independent refutation attempts. `votes` is validated explicitly: an intentional
  `0` is honoured, and invalid values coerce to the default with a log rather than silently.
- **Failure modes** — a finding whose skeptics all failed to run is bucketed `unverified`,
  never counted as refuted, so a transient outage cannot masquerade as a refutation. A
  finding with no verdict in its batch is likewise absent rather than assumed refuted.
- **Tests** (`test/smoke.js`) — the workflow bodies are compiled, and the audit
  confirm/refute logic is executed against stubbed agents, asserting both the outcomes and
  the number of verifier calls.

Scoring:

- **Coverage** — how many of the five points are genuinely addressed.
- **Accuracy** — claims must match the ground truth above. Penalise confident wrong
  statements harder than omissions; a wrong map is worse than a thin one.
- **Specificity** — names files and functions and states conditions, rather than
  describing the system in generalities.

Do not reward length or structure for their own sake. A tight accurate map beats a long
vague one. Do not reward the answer for describing its own process or what tools it used.

Getting the batching-and-escalation shape, the `VOTES` of `VOTES + 1` threshold, or the
unverified-is-not-refuted invariant right are strong signals the subsystem was actually read
rather than guessed at.

Reply with ONLY a JSON object, no prose around it:

{"score": 0.0, "points_covered": 0, "wrong_claims": 0, "reasoning": "one or two sentences"}
