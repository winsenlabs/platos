// The two `vector(1536)` columns the generated client CANNOT NAME — what the
// store does with them, and the one port contract they prove unhonourable.
//
// A SECOND FILE, AND THE BUDGET POINTED AT THE SEAM. `memory-rules.integration.test.ts`
// reached 500 effective lines with these five cases in it, which is the ADR
// M0.3 §6 ERROR threshold exactly. The seam is real rather than convenient:
// that file is about what the SCHEMA decides for a row — an immutable column, a
// permitted ownership move, a cascade, a foreign key that nulls — and this one is
// about the one thing in this store the schema declares and the client cannot
// express. `Memory.embedding` and `MemoryEntity.embedding` are
// `Unsupported("vector(1536)")`, so they appear in no `select`, no `data` and no
// `where`, and every statement that carries one is raw SQL in
// `memory-vectors.ts`.
//
// NO READ ON EITHER PORT RETURNS AN EMBEDDING, which is why these cases ask the
// column directly. That is not a convenience: a mutation that cleared the vector
// on every update survived FIVE suites (`mutations-memory.json` M-M13), because
// the only observable consequence is a row quietly dropping out of every future
// candidate set — and a candidate set nobody asked for after the update looks
// exactly like a correct one.
//
// *** AND ONE PORT CONTRACT IS UNHONOURABLE. *** WIN-258 T3 reported the same
// kind of thing about `OperatorSessionRevoker.revoke`, whose truthful count is
// unobtainable because a database rule has already revoked the rows before the
// port runs. Here: `KnowledgeGraphRepository.searchEntities` reads
// `MemoryEntity.embedding`, and NO METHOD ON THAT PORT CAN WRITE IT.
// `insertEntity` takes a `MemoryEntity`, which carries no vector; there is no
// second parameter and no `EntityWrite` to pair one with, unlike `MemoryWrite`,
// which pairs every `Memory` with an `EmbeddingDirective`. So a node written
// through the port is never a candidate. BOTH halves are pinned below — empty
// through the port, and correct the moment the column is filled out of band —
// because the store's own half of the contract is right and it is the port that
// cannot be satisfied.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AgentId,
  ClusterId,
  EntityKey,
  MemoryEntityId,
  ProfileKey,
  TransactionScope,
} from "@platos/context-memory/application/ports/index.js";
import { asMemoryIdentifier } from "@platos/context-memory/application/ports/index.js";

import type { MemoryChain, MemoryHarness } from "./memory-harness.js";
import { entityDraft, memoryDraft, startMemoryHarness } from "./memory-harness.js";
import { countRowsWithEmbedding, writeMemoryEmbedding } from "./memory-vectors.js";

let harness: MemoryHarness;
let chain: MemoryChain;

const AT = new Date("2026-05-01T09:00:00.000Z");
const LATER = new Date("2026-06-01T09:00:00.000Z");

beforeAll(async () => {
  harness = await startMemoryHarness();
  chain = await harness.seedChain(await harness.freshScope());
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function id(kind: string): string {
  return harness.base.freshId(kind);
}

function write<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
  return harness.base.adapter.unitOfWork.run(work);
}

describe("*** a port contract the database proves unhonourable ***", () => {
  test("`searchEntities` returns NOTHING for a node written through the port, because no method can write its vector", async () => {
    const entityId = id("00c0");
    await write((transaction) =>
      harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, entityId, AT, {
          entityKey: asMemoryIdentifier<EntityKey>("unsearchable"),
          label: "Unsearchable Corp",
        }),
        transaction,
      ),
    );

    const found = await harness.stores.memoryGraph.searchEntities({
      subject: chain.subject,
      agentIds: [asMemoryIdentifier<AgentId>(chain.agentId)],
      embedding: harness.unitVector(11),
      limit: 10,
    });
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value).toEqual([]);

    // The row IS there and IS readable by every other method — so the empty
    // candidate list above is about the COLUMN and not about the scope.
    const byId = await harness.stores.memoryGraph.findEntity(
      chain.subject,
      [asMemoryIdentifier<AgentId>(chain.agentId)],
      asMemoryIdentifier<MemoryEntityId>(entityId),
    );
    expect(byId.ok && byId.value?.label).toBe("Unsearchable Corp");

    // And the column really is NULL, rather than holding something the search
    // filtered out for another reason.
    const stored = await harness.base.client.$queryRaw<{ readonly present: bigint }[]>`
      SELECT count(*) AS "present" FROM "MemoryEntity"
       WHERE "id" = ${entityId}::uuid AND "embedding" IS NOT NULL`;
    expect(Number(stored[0]?.present ?? 0n)).toBe(0);
  });

  test("and the SAME search finds it the moment the column is filled out of band — the store's half is correct", async () => {
    // The other half, and the reason the case above is a REPORT rather than a
    // defect: the statement, the operator class, the scope and the ordering are
    // all right. What is missing is a way for a caller to supply the vector.
    const entityId = id("00c1");
    await write((transaction) =>
      harness.stores.memoryGraph.insertEntity(
        entityDraft(chain, entityId, AT, {
          entityKey: asMemoryIdentifier<EntityKey>("searchable"),
          label: "Searchable Corp",
        }),
        transaction,
      ),
    );
    harness.seedEntityVector(entityId, harness.unitVector(11));

    const found = await harness.stores.memoryGraph.searchEntities({
      subject: chain.subject,
      agentIds: [asMemoryIdentifier<AgentId>(chain.agentId)],
      embedding: harness.unitVector(11),
      limit: 10,
    });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.value.map((match) => match.entity.entityId)).toEqual([entityId]);
      expect(found.value[0]?.score).toBeCloseTo(1, 5);
    }
  });
});

