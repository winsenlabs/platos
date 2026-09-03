// In-memory stand-ins for the two peer contexts this one depends on.
//
// THEY ARE NOT STUBS THAT SAY YES. Each enforces the part of its owner's contract
// this context actually relies on, so a use case that passes here has been held to
// the rules the real contexts impose.
//
//   Tenancy's grant CANNOT be real, and that is not an oversight. `tenancy`
//   deliberately publishes no mint — its authorization is an RBAC DECISION,
//   produced by loading a tenant tree and evaluating four gates, not a value a
//   caller constructs. So this double issues a marked object and recognises it,
//   which exercises the one thing this context is responsible for: asking, and
//   refusing when the answer is no. `authorization.test.ts` separately pins that
//   the REAL published check rejects a hand-written literal.
//
//   Providers' pricing IS real arithmetic. The double holds rate cards as
//   canonical decimal strings and prices usage exactly, because the one thing
//   this context does with the answer is turn it into an amount — and a double
//   that returned a round number would never exercise the string parsing that
//   exists precisely because a JSON number cannot carry the real one.

import { err, ok, environmentScope, asIdentifier, type EnvironmentScope, type Result } from "@platos/kernel";
import type {
  PricedUsageView,
  ProvidersContract,
  TokenUsageDraft,
} from "@platos/context-providers";
import type {
  EnvironmentAccess,
  EnvironmentOperatorAuthorization as TenancyGrant,
  TenancyContract,
} from "@platos/context-tenancy";

import { repositoryUnavailable } from "../../domain/index.js";

const NOT_OFFERED = () =>
  err(repositoryUnavailable("this in-memory double does not implement that operation"));

const ISSUED = new WeakSet<object>();

/**
 * An in-memory `tenancy`, offering only what this context asks of it.
 *
 * `verifyAuthorization` is the one method `cost-monitoring` calls, and it answers
 * from a private register of the grants THIS double issued — the same
 * identity-not-shape rule the real one uses, so a hand-written literal is refused
 * here too.
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

/** A rate card, as this double holds it: canonical strings, USD per token. */
export interface SeededRateCard {
  readonly model: string;
  readonly inputUsdPerToken: string;
  readonly outputUsdPerToken: string;
  readonly cacheReadUsdPerToken?: string;
  readonly cacheWriteUsdPerToken?: string;
}

/**
 * An in-memory `providers`, offering only `priceModelUsage`.
 *
 * The one method this context calls. Everything else on the contract returns the
 * not-offered error rather than a plausible-looking value, so a use case that
 * quietly started depending on a second providers method fails here loudly rather
 * than passing against a stub.
 */
export class InMemoryProviders implements Pick<ProvidersContract, "name" | "priceModelUsage"> {
  readonly name = "providers" as const;

  private readonly cards = new Map<string, SeededRateCard>();

  /** Models this double was asked to price. Proves the edge was actually used. */
  readonly priced: string[] = [];

  seedRateCard(card: SeededRateCard): void {
    this.cards.set(card.model, card);
  }

  async priceModelUsage(query: {
    readonly model: string;
    readonly usage: TokenUsageDraft;
  }): Promise<Result<PricedUsageView>> {
    this.priced.push(query.model);
    const card = this.cards.get(query.model);
    // Failing to price is an ERROR, not a zero — `providers` refuses for the
    // same reason, and a turn nobody can price must surface rather than being
    // silently served free.
    if (card === undefined) return NOT_OFFERED() as Result<PricedUsageView>;

    const input = query.usage.inputTokens ?? 0;
    const output = query.usage.outputTokens ?? 0;
    const cacheRead = query.usage.cacheReadInputTokens ?? 0;
    const cacheWrite = query.usage.cacheWriteInputTokens ?? 0;
    const fresh = Math.max(0, input - cacheRead - cacheWrite);

    // Exact, in pico-USD per token, exactly as `providers` computes it. One USD
    // is 100 cents, so a pico-USD total becomes micro-cents by dividing by 10^4.
    const picoTotal =
      pico(card.inputUsdPerToken) * BigInt(fresh) +
      pico(card.outputUsdPerToken) * BigInt(output) +
      pico(card.cacheReadUsdPerToken ?? "0") * BigInt(cacheRead) +
      pico(card.cacheWriteUsdPerToken ?? "0") * BigInt(cacheWrite);
    const microCents = picoTotal / 10_000n;
    const whole = microCents / 1_000_000n;
    const fraction = (microCents % 1_000_000n).toString().padStart(6, "0");

    return ok({
      price: {
        modelPriceId: `price-${query.model}`,
        modelKey: query.model,
        provider: query.model.split(":")[0] ?? query.model,
        modelName: query.model,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        rates: [],
      },
      costCents: `${whole}.${fraction}`,
      currency: "USD",
      charged: { input: fresh, output, cacheRead, cacheWrite },
    });
  }
}

/** A `Decimal(24, 12)` USD-per-token string as an exact pico-USD integer. */
function pico(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** 12n + BigInt(fraction.slice(0, 12).padEnd(12, "0"));
}

/** A second environment, for the cross-tenant denial tests. */
export function otherEnvironment(): EnvironmentScope {
  return environmentScope(asIdentifier("org-2"), asIdentifier("proj-2"), asIdentifier("env-2"));
}
