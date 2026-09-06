// The clauses no shared scenario can reach, as named cases.
//
// EVERY CASE HERE IS A PROPERTY THE IN-MEMORY DOUBLE CANNOT HAVE, so putting it
// in the conformance differential would have meant either weakening the
// comparison or teaching the double a database it does not have. Four of them
// are the reason this file exists rather than more observations in a transcript:
//
//   THE DELETE TRIGGER. `reject_executable_provider_key_delete` walks
//   `Environment -> AgentBinding -> Agent -> AgentVersion` and refuses to delete
//   a key an executable version still names, in EITHER of the two places a
//   version can name one. The double deletes whatever it is asked to, so this
//   refusal has no counterpart to compare against.
//
//   THE COLLATION. `byListingOrder` compares `provider` with `<` on JavaScript
//   strings — UTF-16 code units — and PostgreSQL's `ORDER BY "provider"` applies
//   the database's collation, which on the `en_US.utf8` cluster this suite runs
//   against is a locale order that ignores case at the primary level. They
//   DISAGREE on the first key of the comparator, and the case below shows both
//   answers side by side rather than asserting one and hoping.
//
//   THE LINK ORDER. `listProviderLinks` promises no order, so the conformance
//   scenario sorts before it compares; that leaves the real store's own
//   ordering unmeasured, and an unordered listing is an order the planner picks.
//
//   THE SECOND ADOPTION. `upsertProviderLink` keeps the STORED identity and the
//   ORIGINAL `linkedAt` when a provider is adopted twice. The double's map is
//   keyed by `${environmentId}/${provider}` and overwrites both with whatever it
//   was handed, so the two stores agree only while the caller passes the stored
//   values back — which a use case does and a careless caller does not.
//
// It FAILS when Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EnvironmentScope,
  ProviderId,
  ProviderKey,
  ProviderKeyId,
  ProviderLink,
} from "@platos/context-providers/application/ports/index.js";
import {
  asProvidersIdentifier,
  byListingOrder,
} from "@platos/context-providers/application/ports/index.js";

import type { ProvidersHarness } from "./providers-harness.js";
import { startProvidersHarness } from "./providers-harness.js";

let harness: ProvidersHarness;
let scope: EnvironmentScope;
let elsewhere: EnvironmentScope;

const AT = new Date("2026-05-01T09:00:00.000Z");
const LATER = new Date("2026-05-01T10:00:00.000Z");
const ANTHROPIC = asProvidersIdentifier<ProviderId>("anthropic");

function uuid(slot: string): string {
  return `ab000000-${slot}-4000-8000-000000000000`;
}

async function seedKey(
  target: EnvironmentScope,
  id: string,
  provider: string,
  label: string,
  name: string,
  isDefault = false,
): Promise<ProviderKey> {
  const credentialId = await harness.seedCredential(target, { provider, name });
  const key: ProviderKey = {
    providerKeyId: asProvidersIdentifier<ProviderKeyId>(id),
    environmentId: target.environmentId,
    credentialId: asProvidersIdentifier(credentialId),
    provider: asProvidersIdentifier(provider),
    label,
    credentialName: asProvidersIdentifier(name),
    isDefault,
    createdBy: asProvidersIdentifier("operator-1"),
    lastUsedAt: null,
    createdAt: AT,
    updatedAt: AT,
  };
  const written = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.repository.insertProviderKey(key, transaction),
  );
  if (!written.ok) throw new Error(`the fixture key ${label} could not be written`);
  return key;
}

