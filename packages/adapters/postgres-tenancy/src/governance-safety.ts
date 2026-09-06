// The `SafetyLedger` — `governance`'s `SafetyEvent` half.
//
// APPEND-ONLY IS A PROPERTY OF THE FILE, not only of the port. There is one
// INSERT, one UPDATE that exists solely to anonymise, and no DELETE anywhere.
// The port's own header says a compliance ledger that can be emptied is not a
// compliance ledger; this is that sentence in statements.
//
// THE INSERT DOES NOT RAISE, AND THAT IS THE CONSTRAINT SHAPE RATHER THAN A
// STYLE. `append` takes `TransactionScope | null` because the kernel
// `SafetyEventSink` records outside any unit of work — but `record-safety-event.ts`
// passes a real one, and on PostgreSQL a violated constraint aborts the whole
// transaction. Every value this row can be refused for is therefore checked in
// `governance-guards.ts` BEFORE the statement is sent, and the statement itself
// is `createManyAndReturn`, whose only remaining failure mode is a genuine
// infrastructure fault.
//
// `SafetyEvent_ancestry` IS THE ONE REFUSAL THAT CANNOT BE PRE-CHECKED. It is a
// database RULE, run BEFORE INSERT OR UPDATE, that resolves `agentId`,
// `endUserId`, `threadId` and `turnId` against the environment's own project —
// four joins this adapter would have to duplicate, racily, to anticipate. A
// foreign agent is refused by the database, mapped to a `Result` here, and the
// caller's transaction is aborted with it. That is reported rather than hidden:
// see `governance-constraints.integration.test.ts`.
//
// `endUserId` IS NEVER WRITTEN. `domain/safety-event.ts` explains why — the
// identifier a producer holds is its own external subject, not this column's
// foreign key — and the subject travels in the metadata envelope instead. The
// column is nonetheless CLEARED by `anonymizeSubject`, because a row written by
// the legacy source may carry one.

import type {
  AdmittedSafetyEvent,
  AgentDetectorCounts,
  AgentId,
  EnvironmentScope,
  Result,
  SafetyEvent,
  SafetyEventId,
  SafetyEventPage,
  SafetyEventQuery,
  SafetyLedger,
  SafetySubjectSelector,
  SafetyTally,
  TransactionScope,
} from "@platos/context-governance/application/ports/index.js";
import {
  asGovernanceIdentifier,
  err,
  INJECTION_DETECTORS,
  ledgerUnavailable,
  ok,
  PII_DETECTORS,
} from "@platos/context-governance/application/ports/index.js";

import { nullableJson } from "./client.js";
import { guardSafetyAppend } from "./governance-guards.js";
import { refuse } from "./governance-refusal.js";
import {
  readSafetyAction,
  readSafetyDetector,
  readSafetyEvent,
  readSafetySeverity,
  SAFETY_METADATA_MARKER,
  scopedWhere,
  tenantWhere,
  writeSafetyEnvelope,
  type SafetyEventRow,
} from "./governance-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** The columns every full read selects. One place, so no read is wider. */
const SAFETY_COLUMNS = {
  id: true,
  environmentId: true,
  agentId: true,
  threadId: true,
  turnId: true,
  endUserId: true,
  detector: true,
  action: true,
  severity: true,
  detail: true,
  metadata: true,
  toolName: true,
  toolCallId: true,
  createdAt: true,
} as const;

/**
 * Only rows whose metadata is an ENVELOPE this adapter wrote, carrying this
 * subject.
 *
 * BOTH clauses, in one statement. The marker matters on its own: a legacy row's
 * metadata is the producer's raw attribute bag, and a detector that emitted a
 * key called `principalId` would otherwise have its attribute read as the
 * ledger's subject — and then erased on somebody else's behalf.
 */
function subjectWhere(selector: SafetySubjectSelector, principalId: string): Record<string, unknown> {
  return {
    ...tenantWhere(selector.scope),
    AND: [
      { metadata: { path: [SAFETY_METADATA_MARKER], equals: 1 } },
      { metadata: { path: ["principalId"], equals: principalId } },
    ],
  };
}

