Map how the `audit` workflow in the claude-swarm repository works, end to end.

Produce a written map covering:

1. **The find stage** — how the target and the lenses are resolved, what happens when a
   caller passes an empty or invalid value for either, and which agent tier does the
   reading.
2. **The verify stage** — how a candidate finding becomes confirmed or refuted, how many
   agents that costs, and how the skeptics are chosen.
3. **The confirmation rule** — the exact threshold a finding must clear, and how that
   interacts with the `votes` argument.
4. **The failure modes it guards against** — what happens when a verifier fails to run,
   and what the code does rather than the obvious wrong thing.
5. **Where the tests exercise this**, and what they would catch.

Be concrete: name files, functions, and the conditions under which things happen. This is
a read-only exercise — do not modify anything.
