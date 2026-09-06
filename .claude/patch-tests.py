import re

p = "scripts/arch/composition-root.test.mjs"
s = open(p).read()

old = '''  // TWENTY-TWO bindings across TWELVE directories (ADR M0.3 §15). Both are
  // asserted, so a change that collapsed them back to one number fails here.
  // 13 -> 17 (WIN-258 T5, three stores): `tools:ToolsRepository`,
  // `agents:AgentsRepository`, `agents:ScaffoldingRepository` and
  // `cost-monitoring:BudgetRepository`, so one directory now carries six.
  // 17 -> 22 (WIN-258 M2.3): tenancy's five NON-REPOSITORY driven ports get
  // slots, so that directory carries eleven. The DIRECTORY count deliberately
  // does not move through any of it, which is the whole content of the
  // amendment.
  assert.equal(audit.bindingCount, adapterBindings().length);
  assert.equal(audit.bindingCount, 22);'''
new = '''  // TWENTY-SEVEN bindings across TWELVE directories (ADR M0.3 §15). Both are
  // asserted, so a change that collapsed them back to one number fails here.
  // 13 -> 17 (WIN-258 T5, three stores): `tools:ToolsRepository`,
  // `agents:AgentsRepository`, `agents:ScaffoldingRepository` and
  // `cost-monitoring:BudgetRepository`, so one directory now carries six.
  // 17 -> 22 (WIN-258 M2.3): tenancy's five NON-REPOSITORY driven ports get
  // slots, so that directory carries eleven.
  // 22 -> 27 (WIN-258 T5, `governance`): five canonical-store ports over five
  // canonical rows, so that directory carries SIXTEEN. The DIRECTORY count
  // deliberately does not move through any of it, which is the whole content of
  // the amendment.
  assert.equal(audit.bindingCount, adapterBindings().length);
  assert.equal(audit.bindingCount, 27);'''
assert old in s
s = s.replace(old, new)

s = s.replace(
    'test("the binding-table parser reads all TWENTY-TWO bindings, across twelve directories", () => {',
    'test("the binding-table parser reads all TWENTY-SEVEN bindings, across twelve directories", () => {',
)
s = s.replace("  assert.equal(bindings.length, 22);", "  assert.equal(bindings.length, 27);")
s = s.replace(
    'problem.includes("binding table names outbox -> memory Cache, which is not one of the 22 declared bindings")',
    'problem.includes("binding table names outbox -> memory Cache, which is not one of the 27 declared bindings")',
)
s = s.replace(
    'assert.ok(problems.some((problem) => problem.includes("declares 21 binding(s)")));',
    'assert.ok(problems.some((problem) => problem.includes("declares 26 binding(s)")));',
)
open(p, "w").write(s)

p = "scripts/arch/gen-v1-skeleton.test.mjs"
s = open(p).read()
s = s.replace(
    'test("§15 refusal: a TWENTY-THIRD binding fails, even though a directory may hold more than one", () => {',
    'test("§15 refusal: a TWENTY-EIGHTH binding fails, even though a directory may hold more than one", () => {',
)
s = s.replace(
    'assert.ok(errors.some((error) => error.includes("declares 22 adapter bindings; ADAPTERS flattens to 23")));',
    'assert.ok(errors.some((error) => error.includes("declares 27 adapter bindings; ADAPTERS flattens to 28")));',
)
open(p, "w").write(s)
print("patched composition-root.test.mjs and gen-v1-skeleton.test.mjs")
