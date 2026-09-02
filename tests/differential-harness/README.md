# WIN-284 — old-vs-V1 differential contract and state-conservation harness

Twin-runs a scenario against two subjects backed by **isolated equivalent stores**,
normalises the nondeterminism, compares seven dimensions, and reports a verdict.

The oracle is `main` at `89c12b8aa8da75c561dc879f370aaefb6e3359bc` — frozen and
admin-enforced, so it cannot drift underneath the harness.

## What this is for, and what it is not yet

WIN-284 was resequenced from M7 to M2 and its seventeen M4/M5/M6 blockers were
removed, because those issues gate **coverage**, not **construction**. The scope
here is *build the harness and prove it detects seeded divergence, against the
surfaces that exist today*. Complete capability coverage is WIN-285.

That distinction has a consequence worth stating plainly rather than burying:

> At this baseline there is **no V1 candidate implementation** of REST, MCP, SDK,
> channels or streams to twin-run against. `docs/audits/win-284-differential-coverage.json`
> therefore reports 2 of 773 capability cells as covered. Every other cell is
> enumerated as `uncovered` and names the issue that will build the surface. The
> gap is real, it is measured, and it is not hidden by shrinking the denominator.

**The recorded oracle has not been captured yet, and nothing here pretends it
has.** `negative-controls.mjs` drives a *synthetic* fixture: it carries the
frozen commit as provenance because the subject requires provenance, but nothing
in it has replayed real `main` behaviour. Its job is to exercise the
comparators, the register and the engine's refusals against a subject with no
moving parts, so a failing control is unambiguously the harness's fault rather
than the environment's. Capturing genuine oracle recordings needs a running
instance of the frozen commit to read, and only becomes useful once there is a
V1 candidate to replay them against — both belong with WIN-285.

Where real systems are compared today is the state-conservation half, and that
runs against two live PostgreSQL stores.

What runs today, for real:

- The **twin-PostgreSQL subject** builds two isolated databases from the
  repository's own `prisma migrate deploy` over the real 93-model tenancy schema,
  runs identical operation sequences against each, and compares persisted state.
- The **end-user tier boundary** is enforced by PostgreSQL, from grants derived at
  run time from the model list in `prisma/end-user.prisma`. A denial is a real
  `42501`, not a rule the harness wrote for itself.

## The seven dimensions

| dimension | what it compares |
| --- | --- |
| `status` | the response status code |
| `schema` | the whole response payload contract: body structure, body **values**, and headers |
| `events` | the **ordered** event log — names, payload shapes, payload values |
| `auth` | resolved principal, granted scopes, allow/deny decision, stated reason |
| `sideEffects` | the multiset of writes and outbound effects |
| `usage` | unit accounting and cost, within a declared tolerance |
| `store` | post-run state of every declared table in each isolated store |

`schema` covers values and headers, not shape alone. Shape-only comparison is the
tempting reading of the word and the wrong one: a field that keeps its name,
position and type and returns a different value is the most common regression a
decomposition produces, and a shape-only harness reports parity on a body that is
simply wrong.

## Normalisation, and why it is the dangerous part

Two independent stores disagree about things that are not drift: clocks advance,
identifiers are random, ports are ephemeral, sequences start independently. Those
have to be erased or every run is red and the harness gets muted.

An **over-broad normaliser is the worse failure**. It erases real drift, the report
reads green, and nobody learns the harness stopped measuring. So every entry in
`normalisers.mjs` carries four mandatory declarations:

- `erases` — the nondeterministic component it removes
- `preserves` — the observable it must still let through
- `sensitivity.equivalent` — a pair differing **only** in the erased component,
  which must normalise **equal**
- `sensitivity.divergent` — a pair differing in a **real** way inside the same
  field family, which must normalise **unequal**

`assertRegisterIsSensitive` enforces both directions across the register. A
normaliser with no sensitivity pair fails; one widened until it swallows its own
divergent fixture fails as over-broad. There is no way to land `s/.*/<any>/` here
and keep the suite green.

### The register

