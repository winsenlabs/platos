// An in-memory `BudgetCapCache` with a REAL expiry.
//
// It reads its own clock, so `clock.advanceSeconds(31)` expires an entry written
// with a thirty-second lifetime. A double that never expired would make the whole
// of ADR §7 decision 3(b) — the trade the cached guard is built on — untestable:
// "a cap edited seconds ago enforces the previous limit for at most the cache
// window" is a claim about time, and it is either exercised at an instant or
// believed.
//
// `reads`, `writes` and `forgets` are counted, because the interesting assertions
// are about WHETHER the repository was reached, not about what came back.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import { repositoryUnavailable, type Budget } from "../../domain/index.js";
import type { BudgetCapCache } from "../ports/index.js";

interface Entry {
  readonly budgets: readonly Budget[];
  readonly expiresAt: number;
}

export class InMemoryBudgetCapCache implements BudgetCapCache {
  private readonly entries = new Map<string, Entry>();

  reads = 0;
  writes = 0;
  readonly forgets: string[] = [];
  /** Set to make every read fail, so "a cache failure is a miss" is testable. */
  unavailable = false;

  constructor(private readonly now: () => Date) {}

  async read(scope: EnvironmentScope): Promise<Result<readonly Budget[] | null>> {
    this.reads += 1;
    if (this.unavailable) return err(repositoryUnavailable("cap cache is unavailable"));
    const entry = this.entries.get(scope.environmentId);
    if (entry === undefined) return ok(null);
    // A miss and an expiry are the SAME answer. Distinguishing them would let a
    // caller treat an expiry as a fault.
    if (entry.expiresAt <= this.now().getTime()) {
      this.entries.delete(scope.environmentId);
      return ok(null);
    }
    return ok(entry.budgets);
  }

  async write(
    scope: EnvironmentScope,
    budgets: readonly Budget[],
    ttlSeconds: number,
  ): Promise<Result<void>> {
    this.writes += 1;
    this.entries.set(scope.environmentId, {
      budgets,
      expiresAt: this.now().getTime() + ttlSeconds * 1000,
    });
    return ok(undefined);
  }

  async forget(scope: EnvironmentScope): Promise<Result<void>> {
    this.forgets.push(scope.environmentId);
    this.entries.delete(scope.environmentId);
    return ok(undefined);
  }

  /** Is anything cached for this scope right now? For the expiry assertions. */
  holds(scope: EnvironmentScope): boolean {
    const entry = this.entries.get(scope.environmentId);
    return entry !== undefined && entry.expiresAt > this.now().getTime();
  }
}
