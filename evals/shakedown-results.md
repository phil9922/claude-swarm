# Build shakedown — results

Run 2026-07-26. Protocol: `evals/shakedown.md`. Prediction being scored:
`evals/README.md`, "Recorded prediction: the first build run" — **not edited**, per the protocol.

---

### Shakedown run — 2026-07-26

Claude Code version: **2.1.220**  Plugin version/path: **working tree via `--plugin-dir`**
Model/effort (master): **opus / high**, `--max-turns 200`
`CLAUDE_CODE_SUBAGENT_MODEL`: **unset** — verified before the run
Scaffolds identical at commit: `72471a6` (solo) / `8e29b21` (build) — identical trees apart from
the project name in `index.html`, `package.json`, `package-lock.json`

**Scope limit (copy into any writeup):** the workflow was explicitly invoked, so this run
measures whether `build` DELIVERS on its wall/cost claims — it says nothing about whether a
master would route to it unprompted; that is a separate experiment.

**Interventions:** none. Neither arm was steered, corrected, or restarted.

| metric | solo | build |
|---|---|---|
| wall total | **997s** (16:37) | **1410s** (23:30) |
| cost (`total_cost_usd`) | **$5.4178** | **$8.0139** |
| turns (main) | 63 | 18 |
| final tsc exit | **0** | **0** |
| npm run build exit | **0** | **0** |

Wall stamped externally (`date +%s` around the process), not read from `duration_ms`.

**Type-check caveat — the protocol's own command is vacuous here.** `npx tsc --noEmit` at the
repo root exits 0 on *any* source, because the Vite scaffold's root `tsconfig.json` is a
solution file with `"files": []`. The build arm's master discovered this by planting a type
error and watching it still exit 0. The exits above are therefore from the **real** graders,
run by hand on both arms identically: `npx tsc -p tsconfig.app.json --noEmit` (0 / 0) and
`npm run build`, which runs `tsc -b` and does honour project references (0 / 0). The bare
`npx tsc --noEmit` also returned 0 for both, but that number is meaningless and is not the
basis of this row. **`evals/shakedown.md` should be corrected** — it specifies the vacuous
command for both arms.

Build arm only:
- **Phase split** (approx, method §4; feed filtered to entries ≥ `09:18:38Z` — see confounds):
  foundation **602s (45.4%)** / leaf wave **402s (30.3%)** / integration **321s (24.2%)**
- **Measured serial fraction** (foundation+integration)/total: **69.7%** — expected 35–40%.
  Foundation alone was **60.4% of the solo arm's entire wall time.**
- **modelUsage**: leaf-wave tokens booked to **Sonnet** — `claude-sonnet-5` $2.2381 (44,161
  output tokens) alongside `claude-opus-5` $5.7758 (87,018 output). **The cost line is NOT
  void**; the tier pin held, as the §2 probe predicted.
- **Units** *(recovered 2026-07-26 after the feed-capture fix — see "Recovered metrics" below)*:
  total **14** / done **14** / partial **0** / failed **0** / unknown **0**. The master
  decomposed into 14 units rather than the spec's 10, adding the app shell and three view
  containers. The 15th workflow agent is the integration mechanic, which returns a different
  schema and is not a unit.
- **Repair cycles per unit**: **not counted** (transcripts *were* preserved — 19 `.jsonl` files
  at `/home/pk/shakedown/transcripts-build` — so this is recoverable, just not yet done).
  import-extension occurrences among them: not counted.
- **Integration rework**: shared files written (expected): not collected. Leaf-owned files
  integration MODIFIED (the metric): **not collected** — requires the manifest's `owns` lists,
  which were not persisted.
- **Manifest**: valid on first try? **Unknown** — not persisted, and no validator output appears
  in the final text. No violations were reported, and the wave ran, so it was at least accepted.

## Prediction scoring

- **wall 1.5–2.5x** (spec-adjusted 1.6–2.3x): measured **0.71x — the build arm was 1.41x
  SLOWER than solo** → **FALSIFIED**, but see the attribution note below before reading this
  as a verdict on fan-out.
