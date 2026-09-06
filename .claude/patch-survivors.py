B = "packages/adapters/postgres-tenancy/src/"

# ---- M-G27 and the thumbs-down flip: the conformance scenario --------------
p = B + "governance-conformance.ts"
s = open(p).read()

old = '''  observed["ratings.tallyTurn"] = outcome('''
new = '''  observed["ratings.upsert.flipDown"] = outcome(
    // A THUMBS-DOWN, which the deployed `CHECK (rating IN (-1, 1))` admits and
    // the FIRST constraint in the same migration file would have refused. Half
    // the domain's value space is exercised here and nowhere else in this
    // scenario.
    await environment.run((transaction) =>
      stores.ratings.upsert(
        scope,
        {
          turnId,
          agentId,
          agentVersionId: asGovernanceIdentifier<AgentVersionId>(ids.secondAgentVersionId),
          endUserId,
          rating: -1,
          comment: "changed my mind",
          revision: 3,
        },
        transaction,
      ),
    ),
    (rating) => ({ rating: rating.rating, revision: rating.revision, comment: rating.comment }),
  );
  observed["ratings.tallyTurn"] = outcome('''
assert old in s
s = s.replace(old, new, 1)

old = '''  observed["criteria.page.forAgent"] = outcome('''
new = '''  observed["criteria.page.explicitUndefined"] = outcome(
    // THE KEY IS PRESENT AND THE VALUE IS `undefined`, which is a THIRD case:
    // `agentId?: AgentId | null` permits it, and `"agentId" in query` is what
    // tells it from an absent key. The double treats it as the SHARED-only
    // filter; a store that switched to `=== undefined` would treat it as no
    // filter at all and widen the listing to every criterion in the environment.
    await stores.criteria.page(scope, {
      limit: 10,
      offset: 0,
      agentId: undefined,
      activeOnly: false,
      search: null,
    }),
    (page) => ({ total: page.total, names: page.items.map((item) => item.name) }),
  );
  observed["criteria.page.forAgent"] = outcome('''
assert old in s
s = s.replace(old, new, 1)
open(p, "w").write(s)

# ---- M-G18: a safety append with a stale token -----------------------------
p = B + "governance-transaction.integration.test.ts"
s = open(p).read()
old = '''test("the three scope refusals are three DISTINCT codes", async () => {'''
new = '''test("an APPEND carrying a scope is held to the same three refusals", async () => {
  // The case above measures the refusals through `criteria.remove`. This one
  // measures them through `safety.append`, which is the ONE method in this
  // context whose transaction parameter is NULLABLE — so it is the one method an
  // implementation could plausibly have resolved through `reader()` on both
  // branches, which would silently accept a finished or a foreign token.
  const stale = await harness.base.adapter.unitOfWork.run(async (transaction) => transaction);
  await expect(
    harness.base.adapter.unitOfWork.run(() =>
      harness.stores.safety.append(scope, conformanceSafetyEvent(ids), stale),
    ),
  ).rejects.toThrow();
  const refusal = await harness.base.adapter.unitOfWork
    .run(() => harness.stores.safety.append(scope, conformanceSafetyEvent(ids), stale))
    .then(() => "<no refusal>", (error: unknown) => codeOf(error));
  // The token names a transaction that has already committed, so it is UNKNOWN
  // rather than foreign and rather than absent.
  expect(refusal).toBe(TRANSACTION_SCOPE_UNKNOWN);
});

test("the three scope refusals are three DISTINCT codes", async () => {'''
assert old in s
s = s.replace(old, new, 1)
open(p, "w").write(s)

# ---- M-G23: erasing ONE subject leaves the others ---------------------------
p = B + "governance-rules.integration.test.ts"
s = open(p).read()
old = '''describe("every read and every write is narrowed to ONE environment", () => {'''
new = '''test("an erasure destroys ONE subject's ratings and leaves every other subject's", async () => {
  // The count an erasure returns is right whether or not the subject predicate
  // is there, because the rows it destroyed are the rows it counted. The only
  // thing that sees a missing predicate is somebody ELSE'S vote, so this case
  // seeds one and looks for it afterwards.
  const chainA = await harness.foreignChain();
  const other = harness.base.freshId("001e");
  harness.applyPeerRows(
    `INSERT INTO "EndUser" ("id", "organizationId", "displayName", "createdAt", "updatedAt")
     VALUES ('${other}', '${chainA.scope.organizationId}', 'second rater', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');
     INSERT INTO "Thread" ("id", "environmentId", "agentId", "endUserId", "status", "createdAt", "updatedAt")
     VALUES ('${harness.base.freshId("001f")}', '${chainA.scope.environmentId}', '${chainA.agentId}', '${other}',
             'ACTIVE', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
  );
  // The second subject's vote has to hang off a turn in a thread THEY own —
  // `MessageRating_ancestry` demands exactly that — so it goes on a second
  // thread with a turn of its own.
  const otherThread = await observer.thread.findFirst({
    where: { endUserId: other },
    select: { id: true },
  });
  const otherTurn = harness.base.freshId("0020");
  harness.applyPeerRows(
    `INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence", "status", "createdAt")
     VALUES ('${otherTurn}', '${otherThread?.id}', '${chainA.agentVersionId}', 'CURRENT', 1, 'SUCCEEDED',
             '2026-05-01T09:00:00Z');`,
  );

  for (const [turn, subject] of [
    [chainA.turnId, chainA.endUserId],
    [otherTurn, other],
  ] as const) {
    const written = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.ratings.upsert(
        chainA.scope,
        {
          turnId: asGovernanceIdentifier<TurnId>(turn),
          agentId: asGovernanceIdentifier<AgentId>(chainA.agentId),
          agentVersionId: asGovernanceIdentifier<AgentVersionId>(chainA.agentVersionId),
          endUserId: asGovernanceIdentifier<EndUserId>(subject),
          rating: 1,
          comment: null,
          revision: 1,
        },
        transaction,
      ),
    );
    expect(written.ok).toBe(true);
  }

  const erased = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.ratings.eraseSubject(
      { scope: chainA.scope, endUserId: asGovernanceIdentifier<EndUserId>(chainA.endUserId) },
      transaction,
    ),
  );
  expect(erased.ok && erased.value).toBe(1);
  expect(
    await observer.messageRating.count({ where: { endUserId: chainA.endUserId } }),
  ).toBe(0);
  // THE ROW THAT MUST SURVIVE.
  expect(await observer.messageRating.count({ where: { endUserId: other } })).toBe(1);

  // And a NULL subject erases nothing at all, which the port requires and which
  // an implementation that dropped the predicate would get exactly backwards.
  const none = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.ratings.eraseSubject({ scope: chainA.scope, endUserId: null }, transaction),
  );
  expect(none.ok && none.value).toBe(0);
  expect(await observer.messageRating.count({ where: { endUserId: other } })).toBe(1);
});

describe("every read and every write is narrowed to ONE environment", () => {'''
assert old in s
s = s.replace(old, new, 1)
open(p, "w").write(s)
print("patched survivors")
