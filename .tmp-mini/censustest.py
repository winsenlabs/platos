import sys

p = 'scripts/arch/test-case-census.test.mjs'
s = open(p).read()

pairs = [
(
'''  // AND `secrets` ADDS NINE MORE: eight real-PostgreSQL and one pure
  // (`secrets-rows.test.ts`). 410 + 6 + 6 + 9 = 431 across the three of them.
  assert.equal(live.totalFiles, 431);''',
'''  // AND `secrets` ADDS NINE MORE: eight real-PostgreSQL and one pure
  // (`secrets-rows.test.ts`). 410 + 6 + 6 + 9 = 431 across the three of them.
  //
  // AND `providers` ADDS SEVEN: six real-PostgreSQL and one pure
  // (`providers-rows.test.ts`). It is SEVEN rather than six because the §6
  // budget split the constraints proof at 491 effective lines, along the port's
  // own seam — `ProviderKey`'s rules are environment-scoped and `Model`'s and
  // `ModelPrice`'s have no scope at all. 410 + 6 + 6 + 9 + 7 = 438 across the
  // four of them. No context row moves, for the fifth time.
  assert.equal(live.totalFiles, 438);''',
),
(
'''  assert.equal(live.totalFiles, 88 + 14 + 20 + 16 + 28 + 21 + 15 + 15 + 25 + 19 + 15 + 31 + 4 + 2 + 15 + 29 + 1 + 2 + 4 + 3 + 4 + 7 + 5 + 4 + 4 + 6 + 6 + 6 + 1 + 6 + 6 + 9);''',
'''  assert.equal(live.totalFiles, 88 + 14 + 20 + 16 + 28 + 21 + 15 + 15 + 25 + 19 + 15 + 31 + 4 + 2 + 15 + 29 + 1 + 2 + 4 + 3 + 4 + 7 + 5 + 4 + 4 + 6 + 6 + 6 + 1 + 6 + 6 + 9 + 7);''',
),
(
'''  // 378 + 5 + 4 + 4 + 6 + 6 + 6 + 1 + 6 + 6 + 9 = 431, and 422 of those files'
  // cases are integration cases the `postgres-tenancy-repository` CI job runs
  // and `pnpm test:v1-packages` does not, across 49 files.''',
'''  // 378 + 5 + 4 + 4 + 6 + 6 + 6 + 1 + 6 + 6 + 9 + 7 = 438, and 476 of those
  // files' cases are integration cases the `postgres-tenancy-repository` CI job
  // runs and `pnpm test:v1-packages` does not, across 55 files.''',
),
(
'''  // in the ordinary package test script, which is why the runnable term goes
  // 118 + 25 + 21 + 18 = 182 while the integration term goes
  // 265 + 47 + 45 + 65 = 422, and 182 + 422 = 604 is the row's whole case count.
  assert.equal(files, 431);''',
'''  // in the ordinary package test script, which is why the runnable term goes
  // 118 + 25 + 21 + 18 + 17 = 199 while the integration term goes
  // 265 + 47 + 45 + 65 + 54 = 476, and 199 + 476 = 675 is the row's whole case
  // count. `providers-rows.test.ts` is the fourth of those pure suites and its
  // 17 cases are the same argument one row over: the two unreadable-row
  // refusals it pins — an unknown `ModelRateSource` and a `Decimal(24, 12)` the
  // rate type will not parse — are rows a LATER release wrote, and a container
  // only ever reads rows this binary wrote.
  assert.equal(files, 438);''',
),
]

for a, b in pairs:
    if a not in s:
        sys.exit("MISS: " + a[:70])
    s = s.replace(a, b, 1)

open(p, 'w').write(s)
print("ok")
