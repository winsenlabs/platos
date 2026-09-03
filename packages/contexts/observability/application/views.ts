// Domain values, as the published contract sees them.
//
// One direction only: domain in, view out. Nothing here parses, validates or
// decides — those live in `domain/`, and a view that decided anything would be a
// second place the same rule could be got wrong.
//
// The views are deliberately close to the domain records rather than a
// re-shaping of them. Every difference is one a consumer needs: a `DrainReport`
// loses nothing, and an `AdminAuditRecord` loses nothing either, because the
// audit trail's whole value is that it is complete.

import type {
  AdminAuditRecord,
  DrainReport,
  ProjectionRows,
} from "../domain/index.js";
import { populatedTables, projectionRowCount } from "../domain/index.js";
import type { AdminAuditView, DrainReportView, TurnProjectionView } from "../contracts/index.js";

export function toAdminAuditView(record: AdminAuditRecord): AdminAuditView {
  return {
    adminAuditId: record.adminAuditId,
    scope: record.scope,
    actorUserId: record.actorUserId,
    action: record.action,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    before: record.before,
    after: record.after,
    reason: record.reason,
    source: record.source,
    recordedAt: record.recordedAt,
  };
}

export function toDrainReportView(report: DrainReport): DrainReportView {
  return {
    claimed: report.claimed,
    delivered: report.delivered,
    retried: report.retried,
    parked: report.parked,
    ignored: report.ignored,
    discarded: report.discarded,
    pruned: report.pruned,
    passes: report.passes,
    depth: report.depth,
    stoppedBecause: report.stoppedBecause,
  };
}

export function toTurnProjectionView(rows: ProjectionRows): TurnProjectionView {
  return {
    rows,
    rowCount: projectionRowCount(rows),
    tables: populatedTables(rows),
  };
}
