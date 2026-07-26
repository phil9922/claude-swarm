# Build shakedown 2 — a spec sized so the question is answerable

*Written 2026-07-26, after run 1. Not yet run.*

Run 1 (`evals/shakedown-results.md`) falsified its wall prediction, but could not
answer the question it was built to ask. Measured serial fraction was **69.7%**
against an assumed 35–40%, so Amdahl capped the achievable speedup near **1.4x**
regardless of how well the leaf wave performed — while the prediction asked for
1.5–2.5x. The result is real and stands; it is just a fact about **Ledgerline's
shape**, not about fan-out.

This spec exists to make the question answerable. Everything about the procedure
is inherited from `evals/shakedown.md` — including the four defects fixed after
run 1. Only the app spec and the prediction change.

## What went wrong, stated as a design rule

Foundation cost is roughly **fixed per unit**: shared types, one signature stub
each, one manifest entry each. It does not shrink by adding units — it grows.
The only lever that moves the serial *fraction* is **work per unit**.

Ledgerline made this worse in two ways beyond size:

1. **A heavyweight shared core.** A discriminated-union `Split`, a reducer store
   over a discriminated-union action type, and an app shell — all of which had to
   exist, and be right, before any leaf could compile. That is irreducibly serial.
2. **Units that were thin wrappers over it.** `MemberBadge` and `FilterBar` are a
   few dozen lines each once the types exist. The foundation was doing the hard
   part; the leaves were doing the easy part in parallel.

**The rule this spec follows: shared surface small and dumb, units large and
independent.** Every unit should contain real algorithmic content that cannot be
hoisted into the foundation.

## The spec: Fieldkit

A dependency-free TypeScript library of input parsers/formatters. No React, no
store, no CSS, no app shell — those were serial cost in run 1 that bought nothing.

**Foundation (master writes, serial) — deliberately tiny:**

`src/types.ts`, and nothing else:

```ts
export type Ok<T> = { ok: true; value: T }
export type Err = { ok: false; issues: Issue[] }
export type Result<T> = Ok<T> | Err
export type Issue = { code: string; message: string; at?: number }
export type ParseOptions = { locale?: string; strict?: boolean }
export interface Field<T> {
  parse(input: string, opts?: ParseOptions): Result<T>
  format(value: T, opts?: ParseOptions): string
}
```

Plus one signature stub per unit and the work manifest. **No shared logic, no
store, no shell.** `Result<T>` is a union, so it still has genuine type surface a
unit can violate — but it is ~15 lines, not a subsystem.

**Leaf units (Sonnet wave) — ten, each one owned file, each substantial:**

| unit | the work that cannot be hoisted |
|---|---|
| `duration` | `1h30m`, `90m`, `1:30:00`, `PT1H30M` → ms; round-trip formatting; overflow rules |
| `bytes` | SI vs IEC (`1kB` vs `1KiB`), fractional input, precision-preserving format |
| `phone` | E.164 normalisation, extensions, per-country trunk prefixes, ambiguity → `Issue` |
| `iban` | mod-97 checksum, per-country length table, grouped formatting, targeted `at` offsets |
| `cron` | 5-field parse incl. ranges/steps/lists, next-N-occurrences, DST boundaries |
| `semver` | full precedence incl. prerelease/build, range matching (`^`, `~`, `>=`), sort |
| `colorspace` | hex/rgb/hsl/oklch parse, conversion, gamut clamping, round-trip stability |
| `csvRow` | RFC 4180 quoting, embedded newlines/quotes, streaming-safe partial rows |
| `humanDate` | `yesterday`, `next tue`, `3 days ago`, `2026-07-26` against an injected now |
| `expr` | tokenise + shunting-yard + eval for `+ - * / % ^ ()`, precedence, div-by-zero |

Each is 150–300 lines of real logic with dense edge cases. Each imports **only**
`src/types.ts`. **No unit reads another unit** — the dependency graph is a star,
so the leaf wave has no internal ordering at all.

**Integration:** barrel export, one cross-unit conformance test asserting every
unit satisfies `Field<T>`, project type check.

## Expected serial fraction — stated before the run

Foundation is ~15 lines of types plus ten stubs and a manifest. Integration is a
barrel plus one conformance test. Estimated **foundation ≈ 8–12%**, integration
≈ 4–6%, so **~12–18% serial** — against run 1's measured 69.7%.

Ideal wall ratio ≈ 1/(0.15 + 0.85/10) ≈ **4.3x**. With dispatch overhead the
spec-adjusted expectation is **2.5–4.0x**.

**This is the point of the redesign:** at 15% serial the ceiling is far above the
band being tested, so a result inside the band is evidence about fan-out rather
than an artefact of the ceiling. If measured serial again lands above ~35%, the
spec failed again — record that and do not score the wall line.

## Pre-registered prediction — do not edit after the run

Scored the same way as run 1. Written before any execution.

1. **Wall: 2.5–4.0x** (build faster than solo). Falsified below 1.3x.
2. **Cost: within ±25%** of solo. **VOID** if the leaf wave books to Opus —
   check `modelUsage`, not the panel.
3. **Measured serial fraction ≤ 20%.** If it exceeds ~35%, the spec is again the
   wrong shape and the wall line is unscoreable rather than falsified.
4. **Integration rework < ~1/5 of leaf files.** Stricter than run 1's 1/3: with a
   star dependency graph and no shared store, integration should have almost
   nothing to reconcile. If it rewrites leaf files anyway, the manifest's
   ownership model is not holding.
5. **Repair cycles ≤ ~1/unit**, from the copied subagent transcripts.
6. **Unknown ≤ ~1 in 6.** Requires the `hooks/subagent-stop.js` capture fix —
   if the feed still records `(no output)` for every agent, this is **not
   collected**, never estimated.

**A note on what run 2 cannot show.** Fieldkit is deliberately the friendliest
possible shape for fan-out: a star graph, no shared mutable state, pure functions
with compiler-checkable contracts. A good result here is evidence that the flow
delivers **when the work decomposes cleanly** — it is not evidence that it
delivers on arbitrary application work, and run 1 already shows it does not when
the foundation dominates. Both runs belong in any writeup. Quoting run 2 alone
would be the more flattering number and the less honest one.

## Procedure

Identical to `evals/shakedown.md` §0–§5, with the app spec above substituted and
these already-fixed points carried over: `tsc -p tsconfig.app.json --noEmit` (the
bare form type-checks nothing), the manifest written to `manifest.json` before
dispatch, `.claude-swarm-feed.log` truncated before the build arm so the §2 probe
cannot contaminate it, and the subagent transcripts copied aside between arms.

Two changes specific to this spec:

- **Scaffold is `npm create vite@latest … --template vanilla-ts`**, not
  `react-ts`. There is no UI; a React scaffold would reintroduce shell cost.
- **Solo arm gets the same "no UI" instruction**, so the arms are building the
  same thing. Run 1's arms diverged — the build arm added strict mode, lint and
  browser probes the solo arm never did — and that confound is recorded in
  `evals/shakedown-results.md`. Both arms here get: implement the library, make
  `tsc -p tsconfig.app.json --noEmit` pass, no extra tooling, no benchmarks.