beforeAll(async () => {
  harness = await startProvidersHarness();
  scope = await harness.freshScope();
  elsewhere = await harness.freshScope();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("reject_executable_provider_key_delete", () => {
  test("a key pinned through modelRoutes cannot be deleted, and the count is truthful", async () => {
    const key = await seedKey(scope, uuid("0001"), "anthropic", "routed", "ANTHROPIC_ROUTED");
    await harness.seedPinningVersion(scope, key.providerKeyId, "anthropic", "modelRoutes");
    await harness.seedPinningVersion(scope, key.providerKeyId, "anthropic", "modelRoutes");

    const counted = await harness.repository.countAgentVersionsPinning(scope, key.providerKeyId);
    expect(counted).toEqual({ ok: true, value: 2 });

    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.deleteProviderKey(scope, key.providerKeyId, transaction),
    );
    // THE COUNT TRAVELS WITH THE ERROR, and it is READ rather than invented. The
    // trigger reports THAT an executable version names the key and never HOW
    // MANY; the savepoint has already rolled the DELETE back, so the versions it
    // saw are still there and the number is obtainable. Tranche 3 refused to
    // invent exactly this kind of number on `OperatorSessionRevoker.revoke`,
    // where the rows were already gone and the count was not obtainable at all.
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_KEY_PINNED_BY_AGENTS", details: { pinnedAgents: 2 } },
    });
    // And the row is still there.
    const found = await harness.repository.findProviderKey(scope, key.providerKeyId);
    expect(found).toMatchObject({ ok: true, value: { label: "routed" } });
  });

  test("a key pinned through memoryConfig is refused too, which is the OTHER half", async () => {
    // The trigger reads TWO places: `{__runtime,providerKeyId}` inside
    // `memoryConfig`, and every entry of the `modelRoutes` array. A store that
    // counted only the routes would agree with the trigger on the case above and
    // disagree with it here — reporting zero and then being refused.
    const key = await seedKey(scope, uuid("0002"), "anthropic", "memoried", "ANTHROPIC_MEMORIED");
    await harness.seedPinningVersion(scope, key.providerKeyId, "anthropic", "memoryConfig");
    expect(await harness.repository.countAgentVersionsPinning(scope, key.providerKeyId)).toEqual({
      ok: true,
      value: 1,
    });
    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.deleteProviderKey(scope, key.providerKeyId, transaction),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_KEY_PINNED_BY_AGENTS", details: { pinnedAgents: 1 } },
    });
  });

  test("a version naming ANOTHER provider's model pins nothing, and the delete succeeds", async () => {
    // THE NEGATIVE CONTROL, and it is the trigger's own clause rather than an
    // invention: both halves compare `split_part(model, ':', 1)` against the
    // key's `provider`. A route that carries this key's id beside an OpenAI
    // model is a configuration error, not a use of this key, and counting it
    // would refuse a delete the database allows — which is the direction a suite
    // written only as "the store agrees with the trigger when it refuses" cannot
    // see.
    const key = await seedKey(scope, uuid("0003"), "anthropic", "mismatched", "ANTHROPIC_MISMATCH");
    await harness.seedPinningVersion(scope, key.providerKeyId, "openai", "modelRoutes");
    expect(await harness.repository.countAgentVersionsPinning(scope, key.providerKeyId)).toEqual({
      ok: true,
      value: 0,
    });
    const removed = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.deleteProviderKey(scope, key.providerKeyId, transaction),
    );
    expect(removed).toEqual({ ok: true, value: true });
  });

  test("the count is scoped: a version in another environment is not this scope's", async () => {
    const key = await seedKey(scope, uuid("0004"), "anthropic", "scoped", "ANTHROPIC_SCOPED");
    await harness.seedPinningVersion(scope, key.providerKeyId, "anthropic", "modelRoutes");
    // The SAME key id, asked for in the WRONG environment. The join is anchored
    // on the scope's whole ancestry, so it finds nothing.
    expect(
      await harness.repository.countAgentVersionsPinning(elsewhere, key.providerKeyId),
    ).toEqual({ ok: true, value: 0 });
  });
});

