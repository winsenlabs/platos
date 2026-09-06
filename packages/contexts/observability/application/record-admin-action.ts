// Record one admin action.
//
// TWO ENTRY POINTS, AND THE DIFFERENCE IS WHO PAYS FOR A FAILURE.
//
//   `recordAdminAction` joins the CALLER'S transaction. The audit row commits
//   with the change it describes, or neither commits. Use it when the audit
//   trail must not be able to disagree with what actually happened — which is
//   every destructive admin action.
//
//   `recordAdminActionBestEffort` opens its own transaction and returns the
//   failure as a value rather than propagating it. Use it when the action has
//   ALREADY happened and cannot be undone. It never reports success it did not
//   have: a failed write comes back as an error the caller may log, and the
//   caller's own work is untouched because it was never in this transaction.
//
// THERE IS NO THIRD OPTION THAT SWALLOWS THE FAILURE. A `record()` that logs and
// returns void reads, at every call site, as "the audit row is written" — and a
// persistently failing audit write is a silent hole in exactly the record an
// investigation depends on. Both functions here make the failure visible in the
// return type, and the composition root decides what to do about it.

import { asIdentifier, err, ok, runResult, type Result, type TransactionScope } from "@platos/kernel";

import {
  buildAdminAuditRecord,
  resolveAuditLimit,
  type AdminActionRequest,
  type AdminAuditId,
  type AdminAuditQuery,
  type AdminAuditRecord,
} from "../domain/index.js";
import type { ObservabilityDependencies } from "./dependencies.js";

/** Mint the record and hand it to the repository inside a live transaction. */
export async function recordAdminAction(
  dependencies: ObservabilityDependencies,
  request: AdminActionRequest,
  transaction: TransactionScope,
): Promise<Result<AdminAuditRecord>> {
  const built = buildAdminAuditRecord(
    asIdentifier<AdminAuditId>(dependencies.ids.uuid()),
    request,
    dependencies.clock.now(),
  );
  if (!built.ok) return err(built.error);
  return dependencies.repository.recordAdminAudit(built.value, transaction);
}

/**
 * Record an action that has already happened, in a transaction of its own.
 *
 * The validation runs BEFORE the transaction is opened, so a malformed request
 * costs no database round trip and the caller learns it built a bad record
 * rather than that a write failed.
 */
export async function recordAdminActionBestEffort(
  dependencies: ObservabilityDependencies,
  request: AdminActionRequest,
): Promise<Result<AdminAuditRecord>> {
  const built = buildAdminAuditRecord(
    asIdentifier<AdminAuditId>(dependencies.ids.uuid()),
    request,
    dependencies.clock.now(),
  );
  if (!built.ok) return err(built.error);
  const written = await runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.repository.recordAdminAudit(built.value, transaction),
  );
  if (!written.ok) {
    dependencies.logger.log("error", "an admin action was not audited", {
      action: built.value.action,
      subjectType: built.value.subjectType,
      code: written.error.code,
    });
  }
  return written;
}

export interface ReadAdminTrailCommand {
  readonly query: Omit<AdminAuditQuery, "limit"> & { readonly limit?: number | null };
}

/**
 * Read a page of the trail.
 *
 * The limit is resolved HERE rather than defaulted in the repository: an
 * unbounded page over an audit table is the read that takes an operator surface
 * down, and a default that lives in an adapter is a default no test can see.
 */
export async function readAdminTrail(
  dependencies: ObservabilityDependencies,
  command: ReadAdminTrailCommand,
): Promise<Result<readonly AdminAuditRecord[]>> {
  const query: AdminAuditQuery = {
    ...command.query,
    limit: resolveAuditLimit(command.query.limit),
  };
  const found = await dependencies.repository.listAdminAudit(query);
  if (!found.ok) return err(found.error);
  return ok(found.value);
}
