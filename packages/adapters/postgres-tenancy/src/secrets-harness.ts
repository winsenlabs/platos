// What the `secrets` suites need on top of the shared container: a fresh tenant
// chain per suite, and envelopes the three `octet_length` CHECKs accept.
//
// THE TENANT CHAIN GOES THROUGH THE PORT. `Organization`, `Project` and
// `Environment` are `tenancy`'s rows and `tenancy`'s canonical store is this
// same directory (ADR M0.3 §15), so a scope is created by calling
// `saveOrganization`, `saveProject` and `saveEnvironment` rather than by writing
// SQL. A fresh chain per suite is what keeps `listCredentials(environmentId)` —
// which returns everything in an environment — from seeing another suite's rows.
//
// AND `Credential` NEEDS NO OUT-OF-BAND SEED HERE, WHICH IS THE DIFFERENCE THIS
// TRANCHE MAKES. `cost-harness.ts` seeds its credentials through
// `prisma db execute` and says why: "`secrets` has NO entry in
// `CANONICAL_STORE_ADAPTERS`, so `sole-writer.mjs` refuses a write to it from
// this directory". That entry now exists, so the vault's own rows are written
// through the vault's own port — which is also the only way the conformance
// differential can be a differential at all.
//
// THE ENVELOPE BYTES ARE EXACT AND NOT ROUGHLY RIGHT. 32-byte salt, 12-byte
// nonce, 16-byte tag, or `CredentialSecretVersion_salt_length_check`,
// `_nonce_length_check` and `_auth_tag_length_check` refuse the row. Nothing in
// `schema.prisma` says so and nothing in the double checks it, so the widths are
// spelled here once and every suite uses these builders.

import type {
  ActorId,
  CredentialAuditDraft,
  CredentialAuditId,
  CredentialDraft,
  CredentialId,
  CredentialKind,
  CredentialSecretVersionDraft,
  EnvelopeFormatVersion,
  EnvironmentVariableId,
  EnvironmentVariableRepository,
  RootKeyVersion,
  SecretRevision,
  SecretVersionId,
  SecretsRepository,
} from "@platos/context-secrets/application/ports/index.js";
import { asSecretsIdentifier } from "@platos/context-secrets/application/ports/index.js";
import type {
  EnvironmentId,
  OrganizationId,
  ProjectId,
  Slug,
} from "@platos/context-tenancy/application/ports/index.js";
import { asIdentifier } from "@platos/context-tenancy/application/ports/index.js";

import type { TenancyHarness } from "./harness.js";
import { AT, startTenancyHarness } from "./harness.js";

export { AT };

// Typed identifier constructors. A bare `asSecretsIdentifier("x")` infers the
// GENERIC brand and is refused by every parameter that wants a specific one, so
// the suites name each brand once, here, rather than at each of sixty call
// sites. `harness.ts` does the same for the tenancy identifiers and for the same
// reason.
export const credentialIdOf = (value: string): CredentialId =>
  asSecretsIdentifier<CredentialId>(value);
export const versionIdOf = (value: string): SecretVersionId =>
  asSecretsIdentifier<SecretVersionId>(value);
export const auditIdOf = (value: string): CredentialAuditId =>
  asSecretsIdentifier<CredentialAuditId>(value);
export const actorIdOf = (value: string): ActorId => asSecretsIdentifier<ActorId>(value);
export const variableIdOf = (value: string): EnvironmentVariableId =>
  asSecretsIdentifier<EnvironmentVariableId>(value);
export const revisionOf = (value: number): SecretRevision => value as SecretRevision;
export const rootKeyOf = (value: number): RootKeyVersion => value as RootKeyVersion;

/**
 * Root-key usage, SORTED, because a `GROUP BY` answers in no order at all.
 *
 * It lives beside the fixtures rather than inside either conformance half
 * because both halves ask for it and neither owns it — and because the sort is a
 * property of the MEASUREMENT, not of the store: `rootKeyReport` in the domain
 * sorts the list itself, so a store that sorted too would be doing it twice.
 */
export async function sortedRootKeyUsage(repository: SecretsRepository): Promise<unknown> {
  const counted = await repository.countVersionsByRootKey();
  if (!counted.ok) return counted;
  return {
    ok: true,
    value: [...counted.value].sort((left, right) => left.rootKeyVersion - right.rootKeyVersion),
  };
}

/** An hour after `AT`. Rotations and retirements land here. */
export const LATER = new Date("2026-05-01T10:00:00.000Z");

/** A day after `AT`. Every purge cutoff in the suites is this instant. */
export const CUTOFF = new Date("2026-05-02T09:00:00.000Z");

export interface SecretsHarness {
  readonly base: TenancyHarness;
  readonly repository: SecretsRepository;
  readonly variables: EnvironmentVariableRepository;
  /** A brand-new organization, project and environment, through the tenancy port. */
  freshEnvironment(): Promise<EnvironmentId>;
  stop(): Promise<void>;
}

