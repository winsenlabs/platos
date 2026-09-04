# @platos/context-governance

ADR M0.3 bounded context 14 — safety, evals and ratings, split out of the old
`monitoring` grab-bag. Layers: `domain/`, `application/`, `application/ports/`,
`contracts/`. Other contexts may import `contracts/` and nothing else
(`cross-context-contracts-only`).

May depend on: tenancy, agents.

## What it owns

Sole writer of `SafetyEvent`, `MessageRating`, `EvalCriterion`, `AgentEval` and
`GoldenSet` (ADR M0.3 §1 row 14). Nothing else may write those five rows, and
`scripts/arch/sole-writer.mjs` holds that.

## The two ways in that are not the contract

Nobody depends on this context in the §1 DAG — it is a sink, reached through the
composition root. Both inbound edges are kernel ports:

- **`safetyEventSink()`** implements the kernel `SafetyEventSink`.
  `identity-access`'s rate-limit guard publishes through that port and this
  context implements it, so there is **no identity-access -> governance code
  edge** (ADR M0.3 §3, the `auth -> monitoring` row). Boundary rule (g)
  `identity-isolation` keeps it that way.
- **`erasureTarget()`** implements the kernel `ErasureTarget`. `privacy` erases
  `MessageRating` and cannot reach into these tables; the composition root
  collects one target per context and injects the array. A context that owns
  subject data and publishes no target makes a multi-context erasure silently
  incomplete, so `application/governance-erasure-target.test.ts` obtains the
  target only through `createGovernanceContract(...)` — a binder that dropped the
  method turns that whole file red.

## The durable seam

"Eval runs enqueue as durable jobs" is `application/ports/eval-run-queue.ts`, a
port this context owns, not a dependency on `jobs`. `enqueueEvalRun` plans and
caps the fan-out and hands it over; it never pays a judge inside the request.

## Falsifiability

`mutations.json` is the guard ledger: one entry per authorization check, scope
check, cap, kill switch and erasure step in this package, each carrying the file
it lives in, the EXACT text that implements it (`from`), the edit that removes it
(`to`), and the suites that are supposed to notice (`suites`). It is data, not
code — nothing imports it, and the `.json` extension is what keeps it out of the
compiled tree.

To check one guard is real: apply the entry's `to` in place of its `from`, run
its suites, and confirm a NAMED case goes red; then revert and confirm green. All
54 entries were exercised that way before this context was proposed, and 54 of
54 were falsifiable. Two of them were not on the first pass — the in-memory
doubles enforce the two unique constraints themselves, so deleting the use case's
pre-check produced an identical refusal — and both suites now assert the
transaction count instead, which is what distinguishes a pre-check from a store
constraint.

A guard added later belongs in this file. One that is not here has not been
shown to be more than a comment.
