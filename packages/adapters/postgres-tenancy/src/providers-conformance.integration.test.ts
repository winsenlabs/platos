// The `providers` conformance differential: `InMemoryProvidersRepository` and
// this adapter, asked the SAME questions against a REAL PostgreSQL, compared
// verbatim.
//
// WHY THE COMPARISON IS THE TEST. A suite written against the adapter alone
// asserts what its author believed; a suite written against the fake alone
// asserts nothing about the database. Running one scenario twice and comparing
// the observation maps makes a divergence a named step with a value on each
// side.
//
// IT EARNED THAT ON THIS TRANCHE BEFORE IT PROVED ANYTHING ELSE. The first run
// of this scenario against a real database was refused outright by
// `ProviderKey_credential_provider_integrity` — a BEFORE INSERT rule, in the
// migrations and in neither `schema.prisma` nor the double, demanding a
// `Credential` in the same environment whose `provider` and `name` match the
// key's. Every use-case suite in the tree inserts provider keys against a double
// that stores any `credentialId` at all, so nothing in the repository had ever
// met that rule.
//
// Excluded from `vitest run` by the package's `test` script and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ImmediateUnitOfWork,
  InMemoryProvidersRepository,
} from "@platos/context-providers/application/testing/index.js";
import type {
  EnvironmentScope,
  ProvidersRepository,
  TransactionScope,
} from "@platos/context-providers/application/ports/index.js";

import type {
  ProvidersConformanceEnvironment,
  ProvidersConformanceIds,
  ProvidersObservation,
} from "./providers-conformance.js";
import { runProvidersConformance } from "./providers-conformance.js";
import type { ProvidersHarness } from "./providers-harness.js";
import { startProvidersHarness } from "./providers-harness.js";

/**
 * The four rates as the transcript carries them.
 *
 * Spelled as an object with four NAMED members rather than as a
 * `Record<string, ...>`, because a record's member is `| undefined` under
 * `noUncheckedIndexedAccess` and the whole point of these assertions is the
 * value that came back.
 */
interface ObservedRate {
  readonly rate: { readonly picoUsdPerToken: bigint };
  readonly source: string;
  readonly sourceRef: string | null;
}

interface RateBookShape {
  readonly input: ObservedRate;
  readonly output: ObservedRate;
  readonly cacheRead: ObservedRate;
  readonly cacheWrite: ObservedRate;
}

let harness: ProvidersHarness;
let scope: EnvironmentScope;
let foreignScope: EnvironmentScope;
let ids: ProvidersConformanceIds;

/**
 * A uuid per role, so no two rows in the scenario can collide on a key.
 *
 * EVERY CHARACTER IS HEXADECIMAL, which is not decoration. The first draft of
 * this helper spelled the prefix `pc` for "providers conformance"; `requireUuid`
 * refused the first insert, and it was right to — `ProviderKey.id` is `@db.Uuid`
 * and PostgreSQL PARSES the value rather than storing the bytes it was given.
 */
function uuid(slot: string): string {
  return `ea000000-${slot}-4000-8000-000000000000`;
}

