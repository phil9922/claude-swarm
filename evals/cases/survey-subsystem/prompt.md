Map how the savings counter in the claude-swarm repository works, end to end.

Produce a written map covering:

1. **What computes the number** — which file does the tallying, what it reads off disk,
   and how it decides which spend counts toward "saved".
2. **How cost is derived** — where the rates live, how cache reads and the two
   cache-write TTLs are priced, and how a turn's date affects its price.
3. **Where state lives** — what files are written, what each is for, and which component
   reads which.
4. **How it reaches the user** — the command and the SessionStart hook, and how they
   differ in freshness and in what they cost to run.
5. **What the number does NOT mean** — any caveat the code or docs attach to it.

Be concrete: name files, functions, and the conditions under which things happen. This is
a read-only exercise — do not modify anything.
