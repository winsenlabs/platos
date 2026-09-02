// Use case: execute one tool call.
//
// The whole context in one sequence:
//
//   route      which of this scope's exposures does this name mean?
//   permit     what do the four tiers say about calling it?
//   resolve    what is the concrete, substituted, residual-free target?
//   dispatch   make the call.
//   record     fold the outcome into health; append the audit row.
//
// The source spreads this across a 1,644-line method with eleven early returns,
// each of which measures its own latency and most of which record their own
// audit row. Here every path converges on `finish`, so a refusal at the
// permission tier and a timeout at the backend are recorded the same way — and
// a future sixth outcome cannot be added without going through it.
//
// AN AUDIT FAILURE NEVER FAILS THE CALL, AND THAT DECISION IS WRITTEN DOWN
// HERE RATHER THAN IN THE ADAPTER. The source swallows it inside
// `ToolAuditService.record` with a comment; the port returns a `Result` and
// this file is the one place that discards it. The reason is that the model has
// already received the result by the time the row is written, so failing the
// call would report a failure for work that was done — but that is a POLICY,
// and a policy hidden in an adapter is one nobody can find to change.
//
// A REFUSED CALL IS STILL AUDITED. A permission block, an ambiguous route and a
// missing end user all produce an audit row with a `FAILED` status, because
// "what did this token try to do" is the question the audit trail exists to
// answer and the calls that were stopped are the interesting ones.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";
import type { EnvironmentAuthorization } from "@platos/context-secrets";

import {
  approvalRequired,
  asToolsIdentifier,
  auditLatency,
  auditStatusFor,
  applyOutcome,
  dispatchFailed,
  dispatchRateLimited,
  EMPTY_AUDIT_ENVELOPE,
  freshHealth,
  injectContext,
  permissionBlocked,
  resolveRoute,
  type AgentId,
  type AuditEnvelope,
  type AuditEntry,
  type DisambiguationStrategy,
  type EndUserId,
  type ExternalEntityId,
  type HealthOutcome,
  type PermissionState,
  type ThreadId,
  type ToolCallAuditId,
  type ToolExposure,
  type ToolHealthId,
  type ToolName,
  type TokenTier,
} from "../domain/index.js";
import type { ToolsDependencies } from "./dependencies.js";
import type { DispatchOutcome } from "./ports/index.js";
import { resolvePermission } from "./resolve-permission.js";
import { resolveDispatchTarget, subjectOf } from "./resolve-transport.js";

export interface ExecuteToolCommand {
  readonly scope: EnvironmentScope;
  readonly toolName: ToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly agentId: AgentId | null;
  readonly threadId: ThreadId | null;
  readonly endUserId: EndUserId | null;
  readonly externalEntityIds?: readonly ExternalEntityId[];
  readonly strategy?: DisambiguationStrategy;
  readonly sessionOverrides?: Readonly<Record<string, PermissionState>> | null;
  readonly tokenTier?: TokenTier;
  readonly traceId?: string | null;
  readonly envelope?: AuditEnvelope;
  readonly vaultAuthorization: EnvironmentAuthorization;
  /**
   * May this caller park on an approval?
   *
   * ADR M0.3 §7 decision 9's qualification: an existing synchronous API keeps
   * its observable result/error semantics. A caller that cannot park gets a
   * terminal `TOOLS_APPROVAL_REQUIRED` error; one that can gets the pending
   * decision back and waits. Neither gets an accepted-and-detached
   * acknowledgement, which is the shape the qualification rules out.
   */
  readonly canPark?: boolean;
}

export type ExecutedTool =
  | { readonly kind: "completed"; readonly result: unknown; readonly latencyMs: number; readonly auditId: ToolCallAuditId | null }
  | { readonly kind: "awaiting_approval"; readonly tier: number; readonly reason: string };

export async function executeTool(
  dependencies: ToolsDependencies,
  command: ExecuteToolCommand,
): Promise<Result<ExecutedTool>> {
  const startedAt = dependencies.clock.now();

  const exposures = await dependencies.repository.listExposures(command.scope);
  if (!exposures.ok) return err(exposures.error);

  const routed = resolveRoute(exposures.value, {
    toolName: command.toolName,
    externalEntityIds: command.externalEntityIds,
    agentId: command.agentId,
    callableOnly: true,
    strategy: command.strategy,
  });
  if (!routed.ok) {
    await recordRefusal(dependencies, command, null, routed.error.message, startedAt);
    return err(routed.error);
  }
  const exposure = routed.value.exposure;

  const permitted = await resolvePermission(dependencies, {
    scope: command.scope,
    toolName: command.toolName,
    agentId: command.agentId,
    toolId: exposure.toolId,
    sessionOverrides: command.sessionOverrides,
    tokenTier: command.tokenTier,
  });
  if (!permitted.ok) return err(permitted.error);

  if (permitted.value.state === "block") {
    const refusal = permissionBlocked(command.toolName, permitted.value.tier, permitted.value.reason);
    await recordRefusal(dependencies, command, exposure, refusal.message, startedAt);
    return err(refusal);
  }
  if (permitted.value.state === "require_approval") {
    if (command.canPark !== true) {
      return err(approvalRequired(command.toolName, permitted.value.tier));
    }
    return ok({
      kind: "awaiting_approval",
      tier: permitted.value.tier,
      reason: permitted.value.reason,
    });
  }

  const target = await resolveDispatchTarget(dependencies, {
    scope: command.scope,
    subject: subjectOf(exposure),
    endUserId: command.endUserId,
    vaultAuthorization: command.vaultAuthorization,
  });
  if (!target.ok) {
    await recordRefusal(dependencies, command, exposure, target.error.message, startedAt);
    return err(target.error);
  }

  // The context envelope is merged LAST, after every gate, so a tool that was
  // going to be refused never has an end-user identity written into its
  // arguments — and therefore never into the audit row that records the refusal.
  const callArguments = exposure.injectMcpContext
    ? injectContext(command.arguments, {
        environmentId: command.scope.environmentId,
        entityId: exposure.externalEntityId,
        endUserId: command.endUserId,
      })
    : command.arguments;

  const dispatched = await dependencies.dispatch.dispatch({
    target: target.value,
    toolName: command.toolName,
    arguments: callArguments,
    callId: dependencies.ids.uuid(),
  });
  if (!dispatched.ok) {
    await finish(dependencies, command, exposure, "failed", 0, null, dispatched.error.message, startedAt);
    return err(dispatched.error);
  }

  return settle(dependencies, command, exposure, dispatched.value, callArguments, startedAt);
}