export function createSafetyLedger(
  transactions: TenancyTransactions,
  now: () => Date,
): SafetyLedger {
  return {
    async append(
      scope: EnvironmentScope,
      event: AdmittedSafetyEvent,
      transaction: TransactionScope | null,
    ): Promise<Result<SafetyEvent>> {
      return refuse(async () => {
        guardSafetyAppend(event);
        // A null scope resolves through `reader()` rather than through the pool
        // directly, so an append issued INSIDE an open transaction still joins
        // it. `transaction.ts`'s header is the argument: a write that went to
        // the pool from inside a transaction would be a row the caller's own
        // rollback could not take back.
        const client = transaction === null ? transactions.reader() : transactions.writer(transaction);
        const written = await client.safetyEvent.createManyAndReturn({
          data: [
            {
              environmentId: scope.environmentId,
              agentId: event.agentId,
              threadId: event.threadId,
              turnId: event.turnId,
              detector: event.detector,
              action: event.action,
              severity: event.severity,
              detail: event.detail,
              metadata: writeSafetyEnvelope(event),
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              createdAt: now(),
            },
          ],
          select: SAFETY_COLUMNS,
        });
        const row = written[0];
        if (row === undefined) return err(ledgerUnavailable("safety append wrote no row"));
        return ok(readSafetyEvent(row as SafetyEventRow));
      }, "safety append");
    },

    async page(scope: EnvironmentScope, query: SafetyEventQuery): Promise<Result<SafetyEventPage>> {
      return refuse(async () => {
        const where = {
          ...scopedWhere(scope),
          createdAt: { gte: query.since },
          ...(query.detector === null ? {} : { detector: query.detector }),
          ...(query.severity === null ? {} : { severity: query.severity }),
          ...(query.agentId === null ? {} : { agentId: query.agentId }),
          ...(query.threadId === null ? {} : { threadId: query.threadId }),
          // Over the TOOL NAME and never over `detail`, which the port states in
          // as many words: `detail` is the one column that can hold whatever a
          // detector saw, and a substring search over it is a way to read it.
          ...(query.search === null
            ? {}
            : { toolName: { contains: query.search, mode: "insensitive" as const } }),
        };
        const reader = transactions.reader();
        // TWO statements, and the same two for one row or ten thousand. The
        // items and the total are read separately because a `findMany` cannot
        // report the count of rows it did not return; they are not a per-row
        // read, which is what `governance-statements.integration.test.ts` pins.
        const rows = await reader.safetyEvent.findMany({
          where,
          select: SAFETY_COLUMNS,
          // `id` breaks the tie, so the order is TOTAL. `createdAt` is
          // millisecond-precision and two events can share one; a paged listing
          // whose order is not total repeats rows on one page and drops them
          // from the next.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: query.offset,
          take: query.limit,
        });
        const total = await reader.safetyEvent.count({ where });
        return ok({ items: rows.map((row) => readSafetyEvent(row as SafetyEventRow)), total });
      }, "safety page");
    },

    async findById(
      scope: EnvironmentScope,
      safetyEventId: SafetyEventId,
    ): Promise<Result<SafetyEvent | null>> {
      return refuse(async () => {
        const row = await transactions.reader().safetyEvent.findFirst({
          where: { id: safetyEventId, ...scopedWhere(scope) },
          select: SAFETY_COLUMNS,
        });
        return ok(row === null ? null : readSafetyEvent(row as SafetyEventRow));
      }, "safety findById");
    },

    async tally(scope: EnvironmentScope, since: Date): Promise<Result<readonly SafetyTally[]>> {
      return refuse(async () => {
        // THREE columns, not the row. The rollup folds by detector, action and
        // severity and reads nothing else, and `detail` is the column that can
        // carry what a detector saw — a rollup has no business selecting it.
        const rows = await transactions.reader().safetyEvent.findMany({
          where: { ...scopedWhere(scope), createdAt: { gte: since } },
          select: { detector: true, action: true, severity: true },
        });
        return ok(
          rows.map((row) => ({
            detector: readSafetyDetector(row.detector),
            action: readSafetyAction(row.action),
            severity: readSafetySeverity(row.severity),
          })),
        );
      }, "safety tally");
    },

    async countByAgent(
      scope: EnvironmentScope,
      since: Date,
    ): Promise<Result<readonly AgentDetectorCounts[]>> {
      return refuse(async () => {
        // ONE grouped statement, not one read per agent. The two rates the risk
        // score divides by are both counts of rows in the window, so the
        // database counts them and this folds the two detector families the
        // context publishes rather than re-listing them here.
        const groups = await transactions.reader().safetyEvent.groupBy({
          by: ["agentId", "detector"],
          where: { ...scopedWhere(scope), createdAt: { gte: since }, agentId: { not: null } },
          _count: { _all: true },
        });
        const counts = new Map<string, { pii: number; injection: number }>();
        for (const group of groups) {
          const agentId = group.agentId;
          if (agentId === null) continue;
          const detector = readSafetyDetector(group.detector);
          const bucket = counts.get(agentId) ?? { pii: 0, injection: 0 };
          if (PII_DETECTORS.includes(detector)) bucket.pii += group._count._all;
          if (INJECTION_DETECTORS.includes(detector)) bucket.injection += group._count._all;
          counts.set(agentId, bucket);
        }
        return ok(
          [...counts.entries()].map(([agentId, bucket]) => ({
            agentId: asGovernanceIdentifier<AgentId>(agentId),
            piiEvents: bucket.pii,
            injectionEvents: bucket.injection,
          })),
        );
      }, "safety countByAgent");
    },

    async countSubject(selector: SafetySubjectSelector): Promise<Result<number>> {
      return refuse(async () => {
        // A NULL selector matches nothing, and the port says an implementation
        // MUST treat it that way rather than as "match everything". It is
        // answered without a statement, so a plan for an unknown subject cannot
        // count somebody else's rows even if the filter below were wrong.
        if (selector.principalId === null) return ok(0);
        const total = await transactions.reader().safetyEvent.count({
          where: subjectWhere(selector, selector.principalId),
        });
        return ok(total);
      }, "safety countSubject");
    },

    async anonymizeSubject(
      selector: SafetySubjectSelector,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuse(async () => {
        const client = transactions.writer(transaction);
        if (selector.principalId === null) return ok(0);
        // OVERWRITE, NEVER DELETE. `detector`, `action`, `severity` and
        // `createdAt` are untouched, so the compliance record of what the
        // control saw survives the erasure of who it was about. The metadata
        // column goes to SQL NULL rather than to the JSON scalar `null`, which
        // `SafetyEvent_metadata_json_root` refuses.
        const outcome = await client.safetyEvent.updateMany({
          where: subjectWhere(selector, selector.principalId),
          data: { detail: null, metadata: nullableJson(null), endUserId: null },
        });
        return ok(outcome.count);
      }, "safety anonymizeSubject");
    },
  };
}