describe("the listing order is the DOMAIN's, not the database's collation", () => {
  test("byListingOrder and ORDER BY provider disagree, and the store follows the domain", async () => {
    // THE FINDING, stated with both answers in front of it. `byListingOrder`
    // compares `provider` with `<` on JavaScript strings, which is UTF-16 code
    // units: `"Zebra"` (Z = 90) sorts before `"apple"` (a = 97). The container
    // this suite runs against is `en_US.utf8`, whose collation ignores case at
    // the primary level and puts `"apple"` first. A store that pushed the order
    // into SQL would satisfy every other case in every other suite and return
    // this page the wrong way round.
    const ordering = await harness.freshScope();
    const zebra = await seedKey(ordering, uuid("0010"), "Zebra", "upper", "ZEBRA_KEY");
    const apple = await seedKey(ordering, uuid("0011"), "apple", "lower", "APPLE_KEY");

    const listed = await harness.repository.listProviderKeys(ordering);
    expect(listed.ok && listed.value.map((key) => key.provider)).toEqual(["Zebra", "apple"]);
    // The comparator itself, applied here, agrees.
    expect([apple, zebra].sort(byListingOrder).map((key) => key.provider)).toEqual([
      "Zebra",
      "apple",
    ]);

    // AND THE DATABASE, ASKED DIRECTLY, DOES NOT. This is the half that makes
    // the case load-bearing rather than decorative: if the two orders agreed,
    // pushing the sort into SQL would be free and this file would be asserting
    // nothing.
    const collated = await harness.base.client.providerKey.findMany({
      where: { environmentId: ordering.environmentId },
      select: { provider: true },
      orderBy: { provider: "asc" },
    });
    expect(collated.map((row: { readonly provider: string }) => row.provider)).toEqual([
      "apple",
      "Zebra",
    ]);
  });
});

describe("EnvironmentProvider, where the double and the database part company", () => {
  test("the store's own link order is total and does not depend on insertion order", async () => {
    const linking = await harness.freshScope();
    // INSERTED IN AN ORDER THAT IS NEITHER the answer nor its reverse, so a
    // store returning insertion order and one returning reverse insertion order
    // both fail.
    const inserted = ["openai", "anthropic", "google-vertex"];
    for (const [index, provider] of inserted.entries()) {
      await harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.upsertProviderLink(
          {
            environmentProviderId: asProvidersIdentifier(uuid(`002${index}`)),
            environmentId: linking.environmentId,
            provider: asProvidersIdentifier(provider),
            enabled: true,
            linkedAt: AT,
            updatedAt: AT,
          },
          transaction,
        ),
      );
    }
    const listed = await harness.repository.listProviderLinks(linking);
    // `providerId` ascending, and the unique index makes it total within a
    // scope. `describe-providers.ts` renders this list beside the manifest
    // catalogue: a page whose rows move between loads is a page an operator
    // cannot read.
    expect(listed.ok && listed.value.map((link) => link.provider)).toEqual([
      "anthropic",
      "google-vertex",
      "openai",
    ]);
  });

  test("a second adoption keeps the STORED identity and the ORIGINAL linkedAt", async () => {
    // The property `InMemoryProvidersRepository` cannot have: its map is keyed
    // by `${environmentId}/${provider}` and it stores whatever link it is
    // handed, so a caller that minted a fresh id would move the row's identity
    // in the double and not in the database. The conformance scenario follows
    // the path a use case takes — read the link, `enable(...)`, upsert — where
    // the two agree; this is the path where they do not.
    const readopting = await harness.freshScope();
    const original: ProviderLink = {
      environmentProviderId: asProvidersIdentifier(uuid("0030")),
      environmentId: readopting.environmentId,
      provider: ANTHROPIC,
      enabled: true,
      linkedAt: AT,
      updatedAt: AT,
    };
    await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertProviderLink(original, transaction),
    );
    const readopted = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertProviderLink(
        {
          ...original,
          // A CARELESS CALLER: a fresh identity and a fresh adoption date for a
          // provider that is already adopted.
          environmentProviderId: asProvidersIdentifier(uuid("0031")),
          enabled: false,
          linkedAt: LATER,
          updatedAt: LATER,
        },
        transaction,
      ),
    );
    expect(readopted).toMatchObject({
      ok: true,
      value: {
        // The row it actually is, not the row it was told it was.
        environmentProviderId: uuid("0030"),
        linkedAt: AT,
        enabled: false,
        updatedAt: LATER,
      },
    });
    // And there is exactly ONE row: adopting a provider twice is the same
    // adoption, which is what `@@unique([environmentId, providerId])` says.
    const listed = await harness.repository.listProviderLinks(readopting);
    expect(listed.ok && listed.value).toHaveLength(1);
  });
});
