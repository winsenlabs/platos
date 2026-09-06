B = "packages/adapters/postgres-tenancy/src/"

# ------------------------------------------------------------- rows.test.ts
p = B + "governance-rows.test.ts"
s = open(p).read()
s = s.replace("  RATING_OUTSIDE_SCHEMA_RANGE,\n", "  RATING_NOT_THUMBS,\n")
s = s.replace(
    '''  test("`MessageRating_rating_check` admits 1..5 and refuses the domain's -1", () => {
    expect(refusalOf(() => requireStorableRating(1))).toBe("<accepted>");
    // A legacy five-star value is STORABLE even though the domain never mints
    // one, because the guard's bound is the CHECK's and not the domain's.
    expect(refusalOf(() => requireStorableRating(5))).toBe("<accepted>");
    expect(refusalOf(() => requireStorableRating(-1))).toBe(RATING_OUTSIDE_SCHEMA_RANGE);
    expect(refusalOf(() => requireStorableRating(6))).toBe(RATING_OUTSIDE_SCHEMA_RANGE);
    expect(refusalOf(() => requireStorableRating(1.5))).toBe(RATING_OUTSIDE_SCHEMA_RANGE);
  });''',
    '''  test("`MessageRating_rating_check` is the constraint the migration ENDS with", () => {
    // The file installs `BETWEEN 1 AND 5` and then, 1,000 lines later, DROPS it
    // for `IN (-1, 1)`. Both thumbs are storable; every five-star value is not,
    // which is the reading a stop-at-the-first-constraint adapter gets backwards
    // in both directions at once.
    expect(refusalOf(() => requireStorableRating(1))).toBe("<accepted>");
    expect(refusalOf(() => requireStorableRating(-1))).toBe("<accepted>");
    expect(refusalOf(() => requireStorableRating(3))).toBe(RATING_NOT_THUMBS);
    expect(refusalOf(() => requireStorableRating(5))).toBe(RATING_NOT_THUMBS);
    expect(refusalOf(() => requireStorableRating(0))).toBe(RATING_NOT_THUMBS);
    expect(refusalOf(() => requireStorableRating(1.5))).toBe(RATING_NOT_THUMBS);
  });''',
)
s = s.replace(
    '''  test("`revision` is a positive int4, under a code of its own", () => {
    expect(refusalOf(() => requireStorableRevision(1))).toBe("<accepted>");
    expect(refusalOf(() => requireStorableRevision(0))).toBe(RATING_REVISION_INVALID);
    expect(refusalOf(() => requireStorableRevision(2 ** 40))).toBe(RATING_REVISION_INVALID);
    expect(RATING_REVISION_INVALID).not.toBe(RATING_OUTSIDE_SCHEMA_RANGE);
  });''',
    '''  test("`revision` satisfies its own CHECK and fits int4, under a code of its own", () => {
    // `MessageRating_revision_check CHECK ("revision" > 0)` is installed by the
    // same later block that corrects the rating constraint. The int4 half is the
    // column type and has no CHECK, so the guard covers both.
    expect(refusalOf(() => requireStorableRevision(1))).toBe("<accepted>");
    expect(refusalOf(() => requireStorableRevision(0))).toBe(RATING_REVISION_INVALID);
    expect(refusalOf(() => requireStorableRevision(2 ** 40))).toBe(RATING_REVISION_INVALID);
    expect(RATING_REVISION_INVALID).not.toBe(RATING_NOT_THUMBS);
  });''',
)
s = s.replace("      RATING_OUTSIDE_SCHEMA_RANGE,\n", "      RATING_NOT_THUMBS,\n")
open(p, "w").write(s)

