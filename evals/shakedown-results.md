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
- **Units**: total **not collected** / done — / partial — / failed — / unknown **not collected**.
  The workflow's `units` array is not in the final result text (the master's closing message is
  a verification report instead), and the manifest was passed as `args` and never written to
  disk, so unit count cannot be recovered. The feed log carries **14 `claude-swarm:leaf`** and
  **1 `claude-swarm:mechanic`** completion for 10 spec units — consistent with batching or
  retries, but not decidable without the manifest.
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
- **unknown ≤ ~1 in 6**: **not collected** — and the feed cannot answer it. Every entry,
  including the mechanic's, recorded `(no output)`. Fifteen silent agents is far less likely
  than the hook failing to capture final messages, so this reads as a **defect in
  `hooks/subagent-stop.js`'s capture**, not as 15 unknowns. Treating it as an unknown count
  would be a fabricated number.

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
