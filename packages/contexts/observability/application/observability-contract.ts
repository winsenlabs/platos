// The composition of this context's use cases into its published contract.
//
// Thin on purpose. Every rule lives in `domain/`, every orchestration in a named
// use-case module, and this file is the adapter between the command shapes the
// contract publishes and the ones the use cases take. It holds one rule of its
// own — the single-environment check on a directly supplied Turn — and only
// because there is no other path into `projectTurn`; the queued path gets the
// same guarantee structurally, by inheriting one scope from the envelope.

import { err, ok, resolvePath, type ErasureTarget, type Result } from "@platos/kernel";

import type {
  AdminAuditView,
  DrainProjectionsRequest,
  DrainReportView,
  ObservabilityContract,
  ObservabilityStatusView,
  ReadAdminTrailRequest,
  RecordAdminActionRequest,
  TurnProjectionView,
} from "../contracts/index.js";
import {
  firstScopeDisagreement,
  projectionScopeMismatch,
  projectTurnWork,
  type TurnWork,
} from "../domain/index.js";
import type { ObservabilityDependencies } from "./dependencies.js";
import { describeObservability } from "./describe-observability.js";
import { drainProjections } from "./drain-projections.js";
import { createObservabilityErasureTarget } from "./observability-erasure-target.js";
import { readAdminTrail, recordAdminActionBestEffort } from "./record-admin-action.js";
import { toAdminAuditView, toDrainReportView, toTurnProjectionView } from "./views.js";

async function projectTurn(work: TurnWork): Promise<Result<TurnProjectionView>> {
  const disagreement = firstScopeDisagreement(work);
  if (disagreement !== null) {
    return err(
      projectionScopeMismatch(
        disagreement.part,
        resolvePath(work.turn.scope),
        resolvePath(disagreement.scope),
      ),
    );
  }
  return ok(toTurnProjectionView(projectTurnWork(work)));
}

async function drain(
  dependencies: ObservabilityDependencies,
  request: DrainProjectionsRequest | undefined,
): Promise<Result<DrainReportView>> {
  const drained = await drainProjections(dependencies, { budget: request?.budget });
  if (!drained.ok) return err(drained.error);
  return ok(toDrainReportView(drained.value));
}

async function describeStatus(
  dependencies: ObservabilityDependencies,
): Promise<Result<ObservabilityStatusView>> {
  const described = await describeObservability(dependencies);
  if (!described.ok) return err(described.error);
  return ok(described.value);
}

async function recordAdminAction(
  dependencies: ObservabilityDependencies,
  request: RecordAdminActionRequest,
): Promise<Result<AdminAuditView>> {
  const recorded = await recordAdminActionBestEffort(dependencies, request);
  if (!recorded.ok) return err(recorded.error);
  return ok(toAdminAuditView(recorded.value));
}

async function readTrail(
  dependencies: ObservabilityDependencies,
  request: ReadAdminTrailRequest,
): Promise<Result<readonly AdminAuditView[]>> {
  const found = await readAdminTrail(dependencies, { query: request });
  if (!found.ok) return err(found.error);
  return ok(found.value.map(toAdminAuditView));
}

/** Build the context. The composition root calls this once, at boot. */
export function createObservabilityContract(
  dependencies: ObservabilityDependencies,
): ObservabilityContract {
  const erasure: ErasureTarget = createObservabilityErasureTarget(dependencies);
  return {
    name: "observability",
    projectTurn: (work) => projectTurn(work),
    drainProjections: (request) => drain(dependencies, request),
    describeStatus: () => describeStatus(dependencies),
    recordAdminAction: (request) => recordAdminAction(dependencies, request),
    readAdminTrail: (request) => readTrail(dependencies, request),
    erasureTarget: () => erasure,
  };
}
