// The scenario BOTH `ProvidersRepository` implementations answer, step by step.
//
// It is one script, run twice — once against `InMemoryProvidersRepository` and
// once against this adapter over a real PostgreSQL — producing two maps of
// observations that are compared VERBATIM. A suite written against the adapter
// alone asserts what its author believed; one written against the fake alone
// asserts nothing about the database. The comparison makes a divergence a named
// step with a value on each side.
//
// THE ROWS ARE INSERTED IN THE WRONG ORDER ON PURPOSE. `byListingOrder` sorts by
// provider, then defaults FIRST, then oldest first, then by id — four keys, and
// a store that dropped any one of them would still pass a fixture whose insert
// order happened to agree. So the insert order disagrees with the listing order
// on every key at once: `openai` goes in first though it sorts last, the
// anthropic DEFAULT goes in last though it sorts first among its provider's
// keys, and two anthropic keys share an instant so only the id tie-break can
// separate them — with the LATER-inserted one carrying the SMALLER id.
//
// SOME ORDERS ARE NORMALISED BEFORE THEY ARE COMPARED, and each is a port that
// promises no order. `findPricesForKeys` says outright that "ordering is the
// caller's", and `listProviderLinks` promises nothing at all; comparing the two
// stores' raw orders there would be comparing a map's insertion order against a
// planner's choice, which is a difference with no meaning. The real store's OWN
// ordering of the links is pinned separately, as a named case, in
// `providers-rules.integration.test.ts`.
//
// MINTED IDENTIFIERS ARE NORMALISED TOO, and that is not a weakening. `Model`
// and `ModelPrice` are the two rows whose identifiers the port does NOT let a
// caller supply — `upsertModel` takes a key and facts, `insertPrice` takes a
// model and a card — so the double mints `model-1` and the database mints a
// uuid, and neither is a fact about the port. What IS a fact is whether the
// SAME identifier comes back the second time, and the normaliser preserves that
// exactly: it maps each newly seen identifier to `<kind>#<n>` in FIRST-SEEN
// order, so a store that minted a fresh model id on the second upsert produces
// `model#2` where the other produces `model#1`.

import type {
  EnvironmentScope,
  ProviderId,
  ProviderKey,
  ProviderKeyId,
  ProviderLink,
  ProvidersRepository,
  TransactionScope,
} from "@platos/context-providers/application/ports/index.js";
import { asProvidersIdentifier } from "@platos/context-providers/application/ports/index.js";

import { runCatalogueConformance } from "./providers-conformance-catalogue.js";

/** Every identifier the scenario uses, so no two rows can collide on a key. */
export interface ProvidersConformanceIds {
  readonly openaiBackupId: string;
  readonly anthropicSecondaryId: string;
  readonly anthropicTertiaryId: string;
  readonly anthropicPrimaryId: string;
  readonly clashingKeyId: string;
  readonly missingKeyId: string;
  readonly openaiCredentialId: string;
  readonly anthropicSecondaryCredentialId: string;
  readonly anthropicTertiaryCredentialId: string;
  readonly anthropicPrimaryCredentialId: string;
  readonly anthropicLinkId: string;
  readonly openaiLinkId: string;
}

export interface ProvidersConformanceEnvironment {
  readonly repository: ProvidersRepository;
  readonly scope: EnvironmentScope;
  /** A DIFFERENT environment, so a cross-tenant read has something to miss. */
  readonly foreignScope: EnvironmentScope;
  readonly ids: ProvidersConformanceIds;
  run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value>;
}

export type ProvidersObservation = Readonly<Record<string, unknown>>;

/** The one instant every fixture row is stamped with. */
export const START = new Date("2026-05-01T09:00:00.000Z");
const LATER = new Date("2026-05-01T09:00:01.000Z");
const LATEST = new Date("2026-05-01T09:00:02.000Z");
const USED_AT = new Date("2026-05-01T10:00:00.000Z");

const ANTHROPIC = asProvidersIdentifier<ProviderId>("anthropic");
const OPENAI = asProvidersIdentifier<ProviderId>("openai");
const UNADOPTED = asProvidersIdentifier<ProviderId>("google-vertex");

