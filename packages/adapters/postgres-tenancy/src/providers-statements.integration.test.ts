// Statement counts, MEASURED — the N+1 control for `providers`' reads.
//
// EVERY PIN IS TAKEN TWICE, over a small environment and one an order of
// magnitude larger, and both must be identical. A read whose cost grows with the
// rows it returns is correct in every case and expensive in exactly one: the
// installation that has been running longest.
//
// TWO READS HERE ARE THE ONES A LOOP WOULD HAVE BEEN EASIEST IN.
// `findPricesForKeys` is handed a LIST of candidate model keys — `model-key.ts`
// produces up to four for one model string — and joins each card to its model
// identity; a loop over the keys, or a second read for the identities, would be
// invisible until the pricing path was slow, and it is asked once per priced
// step. `countAgentVersionsPinning` walks four tables and a JSON array and must
// stay ONE statement whatever the environment holds.
//
// THE PROBE PATTERN IS ANCHORED, and this is tranche 3's trap rather than a
// precaution. Its advisory lock projected `SELECT 1`, which is exactly the shape
// the statement suites strip to discard the driver's connection probe, so the
// lock was measured at ZERO statements and a mutation that removed it survived.
// The filter below therefore anchors the probe to a statement that is ONLY
// `SELECT 1`, and every measurement records the unfiltered count beside the
// filtered one so a suite can assert what the filter actually removed.
//
// THE SAVEPOINT'S THREE STATEMENTS ARE PINNED AS SUCH. Every WRITE on this port
// costs `SAVEPOINT`, the statement, and `RELEASE SAVEPOINT` — and the refusal
// path costs a fourth and sometimes a fifth, because WHICH unique index refused
// is established by reading rather than by guessing. That cost is on writes only
// and the reads above are untouched by it, which is the property this file pins
// rather than the number itself.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EnvironmentScope,
  ModelId,
  ModelKey,
  ProviderId,
  ProviderKey,
  ProviderKeyId,
} from "@platos/context-providers/application/ports/index.js";
import {
  asProvidersIdentifier,
  rateFromDecimalString,
} from "@platos/context-providers/application/ports/index.js";

import type { ProvidersHarness } from "./providers-harness.js";
import { startProvidersHarness } from "./providers-harness.js";

let harness: ProvidersHarness;
let sequence = 0;

const AT = new Date("2026-05-01T09:00:00.000Z");
const ANTHROPIC = asProvidersIdentifier<ProviderId>("anthropic");

interface Fixture {
  readonly scope: EnvironmentScope;
  readonly keyIds: readonly string[];
  readonly modelKeys: readonly ModelKey[];
  readonly modelIds: readonly ModelId[];
}

let small: Fixture;
let large: Fixture;

/** 8-4-4-4-12, version nibble 7, variant 8. A wrong-length group is refused. */
function uuid(): string {
  sequence += 1;
  const tail = sequence.toString(16).padStart(4, "0");
  return `01937fa0-${tail}-7000-8000-${tail.padStart(12, "0")}`;
}

/**
 * Statements the CLIENT sent, less the transaction frame.
 *
 * `BEGIN`, `COMMIT`, a BARE `ROLLBACK` and `DEALLOCATE` are the driver's
 * bookkeeping and are not what an N+1 is made of. `SELECT 1` is the driver's
 * connection probe and is matched ONLY when the whole statement is that and
 * nothing else, so a read that genuinely projects a constant cannot be discarded
 * by the thing measuring it.
 *
 * `ROLLBACK` IS ANCHORED TO THE BARE FORM, and that is tranche 3's trap sprung
 * again one tranche later. The first draft of this filter matched `ROLLBACK\b`,
 * which also matches `ROLLBACK TO SAVEPOINT providers_sp_7` — this store's OWN
 * statement, on the path this file exists to price — so a refused write measured
 * two statements where it sends three, and the measurement was discarding the
 * thing it measures. `SAVEPOINT` and `RELEASE SAVEPOINT` were never filtered and
 * this one no longer is: their cost is on writes only, and stating it is the
 * point.
 */