async function settle(
  dependencies: ToolsDependencies,
  command: ExecuteToolCommand,
  exposure: ToolExposure,
  outcome: DispatchOutcome,
  callArguments: Readonly<Record<string, unknown>>,
  startedAt: Date,
): Promise<Result<ExecutedTool>> {
  if (outcome.kind === "succeeded") {
    const auditId = await finish(
      dependencies,
      command,
      exposure,
      "success",
      outcome.latencyMs,
      outcome.result,
      null,
      startedAt,
      callArguments,
    );
    return ok({ kind: "completed", result: outcome.result, latencyMs: outcome.latencyMs, auditId });
  }

  if (outcome.kind === "rateLimited") {
    // A 429 is health-neutral. The backend answered, and answering is what the
    // health counters measure; counting it as a failure would take a tool that
    // is merely busy across the consecutive-failure threshold and report it
    // broken to an operator who cannot fix it.
    await finish(
      dependencies,
      command,
      exposure,
      "failed",
      outcome.latencyMs,
      null,
      "rate limited by the entity backend",
      startedAt,
      callArguments,
      { skipHealth: true },
    );
    return err(dispatchRateLimited(command.toolName, outcome.retryAfterSeconds));
  }

  const reason = outcome.kind === "timeout" ? "the backend did not answer in time" : outcome.reason;
  await finish(
    dependencies,
    command,
    exposure,
    outcome.kind === "timeout" ? "timeout" : "failed",
    outcome.latencyMs,
    null,
    reason,
    startedAt,
    callArguments,
  );
  return err(
    dispatchFailed(reason, outcome.kind === "timeout" ? dependencies.policy.dispatch.defaultRetryAfterSeconds : null),
  );
}

/** A refusal that never reached a backend: audited, health untouched. */
async function recordRefusal(
  dependencies: ToolsDependencies,
  command: ExecuteToolCommand,
  exposure: ToolExposure | null,
  reason: string,
  startedAt: Date,
): Promise<void> {
  await finish(dependencies, command, exposure, "failed", 0, null, reason, startedAt, command.arguments, {
    skipHealth: true,
  });
}

/**
 * The one exit. Every path — success, refusal, timeout, rate limit, transport
 * defect — ends here, so the audit row and the health fold cannot diverge by
 * being written in eleven places.
 */
async function finish(
  dependencies: ToolsDependencies,
  command: ExecuteToolCommand,
  exposure: ToolExposure | null,
  outcome: HealthOutcome,
  latencyMs: number,
  result: unknown,
  error: string | null,
  startedAt: Date,
  callArguments: Readonly<Record<string, unknown>> = command.arguments,
  options: { readonly skipHealth?: boolean } = {},
): Promise<ToolCallAuditId | null> {
  const at = dependencies.clock.now();
  const measured = latencyMs > 0 ? latencyMs : at.getTime() - startedAt.getTime();

  if (exposure !== null && options.skipHealth !== true) {
    await foldHealth(dependencies, command.scope, exposure, outcome, measured, at);
  }

  const entry: AuditEntry = {
    toolCallAuditId: asToolsIdentifier<ToolCallAuditId>(dependencies.ids.uuid()),
    environmentId: command.scope.environmentId,
    toolId: exposure?.toolId ?? null,
    toolName: command.toolName,
    agentId: command.agentId,
    threadId: command.threadId,
    endUserId: command.endUserId,
    traceId: command.traceId ?? null,
    arguments: callArguments,
    result,
    error,
    status: auditStatusFor(outcome),
    latencyMs: auditLatency(measured),
    costCents: null,
    envelope: {
      ...(command.envelope ?? EMPTY_AUDIT_ENVELOPE),
      externalEntityId: exposure?.externalEntityId ?? command.envelope?.externalEntityId ?? null,
      endUserId: command.endUserId,
    },
    createdAt: at,
  };

  const appended = await dependencies.repository.appendAudit(command.scope, entry);
  // Deliberately discarded. See the header note: the caller already has its
  // answer, and failing here would report a failure for work that was done.
  return appended.ok ? appended.value.toolCallAuditId : null;
}

async function foldHealth(
  dependencies: ToolsDependencies,
  scope: EnvironmentScope,
  exposure: ToolExposure,
  outcome: HealthOutcome,
  latencyMs: number,
  at: Date,
): Promise<void> {
  const existing = await dependencies.repository.findHealth(
    scope,
    exposure.toolId,
    exposure.externalEntityId,
  );
  if (!existing.ok) return;
  const base =
    existing.value ??
    freshHealth(
      asToolsIdentifier<ToolHealthId>(dependencies.ids.uuid()),
      scope.environmentId,
      exposure.toolId,
      exposure.externalEntityId,
      at,
    );
  await dependencies.repository.saveHealth(scope, applyOutcome(base, outcome, latencyMs, at));
}
