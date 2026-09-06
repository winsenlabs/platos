// In-memory stand-ins for the two peer contexts this one depends on.
//
// THEY ARE NOT STUBS THAT SAY YES. Each one enforces the part of its owner's
// contract this context actually relies on, so a use case that passes here has
// been held to the same rules the real contexts impose:
//
//   NEITHER IMPLEMENTS ITS OWNER'S WHOLE CONTRACT, and after WIN-258 M2.3 this
//   file holds no such double at all. `InMemorySecrets` implements `SecretsPeer`
//   — the seven members `providers` actually calls — and `InMemoryTenancy` the
//   two-member Pick beside it. A double typed as a whole contract has to grow a
//   stub for every method its owner adds, and a stub answering "not offered" is a
//   test passing against a peer that would have refused; that shape broke
//   `build:v1` three times on this issue. The seven `NOT_OFFERED` stubs this
//   double used to carry are GONE rather than hidden.
//
//   The vault refuses to read material under an OPERATOR grant, exactly as
//   `secrets` does — "operators administer the vault; they do not read out of
//   it". A use case that reached for material with the wrong grant fails here
//   rather than in production.
//
//   The vault's grants are REAL. `secrets` publishes its mint functions, so
//   these doubles hand out genuinely minted, unforgeable authorizations and the
//   identity check that guards every vault call runs for real.
//
//   Tenancy's grant CANNOT be real, and that asymmetry is not an oversight.
//   `tenancy` deliberately publishes no mint — its authorization is an RBAC
//   DECISION, produced by loading a tenant tree and evaluating four gates, not a
//   value a caller constructs. So this double issues a marked object and
//   recognises it, which exercises the one thing this context is responsible
//   for: asking, and refusing when the answer is no. `authorization.test.ts`
//   separately pins that the REAL published check rejects a literal.

import { err, ok, environmentScope, asIdentifier, type EnvironmentScope, type Result } from "@platos/kernel";
import {
  authorizeEnvironmentOperator as mintVaultOperatorGrant,
  authorizeEnvironmentRuntime as mintVaultRuntimeGrant,
  isSecretMaterial,
  type ActorId,
  type CredentialId,
  type CredentialMetadata,
  type EnvironmentAuthorizationAccess,
  type EnvironmentOperatorAuthorization as VaultOperatorGrant,
  type EnvironmentRuntimeAuthorization as VaultRuntimeGrant,
  type SecretMaterial,
} from "@platos/context-secrets";
import type {
  EnvironmentAccess,
  EnvironmentOperatorAuthorization as TenancyGrant,
  TenancyContract,
} from "@platos/context-tenancy";

import type { SecretsPeer } from "../dependencies.js";

import { repositoryUnavailable } from "../../domain/index.js";

/** Redacts under JSON and string coercion, like the value it stands in for. */
function material(plaintext: string): SecretMaterial {
  return {
    reveal: () => plaintext,
    toJSON: () => "[redacted]",
    toString: () => "[redacted]",
  };
}

export interface SeededCredential {
  readonly name: string;
  readonly provider: string | null;
  readonly plaintext: string;
  readonly kind?: CredentialMetadata["kind"];
  readonly revoked?: boolean;
  readonly withoutActiveVersion?: boolean;
}

/**
 * An in-memory `secrets`.
 *
 * Holds credentials and their material, mints genuine grants, and enforces the
 * tier rule on every material read.
 */
export class InMemorySecrets implements SecretsPeer {
  readonly name = "secrets" as const;

  private readonly credentials = new Map<string, CredentialMetadata>();
  private readonly plaintexts = new Map<string, string>();
  private sequence = 0;

  readonly rotations: string[] = [];
  readonly revocations: string[] = [];
  /** How many times the vault was asked for the environment's credentials. */
  listCalls = 0;

  constructor(private readonly scope: EnvironmentScope, private readonly now: () => Date) {}

  seed(seeded: SeededCredential): CredentialMetadata {
    const id = asIdentifier<CredentialId>(`cred-${(this.sequence += 1)}`);
    const at = this.now();
    const credential: CredentialMetadata = {
      id,
      environmentId: this.scope.environmentId,
      kind: seeded.kind ?? "SERVICE_CREDENTIAL",
      name: seeded.name,
      provider: seeded.provider,
      permissions: [],
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: seeded.revoked === true ? at : null,
      createdBy: null,
      createdAt: at,
      updatedAt: at,
      activeSecretVersion:
        seeded.withoutActiveVersion === true
          ? null
          : {
              id: asIdentifier(`ver-${this.sequence}`),
              // `secrets` brands these two as NUMBERS, which the kernel's
              // string-only `asIdentifier` cannot tag, and its own tagger is not
              // on the published surface. A double is the one place a cast is
              // honest: the value is a literal this file wrote.
              secretRevision: 1 as never,
              formatVersion: 1 as never,
              rootKeyVersion: 1 as never,
              retiredAt: null,
              readableUntil: null,
              createdAt: at,
            },
    };
    this.credentials.set(id, credential);
    this.plaintexts.set(id, seeded.plaintext);
    return credential;
  }

  /** A genuine vault operator grant for this scope. */
  operatorGrant(access: EnvironmentAuthorizationAccess = "secret:mutate"): VaultOperatorGrant {
    return mintVaultOperatorGrant({
      ancestry: {
        organizationId: this.scope.organizationId,
        projectId: this.scope.projectId,
        environmentId: this.scope.environmentId,
      },
      access,
      actorUserId: asIdentifier<ActorId>("operator-1"),
      effectiveUserId: asIdentifier<ActorId>("operator-1"),
    });
  }

