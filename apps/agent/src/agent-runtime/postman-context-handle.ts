import type Redis from "ioredis";
import type { RequestScope } from "../auth/scope.guard";

export const POSTMAN_CONTEXT_TTL_SECONDS = 15 * 60;
const POSTMAN_CONTEXT_PREFIX = "postman:context:";

interface PostmanContextEnvelope {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
  actorUserId: string;
  idempotencyKey: string;
  context: Record<string, unknown>;
}

export function postmanContextRedisKey(handle: string): string {
  return `${POSTMAN_CONTEXT_PREFIX}${handle}`;
}

export async function storePostmanContext(
  redis: Redis,
  input: Omit<PostmanContextEnvelope, "context"> & {
    handle: string;
    context: Record<string, unknown>;
  },
): Promise<void> {
  const stored = await redis.set(
    postmanContextRedisKey(input.handle),
    JSON.stringify({
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      userId: input.userId,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      context: input.context,
    } satisfies PostmanContextEnvelope),
    "EX",
    POSTMAN_CONTEXT_TTL_SECONDS,
    "NX",
  );
  if (stored !== "OK") throw new Error("Postman context handle collision");
}

export async function resolvePostmanContext(
  redis: Redis,
  handle: string,
  scope: Pick<
    RequestScope,
    "organizationId" | "projectId" | "environmentId" | "userId" | "operatorUserId"
  >,
  idempotencyKey: string | undefined,
): Promise<Record<string, unknown>> {
  if (!idempotencyKey) throw new Error("Postman context request binding is missing");
  const raw = await redis.get(postmanContextRedisKey(handle));
  if (!raw) throw new Error("Postman context handle expired or unavailable");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Postman context handle is malformed");
  }
  const envelope = parsed as Partial<PostmanContextEnvelope>;
  if (
    envelope.organizationId !== scope.organizationId ||
    envelope.projectId !== scope.projectId ||
    envelope.environmentId !== scope.environmentId ||
    envelope.userId !== scope.userId ||
    envelope.actorUserId !== scope.operatorUserId ||
    envelope.idempotencyKey !== idempotencyKey ||
    !envelope.context ||
    typeof envelope.context !== "object" ||
    Array.isArray(envelope.context)
  ) {
    throw new Error("Postman context handle does not match this request");
  }
  return envelope.context;
}

export function traceSessionContext(
  scope: Pick<RequestScope, "sessionContext" | "sessionContextHandle">,
): { user?: { name?: string; email?: string } } | null | undefined {
  if (scope.sessionContextHandle) return undefined;
  return scope.sessionContext as { user?: { name?: string; email?: string } } | null | undefined;
}
