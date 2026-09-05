import io

p = "packages/adapters/postgres-tenancy/src/governance-rules.integration.test.ts"
s = open(p).read()

addition = '''
describe("every read and every write is narrowed to ONE environment", () => {
  // THE NEGATIVE CONTROL FOR `scopedWhere`. Each of the five tables is written
  // in a SECOND tenant and then asked for from the first, and every answer must
  // be the answer for an id that does not exist. A store whose narrowing was
  // dropped would still pass every other suite in this package, because every
  // other suite works inside one environment.
  test("a row in another environment is invisible, unwritable and undeletable", async () => {
    const foreign = await harness.foreignChain();
    const foreignIds = {
      ...ids,
      agentId: foreign.agentId,
      agentVersionId: foreign.agentVersionId,
      threadId: foreign.threadId,
      turnId: foreign.turnId,
    };

    const criterion = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.criteria.create(
        foreign.scope,
        conformanceCriterion({ name: `foreign-${Date.now()}` }),
        actor,
        transaction,
      ),
    );
    expect(criterion.ok).toBe(true);
    if (!criterion.ok) return;

    const set = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.goldenSets.create(
        foreign.scope,
        conformanceGoldenSet(foreignIds),
        actor,
        transaction,
      ),
    );
    expect(set.ok).toBe(true);
    if (!set.ok) return;

    const rating = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.ratings.upsert(
        foreign.scope,
        {
          turnId: asGovernanceIdentifier<TurnId>(foreign.turnId),
          agentId: asGovernanceIdentifier<AgentId>(foreign.agentId),
          agentVersionId: asGovernanceIdentifier<AgentVersionId>(foreign.agentVersionId),
          endUserId: asGovernanceIdentifier<EndUserId>(foreign.endUserId),
          rating: 1,
          comment: "from another tenant",
          revision: 1,
        },
        transaction,
      ),
    );
    expect(rating.ok).toBe(true);

    const event = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.safety.append(foreign.scope, conformanceSafetyEvent(foreignIds), transaction),
    );
    expect(event.ok).toBe(true);
    if (!event.ok) return;

    // READS from THIS scope, for rows that exist in the other one.
    const criterionFromHere = await harness.stores.criteria.findById(
      scope,
      criterion.value.evalCriterionId,
    );
    expect(criterionFromHere.ok && criterionFromHere.value).toBeNull();
    const byName = await harness.stores.criteria.findByName(scope, criterion.value.name);
    expect(byName.ok && byName.value).toBeNull();
    const setFromHere = await harness.stores.goldenSets.findById(scope, set.value.goldenSetId);
    expect(setFromHere.ok && setFromHere.value).toBeNull();
    const eventFromHere = await harness.stores.safety.findById(scope, event.value.safetyEventId);
    expect(eventFromHere.ok && eventFromHere.value).toBeNull();
    const ratingFromHere = await harness.stores.ratings.findForTurn(
      scope,
      asGovernanceIdentifier<TurnId>(foreign.turnId),
      asGovernanceIdentifier<EndUserId>(foreign.endUserId),
    );
    expect(ratingFromHere.ok && ratingFromHere.value).toBeNull();

    // WRITES from this scope must touch nothing over there.
    const flip = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.ratings.upsert(
        scope,
        {
          turnId: asGovernanceIdentifier<TurnId>(foreign.turnId),
          agentId: asGovernanceIdentifier<AgentId>(foreign.agentId),
          agentVersionId: null,
          endUserId: asGovernanceIdentifier<EndUserId>(foreign.endUserId),
          rating: 5,
          comment: "reached across",
          revision: 9,
        },
        transaction,
      ),
    );
    // The scoped update matches nothing, so the create path runs and the
    // installation-wide unique index refuses it. Either way the other tenant's
    // row is untouched.
    expect(flip.ok).toBe(false);
    const untouched = await observer.messageRating.findFirst({
      where: { turnId: foreign.turnId, endUserId: foreign.endUserId },
      select: { comment: true, revision: true },
    });
    expect(untouched).toEqual({ comment: "from another tenant", revision: 1 });

    const removedCriterion = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.criteria.remove(scope, criterion.value.evalCriterionId, transaction),
    );
    expect(removedCriterion.ok && removedCriterion.value).toBe(false);
    const removedSet = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.goldenSets.remove(scope, set.value.goldenSetId, transaction),
    );
    expect(removedSet.ok && removedSet.value).toBe(false);
    const renamed = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.goldenSets.update(scope, { ...set.value, name: "renamed" }, transaction),
    );
    expect(renamed.ok).toBe(false);

    // And all four rows are still there, seen from a client that wrote none.
    expect(
      await observer.evalCriterion.count({ where: { id: criterion.value.evalCriterionId } }),
    ).toBe(1);
    expect(await observer.goldenSet.count({ where: { id: set.value.goldenSetId } })).toBe(1);
    expect(await observer.safetyEvent.count({ where: { id: event.value.safetyEventId } })).toBe(1);
    expect(await observer.messageRating.count({ where: { turnId: foreign.turnId } })).toBe(1);
  });
});
'''

s = s.rstrip() + "\n" + addition
open(p, "w").write(s)
print("patched")
