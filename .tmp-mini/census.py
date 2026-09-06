import sys

p = 'scripts/arch/test-case-census.mjs'
s = open(p).read()

BLOCK = ''' * WIN-258 TRANCHE 5 - PROVIDERS' CANONICAL STORE. The SAME package moves a
 * TENTH time, for the tenth reading of ADR M0.3 §15: `providers` is sole writer
 * of four rows in the same PostgreSQL database, so its repository is the same
 * client, the same transaction and the same directory.
 *
 *   packages/adapters/postgres-tenancy   60 -> 67 files,  604 -> 675 cases
 *
 * WHAT THE 71 ARE, file by file, so the total cannot absorb a loss elsewhere:
 *
 *   providers-rows.test.ts                     17  the crossing in both
 *                                                  directions, the three column
 *                                                  renames, every guard and the
 *                                                  two unreadable-row refusals,
 *                                                  PURE - the only one of the
 *                                                  seven `pnpm test:v1-packages`
 *                                                  runs
 *   providers-conformance.integration.test.ts  11  the scenario against the fake
 *                                                  and the real store compared
 *                                                  verbatim, plus non-vacuity,
 *                                                  the listing order, the two
 *                                                  unique refusals told apart,
 *                                                  the Decimal(24, 12) round
 *                                                  trip and the model identity
 *   providers-constraints.integration.test.ts  11  `ProviderKey`'s five database
 *                                                  rules, each guard beside the
 *                                                  rule it restates and each
 *                                                  rule shown refusing a raw
 *                                                  statement that steps around
 *                                                  the guard
 *   providers-catalogue-constraints
 *     .integration.test.ts                     11  the same pairing for `Model`
 *                                                  and `ModelPrice`: the rate
 *                                                  CHECK in both directions, the
 *                                                  append-only triggers, the
 *                                                  SECOND identity the port does
 *                                                  not model, and the INTEGER
 *                                                  columns
 *   providers-rules.integration.test.ts         7  the rules NO port method
 *                                                  restates: the delete trigger
 *                                                  in BOTH places a version can
 *                                                  pin a key, its own provider
 *                                                  negative control, the scoped
 *                                                  count, the collation
 *                                                  disagreement and the second
 *                                                  adoption
 *   providers-transaction.integration.test.ts   7  failure injection over a
 *                                                  second client, the negative
 *                                                  control, BOTH answers a
 *                                                  returned error Result gives,
 *                                                  the touch that survives a
 *                                                  rollback, and the three scope
 *                                                  refusals
 *   providers-statements.integration.test.ts    7  measured statement counts over
 *                                                  two fixture sizes, the probe
 *                                                  anchor, and the three writes
 *                                                  whose count is the contract
 *
 * 17 + 11 + 11 + 11 + 7 + 7 + 7 = 71. Six of the seven need a real PostgreSQL
 * and are run by the `postgres-tenancy-repository` CI job, not by
 * `pnpm test:v1-packages`; they are counted here because this census measures
 * the suites a package SHIPS.
 *
 * TWO OF THE SEVEN ARE THIS TRANCHE'S OWN SPLITS, and both were forced rather
 * than chosen. The constraints proof measured 491 effective lines as one file,
 * four lines of prose from the §6 hard error, and it split along the port's own
 * seam: `ProviderKey`'s rules are environment-scoped and every case needs a
 * tenant chain and a credential, while `Model` and `ModelPrice` have no scope at
 * all. The conformance SCENARIO is two modules for the same reason and is
 * counted once, under the suite that drives it.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 11 in the conformance suite. It is
 * small because it is ONE scenario of sixty-two observations compared verbatim
 * against `InMemoryProvidersRepository`; adding an observation strengthens the
 * differential and moves NO count here, which is why `mutations-providers.json`
 * beside the package is where those guards are held falsifiable.
 *
 * WITH `providers` THE PACKAGE'S ROW IS 20 + 6 + 6 + 7 + 6 + 6 + 9 + 7 = 67
 * files and 199 + 59 + 60 + 65 + 72 + 66 + 83 + 71 = 675 cases. The tree total
 * is 431 + 7 = 438 files and 6520 + 71 = 6591 cases. The adapters term of the
 * three-way identity carries all seven, because every added file is an
 * adapter's: 79 + 7 = 86, and 349 + 3 + 86 = 438.
 */
export const EXPECTED = Object.freeze({'''

pairs = [
(
''' */
export const EXPECTED = Object.freeze({''',
BLOCK
),
(
'''  "packages/adapters/postgres-tenancy": { files: 60, cases: 604 },''',
'''  "packages/adapters/postgres-tenancy": { files: 67, cases: 675 },'''
),
(
''' * It is corrected to the merged measurement rather than carried, because a count
 * of cases stated in prose beside an asserted one is exactly the drift this file
 * exists to catch.
 */
export const EXPECTED_RUNTIME_TOTAL = 6520;''',
''' * It is corrected to the merged measurement rather than carried, because a count
 * of cases stated in prose beside an asserted one is exactly the drift this file
 * exists to catch.
 *
 * 6520 -> 6591: the 71 cases of WIN-258 tranche 5's `providers` canonical store,
 * enumerated file by file in the block beside the postgres-tenancy row. Six of
 * its seven suites carry `.integration.` in the name, so the cases this census
 * records and `pnpm test:v1-packages` does not execute go from 422 over 49 files
 * to 476 over 55; the seventh, `providers-rows.test.ts`, runs in the ordinary
 * package test script for the reason the other three row suites do — it has no
 * database in it, and it reaches the mapping branches a container suite cannot,
 * since a container only ever reads rows this binary wrote.
 */
export const EXPECTED_RUNTIME_TOTAL = 6591;'''
),
]

for a, b in pairs:
    if a not in s:
        sys.exit("MISS: " + a[:70])
    s = s.replace(a, b, 1)

open(p, 'w').write(s)
print("ok")
