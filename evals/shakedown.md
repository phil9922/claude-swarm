# Build shakedown — the first real run

*Prepared 2026-07-25. Not yet run.* Run this in a **fresh session** with the plugin
loaded — not a continuation of the session that authored the workflow. Scoring goes
against the pre-registered prediction in `README.md` ("Recorded prediction: the first
build run"); fill the template, score each line, and don't edit the prediction.

## The spec: Ledgerline

A small expense-splitting web app (Vite + React + TypeScript). Throwaway by design,
but every unit has real type surface — several props, a return type, a contract that
can be violated — because a wall of presentational divs would produce a clean run
that proves nothing.

**Foundation (master writes, serial):** `src/types.ts` (Member, Expense, Category,
`Split` as a discriminated union of equal/percent/exact, Settlement, FilterState);
`src/lib/money.ts` (integer-cents math, proportional allocation with remainder-cent
rules); `src/store.ts` (reducer over a discriminated-union action type);
`src/tokens.css`; `src/App.tsx` shell with view switching; signature stubs for all
ten units below; the work manifest.

**Leaf units (Sonnet wave, wide) — ten, each one owned file:**

| unit | type surface it must honor |
|---|---|
| `MemberBadge` | size variant union, optional balance display, deterministic color from id |
| `ExpenseRow` | Expense + member map → per-participant share via `Split`, all three split kinds |
| `ExpenseForm` | controlled draft type, typed validation issues, submit callback contract |
| `SplitEditor` | edits the `Split` union without widening it; mode switch preserves totals |
| `BalanceList` | folds expenses → per-member net cents; must balance to zero |
| `SettlementPlan` | min-transfer settlement: net balances → typed `Settlement[]` |
| `FilterBar` | FilterState in/out, date-range and member filters, clear semantics |
| `CategoryPicker` | categories with budget cents, over-threshold warning flag |
| `csvExport` (lib) | `Expense[] → string` with quoting/escaping rules, stable column order |
| `StatsPanel` | per-category and per-month aggregation with typed totals |

**Integration (mechanic, then opus only if judgment surfaces):** barrel, wiring the
units into `App.tsx`, project-wide type check.

**Expected serial fraction, stated so the wall result reads against it:** foundation
(types, money lib, store, shell, ten stubs, manifest) ≈ 30–35% of the solo work,
integration ≈ 5–8%, so **~35–40% serial**. Ideal wall ratio ≈ 1/(0.38 + 0.62/10) ≈
2.3x; with dispatch overhead the spec-adjusted expectation is **1.6–2.3x**, sitting
inside the generic 1.5–2.5x band. If foundation blows past ~40% of solo wall, a poor
ratio indicts the spec sizing, not the width — record it as such rather than tripping
the 1.3x falsifier on the wrong cause.

## The frozen plan

The identical plan goes to **both arms**, verbatim. Plan quality varies run to run
and is upstream of everything measured, so **the plan is an input to the experiment,
not part of it** — write it once (below), save it as `PLAN.md` in each arm's
directory, and never regenerate it.

```markdown
# Ledgerline — implementation plan (frozen)

Build a client-only expense-splitting app in this Vite + React + TypeScript project.
No backend, no persistence beyond an in-memory store seeded with demo data. All money
is integer cents. `npx tsc --noEmit` must pass and `npm run build` must succeed when
you are done.

Data model: Members (id, name). Expenses (id, description, category id, payer,
participants, total cents, date, split). A split is exactly one of: equal across
participants; percent per participant (must sum to 100); exact cents per participant
(must sum to the total). Categories have a name and a monthly budget in cents.
Settlements are transfers (from, to, cents) minimizing transfer count from net
balances. Filter state: date range, member, category, all optional.

Money rules: allocation distributes remainder cents deterministically (largest
fractional part first, then input order). Per-member balances across all expenses
must sum to zero.

Views, switchable from an app shell: Expenses (filterable list + add/edit form with
validation), Balances (per-member net + suggested settlements), Stats (per-category
vs budget with over-budget warning, per-month totals), plus CSV export of the
filtered expense list (proper quoting; stable column order).

Components: MemberBadge (size variants, optional balance), ExpenseRow (shows each
participant's computed share), ExpenseForm (controlled, typed validation issues),
SplitEditor (edit any split kind; switching kinds preserves the total), BalanceList,
SettlementPlan, FilterBar, CategoryPicker (budget warning), csvExport (pure lib
function), StatsPanel. Shared types in src/types.ts, cents math in src/lib/money.ts,
one store (reducer + discriminated-union actions) in src/store.ts, design tokens in
src/tokens.css.
```

## Run procedure

**0. Preconditions (both arms).**
- Two identical scaffolds, prepared *before* any timing: `npm create vite@latest
  ledgerline-solo -- --template react-ts` (and `ledgerline-build`), `npm install` in
  each, `PLAN.md` copied in, `git init && git add -A && git commit` so rework is
  diffable. Dependency install must not pollute the timing of either arm.
- `echo ${CLAUDE_CODE_SUBAGENT_MODEL:-unset}` must print `unset` (or `inherit`) — any
  other value voids the tier pins, and the plugin's SessionStart hook warns about
  exactly this.
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` on every command, so a global CLAUDE.md can't
  leak delegation guidance into the solo arm (same reason the eval harness sets it).
- Load the plugin from the working tree with `--plugin-dir /path/to/claude-swarm`
  (the eval harness's guarantee: you measure the tree, not an installed copy).

**1. Solo arm first** — the controlled baseline. The historical "60–90 minutes"
figure is uncontrolled and does not substitute for this arm.

```bash
cd ledgerline-solo
time CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 claude -p "$(cat PLAN.md)

Implement the entire plan now, solo. Run npx tsc --noEmit and fix all errors, then npm run build, before finishing." \
  --model opus --effort high --max-turns 200 --output-format json \
  --allowedTools Read Write Edit Glob Grep Bash > ../solo.json
```

Record wall (from `time`), `total_cost_usd`, `num_turns`, final `npx tsc --noEmit`
and `npm run build` exit codes (run them yourself afterward — the JSON's word for it
is a claim, not evidence).

**2. Leaf-tier probe, before the build arm.** An Opus-booked leaf wave voids the
cost prediction rather than falsifying it — cheaper to catch now than after:

```bash
cd ledgerline-build
CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 claude -p 'Spawn the claude-swarm:leaf subagent with the task: "reply done". Report what it said.' \
  --plugin-dir /path/to/claude-swarm --model opus --max-turns 6 \
  --allowedTools Task --output-format json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(Object.keys(o.modelUsage||{}))})"
