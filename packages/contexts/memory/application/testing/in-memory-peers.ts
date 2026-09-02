// In-memory stand-ins for the two peer contexts this one depends on.
//
// THEY ARE NOT STUBS THAT SAY YES. Each enforces the part of its owner's
// contract this context actually relies on:
//
//   TENANCY'S GRANT CANNOT BE REAL, and that asymmetry is not an oversight.
//   `tenancy` deliberately publishes no mint — its authorization is an RBAC
//   DECISION, produced by loading a tenant tree and evaluating four gates, not a
//   value a caller constructs. So this double issues a marked object and
//   recognises it, which exercises the one thing this context is responsible
//   for: asking, and refusing when the answer is no. `authorization.test.ts`
//   separately pins that the REAL published check rejects a literal, so the
//   production wiring cannot be sound in this file and unsound at the seam.
//
//   PROVIDERS' PRICING IS REAL ARITHMETIC. The double holds a rate per thousand
//   tokens and multiplies, so a pricing test asserts a NUMBER rather than that a
//   method was called. It also enforces the one rule `providers` enforces at
//   this seam — cache reads and writes may not exceed the input count — because
//   the translation from this context's `cacheCreationInputTokens` to the rate
//   card's `cacheWriteInputTokens` is exactly the kind of mapping that goes
//   wrong silently.
//
// Everything either double is not asked for by this context returns a refusal
// rather than a plausible value: a test that starts depending on an unimplemented
// method finds out immediately.

import { asIdentifier, err, ok, type EnvironmentScope, type Result } from "@platos/kernel";
import type {
  EnvironmentAccess,
  EnvironmentOperatorAuthorization,
  TenancyContract,
} from "@platos/context-tenancy";
import type { ProvidersContract } from "@platos/context-providers";

import { repositoryUnavailable, scopeMismatch } from "../../domain/index.js";

const NOT_OFFERED = () =>
  err(repositoryUnavailable("this in-memory double does not implement that operation"));

const MARK = Symbol("in-memory-tenancy-grant");

/** Erase a value's type so a deliberate stand-in cast reads as a decision. */
function opaque(value: object): unknown {
  return value;
}

/**
 * An in-memory `tenancy`.
 *
 * Issues marked grants and recognises only its own. `verifyAuthorization` is the
 * one method this context calls, and it is the one method that behaves.
 */
export class InMemoryTenancy implements TenancyContract {
  readonly name = "tenancy" as const;

  /** How many times this context asked tenancy to verify a grant. */
  verifyCalls = 0;

  constructor(private readonly scope: EnvironmentScope) {}

  /** Mint a grant this double will accept. Not a real tenancy authorization. */
  grant(
    access: EnvironmentAccess = "secret:mutate",
    scope: EnvironmentScope = this.scope,
  ): EnvironmentOperatorAuthorization {
    // The four fields this context actually reads off a tenancy grant. The real
    // value carries five more, and `opaque` is what stops this literal from
    // claiming to be one: a structurally complete stand-in would let a test pass
    // against a shape tenancy has since changed.
    return opaque(
      Object.freeze({
        [MARK]: true,
        scope,
        access,
        actorUserId: asIdentifier("operator-1"),
        effectiveUserId: asIdentifier("operator-1"),
      }),
    ) as EnvironmentOperatorAuthorization;
  }

  verifyAuthorization(value: unknown): Result<EnvironmentOperatorAuthorization> {
    this.verifyCalls += 1;
    if (typeof value !== "object" || value === null || !(MARK in value)) {
      return err(scopeMismatch("a tenancy operator authorization", "a value tenancy did not mint"));
    }
    return ok(opaque(value) as EnvironmentOperatorAuthorization);
  }

  resolveEnvironmentScope: TenancyContract["resolveEnvironmentScope"] = async () => NOT_OFFERED();
  describeTenant: TenancyContract["describeTenant"] = async () => NOT_OFFERED();
  authorizeEnvironmentOperator: TenancyContract["authorizeEnvironmentOperator"] = async () =>
    NOT_OFFERED();
  changeMembershipRole: TenancyContract["changeMembershipRole"] = async () => NOT_OFFERED();
  deactivateMembership: TenancyContract["deactivateMembership"] = async () => NOT_OFFERED();
  addProjectMember: TenancyContract["addProjectMember"] = async () => NOT_OFFERED();
  findOrganizationMembership: TenancyContract["findOrganizationMembership"] = async () =>
    NOT_OFFERED();
  listProjectEntities: TenancyContract["listProjectEntities"] = async () => NOT_OFFERED();
  findEntity: TenancyContract["findEntity"] = async () => NOT_OFFERED();
  revokeAccessKeyGeneration: TenancyContract["revokeAccessKeyGeneration"] = async () => NOT_OFFERED();
  scopeContains: TenancyContract["scopeContains"] = () => false;
}