- **cost ±25%**: measured **+47.9%** ($8.01 vs $5.42) → **FALSIFIED**. Not void — the leaf wave
  booked to Sonnet as required.
- **integration rework < ~1/3 of leaf files**: **not collected** (no manifest).
- **repair cycles ≤ ~1/unit**: **not collected** (transcripts kept, not yet counted).
- **unknown ≤ ~1 in 6**: measured **0 of 14** → **CONFIRMED**. Recovered post-hoc; see below.

## Recovered metrics — the `(no output)` finding, resolved

The original reading here was that every feed entry recording `(no output)` looked more like a
capture defect than like 15 silent agents, so the `unknown` rate was recorded as *not collected*
rather than guessed. That judgement held up, and the cause turned out to be specific.

`last_assistant_message` is present in the `SubagentStop` payload **only when the subagent's
final turn ends in prose**. When it ends by calling `StructuredOutput` — which every
schema-constrained workflow `agent()` does — the key is **absent entirely**, so the hook logged
`(no output)` for the entire leaf wave. The one entry that did carry text (09:14) was the §2
probe, a plain `Task` spawn. That split is exactly the symptom.

Fixed in `hooks/subagent-stop.js` (0.2.8): when the payload carries no message, read the final
assistant message out of `agent_transcript_path`, grouped by `message.id`, and fall back to a
compact JSON of the `StructuredOutput` input. Replaying the fixed hook over the 16 preserved
transcripts from this run yields **16 lines, 0 of them `(no output)`**, and the per-unit status
becomes greppable straight off the feed.

**These numbers are recovered, not live.** They come from transcripts preserved after the run,
using a hook that did not exist while the run executed. That is legitimate — the data was always
in the transcripts, only the feed was blind to it — but it is a different provenance from the
wall and cost figures above, which were measured as the run happened. Anything still marked *not
collected* below is genuinely unrecoverable, not merely un-attempted:

- **Repair cycles per unit** — recoverable in principle from the same transcripts (count the
  typecheck-fix loops), not yet counted.
- **Integration rework** and **manifest validity** — still unrecoverable. Both need the
  manifest's `owns` lists, and the manifest was never written to disk. Fixed in the protocol for
  next time, but it cannot be reconstructed for this run.

## Attribution: why the wall result is not a clean verdict on width

The protocol anticipates exactly this case: *"If foundation blows past ~40% of solo wall, a poor
ratio indicts the spec sizing, not the width — record it as such rather than tripping the 1.3x
falsifier on the wrong cause."* Foundation consumed **60.4% of the solo arm's total wall**, well
past that threshold. The parallel leaf wave — the only part fan-out can speed up — was just
**30.3%** of the build arm's run. With a serial fraction of ~70%, Amdahl caps the achievable
speedup near 1.4x even with infinitely fast leaves; the observed 0.71x is what that ceiling looks
like once dispatch overhead and a 321s integration are added.

**So the honest reading is: this run falsifies the prediction as written, and simultaneously
shows the prediction was scored against a spec whose serial fraction was roughly double what the
protocol assumed (69.7% vs 35–40%).** Both statements belong in any writeup. The 1.3x falsifier
should not be read as "fan-out does not work" on this evidence.

## Where the serial time actually went

Reconstructed afterwards from the master's transcript. Phase boundaries are exact
(`phase.log`); the within-phase splits are inferred from message timestamps and should
be read as approximate — one reconstruction of the foundation phase summed to 674s
against an actual 602s, so treat the proportions as indicative, not measured.

**Foundation, 602s.** 26 file writes and only 8 Bash calls — this phase was writing,
not tool-thrashing. Roughly: skill loading and scaffold survey (including proving the
root `tsc` was a no-op), then designing and writing 12 shared files, then 14 signature
stubs. The shared files were not just contracts: `money.ts`, `balances.ts`, `filter.ts`,
`stats.ts` and `validate.ts` were **fully implemented**, each with a clear contract and
its own file. All five could have been units. So the serial phase wrote the hard,
algorithmic parts and the parallel wave got the presentational components — the inverse
of the shape that makes fan-out pay.