```

A Sonnet model id must appear in `modelUsage`. If only Opus appears, stop and fix
the pin before spending the wave.

**3. Build arm**, same session conditions, plan identical, plus the intervention
instruction (this is the same `armPrompts` pattern the eval harness documents — the
extra instruction *is* the intervention):

```bash
cd ledgerline-build
time CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 claude -p "$(cat PLAN.md)

Build this with the claude-swarm build flow: load the claude-swarm skill; write the foundation files, the signature stubs for every unit, and the work manifest; verify every foundation path and stub exists on disk; then run Workflow({ name: 'claude-swarm:build', args: <the manifest> }) and finish after integration. Timestamp (date -Is) into phase.log when you start the foundation, when you invoke the Workflow, and when integration ends." \
  --model opus --effort high --max-turns 200 --output-format json \
  --allowedTools Read Write Edit Glob Grep Bash Task Workflow > ../build.json
```

Afterward collect: `build.json` (`total_cost_usd`, `modelUsage` per model),
`.claude-swarm-feed.log` (per-agent completions with timestamps), `phase.log`,
`git diff --stat` from the pre-run commit, and per-unit statuses from the workflow's
returned `units` array (in the final result text).

**4. Phase split method.** Foundation = start → Workflow invocation (phase.log).
Leaf wave = Workflow invocation → last `claude-swarm:leaf` line in the feed.
Integration = last leaf line → integration end. Feed timestamps are completions, not
starts, so the split is approximate — say so in the record rather than presenting it
as exact.

**5. Score.** Fill the template below, then mark each line of the pre-registered
prediction confirmed / falsified / void, in `README.md`'s terms. Don't edit the
prediction.

## Recording template

```markdown
### Shakedown run — <date>
Claude Code version:            Plugin version/path:
Model/effort (master):          CLAUDE_CODE_SUBAGENT_MODEL: unset? y/n
Scaffolds identical at commit:  <sha>