# --------------------------------------------------- constraints integration
p = B + "governance-constraints.integration.test.ts"
s = open(p).read()
s = s.replace("  RATING_OUTSIDE_SCHEMA_RANGE,\n", "  RATING_NOT_THUMBS,\n")
s = s.replace(
    '''describe("MessageRating_rating_check admits 1..5, and the domain mints -1", () => {
  test("the double stores a thumbs-DOWN and the schema cannot", async () => {
    // THE DOUBLE. `domain/rating.ts` calls 1 and -1 "the only two values the
    // column may hold" and `admitRatingValue` mints exactly those two.
    const fake = new InMemoryRatingsRepository(governanceConformanceClock());
    const stored = await fake.upsert(
      scope,
      {
        turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
        agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
        agentVersionId: null,
        endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
        rating: -1,
        comment: null,
        revision: 1,
      },
      { transactionId: asGovernanceIdentifier("txn-1") } as TransactionScope,
    );
    expect(stored.ok && stored.value.rating).toBe(-1);

    // THE SCHEMA. `MessageRating_rating_check CHECK ("rating" BETWEEN 1 AND 5)`,
    // installed by 00000000000000_initial and expressible in no Prisma
    // attribute, so `schema.prisma` alone does not show it.
    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.ratings.upsert(
        scope,
        {
          turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
          agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
          agentVersionId: null,
          endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
          rating: -1,
          comment: null,
          revision: 1,
        },
        transaction,
      ),
    );
    expect(refused.ok).toBe(false);
    expect(reasonOf(refused)).toContain(RATING_OUTSIDE_SCHEMA_RANGE);
  });

  test("and a thumbs-UP is stored, so the refusal is the VALUE and not the path", async () => {
    const accepted = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.ratings.upsert(
        scope,
        {
          turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
          agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
          agentVersionId: asGovernanceIdentifier<AgentVersionId>(ids.agentVersionId),
          endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
          rating: 1,
          comment: null,
          revision: 1,
        },
        transaction,
      ),
    );
    expect(accepted.ok).toBe(true);
    await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.ratings.remove(
        scope,
        asGovernanceIdentifier<TurnId>(ids.turnId),
        asGovernanceIdentifier<EndUserId>(ids.endUserId),
        transaction,
      ),
    );
  });''',
    '''describe("MessageRating_rating_check is the constraint the migration ENDS with", () => {
  test("the double stores a five-star `3`, and no database this migration builds can", async () => {
    // THE DOUBLE stores whatever the type lets through: `RatingValue` is
    // `1 | -1`, so `3` needs a cast to get past the compiler and nothing else to
    // get past the store.
    const fake = new InMemoryRatingsRepository(governanceConformanceClock());
    const stored = await fake.upsert(
      scope,
      {
        turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
        agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
        agentVersionId: null,
        endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
        rating: 3 as unknown as 1,
        comment: null,
        revision: 1,
      },
      { transactionId: asGovernanceIdentifier("txn-1") } as TransactionScope,
    );
    expect(stored.ok && stored.value.rating).toBe(3);

    // THE SCHEMA. `00000000000000_initial` installs
    // `CHECK ("rating" BETWEEN 1 AND 5)` at line 2799 and then, at line 3802 in
    // the SAME FILE, DROPS it for `CHECK ("rating" IN (-1, 1))` behind a
    // preflight that refuses to build the database at all if any row holds 2..5.
    // Neither constraint is expressible in a Prisma attribute, so
    // `schema.prisma` shows neither and a reader who stopped at the first would
    // have got this backwards in both directions.
    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.ratings.upsert(
        scope,
        {
          turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
          agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
          agentVersionId: null,
          endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
          rating: 3 as unknown as 1,
          comment: null,
          revision: 1,
        },
        transaction,
      ),
    );
    expect(refused.ok).toBe(false);
    expect(reasonOf(refused)).toContain(RATING_NOT_THUMBS);
  });

  test("and BOTH thumbs are stored, so the refusal is the VALUE and not the path", async () => {
    for (const rating of [1, -1] as const) {
      const accepted = await harness.base.adapter.unitOfWork.run((transaction) =>
        harness.stores.ratings.upsert(
          scope,
          {
            turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
            agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
            agentVersionId: asGovernanceIdentifier<AgentVersionId>(ids.agentVersionId),
            endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
            rating,
            comment: null,
            revision: 1,
          },
          transaction,
        ),
      );
      expect(accepted.ok && accepted.value.rating).toBe(rating);
      await harness.base.adapter.unitOfWork.run((transaction) =>
        harness.stores.ratings.remove(
          scope,
          asGovernanceIdentifier<TurnId>(ids.turnId),
          asGovernanceIdentifier<EndUserId>(ids.endUserId),
          transaction,
        ),
      );
    }
  });''',
)
s = s.replace(
    "    expect(RATING_REVISION_INVALID).not.toBe(RATING_OUTSIDE_SCHEMA_RANGE);",
    "    expect(RATING_REVISION_INVALID).not.toBe(RATING_NOT_THUMBS);",
)
# the transaction-survives case used -1; it must use a value that IS refused.
s = s.replace(
    '''    const refused = await harness.stores.ratings.upsert(
      scope,
      {
        turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
        agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
        agentVersionId: null,
        endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
        rating: -1,
        comment: null,
        revision: 1,
      },
      transaction,
    );
    expect(refused.ok).toBe(false);
    // THE SAME TRANSACTION, still open, still writable.''',
    '''    const refused = await harness.stores.ratings.upsert(
      scope,
      {
        turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
        agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
        agentVersionId: null,
        endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
        rating: 3 as unknown as 1,
        comment: null,
        revision: 1,
      },
      transaction,
    );
    expect(refused.ok).toBe(false);
    // THE SAME TRANSACTION, still open, still writable.''',
)
open(p, "w").write(s)

# --------------------------------------------------- transaction integration
p = B + "governance-transaction.integration.test.ts"
s = open(p).read()
s = s.replace(
    '''    // A rating of `-1`: refused by `governance-guards.ts` BEFORE any statement.''',
    '''    // A five-star `3`: refused by `governance-guards.ts` BEFORE any statement,
    // because the constraint the migration ENDS with is `IN (-1, 1)`.''',
)
s = s.replace(
    '''          agentVersionId: null,
          endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
          rating: -1,
          comment: null,
          revision: 1,
        },
        transaction,
      ),
    );
    expect(refused.ok).toBe(false);
  });

  const committed = await observer.safetyEvent.findUnique({''',
    '''          agentVersionId: null,
          endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
          rating: 3 as unknown as 1,
          comment: null,
          revision: 1,
        },
        transaction,
      ),
    );
    expect(refused.ok).toBe(false);
  });

  const committed = await observer.safetyEvent.findUnique({''',
)
s = s.replace(
    '''          agentVersionId: null,
          endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
          rating: -1,
          comment: null,
          revision: 1,
        },
        transaction,
      );
      if (!refused.ok) throw new Error("erasure abandoned");''',
    '''          agentVersionId: null,
          endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
          rating: 3 as unknown as 1,
          comment: null,
          revision: 1,
        },
        transaction,
      );
      if (!refused.ok) throw new Error("erasure abandoned");''',
)
open(p, "w").write(s)

# --------------------------------------------------------- rules integration
p = B + "governance-rules.integration.test.ts"
s = open(p).read()
s = s.replace(
    '''          // A legacy five-star value: the CHECK admits it and the domain's
          // `RatingValue` does not, so the cast says which of the two this is
          // testing. The row must not move whatever the value is.
          rating: 5 as unknown as 1,''',
    '''          // A perfectly STORABLE value — `CHECK (rating IN (-1, 1))` admits it
          // — so nothing but the scope can be what refuses this write.
          rating: -1,''',
)
open(p, "w").write(s)
print("patched the four suites")