function queries(): readonly string[] {
  return harness.base
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|DEALLOCATE)\b/iu.test(statement) &&
        !/^\s*ROLLBACK\s*;?\s*$/iu.test(statement) &&
        !/^\s*SELECT\s+1\s*$/iu.test(statement),
    );
}

interface Measurement {
  readonly counted: number;
  readonly total: number;
}

async function measure(work: () => Promise<unknown>): Promise<Measurement> {
  harness.base.resetStatements();
  await work();
  return { counted: queries().length, total: harness.base.statements().length };
}

function rate(value: string): { readonly picoUsdPerToken: bigint } {
  const parsed = rateFromDecimalString(value);
  if (!parsed.ok) throw new Error(`fixture rate ${value} is not representable`);
  return parsed.value;
}

const KNOWN = {
  rate: rate("0.000001000000"),
  source: "LITELLM" as const,
  observedAt: AT,
  sourceRef: "litellm@2026-05-01",
};

function key(
  scope: EnvironmentScope,
  id: string,
  credentialId: string,
  label: string,
  credentialName: string,
  isDefault: boolean,
): ProviderKey {
  return {
    providerKeyId: asProvidersIdentifier<ProviderKeyId>(id),
    environmentId: scope.environmentId,
    credentialId: asProvidersIdentifier(credentialId),
    provider: ANTHROPIC,
    label,
    credentialName: asProvidersIdentifier(credentialName),
    isDefault,
    createdBy: asProvidersIdentifier("operator-1"),
    lastUsedAt: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

/**
 * `keys` provider keys and `models` models, each model carrying TWO cards.
 *
 * Every key needs its own `Credential`: the rule demands one in the same
 * environment carrying the key's provider and its `environmentKeyName`, and
 * `Credential` is unique on `(environmentId, kind, name)`, so the names vary.
 */
async function seed(keys: number, models: number): Promise<Fixture> {
  const scope = await harness.freshScope();
  const keyIds: string[] = [];
  for (let index = 0; index < keys; index += 1) {
    const name = `ANTHROPIC_KEY_${index}`;
    const credentialId = await harness.seedCredential(scope, { provider: "anthropic", name });
    const id = uuid();
    keyIds.push(id);
    await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertProviderKey(
        key(scope, id, credentialId, `label-${index}`, name, index === 0),
        transaction,
      ),
    );
  }
  const modelKeys: ModelKey[] = [];
  const modelIds: ModelId[] = [];
  for (let index = 0; index < models; index += 1) {
    const modelKey = asProvidersIdentifier<ModelKey>(`anthropic:measured-${sequence}-${index}`);
    modelKeys.push(modelKey);
    const written = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertModel(
        modelKey,
        {
          provider: ANTHROPIC,
          name: `${modelKey}`,
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
        transaction,
      ),
    );
    if (!written.ok) throw new Error("the fixture model could not be written");
    modelIds.push(written.value.modelId);
    for (const effectiveFrom of [
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    ]) {
      const card = await harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.insertPrice(
          written.value.modelId,
          {
            effectiveFrom,
            rates: { input: KNOWN, output: KNOWN, cacheRead: KNOWN, cacheWrite: KNOWN },
          },
          transaction,
        ),
      );
      if (!card.ok) throw new Error("the fixture card could not be written");
    }
  }
  return { scope, keyIds, modelKeys, modelIds };
}