**Leaf wave, 402s.** The first five leaves completed within a **6-second span**
(09:32:33–09:32:39), then completions became staggered with gaps up to 104s. Completion
timestamps cannot distinguish staggered starts from variable durations, so this is
suggestive rather than conclusive — but a tight leading cluster followed by stragglers
is the signature of a slot queue, and the run had 14 units against a `concurrency`
default of 8.

**Integration, 321s — and most of it was not integration.** The workflow's mechanic
finished at 09:37:05. Nearly everything after that was the **master's own
post-workflow verification**: adversarial CSV quoting (~51s), a headless browser render
(~18s), and driving the real UI through split-kind conversions (~142s, which found and
fixed two genuine bugs), plus `oxlint`. That is roughly **215s of work the solo arm
never did at all**.

**A like-for-like adjustment, offered as an adjustment and not as a measurement.**
Subtracting that ~215s leaves ~1195s against solo's 997s — a ratio of **~0.83x instead
of 0.71x**. The build arm is still slower, so the falsification stands either way; but
roughly a third of the measured gap is the build arm doing more work rather than doing
the same work more slowly. The headline numbers in the table above are left untouched:
they are what the arms actually cost.

## Confounds — recorded, not hidden

1. **The arms did not do equal work.** The build arm's master went well beyond the frozen plan:
   it enabled `strict` in `tsconfig.app.json` (absent in solo), ran `oxlint`, wrote and ran
   money-invariant probes against seed data, verified CSV quoting against an adversarial input,
   and drove the real UI headlessly through split-kind conversions checking totals and balances.
   Solo did none of that. This inflates the build arm's wall and cost, and means the comparison
   is not like-for-like. It is arguably a *property of the flow* rather than noise — but it is
   not the frozen plan, and the numbers above should not be read as "the same job, done two
   ways". Delivered size was similar: solo 2486 lines of TS/TSX, build 2707.
2. **The build arm graded itself more strictly.** `strict: true` in the build arm only. Its
   clean type check therefore clears a higher bar than solo's.
3. **Concurrency.** Solo ran alone. The build arm started at `05:18:38` while an unrelated
   `claude-swarm:verifier` subagent was still running (20 `claude` processes at `05:18:32`) plus
   a 2-second status-line poller. Both API-bound rather than CPU-bound, so the expected effect is
   small — but the arms did not run under identical load.
4. **Plugin version differed between arms.** Solo ran against tree `27f2b00` (0.2.5), build
   against `4fced81` (0.2.6). The delta is status-line display only and touches nothing in the
   build path, but it is a difference and is recorded as one.
5. **Feed-log contamination.** `.claude-swarm-feed.log` in `ledgerline-build` already held one
   `claude-swarm:leaf` entry at `09:14:41Z` from the §2 Sonnet probe, four minutes before the
   arm started at `09:18:38Z`. All feed figures above are filtered to `≥ 09:18:38Z`. The
   protocol does not warn about this because it assumes the probe does not share a directory
   with the build arm.

## Protocol defects this run exposed

These are findings about `evals/shakedown.md` itself, and should be fixed before a second run:

1. **The specified type check is vacuous** (`npx tsc --noEmit` against a `files: []` solution
   config). Both arms would have passed it with arbitrary type errors. Replace with
   `tsc -p tsconfig.app.json --noEmit` and/or rely on `npm run build`.
2. **The manifest is never persisted**, so integration-rework, unit counts and manifest-validity
   — three of the five scored prediction lines — are structurally uncollectable. The build-arm
   prompt should require writing the manifest to disk before dispatch.
3. **The probe shares a directory with the build arm**, contaminating the feed log. Run the
   probe elsewhere, or truncate the feed before the arm starts.
4. **The feed log records `(no output)` for every agent**, so the `unknown` rate cannot be
   measured from it. Either fix the capture in `hooks/subagent-stop.js` or specify a different
   source for that metric.
5. **The spec's serial fraction is roughly double the protocol's estimate** (69.7% measured vs
   35–40% assumed). Either resize the foundation or restate the expected band, otherwise the
   wall prediction is being scored against an arithmetically unreachable target.