/** An in-memory `providers`. Only `priceModelUsage` is real; it is all this uses. */
export class InMemoryProviders implements ProvidersContract {
  readonly name = "providers" as const;

  /** Every pricing request, so a test can assert the translated usage shape. */
  readonly priced: { readonly model: string; readonly usage: Record<string, number> }[] = [];

  /** Cents per thousand tokens, per rate. Cache reads are a tenth of input. */
  centsPerThousandInput = 30;
  centsPerThousandOutput = 150;

  private failure: string | null = null;

  failWith(reason: string | null): void {
    this.failure = reason;
  }

  priceModelUsage: ProvidersContract["priceModelUsage"] = async (query) => {
    const usage = query.usage;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cacheRead = usage.cacheReadInputTokens ?? 0;
    const cacheWrite = usage.cacheWriteInputTokens ?? 0;
    this.priced.push({
      model: query.model,
      usage: { input, output, cacheRead, cacheWrite },
    });
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    if (cacheRead + cacheWrite > input) {
      return err(
        repositoryUnavailable("cache token counts cannot exceed inputTokens"),
      );
    }
    const fresh = input - cacheRead - cacheWrite;
    const cents =
      (fresh * this.centsPerThousandInput) / 1000 +
      (cacheRead * this.centsPerThousandInput) / 10_000 +
      (cacheWrite * this.centsPerThousandInput) / 1000 +
      (output * this.centsPerThousandOutput) / 1000;
    return ok({
      price: {
        modelPriceId: "price-1",
        modelKey: query.model,
        provider: "test",
        modelName: query.model,
        effectiveFrom: new Date(0),
        rates: [],
      },
      costCents: cents.toFixed(6),
      currency: "USD",
      charged: { input: fresh, output, cacheRead, cacheWrite },
    });
  };

  listProviderKeys: ProvidersContract["listProviderKeys"] = async () => NOT_OFFERED();
  pageProviderKeys: ProvidersContract["pageProviderKeys"] = async () => NOT_OFFERED();
  describeProviderKey: ProvidersContract["describeProviderKey"] = async () => NOT_OFFERED();
  linkProviderKey: ProvidersContract["linkProviderKey"] = async () => NOT_OFFERED();
  registerProviderKey: ProvidersContract["registerProviderKey"] = async () => NOT_OFFERED();
  rotateProviderKeySecret: ProvidersContract["rotateProviderKeySecret"] = async () => NOT_OFFERED();
  relinkProviderKey: ProvidersContract["relinkProviderKey"] = async () => NOT_OFFERED();
  updateProviderKey: ProvidersContract["updateProviderKey"] = async () => NOT_OFFERED();
  deleteProviderKey: ProvidersContract["deleteProviderKey"] = async () => NOT_OFFERED();
  describeProviders: ProvidersContract["describeProviders"] = async () => NOT_OFFERED();
  describeProvider: ProvidersContract["describeProvider"] = async () => NOT_OFFERED();
  setProviderAdoption: ProvidersContract["setProviderAdoption"] = async () => NOT_OFFERED();
  unlinkProvider: ProvidersContract["unlinkProvider"] = async () => NOT_OFFERED();
  listUsableProviders: ProvidersContract["listUsableProviders"] = async () => NOT_OFFERED();
  checkProviderHealth: ProvidersContract["checkProviderHealth"] = async () => NOT_OFFERED();
  checkAllProvidersHealth: ProvidersContract["checkAllProvidersHealth"] = async () => NOT_OFFERED();
  openModelRoute: ProvidersContract["openModelRoute"] = async () => NOT_OFFERED();
  resolveModelPrice: ProvidersContract["resolveModelPrice"] = async () => NOT_OFFERED();
  ingestRateCard: ProvidersContract["ingestRateCard"] = async () => NOT_OFFERED();
}