describe("the three-case embedding directive, against the column itself", () => {
  // THESE THREE CASES EXIST BECAUSE A MUTATION SURVIVED. `mutations-memory.json`
  // M-M13 replaces `if (write.embedding.action !== "keep")` with `if (true)`,
  // which sends the vector statement with a NULL literal on the `keep` branch
  // and CLEARS the column on every update. Five suites stayed green: no read on
  // either port returns an embedding, so the only way to see it is to ask the
  // column directly or to ask a search whose candidate set the column decides.
  test("`keep` on an update leaves the stored vector standing", async () => {
    const memoryId = id("00e0");
    await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, memoryId, AT), embedding: { action: "set", vector: harness.unitVector(21) } },
        transaction,
      ),
    );
    expect(await countRowsWithEmbedding(harness.base.client, memoryId)).toBe(1);

    const updated = await write((transaction) =>
      harness.stores.memory.updateMemory(
        { memory: memoryDraft(chain, memoryId, LATER, { content: "prefers Samuel" }), embedding: { action: "keep" } },
        transaction,
      ),
    );
    expect(updated.ok).toBe(true);
    expect(await countRowsWithEmbedding(harness.base.client, memoryId)).toBe(1);
  });

  test("`clear` on an update removes it, which is what makes `keep` mean something", async () => {
    const memoryId = id("00e1");
    await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, memoryId, AT), embedding: { action: "set", vector: harness.unitVector(22) } },
        transaction,
      ),
    );
    await write((transaction) =>
      harness.stores.memory.updateMemory(
        {
          memory: memoryDraft(chain, memoryId, LATER, {
            kind: "profile",
            profileKey: asMemoryIdentifier<ProfileKey>("role"),
            content: "staff engineer",
          }),
          embedding: { action: "clear" },
        },
        transaction,
      ),
    );
    expect(await countRowsWithEmbedding(harness.base.client, memoryId)).toBe(0);
  });

  test("the vector write is SCOPED, so a mismatched environment reaches no row", async () => {
    // M-M35's guard, made falsifiable. `writeMemoryEmbedding` is keyed on the
    // primary key AND the environment, and no call through either port can
    // supply a mismatched pair — the store takes both off the same aggregate. So
    // the clause is defence in depth that the ports cannot exercise, and the
    // only honest way to hold it falsifiable is to call the statement directly.
    const memoryId = id("00e2");
    await write((transaction) =>
      harness.stores.memory.insertMemory(
        { memory: memoryDraft(chain, memoryId, AT), embedding: { action: "set", vector: harness.unitVector(23) } },
        transaction,
      ),
    );
    const foreignEnvironment = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const touched = await harness.base.adapter.unitOfWork.run(async () =>
      harness.base.client.$transaction((client) =>
        writeMemoryEmbedding(client, foreignEnvironment, memoryId, null),
      ),
    );
    expect(touched).toBe(0);
    expect(await countRowsWithEmbedding(harness.base.client, memoryId)).toBe(1);
  });
});