| id | erases | preserves |
| --- | --- | --- |
| `store-row-canonical-order` | the physical order rows come back in from an unordered store dump | row content and multiset membership in full — `compareStore` already compares a table as a multiset, so ordering carried no signal to lose |
| `instant-rank` | the wall-clock value of every ISO-8601 instant | presence, count, and **relative order** — instants become ranks, so a reordering still diverges |
| `identifier-ordinal` | the random value of UUIDs and ULIDs | referential structure and count — reusing one id where the other side uses two still diverges ([stated limit](#one-stated-limit)) |
| `duration-elided` | the magnitude of measured durations, entirely | presence and type only; scope is an exact field allowlist, never a `*Ms` suffix rule, so a configured `retentionMs` is untouched |
| `ephemeral-endpoint` | the host and port authority of a connection string | scheme, path, database name, query string |
| `store-sequence-ordinal` | the absolute value of integer surrogate keys | row count, row order, and every join |

`duration-elided` is the only fully lossy normaliser, and deliberately so: timing
is a performance property and performance parity is WIN-285's gate battery.

`store-row-canonical-order` exists because of a defect the twin-PostgreSQL run
found and reasoning did not. A store dump keyed by a UUID comes back in an
effectively random order that differs between two isolated stores;
`identifier-ordinal` numbers identifiers by first appearance, so the same
logical row was given a different ordinal on each side and the run reported
`store-row-missing` plus `store-row-extra` for rows that were identical. A false
positive, and an intermittent one — it passed twice before it failed. Ordinals
are now assigned over content-sorted rows with identifier- and instant-shaped
values masked, which is stable across two stores because it uses only the parts
neither store randomises. `normalisers.test.mjs` carries the regression, in both
directions.

### One stated limit

Ordinal normalisation **cannot** detect a permutation of two random identifiers
that each appear exactly once and never co-occur. It should not pretend to:
which UUID a store happened to mint for which row is precisely the
nondeterminism being erased.

What survives is referential structure — one identifier used in two places is a
different fact from two distinct identifiers, and a differing identifier *count*
still diverges. In practice that catches the interesting version of the bug: an
id written into the wrong column stops matching the row it should have matched,
which changes the equality class. The residual blind spot is narrow, it is
asserted explicitly in `normalisers.test.mjs`, and it is recorded here rather
than left for a reviewer to discover.

Ordinals are assigned over a **key-sorted** traversal, not insertion order.
Without that, once the oracle is a recording and the candidate is a live
transport, two sides building the same object with keys in different orders
would produce different ordinals and a false divergence.

### A dimension may not compare a constant

Every subject declares `usage.measured` — which components it actually meters.
Without it, a subject that does not model cost reports `costMicros: 0`, both
sides agree on zero, and the usage dimension records agreement about a number
neither side ever measured. So:

- only components **both** sides declare are compared;
- a side that stops metering one is a `usage-measurement-changed` divergence,
  not silent agreement;
- a subject that meters nothing makes the dimension **vacuous** and the run is
  refused.

The twin-PostgreSQL subject meters `inputUnits` and `outputUnits` — statements
and rows — and does **not** meter cost. Cost parity is therefore uncovered
today, and the declaration is what makes that legible rather than assumed.

### Two reaches that are refused structurally

- **`events` can never be order-normalised.** `sortDeclaredUnordered` throws.
  Sorting events would delete the reordered-event negative control, so this is
  enforced in code rather than left to reviewer discipline.
- **Contract-bearing headers can never be declared volatile** — `content-type`,
  `content-encoding`, `location`, `www-authenticate`, `set-cookie`,
  `cache-control`, `retry-after`, `allow`. Muting `www-authenticate` would hide
  exactly the auth regression this harness exists to find.

A tolerance is a normaliser wearing a different hat, so `assertTolerance` refuses
anything above a 1% relative ceiling — wide enough to absorb integer rounding
between two independent accumulators, far too tight to hide a pricing change.

## Refusing to report parity it did not measure

The engine has six verdicts. Three of them are refusals:

| verdict | meaning |
| --- | --- |
| `parity` | every declared dimension compared, no unapproved divergence |
| `divergent` | at least one unapproved difference, localised to a dimension and a code |
| `vacuous` | a declared dimension carried **zero** comparable facts on one or both sides. Two sides that both produced no events are not in agreement about events; they are silent, and silence is not evidence |
| `invalid` | a subject returned something that is not an observation; both sides reported the **same store identity** — one store twin-run against itself compares equal for free; or a scenario compared store state without both sides naming their store, which would make isolation an assumption rather than a check |
| `stale-approval` | the scenario approved an intentional difference that did not occur. An approval nobody reconciles becomes a blanket mute |
| `unsound` | the scenario declared a dimension with no comparator, approved a difference with no rationale or issue, or asked for a refused normalisation |

Intentional differences are **approved, not hidden**: an approval must carry a
prose rationale and a `WIN-` issue, it is reported in the result as approved, and
it is consumed one-for-one so a second occurrence still fails.

## Negative controls — the deliverable, not the footnote

A parity harness never shown to catch a deliberate difference is decoration.

```
node tests/differential-harness/negative-controls.mjs         # 33 controls, no Docker
node tests/differential-harness/postgres-conservation.mjs     # 10 phases, needs Docker
```

Three phases, and all three matter:

1. **Clean run.** Two observations differing only in nondeterminism must report
   `parity`. Without this, a harness that reported divergence for everything would
   pass every seeded control below and look perfect.
2. **Seeded runs.** One deliberate difference at a time, each required to produce
   the **right** divergence code. "Something changed" is not a pass — a harness
   that cannot localise drift is unusable against a 14k-line decomposition.
3. **Vacuity controls.** The shapes that make this class of harness go quietly
   green — an empty observation, a dimension nothing populated, one store compared
   with itself, a malformed observation, a standing approval that never matches —
   each required to be refused.

Every divergence code the comparators can emit has at least one seed;
`assertSeedCoverage` makes that mechanical. A comparator branch with no seed
behind it is a branch nobody has watched go red.

### Controls on the controls

- **Parity is earned.** With the register switched off, the clean twin pair
  diverges — 10 divergences on the recorded fixtures, 6 against the real twin
  databases. The clean control passes because normalisation works, not because
  the two sides were quietly identical.
- **Every seed goes uncaught when its dimension is removed** from the scenario,
  proving each control's pass depends on its comparator actually running.
- A seeded control with the seed replaced by a no-op **fails**, as it must.
- `assertSeedCoverage` rejects a truncated catalogue; `assertRegisterIsSensitive`
  rejects an over-broad, inert, undocumented or self-identical normaliser.

The store runner **fails when Docker is absent rather than skipping**. A suite
that silently skips is indistinguishable in a summary from one that passes, and
that is the exact failure this issue exists to prevent.

## Coverage

`scripts/differential-coverage.mjs` enumerates every cell the M0 censuses found —
WIN-247's capability matrix, the independent REST census, the webapp BFF matrix,
and the design contract map — and gives each a declared status.

The numerator is **computed** from `scenarios.mjs`; it cannot be asserted in the
matrix. A claim naming a cell no census contains is a hard error, so a typo
inflates nothing, and the digest moves if a cell is dropped, so the denominator
cannot shrink quietly.

```
pnpm audit:differential-coverage      # check the committed matrix
pnpm generate:differential-coverage   # regenerate it
```

## Adding a surface as M4–M6 land

1. Write a subject that produces an `Observation` for the new transport.
2. Add scenarios to `scenarios.mjs`, each claiming the exact census cell ids it
   twin-runs.
3. Regenerate the coverage matrix. The covered count moves because the scenarios
   moved it — there is no other way to move it.
4. If the surface introduces a new nondeterminism, add a normaliser **with both
   sensitivity fixtures**. It will not pass without them.
5. If it introduces a new divergence code, add a seed. It will not pass without
   one.

## Files

| file | role |
| --- | --- |
| `observation.mjs` | the observation record, fail-closed validation, comparable-fact counting |
| `normalisers.mjs` | the normalisation register and its own sensitivity guard |
| `comparators.mjs` | one comparator per dimension, stable divergence codes |
| `twin-run.mjs` | the engine and its refusals |
| `seeds.mjs` | the seeded-divergence catalogue |
| `scenarios.mjs` | the scenario registry and the only source of coverage claims |
| `negative-controls.mjs` | the three-phase control runner (no Docker) |
| `postgres-conservation.mjs` | state conservation against two real isolated stores (Docker) |
| `subjects/recorded.mjs` | replays a frozen oracle recording |
| `subjects/postgres-twin.mjs` | provisions and drives the two isolated databases |
