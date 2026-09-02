# Advisory scanning and disposition

Two files, two different jobs.

| File | Job | Regenerate with |
|---|---|---|
| `osv-report.json` | Point-in-time OSV scan of the exact shipping package sets | `pnpm audit:advisory` |
| `advisory-policy.json` | Who owns each CRITICAL/HIGH finding, and why it is still here | hand-edited |

`pnpm audit:advisory:check` enforces both: first that the receipt reconciles
against the exact lockfile and the exact webapp image inventory, then that every
CRITICAL/HIGH finding in it carries an owned, dated disposition.

## Why the second file exists

The receipt is a *freshness* contract. It proves the finding list is honest
about what ships. It has no opinion about whether anybody has looked at the
findings.

That gap is not hypothetical. `GHSA-gr94-w7qr-f4j3` (engine.io) and
`GHSA-xwg4-73v4-xw9w` (nanoid) reached `v1` unowned because they are
**pre-existing dependencies with newly published advisories** — `scanSetSha256`
never moved, no dependency changed, so nothing had a reason to fail. Both were
HIGH. Neither had an owner. WIN-299 closed that.

## The three states

**`resolved[]` — upgraded away.** Not a disposition at all: the finding stops
appearing in the receipt. The gate verifies the claim by proving the advisory is
genuinely **absent**, so a false "we fixed it" fails as loudly as an unowned
finding.

**`waived` — assessed.** Somebody established reachability and wrote the
argument down, with an owner and a review date.

**`carried` — not assessed.** An explicit, dated admission that a live
CRITICAL/HIGH has *not* been analysed. This is deliberately **not** a safety
claim, and the gate refuses to let a `carried` entry claim a reachability
verdict. It exists so the honest answer ("nobody has looked at this yet") is
recordable without either lying or leaving the finding unowned.

A `waived` entry whose reachability is `reachable` additionally requires a named
`compensatingControl`. Prose alone is not a control.

## What fails the gate

Seven independent mechanisms, each proven to fail by `pnpm audit:advisory:nonvacuity`:

| Case | Mutation of the committed policy | Expected |
|---|---|---|
| A | Real receipt, real policy | pass |
| B | Delete a live HIGH's disposition (**the original gap**) | fail |
| C | Keep a disposition for an advisory no longer present | fail |
| D | Move `reviewBy` into the past | fail |
| E | Blank the `argument` | fail |
| F | Make `images` disagree with the receipt | fail |
| G | Claim in `resolved[]` an advisory that is still present | fail |
| H | Narrow `gatedSeverities` to CRITICAL only | fail |

Case A proves the gate is not stuck red; B–H prove it is not stuck green. Every
case runs the real `audit:advisory:check` CLI against the real committed
receipt, lockfile and image inventory, varying only `--policy` — the inputs are
the same ones CI checks, so no case rests on a forged receipt.

Case H matters more than it looks: without it the entire gate could be disabled
by a one-word diff, without deleting a single disposition. The severity floor is
a constant in `scripts/lib/advisory-dispositions.mjs`; the policy file must
restate it exactly.

## Adding an entry

By hand. There is deliberately **no generator** in the repository — a
regenerate button would mass-absolve every newly published advisory, which is
the precise failure this gate exists to prevent. A new CRITICAL/HIGH turns CI
red until a human writes an argument, puts their name on it and dates it.

Review dates are real deadlines: an expired disposition fails the gate. That is
the point. A waiver is a loan, not a pardon.