function key(
  scope: EnvironmentScope,
  id: string,
  credentialId: string,
  provider: ProviderId,
  label: string,
  credentialName: string,
  isDefault: boolean,
  createdAt: Date,
): ProviderKey {
  return {
    providerKeyId: asProvidersIdentifier<ProviderKeyId>(id),
    environmentId: scope.environmentId,
    credentialId: asProvidersIdentifier(credentialId),
    provider,
    label,
    credentialName: asProvidersIdentifier(credentialName),
    isDefault,
    createdBy: asProvidersIdentifier("operator-1"),
    lastUsedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function link(
  scope: EnvironmentScope,
  id: string,
  provider: ProviderId,
  enabled: boolean,
  linkedAt: Date,
  updatedAt: Date,
): ProviderLink {
  return {
    environmentProviderId: asProvidersIdentifier(id),
    environmentId: scope.environmentId,
    provider,
    enabled,
    linkedAt,
    updatedAt,
  };
}

/**
 * Replace identifiers neither store's caller chose with first-seen tokens.
 *
 * Walks the whole observation, including the `details` of a `DomainError`, so a
 * refusal that names a minted id is compared for its SHAPE rather than for a
 * value one store had no way to produce.
 */
export class MintedIds {
  private readonly seen = new Map<string, string>();
  private counter = 0;

  /** Register a minted identifier and return the token that stands for it. */
  register(value: string): string {
    const held = this.seen.get(value);
    if (held !== undefined) return held;
    this.counter += 1;
    const token = `minted#${this.counter}`;
    this.seen.set(value, token);
    return token;
  }

  /** Replace every registered identifier anywhere inside a value. */
  normalise(value: unknown): unknown {
    if (typeof value === "string") return this.seen.get(value) ?? value;
    if (Array.isArray(value)) return value.map((item) => this.normalise(item));
    if (value instanceof Date || value === null || typeof value !== "object") return value;
    const normalised: Record<string, unknown> = {};
    for (const [name, held] of Object.entries(value as Record<string, unknown>)) {
      normalised[name] = this.normalise(held);
    }
    return normalised;
  }
}

/**
 * Run the whole scenario and return the transcript.
 *
 * Every step is recorded whether it succeeded or refused: a refusal is an
 * observation like any other, and the two stores have to agree about which ones
 * they are.
 */
export async function runProvidersConformance(
  environment: ProvidersConformanceEnvironment,
): Promise<ProvidersObservation> {
  const { repository, scope, foreignScope, ids } = environment;
  const seen: Record<string, unknown> = {};
  const minted = new MintedIds();
  const record = (name: string, value: unknown): void => {
    seen[name] = minted.normalise(value);
  };

  // --- ProviderKey ---------------------------------------------------------

  record("emptyList", await repository.listProviderKeys(scope));

  const openaiBackup = key(
    scope,
    ids.openaiBackupId,
    ids.openaiCredentialId,
    OPENAI,
    "backup",
    "OPENAI_BACKUP",
    true,
    START,
  );
  const anthropicSecondary = key(
    scope,
    ids.anthropicSecondaryId,
    ids.anthropicSecondaryCredentialId,
    ANTHROPIC,
    "secondary",
    "ANTHROPIC_SECONDARY",
    false,
    LATER,
  );
  // THE SAME INSTANT as `anthropicSecondary` and a SMALLER id, inserted after
  // it. Only the comparator's final id tie-break can separate the two, and
  // without it the pair comes back in whichever order the planner reached them.
  const anthropicTertiary = key(
    scope,
    ids.anthropicTertiaryId,
    ids.anthropicTertiaryCredentialId,
    ANTHROPIC,
    "tertiary",
    "ANTHROPIC_TERTIARY",
    false,
    LATER,
  );
  const anthropicPrimary = key(
    scope,
    ids.anthropicPrimaryId,
    ids.anthropicPrimaryCredentialId,
    ANTHROPIC,
    "primary",
    "ANTHROPIC_PRIMARY",
    true,
    LATEST,
  );

  record(
    "insertOpenaiBackup",
    await environment.run((transaction) => repository.insertProviderKey(openaiBackup, transaction)),
  );
  record(
    "insertAnthropicSecondary",
    await environment.run((transaction) =>
      repository.insertProviderKey(anthropicSecondary, transaction),
    ),
  );
  record(
    "insertAnthropicTertiary",
    await environment.run((transaction) =>
      repository.insertProviderKey(anthropicTertiary, transaction),
    ),
  );
  record(
    "insertAnthropicPrimary",
    await environment.run((transaction) =>
      repository.insertProviderKey(anthropicPrimary, transaction),
    ),
  );

  // The label index, refused. A DIFFERENT id and the SAME (provider, label).
  record(
    "insertDuplicateLabel",
    await environment.run((transaction) =>
      repository.insertProviderKey(
        {
          ...anthropicSecondary,
          providerKeyId: asProvidersIdentifier<ProviderKeyId>(ids.clashingKeyId),
        },
        transaction,
      ),
    ),
  );

  // The PARTIAL unique index, refused: a second default for one provider, with
  // no demotion first. This is the step the two stores reach by two completely
  // different routes — the double scans its map, the database has an index
  // `WHERE "isDefault" = TRUE` — and it is why the refusal is spelled the same.
  record(
    "insertSecondDefault",
    await environment.run((transaction) =>
      repository.insertProviderKey(
        {
          ...anthropicSecondary,
          providerKeyId: asProvidersIdentifier<ProviderKeyId>(ids.clashingKeyId),
          label: "another default",
          isDefault: true,
        },
        transaction,
      ),
    ),
  );

  record("listOrdered", await repository.listProviderKeys(scope));
  record(
    "firstPage",
    await repository.pageProviderKeys(scope, { limit: 2, offset: 0, provider: null, search: null }),
  );
  record(
    "secondPage",
    await repository.pageProviderKeys(scope, { limit: 2, offset: 2, provider: null, search: null }),
  );
  record(
    "pastTheEnd",
    await repository.pageProviderKeys(scope, { limit: 2, offset: 8, provider: null, search: null }),
  );
  record(
    "providerPage",
    await repository.pageProviderKeys(scope, {
      limit: 10,
      offset: 0,
      provider: ANTHROPIC,
      search: null,
    }),
  );
  // Across all THREE searchable fields: `secondary` is a label, `ANTHROPIC` is
  // both a provider and part of two credential names, and the needle is upper
  // case while two of the three fields are lower case.
  record(
    "searchByLabel",
    await repository.pageProviderKeys(scope, {
      limit: 10,
      offset: 0,
      provider: null,
      search: "secondary",
    }),
  );
  record(
    "searchByCredentialName",
    await repository.pageProviderKeys(scope, {
      limit: 10,
      offset: 0,
      provider: null,
      search: "OPENAI_BACK",
    }),
  );
  record(
    "searchUpperCaseAgainstProvider",
    await repository.pageProviderKeys(scope, {
      limit: 10,
      offset: 0,
      provider: null,
      search: "ANTHROPIC",
    }),
  );
  record(
    "searchMatchesNothing",
    await repository.pageProviderKeys(scope, {
      limit: 10,
      offset: 0,
      provider: null,
      search: "no such key",
    }),
  );

  record(
    "findKnown",
    await repository.findProviderKey(
      scope,
      asProvidersIdentifier<ProviderKeyId>(ids.anthropicPrimaryId),
    ),
  );
  record(
    "findMissing",
    await repository.findProviderKey(scope, asProvidersIdentifier<ProviderKeyId>(ids.missingKeyId)),
  );
  // The row EXISTS, in another environment. It must be ABSENT, not returned.
  record(
    "findAcrossTenants",
    await repository.findProviderKey(
      foreignScope,
      asProvidersIdentifier<ProviderKeyId>(ids.anthropicPrimaryId),
    ),
  );
  record("listForAnthropic", await repository.listProviderKeysFor(scope, ANTHROPIC));
  record("listForUnadoptedProvider", await repository.listProviderKeysFor(scope, UNADOPTED));

  // The rotation the partial index exists to serialise, in ONE transaction:
  // demote the incumbent, then promote the challenger. Two writes that must
  // both land or neither.
  record(
    "rotateDefault",
    await environment.run(async (transaction) => {
      const demoted = await repository.updateProviderKey(
        { ...anthropicPrimary, isDefault: false, updatedAt: USED_AT },
        transaction,
      );
      if (!demoted.ok) return demoted;
      return repository.updateProviderKey(
        { ...anthropicSecondary, isDefault: true, updatedAt: USED_AT },
        transaction,
      );
    }),
  );
  record("listAfterRotation", await repository.listProviderKeys(scope));

  // NOT transactional, by the port's own instruction. The write is made and
  // then read back through a scoped find, so the observation is what a caller
  // would see rather than what the method returned.
  record(
    "touch",
    await repository.touchProviderKey(
      asProvidersIdentifier<ProviderKeyId>(ids.openaiBackupId),
      USED_AT,
    ),
  );
  record(
    "findAfterTouch",
    await repository.findProviderKey(
      scope,
      asProvidersIdentifier<ProviderKeyId>(ids.openaiBackupId),
    ),
  );

  record(
    "countPinsForUnpinnedKey",
    await repository.countAgentVersionsPinning(
      scope,
      asProvidersIdentifier<ProviderKeyId>(ids.anthropicTertiaryId),
    ),
  );
  record(
    "countPinsForMissingKey",
    await repository.countAgentVersionsPinning(
      scope,
      asProvidersIdentifier<ProviderKeyId>(ids.missingKeyId),
    ),
  );

  record(
    "deleteMissing",
    await environment.run((transaction) =>
      repository.deleteProviderKey(
        scope,
        asProvidersIdentifier<ProviderKeyId>(ids.missingKeyId),
        transaction,
      ),
    ),
  );
  // A row that EXISTS, deleted through the WRONG scope. `false`, and the row
  // still there afterwards — which `listAfterDelete` shows.
  record(
    "deleteAcrossTenants",
    await environment.run((transaction) =>
      repository.deleteProviderKey(
        foreignScope,
        asProvidersIdentifier<ProviderKeyId>(ids.anthropicTertiaryId),
        transaction,
      ),
    ),
  );
  record(
    "deleteUnpinned",
    await environment.run((transaction) =>
      repository.deleteProviderKey(
        scope,
        asProvidersIdentifier<ProviderKeyId>(ids.anthropicTertiaryId),
        transaction,
      ),
    ),
  );
  record("listAfterDelete", await repository.listProviderKeys(scope));

  // --- EnvironmentProvider -------------------------------------------------

  record("linksEmpty", await repository.listProviderLinks(scope));
  const anthropicLink = link(scope, ids.anthropicLinkId, ANTHROPIC, true, START, START);
  record(
    "adoptAnthropic",
    await environment.run((transaction) =>
      repository.upsertProviderLink(anthropicLink, transaction),
    ),
  );
  record(
    "adoptOpenai",
    await environment.run((transaction) =>
      repository.upsertProviderLink(
        link(scope, ids.openaiLinkId, OPENAI, true, START, START),
        transaction,
      ),
    ),
  );
  // THE SECOND ADOPTION OF ONE PROVIDER, exactly as a use case makes it: the
  // stored link is read, `enable(link, false, now)` keeps its identity and its
  // original `linkedAt`, and only `enabled` and `updatedAt` move. A caller that
  // minted a fresh id here would be re-adopting rather than pausing, and the
  // two stores would then disagree about which row this is.
  record(
    "pauseAnthropic",
    await environment.run((transaction) =>
      repository.upsertProviderLink(
        { ...anthropicLink, enabled: false, updatedAt: USED_AT },
        transaction,
      ),
    ),
  );
  record("findAnthropicLink", await repository.findProviderLink(scope, ANTHROPIC));
  record("findUnadoptedLink", await repository.findProviderLink(scope, UNADOPTED));
  record("findLinkAcrossTenants", await repository.findProviderLink(foreignScope, ANTHROPIC));
  // Sorted: `listProviderLinks` promises no order and the two stores reach one
  // by different means. The real store's own ordering is pinned separately.
  record(
    "listLinks",
    sortedLinks(await repository.listProviderLinks(scope)),
  );
  record(
    "unadoptOpenai",
    await environment.run((transaction) =>
      repository.deleteProviderLink(scope, OPENAI, transaction),
    ),
  );
  record(
    "unadoptAgain",
    await environment.run((transaction) =>
      repository.deleteProviderLink(scope, OPENAI, transaction),
    ),
  );
  record(
    "unadoptAcrossTenants",
    await environment.run((transaction) =>
      repository.deleteProviderLink(foreignScope, ANTHROPIC, transaction),
    ),
  );
  record("listLinksAfterUnadopt", sortedLinks(await repository.listProviderLinks(scope)));

  // --- Model and ModelPrice ------------------------------------------------

  await runCatalogueConformance(environment, record, minted);

  return seen;
}

/** A links result in a deterministic order, for a port that promises none. */
function sortedLinks(
  result: { readonly ok: true; readonly value: readonly ProviderLink[] } | { readonly ok: false },
): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    value: [...result.value].sort((left, right) => (left.provider < right.provider ? -1 : 1)),
  };
}
