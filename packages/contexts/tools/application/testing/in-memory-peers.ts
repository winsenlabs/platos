// In-memory stand-ins for the four peer contexts this one depends on.
//
// THEY ARE NOT STUBS THAT SAY YES. Each enforces the part of its owner's
// contract this context actually relies on, so a use case that passes here has
// been held to the same rules the real contexts impose:
//
//   The vault refuses to read material under an OPERATOR grant, exactly as
//   `secrets` does — operators administer the vault, they do not read out of it.
//   A use case that reached for material with the wrong grant fails here rather
//   than in production.
//
//   Identity-access DENIES ACROSS SCOPES. `authenticateBearer` takes a
//   requested scope and its own contract note says that is what refuses a
//   credential addressed elsewhere. The double compares the whole ancestry, so
//   a use case that passed the wrong scope is caught.
//
//   Tenancy's grant CANNOT be real, and that asymmetry is not an oversight.
//   `tenancy` deliberately publishes no mint — its authorization is an RBAC
//   DECISION produced by loading a tenant tree, not a value a caller builds. So
//   this double issues a marked object and recognises it, which exercises the
//   one thing this context is responsible for: asking, and refusing when the
//   answer is no.

import {
  asIdentifier,
  contains,
  domainError,
  environmentScope,
  err,
  ok,
  resolvePath,
  type DomainError,
  type EntityId,
  type EnvironmentScope,
  type Result,
  type TenantScope,
} from "@platos/kernel";
import type {
  IdentityAccessContract,
  PrincipalAuthorizationView,
} from "@platos/context-identity-access";
import type {
  EnvironmentAuthorization,
  SecretMaterial,
  SecretsContract,
} from "@platos/context-secrets";
import type {
  EntityRecord,
  EnvironmentAccess,
  EnvironmentOperatorAuthorization as TenancyGrant,
  TenancyContract,
} from "@platos/context-tenancy";

import { repositoryUnavailable } from "../../domain/index.js";

const NOT_OFFERED = () =>
  err(repositoryUnavailable("this in-memory double does not implement that operation"));

/** Redacts under JSON and string coercion, like the value it stands in for. */
function material(plaintext: string): SecretMaterial {
  return {
    reveal: () => plaintext,
    toJSON: () => "[redacted]",
    toString: () => "[redacted]",
  };
}

/** An in-memory `secrets`, holding only what this context reads: material. */
export class InMemorySecrets implements Pick<SecretsContract, "name" | "readSecret"> {
  readonly name = "secrets" as const;

  private readonly plaintexts = new Map<string, string>();
  /** Every credential name this context asked for, in order. Assert emptiness. */
  readonly reads: string[] = [];

  seed(name: string, plaintext: string): void {
    this.plaintexts.set(name, plaintext);
  }

  async readSecret(query: {
    readonly authorization: EnvironmentAuthorization;
    readonly name?: string;
  }): Promise<Result<SecretMaterial>> {
    // The tier rule, enforced. An operator grant must not read material.
    const grant = query.authorization as unknown as { principalType?: string } | null;
    if (grant?.principalType !== "runtime") {
      return err(repositoryUnavailable("read_requires_runtime_tier"));
    }
    this.reads.push(query.name ?? "");
    const plaintext = query.name === undefined ? undefined : this.plaintexts.get(query.name);
    if (plaintext === undefined) return err(repositoryUnavailable("credential_not_found"));
    return ok(material(plaintext));
  }
}

/** A runtime-tier vault grant. Shape-compatible; `secrets` owns the real mint. */
export function testVaultAuthorization(): EnvironmentAuthorization {
  return Object.freeze({ principalType: "runtime" }) as unknown as EnvironmentAuthorization;
}

const ISSUED = new WeakSet<object>();

/**
 * An in-memory `tenancy`, offering the two methods this context asks of it.
 *
 * `verifyAuthorization` answers from a private register of the grants THIS
 * double issued — the same identity-not-shape rule the real one uses, so a
 * hand-written literal is refused here too.
 */
