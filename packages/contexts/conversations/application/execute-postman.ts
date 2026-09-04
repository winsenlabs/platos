// Launching an agent as an operator, on a simulated end user's behalf.
//
// THE ONE PLACE IN THIS CONTEXT WHERE AN OPERATOR GRANT AND A RUNTIME GRANT
// MEET. Both are required and neither substitutes for the other: the operator
// grant proves the human is entitled to run agents in this environment, and the
// runtime grant is what the turn itself is executed under and what
// `providers.runModelGeneration` demands. A design that derived one from the
// other would let an operator's read grant buy provider credentials.
//
// THE REPLAY BRANCH IS THE INTERESTING ONE, AND IT IS TWO DECISIONS.
// `@@unique([templateId, requestId])` refuses a second row; what it cannot do is
// tell a retry from a caller reusing an id. So the request is fingerprinted:
//
//   same id, same fingerprint -> the EXISTING execution, no second turn, no
//                                error. A caller retrying a timed-out request
//                                gets what it asked for.
//   same id, different one    -> refused, its own code. Answering the first
//                                execution here hands this caller a result
//                                computed from a different request.
//
// AN AD-HOC REQUEST HAS NO TEMPLATE, AND THE CONSTRAINT IS THEN VACUOUS.
// `templateId` is nullable and the unique index is on the PAIR, so a null
// template does not de-duplicate. `postman-repository.ts` says so and this use
// case does not pretend otherwise: an ad-hoc launch always creates.
//
// THE HANDLE IS A CAPABILITY WITH A DEADLINE AND IT IS CHECKED. `contextHandle`
// is `@unique` and `contextExpiresAt` sits beside it; the source writes both and
// checks neither, so a handle minted a month ago still names its execution.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  openPostmanExecution,
  postmanNotFound,
  reconcileReplay,
  requireLiveHandle,
  settlePostmanExecution,
  type ActorId,
  type AgentId,
  type EndUserId,
  type PostmanContextHandle,
  type PostmanExecution,
  type PostmanExecutionId,
  type PostmanTemplateId,
  type ThreadId,
  type TurnId,
} from "../domain/index.js";
import { verifyOperator, verifyRuntime, type SecretsRuntimeGrant } from "./authorization.js";
import type { ConversationsDependencies } from "./dependencies.js";

export interface LaunchPostmanCommand {
  readonly authorization: unknown;
  readonly runtimeAuthorization: SecretsRuntimeGrant;
  readonly scope: EnvironmentScope;
  readonly agentId: AgentId;
  readonly templateId?: PostmanTemplateId | null;
  readonly requestId: string;
  /** A digest of the request body, computed by the transport. Compared, not stored twice. */
  readonly requestFingerprint: string;
  readonly actorUserId: ActorId;
  readonly simulatedEndUserId?: EndUserId | null;
  readonly contextHandle: PostmanContextHandle;
  /** How long the handle stays usable, in milliseconds from now. */
  readonly handleLifetimeMs: number;
}

export interface LaunchedPostman {
  readonly execution: PostmanExecution;
  /** True when this call answered an execution a previous one had already made. */
  readonly replayed: boolean;
}

export async function launchPostmanExecution(
  dependencies: ConversationsDependencies,
  command: LaunchPostmanCommand,
): Promise<Result<LaunchedPostman>> {
  const operator = verifyOperator(dependencies, command.authorization, command.scope);
  if (!operator.ok) return err(operator.error);
  const runtime = verifyRuntime(command.runtimeAuthorization, command.scope);
  if (!runtime.ok) return err(runtime.error);

  const template = command.templateId ?? null;
  if (template !== null) {
    const existing = await dependencies.postman.findByRequest(
      command.scope,
      template,
      command.requestId,
    );
    if (!existing.ok) return err(existing.error);
    if (existing.value !== null) {
      const reconciled = reconcileReplay(existing.value, command.requestFingerprint);
      if (!reconciled.ok) return err(reconciled.error);
      return ok({ execution: reconciled.value, replayed: true });
    }
  }

  const at = dependencies.clock.now();
  const execution = openPostmanExecution({
    executionId: dependencies.ids.uuid() as unknown as PostmanExecutionId,
    agentId: command.agentId,
    templateId: template,
    requestId: command.requestId,
    requestFingerprint: command.requestFingerprint,
    actorUserId: command.actorUserId,
    simulatedEndUserId: command.simulatedEndUserId ?? null,
    contextHandle: command.contextHandle,
    contextExpiresAt: new Date(at.getTime() + command.handleLifetimeMs),
    at,
  });

  const created = await dependencies.postman.createExecution(command.scope, execution);
  if (!created.ok) return err(created.error);
  return ok({ execution: created.value, replayed: false });
}

export interface SettlePostmanCommand {
  readonly authorization: unknown;
  readonly scope: EnvironmentScope;
  readonly contextHandle: PostmanContextHandle;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly succeeded: boolean;
}

/**
 * Bind an execution to the turn it produced, and close it.
 *
 * THREE GUARDS IN ORDER, three codes: the handle must name an execution here
 * (`not_found`, concealing a foreign environment's row), the handle must not
 * have expired (`precondition_failed`), and the execution must not already be
 * settled (`conflict`). Reordering the first two would let an expired handle
 * reveal that some execution exists.
 */
export async function settleExecution(
  dependencies: ConversationsDependencies,
  command: SettlePostmanCommand,
): Promise<Result<PostmanExecution>> {
  const operator = verifyOperator(dependencies, command.authorization, command.scope);
  if (!operator.ok) return err(operator.error);

  const found = await dependencies.postman.findByHandle(command.scope, command.contextHandle);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(postmanNotFound(command.contextHandle));

  const live = requireLiveHandle(found.value, dependencies.clock.now());
  if (!live.ok) return err(live.error);

  const settled = settlePostmanExecution(live.value, {
    status: command.succeeded ? "SUCCEEDED" : "FAILED",
    threadId: command.threadId,
    turnId: command.turnId,
    at: dependencies.clock.now(),
  });
  if (!settled.ok) return err(settled.error);

  return dependencies.unitOfWork.run(async (transaction) => {
    const saved = await dependencies.postman.saveExecution(command.scope, settled.value);
    if (!saved.ok) return err(saved.error);
    await dependencies.outbox.append(
      {
        name: "conversations.postman.executed",
        schemaVersion: 1,
        scope: command.scope,
        requestId: null,
        payload: {
          executionId: saved.value.executionId,
          agentId: saved.value.agentId,
          actorUserId: saved.value.actorUserId,
          threadId: saved.value.threadId,
          turnId: saved.value.turnId,
          status: saved.value.status,
        },
      },
      transaction,
    );
    return ok(saved.value);
  });
}

export interface DescribePostmanQuery {
  readonly authorization: unknown;
  readonly scope: EnvironmentScope;
  readonly executionId: PostmanExecutionId;
}

export async function describeExecution(
  dependencies: ConversationsDependencies,
  query: DescribePostmanQuery,
): Promise<Result<PostmanExecution>> {
  const operator = verifyOperator(dependencies, query.authorization, query.scope);
  if (!operator.ok) return err(operator.error);
  const found = await dependencies.postman.findExecution(query.scope, query.executionId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(postmanNotFound(query.executionId));
  return ok(found.value);
}
