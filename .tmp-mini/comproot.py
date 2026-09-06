import sys

p = 'scripts/arch/composition-root.test.mjs'
s = open(p).read()

pairs = [
(
'''  // THIRTY bindings across TWELVE directories (ADR M0.3 §15). Both are''',
'''  // THIRTY-ONE bindings across TWELVE directories (ADR M0.3 §15). Both are'''
),
(
'''  // both. The DIRECTORY count deliberately does not move through any of it,
  // which is the whole content of the amendment.
  assert.equal(audit.bindingCount, adapterBindings().length);
  assert.equal(audit.bindingCount, 30);''',
'''  // both. The DIRECTORY count deliberately does not move through any of it,
  // which is the whole content of the amendment.
  // 30 -> 31 (WIN-258 T5): `providers` adds `ProvidersRepository`, its ONE
  // canonical-store port over the four rows of §1 row 4, so that directory
  // carries TWENTY. It is proven against the ADAPTER rather than through a
  // property — its eighteen method names collide with nothing the directory
  // already publishes — which is the contrast that makes `secrets`' two
  // property proofs read as forced rather than stylistic.
  assert.equal(audit.bindingCount, adapterBindings().length);
  assert.equal(audit.bindingCount, 31);'''
),
(
'''  assert.ok(problems.some((problem) => problem.includes("declares 29 binding(s)")));''',
'''  assert.ok(problems.some((problem) => problem.includes("declares 30 binding(s)")));'''
),
(
'''test("the binding-table parser reads all THIRTY bindings, across twelve directories", () => {''',
'''test("the binding-table parser reads all THIRTY-ONE bindings, across twelve directories", () => {'''
),
(
'''  assert.equal(bindings.length, 30);''',
'''  assert.equal(bindings.length, 31);'''
),
(
'''      problem.includes("binding table names outbox -> memory Cache, which is not one of the 30 declared bindings")''',
'''      problem.includes("binding table names outbox -> memory Cache, which is not one of the 31 declared bindings")'''
),
]

for a, b in pairs:
    if a not in s:
        sys.exit("MISS: " + a[:70])
    s = s.replace(a, b)

open(p, 'w').write(s)
print("ok")