export class InMemoryTenancy
  implements Pick<TenancyContract, "name" | "verifyAuthorization" | "findEntity">
{
  readonly name = "tenancy" as const;

  private readonly entities = new Map<string, EntityRecord>();

  constructor(private readonly scope: EnvironmentScope) {}

  seedEntity(entityId: EntityId, externalId: string): EntityRecord {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const entity: EntityRecord = {
      id: entityId,
      projectId: this.scope.projectId,
      externalId,
      displayName: externalId,
      connectionStatus: "connected",
      connectionKind: "wire",
      mcpUrls: [],
      allowedOrigins: [],
      capabilities: [],
      lastConnectedAt: at,
      createdAt: at,
      updatedAt: at,
    };
    this.entities.set(entityId, entity);
    return entity;
  }

  /** Issue a grant this double will subsequently recognise. */
  grant(
    access: EnvironmentAccess = "secret:mutate",
    scope: EnvironmentScope = this.scope,
  ): TenancyGrant {
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

  async findEntity(entityId: EntityId): Promise<Result<EntityRecord>> {
    const held = this.entities.get(entityId);
    if (held === undefined) return err(repositoryUnavailable("entity_not_found"));
    return ok(held);
  }
}

/**
 * An in-memory `identity-access` that denies across scopes.
 *
 * The cross-scope check is the whole reason this context calls that contract
 * at execution time (ADR M0.3 §3's `auth -> tool-gateway` fix), so a double
 * that skipped it would leave the fix untested.
 *
 * IT REFUSES WITH IDENTITY-ACCESS'S OWN CODES, NOT WITH A `tools` ONE. The
 * earlier version answered every refusal with `TOOLS_REPOSITORY_UNAVAILABLE`,
 * which is a store-is-down error for a decision the store was never asked
 * about — so a suite could pin the wrong reason for a refusal, and the real
 * context would answer `unauthenticated` / `forbidden` in production where the
 * double had trained the suite to expect `unavailable`. `UNAUTHENTICATED` and
 * `FORBIDDEN_SCOPE` are the codes identity-access's own `domain/errors.ts` mints
 * for exactly these three refusals.
 *
 * THE THREE RULES ARE TRANSCRIBED, NOT APPROXIMATED. Each mirrors the line in
 * `identity-access` that owns it:
 *
 *   an absent or unknown token → `unauthenticated`.
 *   a scope the grant does not reach → `assertAuthorizes`, which is
 *     CONTAINMENT and not equality: a GLOBAL grant reaches everything and every
 *     other grant reaches exactly its own subtree.
 *   a missing permission → `assertPermission`, with `*` as the one wildcard
 *     and no prefix matching.
 *
 * The scope arrives as the contract's `AuthorizationScopeView` — `{ kind,
 * tenant }` — and is read as such. The earlier version cast the whole view to
 * a `TenantScope` and called `resolvePath` on it, which yields `org/undefined`
 * for every credential: the cross-scope rule this class exists to enforce could
 * only ever have compared two identical nonsense strings to each other.
 */
export class InMemoryIdentityAccess
  implements Pick<IdentityAccessContract, "name" | "authenticateBearer">
{
  readonly name = "identity-access" as const;

  private readonly tokens = new Map<string, PrincipalAuthorizationView>();

  seed(token: string, view: PrincipalAuthorizationView): void {
    this.tokens.set(token, view);
  }

  async authenticateBearer(request: {
    readonly presentedToken: string | null;
    readonly requestedScope: TenantScope | null;
    readonly requiredPermission?: string;
  }): Promise<Result<PrincipalAuthorizationView>> {
    if (request.presentedToken === null || request.presentedToken === "") {
      return err(unauthenticated("no-token"));
    }
    const held = this.tokens.get(request.presentedToken);
    if (held === undefined) return err(unauthenticated("no-credential"));

    if (request.requestedScope !== null && !grantReaches(held, request.requestedScope)) {
      return err(
        forbiddenScope(`Credential is not authorized for ${resolvePath(request.requestedScope)}`),
      );
    }
    if (
      request.requiredPermission !== undefined &&
      !held.permissions.includes(WILDCARD_PERMISSION) &&
      !held.permissions.includes(request.requiredPermission)
    ) {
      return err(
        forbiddenScope(`Credential does not carry the ${request.requiredPermission} permission`),
      );
    }
    return ok(held);
  }
}

/** `*` grants everything; there is no prefix matching. Transcribed. */
const WILDCARD_PERMISSION = "*";

function unauthenticated(reason: string): DomainError {
  return domainError("UNAUTHENTICATED", "unauthenticated", "Invalid operator session", {
    details: { reason },
  });
}

function forbiddenScope(message: string): DomainError {
  return domainError("FORBIDDEN_SCOPE", "forbidden", message);
}

/** `authorizes` from identity-access: GLOBAL reaches everything, else subtree. */
function grantReaches(held: PrincipalAuthorizationView, requested: TenantScope): boolean {
  if (held.scope.kind === "GLOBAL") return true;
  return held.scope.tenant !== null && contains(held.scope.tenant, requested);
}

/**
 * An in-memory `providers`, offering nothing.
 *
 * This context holds the handle for the priced side of a call — a
 * `ToolCallAudit` carries a `Decimal(18, 6)` and only `providers` may produce
 * one — and no use case in this package prices anything yet. The double is
 * honest about that: every method refuses, so a use case that started calling
 * it would fail here rather than silently pass against a stub that said yes.
 */
export class InMemoryProviders {
  readonly name = "providers" as const;

  async priceModelUsage(): Promise<Result<never>> {
    return NOT_OFFERED() as Result<never>;
  }
}

/** A second environment, for the cross-tenant denial tests. */
export function otherEnvironment(): EnvironmentScope {
  return environmentScope(asIdentifier("org-2"), asIdentifier("proj-2"), asIdentifier("env-2"));
}
