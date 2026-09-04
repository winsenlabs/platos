// In-memory stand-ins for the peer contexts this one depends on.
//
// THEY ARE NOT STUBS THAT SAY YES.
//
//   Tenancy's grant CANNOT be real, and that asymmetry is not an oversight.
//   `tenancy` deliberately publishes no mint — its authorization is an RBAC
//   DECISION, produced by loading a tenant tree and evaluating four gates, not a
//   value a caller constructs. So this double issues a marked object and
//   recognises it, which exercises the one thing this context is responsible
//   for: asking, and refusing when the answer is no. `authorization.test.ts`
//   separately pins that the REAL published check rejects a literal.
//
//   Providers enforces the part of its contract this context relies on: a key
//   resolves only inside the environment it was seeded in, and it carries the
//   provider it belongs to. A route pinning a key for the wrong provider fails
//   HERE, which is the check `resolve-route.ts` exists to make.
//
//   Skills REFUSES everything and counts being asked. That is not laziness:
//   `agents` holds the handle and never calls it (see `dependencies.ts`), and a
//   double that returned plausible data would let a call sneak in unnoticed. The
//   counter is what makes "never called" a testable claim rather than a comment;
//   the refusal is what makes a call that does sneak in fail where it happens.
//
//   IT IMPLEMENTS `SkillsPeer`, NOT `SkillsContract`. The port is this context's
//   own and has one method, so the double owes one method. Written against the
//   whole published surface, this class was green only for as long as `skills`
//   stayed a generated placeholder with a single method to match — and it stopped
//   compiling the day the real `skills` and this context first shared a tree.

import { err, ok, environmentScope, asIdentifier, type EnvironmentScope, type Result } from "@platos/kernel";
import type { ProviderKeyView, ProvidersContract } from "@platos/context-providers";
import type {
  EnvironmentAccess,
  EnvironmentOperatorAuthorization as TenancyGrant,
  TenancyContract,
} from "@platos/context-tenancy";

import type { SkillsPeer } from "../dependencies.js";
import { repositoryUnavailable } from "../../domain/index.js";

const NOT_OFFERED = () =>
  err(repositoryUnavailable("this in-memory double does not implement that operation"));

const ISSUED = new WeakSet<object>();

/**
 * An in-memory `tenancy`, offering only what this context asks of it.
 *
 * `verifyAuthorization` is the one method `agents` calls, and it answers from a
 * private register of the grants THIS double issued — the same identity-not-shape
 * rule the real one uses, so a hand-written literal is refused here too.
 */
export class InMemoryTenancy implements Pick<TenancyContract, "name" | "verifyAuthorization"> {
  readonly name = "tenancy" as const;

  constructor(private readonly scope: EnvironmentScope) {}

  /** Issue a grant this double will subsequently recognise. */
  grant(access: EnvironmentAccess = "metadata", scope: EnvironmentScope = this.scope): TenancyGrant {
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

export interface SeededProviderKey {
  readonly providerKeyId: string;
  readonly provider: string;
  readonly credentialName: string;
  readonly label?: string;
  readonly isDefault?: boolean;
}

/**
 * An in-memory `providers`, offering only `describeProviderKey`.
 *
 * Every other method refuses. A use case that reached for one would fail loudly
 * here rather than quietly acquiring an edge the ADR M0.3 §1 DAG permits but
 * this context has no business taking.
 */
export class InMemoryProviders implements Pick<ProvidersContract, "name" | "describeProviderKey"> {
  readonly name = "providers" as const;

  private readonly keys = new Map<string, ProviderKeyView>();
  /** Every key id this double was asked about, in order. */
  readonly lookups: string[] = [];

  constructor(private readonly scope: EnvironmentScope, private readonly now: () => Date) {}

  seed(seeded: SeededProviderKey): ProviderKeyView {
    const at = this.now();
    const view: ProviderKeyView = {
      providerKeyId: seeded.providerKeyId,
      environmentId: this.scope.environmentId,
      provider: seeded.provider,
      label: seeded.label ?? "production",
      credentialName: seeded.credentialName,
      isDefault: seeded.isDefault ?? true,
      createdBy: "operator-1",
      lastUsedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    this.keys.set(seeded.providerKeyId, view);
    return view;
  }

  async describeProviderKey(query: { readonly providerKeyId: string }): Promise<Result<ProviderKeyView>> {
    this.lookups.push(query.providerKeyId);
    const held = this.keys.get(query.providerKeyId);
    if (held === undefined) return err(repositoryUnavailable("provider_key_not_found"));
    return ok(held);
  }
}

/**
 * An in-memory `skills` that refuses and counts being asked.
 *
 * See the note at the top: the count is the control on the claim that this
 * context holds the handle and never calls it, and `NOT_OFFERED` is why a call
 * that did happen would surface as a failed `Result` at the call site rather
 * than as a plausible row nobody questions.
 */
export class InMemorySkills implements SkillsPeer {
  readonly name = "skills" as const;
  calls = 0;

  describe: SkillsPeer["describe"] = async () => {
    this.calls += 1;
    return NOT_OFFERED();
  };
}

/** A second environment, for the cross-tenant denial tests. */
export function otherEnvironment(): EnvironmentScope {
  return environmentScope(asIdentifier("org-2"), asIdentifier("proj-2"), asIdentifier("env-2"));
}

export { NOT_OFFERED };