| metric | solo | build |
|---|---|---|
| wall total | | |
| cost (total_cost_usd) | | |
| turns (main) | | |
| final tsc exit | | |
| npm run build exit | | |

Build arm only:
- Phase split (approx, method §4): foundation ___ / leaf wave ___ / integration ___
- Measured serial fraction (foundation+integration)/total: ___ (expected 35–40%)
- modelUsage: leaf-wave tokens booked to: ______ (Sonnet required; Opus ⇒ cost line VOID)
- Units: total ___  done ___  partial ___  failed ___  unknown ___
- Repair cycles per unit (from leaf transcripts/notes; count typecheck-fix loops):
  unit / cycles: ...
  import-extension occurrences among them: ___
- Integration rework: shared files written (expected): ___
  leaf-owned files integration MODIFIED (the metric): ___ of ___
- Manifest: valid on first try? y/n — if no, violations verbatim + minutes to fix: ___

Prediction scoring (README, "Recorded prediction: the first build run"):
- wall 1.5–2.5x (spec-adjusted 1.6–2.3x): measured ___ → confirmed/falsified
- cost ±25%: measured ___ → confirmed/falsified/VOID(opus leaves)
- integration rework < ~1/3 of leaf files: measured ___ → confirmed/falsified
- repair cycles ≤ ~1/unit: measured ___ → confirmed/falsified
- unknown ≤ ~1 in 6: measured ___ → confirmed/falsified
```

## Known first-contact risks

*(Two risks originally listed here — a misspelled manifest key silently misdirecting,
and full-project tsc noise between concurrent leaves — were fixed before this run
because they would have contaminated the metrics rather than informed them: the
validator now warns on unknown keys with a nearest-key suggestion, and each leaf's
type check is sibling-filtered to its owned files. What remains is what the run is
supposed to discover.)*

1. **The master's first real manifest, and how legibly validation fails.** Every
   manifest the validator has seen was written to be correct. When the first real one
   isn't: violations are *collected* (not fail-fast), logged one per line, and each
   names the unit id, the path, and the rule — `path owned by more than one unit:
   src/x.ts (a and b)`, `b: reads src/ghost.ts, which is neither in foundation nor
   owned by any unit`, `dependency cycle: a → b → a`, `u: owns a shared file reserved
   for integration (barrel): src/index.ts` — and unrecognized keys get a warning
   naming the key and the nearest valid one. The open question the run answers:
   whether that's enough to fix a genuinely bad *decomposition* (not just a typo) in
   two minutes without opening the validator source. Record the violations verbatim
   if it happens.
2. **Stubs that don't exist.** The validator structurally can't stat the filesystem,
   so a foundation path or signature stub the master forgot to write passes
   validation and fails mid-wave as confused leaf notes. The build-arm prompt orders
   an explicit on-disk verification step; *organic* use depends on the master loading
   the skill and obeying the precondition. Deliberately left in: whether the master
   honours a documented precondition unprompted is a finding worth having.
3. **Bash permissions in headless mode.** In `claude -p` nobody is prompted — tool
   calls follow configured rules — so if `Bash` isn't allowlisted, every leaf's
   type check silently fails and repair never runs. The commands above allowlist it;
   forgetting this would produce a plausible-looking but unrepaired wave.
4. **`maxTurns: 25` calibrated on single-file pure TS.** F1's units were one file
   with no JSX and no store wiring; a React component reading tokens + store may need
   more reads. 25 leaves slack (write 5–6 + repair 6), but three repair cycles
   approaches the silent cap — the `unknown` count is the tripwire. Deliberately not
   retuned beforehand: this run *is* the calibration data.
5. **Stub compliance.** The instructions now require compiling placeholder bodies
   (`throw`, never empty) that type-check before the wave — but instruction is not
   compliance, same class as risk 2. If the master ships red stubs anyway, the
   leaves' sibling filter will still surface those errors (they sit in owned files):
   attribute them to Wave 1 in the record, not to the leaf or to signature quality.
