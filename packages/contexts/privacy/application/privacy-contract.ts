// The composition of this context's use cases into its published contract.
//
// Thin on purpose. Every rule lives in `domain/`, every orchestration in a named
// use-case module, and this file is the adapter between the command shapes the
// contract publishes and the ones the use cases take. It holds no rule of its
// own, which is what keeps it from becoming the god-service ADR M0.3 §6 exists
// to prevent.

import { err, ok, type Result } from "@platos/kernel";

import { operationNotFound, operationStoreUnavailable, projectOperation } from "../domain/index.js";
import type {
  AliasHash,
  DescribeOperationQuery,
  ErasureOperationView,
  InventorySubjectQuery,
  PrivacyContract,
  PurgeTombstonesCommand,
  RequestErasureCommand,
  RetryErasureCommand,
  SubjectInventoryView,
  SubjectWriteCheck,
} from "../contracts/index.js";
import type { PrivacyDependencies } from "./dependencies.js";
import { assertSubjectNotErased, erasedAliases } from "./guard-subject-write.js";
import { inventorySubject } from "./inventory-subject.js";
import { purgeExpiredTombstones } from "./seal-subject.js";
import { recordPass } from "./record-pass.js";
import { requestErasure } from "./request-erasure.js";
import { retryErasure } from "./retry-erasure.js";
import { toErasureOperationView } from "./views.js";

async function describeOperation(
  dependencies: PrivacyDependencies,
  query: DescribeOperationQuery,
): Promise<Result<ErasureOperationView>> {
  const found = await dependencies.repository.findOperation(query.organizationId, query.operationId);
  if (!found.ok) return err(operationStoreUnavailable(found.error.code));
  if (found.value === null) return err(operationNotFound(query.operationId));
  return ok(
    toErasureOperationView(projectOperation(found.value, dependencies.policy.erasure.requiredTargets)),
  );
}

/** Build the context. The composition root calls this once, at boot. */
export function createPrivacyContract(dependencies: PrivacyDependencies): PrivacyContract {
  return {
    name: "privacy",
    requestErasure: async (command: RequestErasureCommand) => {
      const requested = await requestErasure(dependencies, command);
      return requested.ok ? ok(toErasureOperationView(requested.value)) : err(requested.error);
    },
    retryErasure: async (command: RetryErasureCommand) => {
      const retried = await retryErasure(dependencies, command);
      return retried.ok ? ok(toErasureOperationView(retried.value)) : err(retried.error);
    },
    describeOperation: (query: DescribeOperationQuery) => describeOperation(dependencies, query),
    inventorySubject: (query: InventorySubjectQuery): Promise<Result<SubjectInventoryView>> =>
      inventorySubject(dependencies, query),
    assertSubjectNotErased: (check: SubjectWriteCheck) => assertSubjectNotErased(dependencies, check),
    erasedAliases: (check: SubjectWriteCheck): Promise<Result<readonly AliasHash[]>> =>
      erasedAliases(dependencies, check),
    purgeExpiredTombstones: (_command: PurgeTombstonesCommand) => purgeExpiredTombstones(dependencies),
  };
}

// Re-exported so the composition root can drive a queue pass without reaching
// into a use-case module: `listDueOperations` finds the work, `retryErasure`
// does it, and `recordPass` is what a bespoke driver would need if it ever ran
// targets itself. Nothing here widens the contract.
export { recordPass };
