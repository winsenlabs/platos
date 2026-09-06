import sys

p = 'scripts/arch/test-case-census.test.mjs'
s = open(p).read()

pairs = [
(
'''  //
  // ALL FIVE tranches move THIS row, so it carries every tail:
  // 11 + 5 + 4 + 6 + 6 + 6 + 1 + 9 = 48 files and
  // 123 + 43 + 33 + 59 + 60 + 61 + 4 + 83 = 466 cases. No branch's own row is
  // the merged row, and any one taken alone would drop the others' suites out of
  // a census whose whole purpose is to see every case.
  assert.equal(
    EXPECTED["packages/adapters/postgres-tenancy"].files,
    2 + 2 + 1 + 6 + 1 + 4 + 4 + 6 + 6 + 6 + 1 + 6 + 6 + 9,
  );''',
'''  //
  // WIN-258 TRANCHE 5 adds SEVEN more suites and 71 more cases to the same row —
  // `providers`' canonical store, the FIFTH owner behind the one ORM client and
  // the NINTH overall: one pure (providers-rows.test, 17, the three column
  // renames the schema and the aggregates disagree about, every guard, and the
  // two unreadable-row refusals) and six real-PostgreSQL — `ProviderKey`'s five
  // database rules each stood beside a raw statement that steps around the
  // guard (11), the same pairing for `Model` and `ModelPrice` (11), the
  // conformance differential against `InMemoryProvidersRepository` (11), the
  // rules no port method restates (7), failure injection with the touch that
  // survives a rollback and the three scope refusals (7), and the measured
  // statement counts (7).
  //
  // IT IS SEVEN SUITES RATHER THAN SIX BECAUSE THE §6 BUDGET SPLIT ONE, at 491
  // effective lines and four lines of prose from the hard error. The seam is the
  // port's own and not an arbitrary halving: `ProviderKey`'s rules are
  // ENVIRONMENT-SCOPED and every case needs a tenant chain and a credential,
  // while `Model` and `ModelPrice` have no scope at all.
  //
  // ALL FIVE tranches move THIS row, so it carries every tail:
  // 11 + 5 + 4 + 6 + 6 + 6 + 1 + 9 + 7 = 55 files and
  // 123 + 43 + 33 + 59 + 60 + 61 + 4 + 83 + 71 = 537 cases. No branch's own row
  // is the merged row, and any one taken alone would drop the others' suites out
  // of a census whose whole purpose is to see every case.
  assert.equal(
    EXPECTED["packages/adapters/postgres-tenancy"].files,
    2 + 2 + 1 + 6 + 1 + 4 + 4 + 6 + 6 + 6 + 1 + 6 + 6 + 9 + 7,
  );'''
),
(
'''      18 + 11 + 10 + 8 + 8 + 8 + 7 + 7 + 6,
  );
  assert.equal(EXPECTED["packages/adapters/postgres-tenancy"].cases, 604);
  // 182 of the 604 run in `pnpm test:v1-packages`; the other 422 need a Docker
  // daemon and run in the `postgres-tenancy-repository` CI job. A pin that
  // counted only the runnable 182 would go green if the integration suites were
  // deleted, which is the one change this row exists to make visible.
  assert.equal(EXPECTED_RUNTIME_TOTAL, 5875 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83);''',
'''      18 + 11 + 10 + 8 + 8 + 8 + 7 + 7 + 6 +
      17 + 11 + 11 + 11 + 7 + 7 + 7,
  );
  assert.equal(EXPECTED["packages/adapters/postgres-tenancy"].cases, 675);
  // 199 of the 675 run in `pnpm test:v1-packages`; the other 476 need a Docker
  // daemon and run in the `postgres-tenancy-repository` CI job. A pin that
  // counted only the runnable 199 would go green if the integration suites were
  // deleted, which is the one change this row exists to make visible.
  assert.equal(EXPECTED_RUNTIME_TOTAL, 5875 + 56 + 67 + 43 + 41 + 33 + 59 + 60 + 61 + 4 + 72 + 66 + 83 + 71);'''
),
]

for a, b in pairs:
    if a not in s:
        sys.exit("MISS: " + a[:70])
    s = s.replace(a, b, 1)

open(p, 'w').write(s)
print("ok")
