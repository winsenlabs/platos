// The clauses no shared scenario can reach, as named cases.
//
// EVERY CASE HERE IS A PROPERTY THE IN-MEMORY DOUBLE CANNOT HAVE, so putting it
// in the conformance differential would have meant either weakening the
// comparison or teaching the double a database it does not have. Four of them
// are the reason this file exists rather than more observations in a transcript:
//
//   THE DELETE RULE. `reject_executable_provider_key_delete` walks
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
import { runResult } from "@platos/kernel";

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
  const written = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
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

    const refused = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.deleteProviderKey(scope, key.providerKeyId, transaction),
    );
    // THE COUNT TRAVELS WITH THE ERROR, and it is READ rather than invented. The
    // rule reports THAT an executable version names the key and never HOW
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
    // The rule reads TWO places: `{__runtime,providerKeyId}` inside
    // `memoryConfig`, and every entry of the `modelRoutes` array. A store that
    // counted only the routes would agree with the rule on the case above and
    // disagree with it here — reporting zero and then being refused.
    const key = await seedKey(scope, uuid("0002"), "anthropic", "memoried", "ANTHROPIC_MEMORIED");
    await harness.seedPinningVersion(scope, key.providerKeyId, "anthropic", "memoryConfig");
    expect(await harness.repository.countAgentVersionsPinning(scope, key.providerKeyId)).toEqual({
      ok: true,
      value: 1,
    });
    const refused = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.deleteProviderKey(scope, key.providerKeyId, transaction),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_KEY_PINNED_BY_AGENTS", details: { pinnedAgents: 1 } },
    });
  });

  test("a key pinned through the LEGACY route field is refused too", async () => {
    // THE THIRD PLACE, and the one a fixture would forget.
    // `reject_executable_provider_key_delete` accepts EITHER spelling of the
    // route's identifier — `providerCredentialId`, which the extraction source
    // wrote, or `providerKeyId`, which the current shape writes — so a store
    // reading only one of the two agrees with the rule on every key written by
    // the release it was built against and disagrees on every key written by the
    // other. Both spellings are live in one database the day an upgrade lands.
    const key = await seedKey(scope, uuid("0005"), "anthropic", "legacy", "ANTHROPIC_LEGACY");
    await harness.seedPinningVersion(scope, key.providerKeyId, "anthropic", "modelRoutesLegacy");
    expect(await harness.repository.countAgentVersionsPinning(scope, key.providerKeyId)).toEqual({
      ok: true,
      value: 1,
    });
    const refused = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.deleteProviderKey(scope, key.providerKeyId, transaction),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_KEY_PINNED_BY_AGENTS", details: { pinnedAgents: 1 } },
    });
  });

  test("a version naming ANOTHER provider's model pins nothing, in EITHER place", async () => {
    // THE NEGATIVE CONTROL, and it is the rule's own clause rather than an
    // invention: BOTH halves compare `split_part(model, ':', 1)` against the
    // key's `provider`. A route — or a memory configuration — that carries this
    // key's id beside an OpenAI model is a configuration error, not a use of
    // this key, and counting it would refuse a delete the database allows, which
    // is the direction a suite written only as "the store agrees with the rule
    // when it refuses" cannot see.
    //
    // BOTH SITES ARE SEEDED, because the clause is written out twice and the
    // first sweep of `mutations-providers.json` proved that a control seeding
    // only the routes leaves the memory configuration's copy of it with no
    // witness at all.
    const key = await seedKey(scope, uuid("0003"), "anthropic", "mismatched", "ANTHROPIC_MISMATCH");
    await harness.seedPinningVersion(scope, key.providerKeyId, "openai", "modelRoutes");
    await harness.seedPinningVersion(scope, key.providerKeyId, "openai", "memoryConfig");
    expect(await harness.repository.countAgentVersionsPinning(scope, key.providerKeyId)).toEqual({
      ok: true,
      value: 0,
    });
    const removed = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.deleteProviderKey(scope, key.providerKeyId, transaction),
    );
    expect(removed).toEqual({ ok: true, value: true });
  });

  test("the count is scoped: a version in another tenant is not this scope's", async () => {
    const key = await seedKey(scope, uuid("0004"), "anthropic", "scoped", "ANTHROPIC_SCOPED");
    await harness.seedPinningVersion(scope, key.providerKeyId, "anthropic", "modelRoutes");
    // The SAME key id, asked for in the WRONG tenant. The join is anchored on
    // the scope's whole ancestry, so it finds nothing.
    expect(
      await harness.repository.countAgentVersionsPinning(elsewhere, key.providerKeyId),
    ).toEqual({ ok: true, value: 0 });
  });

  test("and scoped to the ENVIRONMENT, not just to the tenant above it", async () => {
    // THE CLAUSE THE CASE ABOVE CANNOT REACH. `elsewhere` differs in all three
    // ids, so the organization and project clauses refuse it before the
    // environment clause is consulted; a project with TWO environments is the
    // ordinary shape that reaches the third, and the first sweep of
    // `mutations-providers.json` found it had no witness at all.
    const sibling = await harness.siblingEnvironment(scope);
    const key = await seedKey(scope, uuid("0006"), "anthropic", "environed", "ANTHROPIC_ENVIRONED");
    await harness.seedPinningVersion(scope, key.providerKeyId, "anthropic", "modelRoutes");
    expect(await harness.repository.countAgentVersionsPinning(scope, key.providerKeyId)).toEqual({
      ok: true,
      value: 1,
    });
    expect(
      await harness.repository.countAgentVersionsPinning(sibling, key.providerKeyId),
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
      await runResult(harness.base.adapter.unitOfWork, (transaction) =>
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
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.upsertProviderLink(original, transaction),
    );
    const readopted = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
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

describe("the scope predicate is the whole ancestry, not the environment id", () => {
  test("a caller holding another tenant's grant sees nothing, whatever id it supplies", async () => {
    // THE DIVERGENCE FROM THE DOUBLE, and it has to live here because the shared
    // conformance scenario uses a consistent scope throughout and cannot reach
    // it. `InMemoryProvidersRepository` compares `environmentId` and stops; this
    // store spells the predicate as a relation filter through `Environment` and
    // `Project`, so an environment id that is RIGHT under an organization that
    // is WRONG resolves to nothing.
    //
    // It is not a hypothetical shape. `EnvironmentScope` is three ids a caller
    // supplies together, and a grant for one tenant carrying another tenant's
    // environment id is exactly what an authorization defect looks like from the
    // store's side. Cross-scope denial is the property ADR M0.3 §4 says this
    // programme cannot get wrong.
    const owner = await harness.freshScope();
    const key = await seedKey(owner, uuid("0040"), "anthropic", "owned", "ANTHROPIC_OWNED");
    await harness.seedPinningVersion(owner, key.providerKeyId, "anthropic", "modelRoutes");
    const stranger = await harness.freshScope();
    const forged = {
      level: "environment" as const,
      organizationId: stranger.organizationId,
      projectId: stranger.projectId,
      // The RIGHT environment, under the WRONG project and organization.
      environmentId: owner.environmentId,
    } as unknown as EnvironmentScope;

    expect(await harness.repository.listProviderKeys(forged)).toEqual({ ok: true, value: [] });
    expect(await harness.repository.findProviderKey(forged, key.providerKeyId)).toEqual({
      ok: true,
      value: null,
    });
    expect(await harness.repository.listProviderKeysFor(forged, ANTHROPIC)).toEqual({
      ok: true,
      value: [],
    });
    const removed = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.deleteProviderKey(forged, key.providerKeyId, transaction),
    );
    expect(removed).toEqual({ ok: true, value: false });
    // AND THE PIN COUNT IS ANCHORED THE SAME WAY, which is the one read in this
    // store that cannot use `scopedWhere` at all: it is hand-written SQL, so its
    // ancestry clauses are written out rather than folded in by the driver, and
    // the first sweep of `mutations-providers.json` found them with no witness.
    // Under a forged ancestry it must answer ZERO, and under the scope that owns
    // the key it must answer the version that really is there — otherwise the
    // case would pass against a count that is always zero.
    expect(await harness.repository.countAgentVersionsPinning(forged, key.providerKeyId)).toEqual({
      ok: true,
      value: 0,
    });
    expect(await harness.repository.countAgentVersionsPinning(owner, key.providerKeyId)).toEqual({
      ok: true,
      value: 1,
    });
    // And the key is still there under the scope that really owns it, so this is
    // a denial rather than a store that answers nothing to everybody.
    expect(await harness.repository.findProviderKey(owner, key.providerKeyId)).toMatchObject({
      ok: true,
      value: { label: "owned" },
    });
    expect(await harness.repository.listProviderKeys(owner)).toMatchObject({ ok: true });
  });
});
