import sys

p = 'packages/adapters/postgres-tenancy/src/providers-catalogue-constraints.integration.test.ts'
s = open(p).read()

pairs = [
(
'''        asProvidersIdentifier<ModelKey>("anthropic:constraint-model"),
        {
          provider: ANTHROPIC,
          name: "constraint-model",
          displayName: null,
          description: null,
          contextWindow: 1000,
          maxOutputTokens: 100,
          capabilities: [],
          releaseDate: null,
          deprecationDate: null,
          baseModelName: null,
          sourceUpdatedAt: AT,
        },
        transaction,''',
'''        asProvidersIdentifier<ModelKey>("anthropic:constraint-model"),
        facts("constraint-model"),
        transaction,'''
),
(
'''    const facts = {
      provider: ANTHROPIC,
      name: "shared-name",
      displayName: null,
      description: null,
      contextWindow: 1000,
      maxOutputTokens: 100,
      capabilities: [],
      releaseDate: null,
      deprecationDate: null,
      baseModelName: null,
      sourceUpdatedAt: AT,
    };
    const first = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertModel(
        asProvidersIdentifier<ModelKey>("anthropic:shared-name"),
        facts,
        transaction,
      ),
    );
    expect(first.ok).toBe(true);
    const second = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertModel(
        asProvidersIdentifier<ModelKey>("anthropic:shared-name-alias"),
        facts,
        transaction,
      ),
    );''',
'''    const shared = facts("shared-name");
    const first = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertModel(
        asProvidersIdentifier<ModelKey>("anthropic:shared-name"),
        shared,
        transaction,
      ),
    );
    expect(first.ok).toBe(true);
    const second = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertModel(
        asProvidersIdentifier<ModelKey>("anthropic:shared-name-alias"),
        shared,
        transaction,
      ),
    );'''
),
(
'''          asProvidersIdentifier<ModelKey>("anthropic:too-wide"),
          {
            provider: ANTHROPIC,
            name: "too-wide",
            displayName: null,
            description: null,
            // A catalogue that published a context window in BYTES.
            contextWindow: 4_000_000_000,
            maxOutputTokens: 100,
            capabilities: [],
            releaseDate: null,
            deprecationDate: null,
            baseModelName: null,
            sourceUpdatedAt: AT,
          },
          transaction,''',
'''          asProvidersIdentifier<ModelKey>("anthropic:too-wide"),
          // A catalogue that published a context window in BYTES.
          { ...facts("too-wide"), contextWindow: 4_000_000_000 },
          transaction,'''
),
]

for a, b in pairs:
    if a not in s:
        sys.exit("MISS: " + a[:70])
    s = s.replace(a, b)

open(p, 'w').write(s)
print("ok")