/**
 * A byte field of an exact width, filled with one repeated value.
 *
 * The FILL varies per field so a store that swapped the salt and the nonce would
 * be caught by the comparison rather than passing on two arrays that happen to
 * be equal.
 */
export function bytes(width: number, fill: number): Uint8Array {
  return new Uint8Array(width).fill(fill);
}

/** A format-1 envelope of the exact widths the three CHECKs demand. */
export function envelope(fill: number): {
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authTag: Uint8Array;
} {
  return {
    salt: bytes(32, fill),
    nonce: bytes(12, fill + 1),
    // The ONLY field with no width rule. Eight bytes because a plaintext is as
    // long as it is, and a guard inventing a bound would be stricter than the
    // column.
    ciphertext: bytes(8, fill + 2),
    authTag: bytes(16, fill + 3),
  };
}

export interface CredentialDraftInput {
  readonly id: string;
  readonly environmentId: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly provider?: string | null;
  readonly createdBy?: string | null;
  readonly at?: Date;
}

export function credentialDraft(input: CredentialDraftInput): CredentialDraft {
  const createdBy = input.createdBy ?? null;
  return {
    id: credentialIdOf(input.id),
    environmentId: asSecretsIdentifier<EnvironmentId>(input.environmentId),
    kind: input.kind,
    name: input.name,
    provider: input.provider ?? null,
    createdBy: createdBy === null ? null : actorIdOf(createdBy),
    createdAt: input.at ?? AT,
  };
}

export interface VersionDraftInput {
  readonly id: string;
  readonly credentialId: string;
  readonly secretRevision: number;
  readonly rootKeyVersion: number;
  readonly fill: number;
  readonly formatVersion?: number;
  readonly at?: Date;
}

export function versionDraft(input: VersionDraftInput): CredentialSecretVersionDraft {
  return {
    id: versionIdOf(input.id),
    credentialId: credentialIdOf(input.credentialId),
    secretRevision: revisionOf(input.secretRevision),
    formatVersion: (input.formatVersion ?? 1) as EnvelopeFormatVersion,
    rootKeyVersion: rootKeyOf(input.rootKeyVersion),
    ...envelope(input.fill),
    createdAt: input.at ?? AT,
  };
}

export interface AuditDraftInput {
  readonly id: string;
  readonly environmentId: string;
  readonly credentialId: string;
  readonly action: CredentialAuditDraft["action"];
  readonly outcome?: CredentialAuditDraft["outcome"];
  readonly secretRevision?: number | null;
  readonly fromRootKeyVersion?: number | null;
  readonly toRootKeyVersion?: number | null;
  readonly at?: Date;
}

export function auditDraft(input: AuditDraftInput): CredentialAuditDraft {
  const revision = input.secretRevision ?? null;
  const from = input.fromRootKeyVersion ?? null;
  const to = input.toRootKeyVersion ?? null;
  return {
    id: auditIdOf(input.id),
    environmentId: asSecretsIdentifier<EnvironmentId>(input.environmentId),
    credentialId: credentialIdOf(input.credentialId),
    action: input.action,
    outcome: input.outcome ?? "SUCCESS",
    // `actorType` and `actorId` are plain TEXT with no CHECK, so the fixture
    // uses the two the extraction source writes rather than inventing a shape
    // the column does not have.
    actorType: "operator",
    actorId: actorIdOf("operator-1"),
    effectiveUserId: null,
    secretRevision: revision === null ? null : revisionOf(revision),
    fromRootKeyVersion: from === null ? null : rootKeyOf(from),
    toRootKeyVersion: to === null ? null : rootKeyOf(to),
    createdAt: input.at ?? AT,
  };
}

export async function startSecretsHarness(): Promise<SecretsHarness> {
  const base = await startTenancyHarness();

  return {
    base,
    repository: base.adapter.secrets,
    variables: base.adapter.secretsVariables,

    async freshEnvironment(): Promise<EnvironmentId> {
      // The WHOLE fresh identifier, not a slice of it. `Organization.slug` is
      // UNIQUE installation-wide and `freshId` varies only in its LAST group, so
      // a slice of the middle is the same string on every call.
      const organizationId: OrganizationId = await base.seedOrganization(
        `secrets-${base.freshId("0011")}`,
      );
      const projectId: ProjectId = await base.seedProject(
        organizationId,
        `proj-${base.freshId("0012")}`,
      );
      const environmentId = asIdentifier<EnvironmentId>(base.freshId("0013"));
      await base.adapter.unitOfWork.run((transaction) =>
        base.adapter.saveEnvironment(
          {
            id: environmentId,
            projectId,
            slug: asIdentifier<Slug>("prod"),
            name: "prod",
            archivedAt: null,
            accessKeyRevocationVersion: 0,
            memoryFeedbackBackfillCursor: null,
            memoryFeedbackBackfillCompletedAt: null,
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        ),
      );
      return environmentId;
    },

    async stop(): Promise<void> {
      await base.stop();
    },
  };
}
