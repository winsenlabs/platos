// An in-memory `SafetyLedger` that enforces what the schema enforces.
//
// It is APPEND-ONLY, it FILTERS BY ENVIRONMENT on every read, and its
// `anonymizeSubject` really does overwrite rather than delete — which is what
// makes the erasure decision testable rather than asserted. A double that
// deleted the row would let a target claiming `anonymize` pass while doing
// something else.
//
// `countSubject` NEVER MUTATES, and the suite proves it by counting the rows
// before and after a plan. The kernel port says a plan "must not mutate"; a
// double that did not honour that would make the claim untestable.

import { err, ok, asIdentifier, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  ledgerUnavailable,
  type AdmittedSafetyEvent,
  type AgentId,
  type SafetyEvent,
  type SafetyEventId,
  type SafetyTally,
} from "../../domain/index.js";
import type {
  AgentDetectorCounts,
  SafetyEventPage,
  SafetyEventQuery,
  SafetyLedger,
  SafetySubjectSelector,
} from "../ports/index.js";
import { PII_DETECTORS, INJECTION_DETECTORS } from "../../domain/index.js";
import { scopeReaches, type StoredScope } from "./scope-match.js";

interface StoredEvent extends SafetyEvent {
  readonly stored: StoredScope;
}

export class InMemorySafetyLedger implements SafetyLedger {
  private readonly rows: StoredEvent[] = [];
  private counter = 0;
  private failure: string | null = null;

  constructor(private readonly now: () => Date) {}

  /** Make the NEXT call fail, once. Models a store that went away mid-erasure. */
  failNext(reason: string): void {
    this.failure = reason;
  }

  size(): number {
    return this.rows.length;
  }

  /** Every stored row, for assertions the port does not expose. */
  all(): readonly SafetyEvent[] {
    return this.rows;
  }

  async append(
    scope: EnvironmentScope,
    event: AdmittedSafetyEvent,
    _transaction: TransactionScope | null,
  ): Promise<Result<SafetyEvent>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    this.counter += 1;
    const row: StoredEvent = {
      ...event,
      safetyEventId: asIdentifier<SafetyEventId>(`safety-${String(this.counter).padStart(4, "0")}`),
      environmentId: scope.environmentId,
      endUserId: null,
      createdAt: this.now(),
      stored: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    };
    this.rows.push(row);
    return ok(row);
  }

  async page(scope: EnvironmentScope, query: SafetyEventQuery): Promise<Result<SafetyEventPage>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const matched = this.rows
      .filter((row) => row.environmentId === scope.environmentId)
      .filter((row) => row.createdAt.getTime() >= query.since.getTime())
      .filter((row) => query.detector === null || row.detector === query.detector)
      .filter((row) => query.severity === null || row.severity === query.severity)
      .filter((row) => query.agentId === null || row.agentId === query.agentId)
      .filter((row) => query.threadId === null || row.threadId === query.threadId)
      .filter(
        (row) =>
          query.search === null ||
          (row.toolName ?? "").toLowerCase().includes(query.search.toLowerCase()),
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return ok({
      items: matched.slice(query.offset, query.offset + query.limit),
      total: matched.length,
    });
  }

  async findById(scope: EnvironmentScope, safetyEventId: SafetyEventId): Promise<Result<SafetyEvent | null>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const held = this.rows.find(
      (row) => row.safetyEventId === safetyEventId && row.environmentId === scope.environmentId,
    );
    return ok(held ?? null);
  }

  async tally(scope: EnvironmentScope, since: Date): Promise<Result<readonly SafetyTally[]>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    return ok(
      this.inWindow(scope, since).map((row) => ({
        detector: row.detector,
        action: row.action,
        severity: row.severity,
      })),
    );
  }

  async countByAgent(scope: EnvironmentScope, since: Date): Promise<Result<readonly AgentDetectorCounts[]>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const counts = new Map<string, { pii: number; injection: number }>();
    for (const row of this.inWindow(scope, since)) {
      if (row.agentId === null) continue;
      const bucket = counts.get(row.agentId) ?? { pii: 0, injection: 0 };
      if (PII_DETECTORS.includes(row.detector)) bucket.pii += 1;
      if (INJECTION_DETECTORS.includes(row.detector)) bucket.injection += 1;
      counts.set(row.agentId, bucket);
    }
    return ok(
      [...counts.entries()].map(([agentId, bucket]) => ({
        agentId: agentId as AgentId,
        piiEvents: bucket.pii,
        injectionEvents: bucket.injection,
      })),
    );
  }

  async countSubject(selector: SafetySubjectSelector): Promise<Result<number>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    return ok(this.matchSubject(selector).length);
  }

  async anonymizeSubject(
    selector: SafetySubjectSelector,
    _transaction: TransactionScope,
  ): Promise<Result<number>> {
    const failed = this.takeFailure();
    if (failed !== null) return err(failed);
    const matched = this.matchSubject(selector);
    for (const row of matched) {
      const index = this.rows.indexOf(row);
      // Overwrite the identifying columns; keep the ledger's own facts.
      this.rows[index] = { ...row, principalId: null, detail: null, metadata: null, endUserId: null };
    }
    return ok(matched.length);
  }

  private inWindow(scope: EnvironmentScope, since: Date): readonly StoredEvent[] {
    return this.rows.filter(
      (row) => row.environmentId === scope.environmentId && row.createdAt.getTime() >= since.getTime(),
    );
  }

  private matchSubject(selector: SafetySubjectSelector): readonly StoredEvent[] {
    if (selector.principalId === null) return [];
    return this.rows.filter(
      (row) => row.principalId === selector.principalId && scopeReaches(selector.scope, row.stored),
    );
  }

  private takeFailure() {
    if (this.failure === null) return null;
    const reason = this.failure;
    this.failure = null;
    return ledgerUnavailable(reason);
  }
}
