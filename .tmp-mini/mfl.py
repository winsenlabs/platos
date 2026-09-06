import sys

p = 'scripts/arch/max-file-lines.test.mjs'
s = open(p).read()

pairs = [
(
'''  // THE TRANCHE-5 BLOCKS SUM: 1200 + 18 + 16 + 16 + 1 + 15 + 18 + 19 = 1303. All
  // the stores are in the one adapter directory, so no branch's own figure
  // survives the merge — 1266 for `channels`, 1269 for `governance`, 1270 for
  // `secrets`.
  assert.equal(result.fileCount, 1303);''',
'''  //
  // 1251 -> 1267 (WIN-258 T5): `providers`' canonical store adds SIXTEEN files
  // to the one ORM home -- nine source and SEVEN suites.
  //
  // AND THE BUDGET BIT AGAIN, before either file was committed. The constraints
  // suite reached 491 effective lines as one module -- inside the warning band
  // and four lines of prose from the 500-line ERROR -- and the split is at a
  // seam the port itself already has: `ProviderKey`'s five rules are all
  // ENVIRONMENT-SCOPED and every case needs a tenant chain and a credential,
  // while `Model` and `ModelPrice` have no scope at all and not one case there
  // takes one. The remaining warning is `providers-conformance.ts` at 421, and
  // it is named in the finding list below rather than split: like
  // `channels-conformance.ts` it is ONE scenario compared verbatim against a
  // double, and it is ALREADY two files -- the catalogue half is a separate
  // module for the same scoping reason.
  //
  // THE TRANCHE-5 BLOCKS SUM: 1200 + 18 + 16 + 16 + 1 + 15 + 18 + 19 + 16 =
  // 1319. All the stores are in the one adapter directory, so no branch's own
  // figure survives the merge — 1266 for `channels`, 1269 for `governance`,
  // 1270 for `secrets`, 1267 for `providers`.
  assert.equal(result.fileCount, 1319);'''
),
(
'''    328 + 44 + 55 + 51 + 77 + 63 + 48 + 48 + 67 + 56 + 42 + 83 + 8 + 4 + 20 + 54 + 18 + 74 + 12 + 22 + 11 + 9 + 6 + 18 + 16 + 16 + 1 + 15 + 18 + 19
  );''',
'''    328 + 44 + 55 + 51 + 77 + 63 + 48 + 48 + 67 + 56 + 42 + 83 + 8 + 4 + 20 + 54 + 18 + 74 + 12 + 22 + 11 + 9 + 6 + 18 + 16 + 16 + 1 + 15 + 18 + 19 + 16
  );'''
),
(
'''  // (secrets) = 217. The contexts, kernel and app rows are untouched, which is''',
'''  // (secrets) + 16 (providers) = 233. The contexts, kernel and app rows are
  // untouched, which is'''
),
(
'''  assert.equal(result.fileCount, 20 + 1060 + 217 + 6);''',
'''  assert.equal(result.fileCount, 20 + 1060 + 233 + 6);'''
),
(
'''    {
      path: "packages/contexts/jobs/application/approval-lifecycle.test.ts",
      effectiveLines: 465,
      severity: "warning",
    },''',
'''    {
      path: "packages/adapters/postgres-tenancy/src/providers-conformance.ts",
      effectiveLines: 421,
      severity: "warning",
    },
    {
      path: "packages/contexts/jobs/application/approval-lifecycle.test.ts",
      effectiveLines: 465,
      severity: "warning",
    },'''
),
(
'''  // tables in a second tenant. A table-driven loop would not be counted as cases
  // at all.
  assert.deepEqual(result.findings, [''',
'''  // tables in a second tenant. A table-driven loop would not be counted as cases
  // at all.
  //
  // WIN-258 T5 (`providers`) BROUGHT ONE, and it is the second conformance
  // scenario in this list rather than a new kind of finding.
  // `providers-conformance.ts` is 421 because it drives EIGHTEEN port methods
  // over four rows in one sequence and records every one, and it is ALREADY
  // split: the catalogue half is a separate module, because `Model` and
  // `ModelPrice` take no scope and every step in this half does. Splitting it
  // again would split a transcript that is only evidence while it is one
  // sequence. The constraints suite beside it was 491 and IS split, along the
  // same seam, which is the difference between a warning that is a shape and one
  // that is a queue for the hard error.
  assert.deepEqual(result.findings, ['''
),
]

for a, b in pairs:
    if a not in s:
        sys.exit("MISS: " + a[:70])
    s = s.replace(a, b)

open(p, 'w').write(s)
print("ok")
