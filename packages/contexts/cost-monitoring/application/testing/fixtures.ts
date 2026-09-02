// Deterministic doubles for the kernel ports, and one call that assembles the
// whole context in memory.
//
// `MutableClock` and `SequenceIdGenerator` are why every rule in this package is
// testable at an instant. This context is almost entirely about time — a lease
// expiring, a window rolling over at midnight, an override running out, a cached
// cap going stale — so a wall clock here would make most of its behaviour
// untestable rather than merely awkward.

import {
  asIdentifier,
  environmentScope,
  zero,
  type Clock,
  type EnvironmentScope,
  type IdGenerator,
  type Money,
  type TransactionScope,
  type Ulid,
  type UnitOfWork,
  type Uuid,
} from "@platos/kernel";
import type { ProvidersContract } from "@platos/context-providers";
import type { TenancyContract } from "@platos/context-tenancy";

import {
  DEFAULT_COST_MONITORING_POLICY,
  asCostIdentifier,
  centsToMoney,
  type AlertChannel,
  type AlertChannelId,
  type Budget,
  type BudgetId,
  type CostMonitoringPolicy,
} from "../../domain/index.js";
import type { CostMonitoringDependencies } from "../dependencies.js";
import { InMemoryBudgetCapCache } from "./in-memory-cap-cache.js";
import { InMemoryBudgetRepository } from "./in-memory-budget-repository.js";
import { InMemoryNotifier, allNotifiers } from "./in-memory-notifier.js";
import { InMemoryProviders, InMemoryTenancy } from "./in-memory-peers.js";
import { InMemorySpendLedger } from "./in-memory-spend-ledger.js";

export class MutableClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date("2026-01-15T12:00:00.000Z")) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }

  advanceDays(days: number): void {
    this.advanceSeconds(days * 86_400);
  }

  set(instant: Date): void {
    this.current = new Date(instant.getTime());
  }
}

export class SequenceIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = "id") {}

  uuid(): Uuid {
    this.counter += 1;
    return asIdentifier<Uuid>(`${this.prefix}-${String(this.counter).padStart(4, "0")}`);
  }

  ulid(): Ulid {
    this.counter += 1;
    return asIdentifier<Ulid>(`${this.prefix.toUpperCase()}${String(this.counter).padStart(4, "0")}`);
  }
}

/** Runs the work with a stable handle; no rollback semantics to simulate. */
export class ImmediateUnitOfWork implements UnitOfWork {
  private counter = 0;
  readonly transactions: TransactionScope[] = [];

  async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
    this.counter += 1;
    const transaction: TransactionScope = { transactionId: asIdentifier(`txn-${this.counter}`) };
    this.transactions.push(transaction);
    return work(transaction);
  }
}

export function testEnvironmentScope(environmentId = "env-1"): EnvironmentScope {
  return environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier(environmentId));
}

export interface CostTestContext {
  readonly dependencies: CostMonitoringDependencies;
  readonly repository: InMemoryBudgetRepository;
  readonly ledger: InMemorySpendLedger;
  readonly capCache: InMemoryBudgetCapCache;
  readonly notifiers: readonly InMemoryNotifier[];
  readonly email: InMemoryNotifier;
  readonly webhook: InMemoryNotifier;
  readonly tenancy: InMemoryTenancy;
  readonly providers: InMemoryProviders;
  readonly clock: MutableClock;
  readonly ids: SequenceIdGenerator;
  readonly unitOfWork: ImmediateUnitOfWork;
  readonly scope: EnvironmentScope;
}

export interface CostTestOptions {
  readonly policy?: CostMonitoringPolicy;
  readonly scope?: EnvironmentScope;
  /** Compose fewer transports, to exercise the unrouted-kind path. */
  readonly notifiers?: readonly InMemoryNotifier[];
}

export function buildCostTestContext(options: CostTestOptions = {}): CostTestContext {
  const scope = options.scope ?? testEnvironmentScope();
  const clock = new MutableClock();
  const repository = new InMemoryBudgetRepository();
  repository.knowScope(scope);
  const ledger = new InMemorySpendLedger();
  const capCache = new InMemoryBudgetCapCache(() => clock.now());
  const notifiers = options.notifiers ?? allNotifiers();
  const tenancy = new InMemoryTenancy(scope);
  const providers = new InMemoryProviders();
  const ids = new SequenceIdGenerator();
  const unitOfWork = new ImmediateUnitOfWork();

  const byKind = (kind: string): InMemoryNotifier =>
    notifiers.find((notifier) => (notifier.kinds as readonly string[]).includes(kind)) ??
    new InMemoryNotifier([]);

  return {
    dependencies: Object.freeze({
      repository,
      ledger,
      capCache,
      notifiers,
      clock,
      ids,
      unitOfWork,
      policy: options.policy ?? DEFAULT_COST_MONITORING_POLICY,
      tenancy: tenancy as unknown as TenancyContract,
      providers: providers as unknown as ProvidersContract,
    }),
    repository,
    ledger,
    capCache,
    notifiers,
    email: byKind("EMAIL"),
    webhook: byKind("WEBHOOK"),
    tenancy,
    providers,
    clock,
    ids,
    unitOfWork,
    scope,
  };
}

/** An amount, from a plain cent figure. Throws only on a literal a test wrote. */
export function cents(value: number): Money {
  const amount = centsToMoney(value);
  if (!amount.ok) throw new Error(`unreachable: ${amount.error.code}`);
  return amount.value;
}

export const NOTHING: Money = zero();

/** A ready-made cap, for tests that need one to already exist. */
export function testBudget(scope: EnvironmentScope, overrides: Partial<Budget> = {}): Budget {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    budgetId: asCostIdentifier<BudgetId>("budget-1"),
    environmentId: scope.environmentId,
    target: {
      subject: "scope",
      targetId: "",
      tier: "llm",
      skillSlug: null,
      agentId: null,
      legacyWebhookUrl: null,
      legacyEmails: null,
      overrideBy: null,
    },
    period: "day",
    limitCents: 1_000,
    runsLimit: 0,
    alertThresholds: [50, 80, 100],
    enabled: true,
    overrideUntil: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/** A ready-made channel subscribed to budget alerts. */
export function testChannel(
  scope: EnvironmentScope,
  overrides: Partial<AlertChannel> = {},
): AlertChannel {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    channelId: asCostIdentifier<AlertChannelId>("channel-1"),
    environmentId: scope.environmentId,
    kind: "EMAIL",
    name: "ops mailbox",
    enabled: true,
    topics: ["BUDGET"],
    deduplicationKey: null,
    operatorSuppliedKey: false,
    configuration: { kind: "EMAIL", email: "ops@example.test" },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