beforeAll(async () => {
  harness = await startProvidersHarness();
  scope = await harness.freshScope();
  foreignScope = await harness.freshScope();
  ids = {
    // THE ANTHROPIC PAIR IS NUMBERED AGAINST ITS OWN NAMES. `tertiary` is
    // inserted AFTER `secondary` and carries the SMALLER identifier, and the two
    // share an instant — so the comparator's final id tie-break is the only
    // thing that can order them, and a store that dropped it comes back with the
    // pair the other way round.
    openaiBackupId: uuid("0001"),
    anthropicSecondaryId: uuid("0003"),
    anthropicTertiaryId: uuid("0002"),
    anthropicPrimaryId: uuid("0004"),
    clashingKeyId: uuid("0005"),
    missingKeyId: uuid("0006"),
    // The four identifiers the scenario cannot invent: every `ProviderKey` is
    // refused unless a `Credential` in the same environment carries its provider
    // and its `environmentKeyName`.
    openaiCredentialId: await harness.seedCredential(scope, {
      provider: "openai",
      name: "OPENAI_BACKUP",
    }),
    anthropicSecondaryCredentialId: await harness.seedCredential(scope, {
      provider: "anthropic",
      name: "ANTHROPIC_SECONDARY",
    }),
    anthropicTertiaryCredentialId: await harness.seedCredential(scope, {
      provider: "anthropic",
      name: "ANTHROPIC_TERTIARY",
    }),
    anthropicPrimaryCredentialId: await harness.seedCredential(scope, {
      provider: "anthropic",
      name: "ANTHROPIC_PRIMARY",
    }),
    anthropicLinkId: uuid("0007"),
    openaiLinkId: uuid("0008"),
  };
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function fakeEnvironment(): ProvidersConformanceEnvironment {
  const repository = new InMemoryProvidersRepository();
  const unitOfWork = new ImmediateUnitOfWork();
  return {
    repository,
    scope,
    foreignScope,
    ids,
    run: <Value>(work: (transaction: TransactionScope) => Promise<Value>) => unitOfWork.run(work),
  };
}

function adapterEnvironment(): ProvidersConformanceEnvironment {
  return {
    repository: harness.repository as ProvidersRepository,
    scope,
    foreignScope,
    ids,
    run: <Value>(work: (transaction: TransactionScope) => Promise<Value>) =>
      harness.base.adapter.unitOfWork.run(work),
  };
}

describe("the PostgreSQL providers store against the in-memory double", () => {
  let fake: ProvidersObservation;
  let real: ProvidersObservation;

  beforeAll(async () => {
    fake = await runProvidersConformance(fakeEnvironment());
    real = await runProvidersConformance(adapterEnvironment());
  }, 300_000);

  test("both stores answered every step of the scenario", () => {
    expect(Object.keys(real)).toEqual(Object.keys(fake));
    expect(Object.keys(real).length).toBeGreaterThan(40);
  });

  test("the steps that could agree by being empty did not", () => {
    // NON-VACUITY, asserted rather than assumed. Two stores that both returned
    // nothing would match transcript for transcript and prove nothing at all,
    // and these are the steps where "nothing" is a legal answer.
    const listed = real.listOrdered as { readonly value: readonly unknown[] };
    expect(listed.value).toHaveLength(4);
    expect(real.firstPage).toMatchObject({ ok: true, value: { total: 4 } });
    expect(real.providerPage).toMatchObject({ ok: true, value: { total: 3 } });
    expect(real.searchByLabel).toMatchObject({ ok: true, value: { total: 1 } });
    expect(real.searchUpperCaseAgainstProvider).toMatchObject({ ok: true, value: { total: 3 } });
    const links = real.listLinks as { readonly value: readonly unknown[] };
    expect(links.value).toHaveLength(2);
    const prices = real.pricesForBothKeys as { readonly value: readonly unknown[] };
    expect(prices.value).toHaveLength(3);
  });

  test("the listing order was the domain's, tie-break included", () => {
    // Read off the SHARED transcript, so this is a claim about both stores.
    const listed = (
      real.listOrdered as { readonly value: readonly { readonly label: string }[] }
    ).value;
    expect(listed.map((item) => item.label)).toEqual([
      // provider first: anthropic before openai. Within anthropic, the DEFAULT
      // first even though it was created LAST. Then the two that share an
      // instant, separated only by id — `tertiary` carries the smaller one.
      "primary",
      "tertiary",
      "secondary",
      "backup",
    ]);
  });

  test("a second default was refused, and the label clash was a DIFFERENT refusal", () => {
    // Two unique indexes on one table, told apart. A store that collapsed them
    // would tell an operator who promoted a second default that their LABEL was
    // taken.
    expect(real.insertDuplicateLabel).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_KEY_ALREADY_EXISTS", details: { label: "secondary" } },
    });
    expect(real.insertSecondDefault).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_KEY_ALREADY_EXISTS", details: { label: "default" } },
    });
  });

  test("the refused inserts left the store exactly as it was", () => {
    // THE SAVEPOINT'S WHOLE POINT. Both refusals above were raised by PostgreSQL
    // inside a transaction; without `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` the
    // transaction would have been aborted and the four rows before them
    // discarded at COMMIT with no error at all.
    const listed = (real.listOrdered as { readonly value: readonly unknown[] }).value;
    expect(listed).toHaveLength(4);
  });

  test("the append-only price ledger refused a second card at one instant", () => {
    expect(real.insertDuplicateInstant).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_PRICE_REVISION_CONFLICT" },
    });
    // NOT converted into an update, and not shifted to the next free instant:
    // the card in force is still the one that was there.
    expect(real.latestPriceAfterClash).toEqual(real.insertFirstCard);
  });

  test("the rate crossed Decimal(24, 12) and came back the same integer", () => {
    // The one claim a double cannot make. A `TokenRate` is an exact bigint and
    // the column is a 24-digit decimal; a store that went through a JavaScript
    // `number` loses the tail of both of these.
    const latest = real.latestPrice as { readonly value: { readonly rates: RateBookShape } };
    expect(latest.value.rates.input.rate.picoUsdPerToken).toBe(900_000n);
    expect(latest.value.rates.cacheWrite.rate.picoUsdPerToken).toBe(999_999_999_999_999_999_999_999n);
    const firstCard = real.insertFirstCard as { readonly value: { readonly rates: RateBookShape } };
    expect(firstCard.value.rates.input.rate.picoUsdPerToken).toBe(800_001n);
  });

  test("an UNAVAILABLE rate came back unavailable rather than as a zero price", () => {
    const firstCard = real.insertFirstCard as { readonly value: { readonly rates: RateBookShape } };
    expect(firstCard.value.rates.cacheWrite.source).toBe("UNAVAILABLE");
    expect(firstCard.value.rates.cacheWrite.sourceRef).toBeNull();
  });

  test("the second upsert of one model key kept the model's identity", () => {
    // The normaliser maps each newly seen minted id to `minted#<n>` in
    // first-seen order, so "the same id came back" is `minted#1` twice.
    const first = real.upsertModel as { readonly value: { readonly modelId: string } };
    const again = real.upsertModelAgain as { readonly value: { readonly modelId: string } };
    expect(first.value.modelId).toBe("minted#1");
    expect(again.value.modelId).toBe("minted#1");
    // And the facts DID change, so this is not a no-op that agreed by accident.
    const changed = real.upsertModelAgain as { readonly value: { readonly contextWindow: number } };
    expect(changed.value.contextWindow).toBe(500_000);
  });

  test("a key that exists in another environment was ABSENT, not returned", () => {
    expect(real.findAcrossTenants).toEqual({ ok: true, value: null });
    expect(real.deleteAcrossTenants).toEqual({ ok: true, value: false });
    expect(real.findLinkAcrossTenants).toEqual({ ok: true, value: null });
    expect(real.unadoptAcrossTenants).toEqual({ ok: true, value: false });
    // And the row the cross-tenant delete named is still there.
    const listed = (
      real.listOrdered as { readonly value: readonly { readonly label: string }[] }
    ).value;
    expect(listed.map((item) => item.label)).toContain("tertiary");
  });

  test("their transcripts match, observation for observation", () => {
    // ONE assertion over the whole map rather than one per step: a divergence
    // then names the step AND shows both values, and a step somebody forgot to
    // assert cannot exist.
    expect(real).toEqual(fake);
  });
});