beforeAll(async () => {
  harness = await startProvidersHarness();
  small = await seed(2, 1);
  large = await seed(20, 10);
  // ONE pinning version in each fixture, so `countAgentVersionsPinning` has
  // something to count and its statement cost is measured over a real join
  // rather than over an empty one.
  await harness.seedPinningVersion(small.scope, small.keyIds[0] ?? "", "anthropic", "modelRoutes");
  for (let index = 0; index < 5; index += 1) {
    await harness.seedPinningVersion(large.scope, large.keyIds[0] ?? "", "anthropic", "modelRoutes");
  }
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

interface Read {
  readonly name: string;
  readonly pin: number;
  run(fixture: Fixture): Promise<unknown>;
}

const READS: readonly Read[] = [
  { name: "listProviderKeys", pin: 1, run: (f) => harness.repository.listProviderKeys(f.scope) },
  {
    name: "pageProviderKeys",
    pin: 1,
    // ONE statement, and the page and its total come from the SAME read — a
    // separate `count` would be a second statement AND a second snapshot, and
    // the two could then disagree about which rows exist.
    run: (f) =>
      harness.repository.pageProviderKeys(f.scope, {
        limit: 2,
        offset: 0,
        provider: null,
        search: "label",
      }),
  },
  {
    name: "findProviderKey",
    pin: 1,
    run: (f) =>
      harness.repository.findProviderKey(
        f.scope,
        asProvidersIdentifier<ProviderKeyId>(f.keyIds[0] ?? ""),
      ),
  },
  {
    name: "listProviderKeysFor",
    pin: 1,
    run: (f) => harness.repository.listProviderKeysFor(f.scope, ANTHROPIC),
  },
  {
    name: "countAgentVersionsPinning",
    pin: 1,
    // ONE statement across `Environment`, `Project`, `AgentBinding`, `Agent`,
    // `AgentVersion` and a `jsonb_array_elements` walk of the routes array.
    run: (f) =>
      harness.repository.countAgentVersionsPinning(
        f.scope,
        asProvidersIdentifier<ProviderKeyId>(f.keyIds[0] ?? ""),
      ),
  },
  { name: "listProviderLinks", pin: 1, run: (f) => harness.repository.listProviderLinks(f.scope) },
  {
    name: "findProviderLink",
    pin: 1,
    run: (f) => harness.repository.findProviderLink(f.scope, ANTHROPIC),
  },
  {
    name: "findModelByKey",
    pin: 1,
    run: (f) => harness.repository.findModelByKey(f.modelKeys[0] ?? asProvidersIdentifier<ModelKey>("")),
  },
  {
    name: "findLatestPrice",
    pin: 1,
    run: (f) => harness.repository.findLatestPrice(f.modelIds[0] ?? asProvidersIdentifier<ModelId>("")),
  },
  {
    name: "findPricesForKeysOneKey",
    pin: 1,
    run: (f) =>
      harness.repository.findPricesForKeys(
        [f.modelKeys[0] ?? ""],
        new Date("2026-09-01T00:00:00.000Z"),
      ),
  },
  {
    name: "findPricesForKeysEveryKey",
    pin: 1,
    // THE N+1 CONTROL WITH TEETH: the small fixture passes ONE key and the large
    // one passes TEN, each joined to its model identity, and both must be one
    // statement. A loop, or a second read for the identities, shows up here and
    // nowhere else.
    run: (f) =>
      harness.repository.findPricesForKeys([...f.modelKeys], new Date("2026-09-01T00:00:00.000Z")),
  },
];

/** Every read measured over one fixture, as a map from name to count. */
async function measureReads(fixture: Fixture): Promise<Record<string, Measurement>> {
  const measured: Record<string, Measurement> = {};
  for (const read of READS) {
    measured[read.name] = await measure(() => read.run(fixture));
  }
  return measured;
}

describe("every read costs the same over a small environment and a large one", () => {
  test("each read's statement count matches its pin, over BOTH sizes", async () => {
    // ONE case over the whole map rather than one per read — the census refuses
    // a `test()` declared in a loop, and the map is the better instrument
    // anyway: a divergence names the read and shows both counts, and a read
    // somebody forgot to measure cannot exist.
    const overSmall = await measureReads(small);
    const overLarge = await measureReads(large);
    const pins = Object.fromEntries(READS.map((read) => [read.name, read.pin]));
    expect(Object.fromEntries(Object.entries(overSmall).map(([n, m]) => [n, m.counted]))).toEqual(
      pins,
    );
    expect(Object.fromEntries(Object.entries(overLarge).map(([n, m]) => [n, m.counted]))).toEqual(
      pins,
    );
  });

  test("nothing the reads sent was discarded by the filter that counts them", async () => {
    // THE ANCHOR. Tranche 3's advisory lock projected `SELECT 1`, which is the
    // shape these suites strip to discard the driver's connection probe, so the
    // lock measured ZERO statements and the mutation that removed it survived.
    // A read outside a transaction sends no frame either, so for every read the
    // filtered and unfiltered counts must be EQUAL.
    const overSmall = await measureReads(small);
    for (const [name, measured] of Object.entries(overSmall)) {
      expect({ name, ...measured }).toEqual({
        name,
        counted: measured.counted,
        total: measured.counted,
      });
    }
  });

  test("the large fixture really is larger", async () => {
    // NON-VACUITY. Two empty environments would agree on every count above.
    const keys = await harness.repository.listProviderKeys(large.scope);
    expect(keys.ok && keys.value.length).toBe(20);
    const prices = await harness.repository.findPricesForKeys(
      [...large.modelKeys],
      new Date("2026-09-01T00:00:00.000Z"),
    );
    expect(prices.ok && prices.value.length).toBe(20);
    const pinned = await harness.repository.countAgentVersionsPinning(
      large.scope,
      asProvidersIdentifier<ProviderKeyId>(large.keyIds[0] ?? ""),
    );
    expect(pinned).toEqual({ ok: true, value: 5 });
  });
});

describe("the writes, and what the savepoint costs them", () => {
  test("an accepted insert is the write plus its savepoint frame", async () => {
    const name = "ANTHROPIC_MEASURED_INSERT";
    const credentialId = await harness.seedCredential(small.scope, {
      provider: "anthropic",
      name,
    });
    const measured = await measure(() =>
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.insertProviderKey(
          key(small.scope, uuid(), credentialId, "measured insert", name, false),
          transaction,
        ),
      ),
    );
    // SAVEPOINT, the INSERT, RELEASE SAVEPOINT. Three, and the cost is stated
    // rather than hidden: without it a refusal would abort the caller's whole
    // transaction and every write before it would be discarded at COMMIT.
    expect(measured.counted).toBe(3);
    // The frame IS present here, because this ran inside a transaction.
    expect(measured.total).toBeGreaterThan(measured.counted);
  });

  test("an insert refused by a UNIQUE index costs two more, because WHICH one is READ", async () => {
    // The SAME credential and the SAME label as the case above, so the label
    // index is what refuses this one.
    const found = await harness.repository.listProviderKeysFor(small.scope, ANTHROPIC);
    const clashing = found.ok
      ? found.value.find((held) => held.label === "measured insert")
      : undefined;
    expect(clashing).toBeDefined();
    const measured = await measure(() =>
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.insertProviderKey(
          key(
            small.scope,
            uuid(),
            clashing?.credentialId ?? "",
            "measured insert",
            clashing?.credentialName ?? "",
            false,
          ),
          transaction,
        ),
      ),
    );
    // SAVEPOINT, the refused INSERT, ROLLBACK TO SAVEPOINT, then the two reads
    // that decide which of the three unique indexes refused. Only two of them
    // are in `schema.prisma`, so the driver's error cannot tell the third apart
    // and the answer has to be established rather than guessed.
    expect(measured.counted).toBe(5);
  });

  test("an insert refused by the credential RULE costs three, and no reads", async () => {
    // The contrast that makes the count above mean something. A rule names
    // itself in the message it raises, so there is nothing to establish and the
    // store answers from the error alone: SAVEPOINT, the refused INSERT,
    // ROLLBACK TO SAVEPOINT. A store that read on every refusal would cost five
    // here too and nothing would have noticed.
    const name = "ANTHROPIC_MEASURED_RULE";
    const credentialId = await harness.seedCredential(small.scope, {
      provider: "anthropic",
      name,
    });
    const measured = await measure(() =>
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.insertProviderKey(
          // The credential exists and carries `name`; the KEY names a different
          // reference, which is exactly what the rule compares.
          key(small.scope, uuid(), credentialId, "rule refusal", "ANTHROPIC_NOT_THAT_ONE", false),
          transaction,
        ),
      ),
    );
    expect(measured.counted).toBe(3);
  });

  test("a touch is ONE statement and does not open a transaction of its own", async () => {
    const measured = await measure(() =>
      harness.repository.touchProviderKey(
        asProvidersIdentifier<ProviderKeyId>(small.keyIds[0] ?? ""),
        new Date("2026-05-01T11:00:00.000Z"),
      ),
    );
    // ONE, and no frame at all: it runs on the pool, outside any transaction,
    // which is what the port requires of it.
    expect(measured.counted).toBe(1);
    expect(measured.total).toBe(1);
  });
});
