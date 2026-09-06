p = "scripts/arch/sole-writer.test.mjs"
s = open(p).read()

anchor = '''test("the shared directory is not a blanket licence over the whole schema", () => {'''

addition = '''test("only governance's own two directories may write its five rows", () => {
  // WIN-258 T5. The delegation added for `governance` is a permission, and a
  // permission is only worth anything if the thing it does NOT permit goes red.
  // Every one of the five rows is checked, not a representative one, because the
  // grant is per row and a map entry lost for a single model would otherwise sit
  // here unnoticed behind a green case for `SafetyEvent`.
  const FIVE = [
    ["safetyEvent", "SafetyEvent"],
    ["messageRating", "MessageRating"],
    ["evalCriterion", "EvalCriterion"],
    ["agentEval", "AgentEval"],
    ["goldenSet", "GoldenSet"],
  ];

  for (const [delegate, model] of FIVE) {
    // The delegate directory: legal, and the reason the five repositories can
    // exist at all.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/postgres-tenancy/src/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its canonical-store adapter`,
    );
    // The owning context itself: also legal, and never exercised in the live
    // tree, because ADR M0.3 §2 forbids that package from holding the client.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/contexts/governance/application/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its owning context`,
    );
    // ANY THIRD PLACE: refused. `conversations` is the pointed choice — it owns
    // the `Thread` and the `Turn` that three of these five rows hang off, it
    // cascades them away when a thread is deleted, and it is exactly as refused
    // from writing one as anything else is.
    const trespass = checkWriteEnforcement(
      fixture({ [`packages/contexts/conversations/application/x.ts`]: write(delegate, "create") }),
    );
    assert.equal(trespass.violations.length, 1, `a foreign write to ${model} must be refused`);
    assert.equal(trespass.violations[0].model, model);
    assert.equal(trespass.violations[0].actual, "packages/contexts/conversations");
    assert.deepEqual(trespass.violations[0].permitted, [
      "packages/contexts/governance",
      "packages/adapters/postgres-tenancy",
    ]);
    // And a SIBLING canonical-store adapter is not a loophole either: being an
    // adapter is not the qualification, being THIS owner's declared store is.
    assert.equal(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/outbox/src/x.ts`]: write(delegate, "create") }),
      ).violations.length,
      1,
      `${model} must be refused from an adapter that is not its canonical store`,
    );
  }

  // AND RAW SQL IS NOT A WAY ROUND IT. The gate attributes a raw statement to
  // the table its SQL names, so a context reaching for the ledger through
  // `$executeRaw` is refused on the same terms as one reaching for the delegate.
  const raw = checkWriteEnforcement(
    fixture({
      "packages/contexts/observability/application/steal.ts":
        `export async function run(db) {\\n` +
        `  await db.$executeRaw\\`insert into "public"."SafetyEvent" (id) values ('x')\\`;\\n` +
        `}\\n`,
    }),
  );
  assert.equal(raw.violations.length, 1);
  assert.equal(raw.violations[0].model, "SafetyEvent");
});

'''

assert anchor in s, "anchor"
s = s.replace(anchor, addition + anchor, 1)
open(p, "w").write(s)
print("patched")