  /** A genuine vault runtime grant for this scope. */
  runtimeGrant(scope: EnvironmentScope = this.scope): VaultRuntimeGrant {
    return mintVaultRuntimeGrant({
      ancestry: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      actorId: asIdentifier<ActorId>("runtime-1"),
    });
  }

  async describeCredential(query: {
    readonly credentialId: CredentialId;
  }): Promise<Result<CredentialMetadata | null>> {
    return ok(this.credentials.get(query.credentialId) ?? null);
  }

  async listCredentials(): Promise<Result<readonly CredentialMetadata[]>> {
    this.listCalls += 1;
    return ok([...this.credentials.values()]);
  }

  async readSecret(query: {
    readonly authorization: unknown;
    readonly credentialId?: CredentialId;
    readonly name?: string;
    readonly provider?: string;
  }): Promise<Result<SecretMaterial>> {
    // The tier rule, enforced. An operator grant must not read material.
    const grant = query.authorization as { principalType?: string } | null;
    if (grant?.principalType !== "runtime") {
      return err(repositoryUnavailable("read_requires_runtime_tier"));
    }
    const held =
      query.credentialId !== undefined
        ? this.credentials.get(query.credentialId)
        : [...this.credentials.values()].find(
            (credential) =>
              credential.name === query.name &&
              (query.provider === undefined || credential.provider === query.provider),
          );
    if (held === undefined) return err(repositoryUnavailable("credential_not_found"));
    const plaintext = this.plaintexts.get(held.id);
    if (plaintext === undefined) return err(repositoryUnavailable("credential_unavailable"));
    return ok(material(plaintext));
  }

  /**
   * WIN-259 — the double REFUSES a bare string, exactly as the real vault does.
   *
   * A double that accepts one would let this context regress to handing
   * `secrets` a serialisable plaintext while every suite here stayed green,
   * which is the failure this project has recorded twice already: the doubles
   * mint what the canonical store refuses, and the suites certify it.
   */
  private static writeOnly(plaintext: unknown): Result<string> {
    if (!isSecretMaterial(plaintext)) {
      return err(repositoryUnavailable("secret_input_not_write_only"));
    }
    return ok(plaintext.reveal());
  }

  async createCredential(command: {
    readonly name: string;
    readonly provider?: string | null;
    readonly kind?: CredentialMetadata["kind"];
    readonly plaintext: SecretMaterial;
  }): Promise<Result<CredentialMetadata>> {
    const admitted = InMemorySecrets.writeOnly(command.plaintext);
    if (!admitted.ok) return err(admitted.error);
    return ok(
      this.seed({
        name: command.name,
        provider: command.provider ?? null,
        plaintext: admitted.value,
        ...(command.kind === undefined ? {} : { kind: command.kind }),
      }),
    );
  }

  async rotateCredential(command: {
    readonly credentialId: CredentialId;
    readonly plaintext: SecretMaterial;
  }): Promise<Result<CredentialMetadata>> {
    const admitted = InMemorySecrets.writeOnly(command.plaintext);
    if (!admitted.ok) return err(admitted.error);
    const held = this.credentials.get(command.credentialId);
    if (held === undefined) return err(repositoryUnavailable("credential_not_found"));
    this.plaintexts.set(held.id, admitted.value);
    this.rotations.push(held.id);
    const rotated = { ...held, updatedAt: this.now() };
    this.credentials.set(held.id, rotated);
    return ok(rotated);
  }

  async revokeCredential(command: {
    readonly credentialId: CredentialId;
  }): Promise<Result<CredentialMetadata>> {
    const held = this.credentials.get(command.credentialId);
    if (held === undefined) return err(repositoryUnavailable("credential_not_found"));
    this.revocations.push(held.id);
    const revoked = { ...held, revokedAt: this.now() };
    this.credentials.set(held.id, revoked);
    return ok(revoked);
  }
}

const ISSUED = new WeakSet<object>();

/**
 * An in-memory `tenancy`, offering only what this context asks of it.
 *
 * `verifyAuthorization` is the one method `providers` calls, and it answers from
 * a private register of the grants THIS double issued — the same identity-not-
 * shape rule the real one uses, so a hand-written literal is refused here too.
 */
export class InMemoryTenancy implements Pick<TenancyContract, "name" | "verifyAuthorization"> {
  readonly name = "tenancy" as const;

  constructor(private readonly scope: EnvironmentScope) {}

  /** Issue a grant this double will subsequently recognise. */
  grant(access: EnvironmentAccess = "secret:mutate", scope: EnvironmentScope = this.scope): TenancyGrant {
    const issued = Object.freeze({
      principalType: "operator",
      tier: "OPERATOR",
      access,
      scope,
      actorUserId: asIdentifier("operator-1"),
      effectiveUserId: asIdentifier("operator-1"),
      organizationRole: "ADMIN",
      projectRole: null,
    }) as unknown as TenancyGrant;
    ISSUED.add(issued);
    return issued;
  }

  verifyAuthorization(value: unknown): Result<TenancyGrant> {
    if (typeof value === "object" && value !== null && ISSUED.has(value)) {
      return ok(value as TenancyGrant);
    }
    return err(repositoryUnavailable("authorization_not_issued"));
  }
}

/** A second environment, for the cross-tenant denial tests. */
export function otherEnvironment(): EnvironmentScope {
  return environmentScope(asIdentifier("org-2"), asIdentifier("proj-2"), asIdentifier("env-2"));
}
