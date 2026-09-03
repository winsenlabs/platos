// Admitting one execution request.
//
// A faithful port of `parseJobExecutionRequest`. This is the gate an untrusted
// body passes through before anything else in this context sees it, and its
// defining property is that it is CLOSED: an exact key set, not a minimum one.
//
// WHY EXACT KEYS. `exactKeys(input, REQUEST_KEYS)` refuses a body carrying any
// property the shape does not declare, at both the top level and inside `scope`.
// An allow-list that merely ignores extras lets a caller smuggle a field that a
// later version starts honouring, and turns adding a field into a silent
// behaviour change for bodies already in flight.
//
// THE INVOKER/AGENT COUPLING IS BIDIRECTIONAL, which is easy to misread as one
// rule. The live conditions are three:
//
//     agentId present and malformed                    -> refuse
//     invokedBy === "agent" and agentId absent          -> refuse
//     invokedBy !== "agent" and agentId PRESENT         -> refuse
//
// The third is the one an extraction tends to drop. Without it a `manual`
// dispatch may carry an `agentId`, which is then ignored by authorization —
// producing a request that reads as agent-attributed in a log and was never
// checked against the job's allow-list.

import { asIdentifier, err, ok, type JsonValue, type Result } from "@platos/kernel";

import { invalidRequest } from "./errors.js";
import type { AgentId, ExecutionRequestId, JobId } from "./identifiers.js";
import { isClaimedInvoker, type ClaimedInvoker } from "./invocation.js";
import {
  isAdmissibleJson,
  isPlainObject,
  withinSizeCap,
  type PayloadLimits,
  PAYLOAD_LIMITS,
} from "./payload.js";

/** The complete top-level key set. Anything else is a refusal. */
export const REQUEST_KEYS: ReadonlySet<string> = new Set([
  "requestId",
  "jobId",
  "payload",
  "scope",
  "invokedBy",
  "agentId",
]);

/** The complete `scope` key set. */
export const SCOPE_KEYS: ReadonlySet<string> = new Set([
  "organizationId",
  "projectId",
  "environmentId",
  "userId",
]);

/**
 * The shape every identifier on this request must take: an alphanumeric first
 * character then up to 127 more of alphanumerics, dot, underscore, colon or
 * hyphen. Deliberately broader than a uuid — the live system passes both uuids
 * and prefixed token ids through this path — and deliberately anchored.
 */
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ExecutionScopeClaim {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly userId: string | null;
}

export interface ExecutionRequest {
  readonly requestId: ExecutionRequestId;
  readonly jobId: JobId;
  readonly payload: JsonValue;
  readonly scope: ExecutionScopeClaim;
  readonly invokedBy: ClaimedInvoker;
  readonly agentId: AgentId | null;
}

function hasOnly(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value) ? value : null;
}

function parseScope(input: unknown): ExecutionScopeClaim | null {
  if (!isPlainObject(input) || !hasOnly(input, SCOPE_KEYS)) return null;
  const organizationId = identifier(input["organizationId"]);
  const projectId = identifier(input["projectId"]);
  const environmentId = identifier(input["environmentId"]);
  if (organizationId === null || projectId === null || environmentId === null) return null;

  const rawUserId = input["userId"];
  if (rawUserId !== undefined && identifier(rawUserId) === null) return null;
  return {
    organizationId,
    projectId,
    environmentId,
    userId: typeof rawUserId === "string" ? rawUserId : null,
  };
}

/** The three-part invoker/agent coupling described in the header. */
function parseAgent(invokedBy: ClaimedInvoker, raw: unknown): Result<AgentId | null> {
  if (raw !== undefined && identifier(raw) === null) {
    return err(invalidRequest("agentId is not a well-formed identifier"));
  }
  const present = typeof raw === "string";
  if (invokedBy === "agent" && !present) {
    return err(invalidRequest("an agent dispatch must carry an agentId"));
  }
  if (invokedBy !== "agent" && present) {
    return err(invalidRequest("only an agent dispatch may carry an agentId"));
  }
  return ok(present ? asIdentifier<AgentId>(raw) : null);
}

/**
 * Admit an untrusted body.
 *
 * `knownSecrets` are values the composition root already knows are secret; a
 * payload quoting one is refused. The live caller supplies the internal auth
 * token and the database URL.
 */
export function admitExecutionRequest(
  input: unknown,
  knownSecrets: readonly string[],
  limits: PayloadLimits = PAYLOAD_LIMITS,
): Result<ExecutionRequest> {
  if (!isPlainObject(input) || !hasOnly(input, REQUEST_KEYS)) {
    return err(invalidRequest("request carries a key the shape does not declare"));
  }

  const requestId = identifier(input["requestId"]);
  if (requestId === null) return err(invalidRequest("requestId is not a well-formed identifier"));
  const jobId = identifier(input["jobId"]);
  if (jobId === null) return err(invalidRequest("jobId is not a well-formed identifier"));

  const scope = parseScope(input["scope"]);
  if (scope === null) return err(invalidRequest("scope is missing or not well-formed"));

  const rawInvoker = input["invokedBy"];
  if (typeof rawInvoker !== "string" || !isClaimedInvoker(rawInvoker)) {
    return err(invalidRequest("invokedBy is not a recognised invoker"));
  }

  const agent = parseAgent(rawInvoker, input["agentId"]);
  if (!agent.ok) return err(agent.error);

  const payload = input["payload"] ?? {};
  if (!isPlainObject(payload)) return err(invalidRequest("payload must be an object"));
  if (!isAdmissibleJson(payload, knownSecrets, limits)) {
    return err(invalidRequest("payload is not admissible"));
  }
  if (!withinSizeCap(payload as JsonValue, limits)) {
    return err(invalidRequest(`payload exceeds ${limits.maxJsonBytes} bytes`));
  }

  return ok({
    requestId: asIdentifier<ExecutionRequestId>(requestId),
    jobId: asIdentifier<JobId>(jobId),
    payload: payload as JsonValue,
    scope,
    invokedBy: rawInvoker,
    agentId: agent.value,
  });
}

/**
 * The value a request is digested over.
 *
 * `agentId` is included ONLY when present, matching the live
 * `...(request.agentId ? { agentId } : {})`. Including it as an explicit `null`
 * would give a manual dispatch a different digest than the live system computes,
 * and every in-flight idempotency record would read as a conflict at cutover.
 */
export function digestSubject(request: ExecutionRequest): JsonValue {
  return {
    requestId: request.requestId,
    jobId: request.jobId,
    payload: request.payload,
    scope: {
      organizationId: request.scope.organizationId,
      projectId: request.scope.projectId,
      environmentId: request.scope.environmentId,
      ...(request.scope.userId === null ? {} : { userId: request.scope.userId }),
    },
    invokedBy: request.invokedBy,
    ...(request.agentId === null ? {} : { agentId: request.agentId }),
  };
}
