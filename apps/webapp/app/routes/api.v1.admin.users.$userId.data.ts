/**
 * EOBD.66 — user-data admin surface for GDPR erasure + export.
 *
 * DELETE /api/v1/admin/users/:userId/data?organizationId=…&projectId=…&environmentId=…
 *   Cascades clean Platos rows for the canonical EndUser UUID in the given
 *   scope. Admin-tier control-plane credential gated.
 *   Returns per-model delete counts. Normalized conversation evidence remains
 *   Thread → Turn → Step → ToolCall until the transaction deletes its owning
 *   Thread. Audit rows (`AdminAudit`, `ToolCallAudit`) are retained for
 *   forensics unless `purgeAudit=1`
 *   is passed explicitly.
 *
 * GET /api/v1/admin/users/:userId/data?organizationId=…&projectId=…&environmentId=…&dryRun=1
 *   Returns per-table row counts without deleting.
 *
 * Both call paths require `Authorization: Bearer plt_mcp_...` where the
 * credential is admin-tier and belongs to the requested organization.
 */
import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import { verifyAdminControlPlaneCredential } from "~/services/controlPlaneCredential.server";

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DataCounts = {
  threads: number;
  turns: number;
  steps: number;
  toolCalls: number;
  memories: number;
  memoryEntities: number;
  memoryRelationships: number;
  ratings: number;
  attachments: number;
  adminAudits: number;
  toolCallAudits: number;
};

const EMPTY_COUNTS: DataCounts = {
  threads: 0,
  turns: 0,
  steps: 0,
  toolCalls: 0,
  memories: 0,
  memoryEntities: 0,
  memoryRelationships: 0,
  ratings: 0,
  attachments: 0,
  adminAudits: 0,
  toolCallAudits: 0,
};

function parseScope(url: URL): Scope | Response {
  const organizationId = url.searchParams.get("organizationId");
  const projectId = url.searchParams.get("projectId");
  const environmentId = url.searchParams.get("environmentId");
  if (!organizationId || !projectId || !environmentId) {
    return json(
      {
        error: "Missing required query params",
        required: ["organizationId", "projectId", "environmentId"],
      },
      { status: 400 }
    );
  }
  return { organizationId, projectId, environmentId };
}

function parseEndUserId(userId: string | undefined): string | Response {
  if (!userId || userId.length === 0) {
    return json({ error: "userId path param is required" }, { status: 400 });
  }
  if (!UUID_PATTERN.test(userId)) {
    return json(
      {
        error: "invalid_end_user_id",
        message: "userId must be a canonical EndUser UUID",
      },
      { status: 400 }
    );
  }
  return userId;
}

async function scopeExists(client: PrismaClientOrTransaction, scope: Scope): Promise<boolean> {
  return (
    (await client.environment.findFirst({
      where: {
        id: scope.environmentId,
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
      select: { id: true },
    })) !== null
  );
}

async function resolveEndUserId(
  client: PrismaClientOrTransaction,
  scope: Scope,
  endUserId: string
): Promise<string | null> {
  const endUser = await client.endUser.findFirst({
    where: { id: endUserId, organizationId: scope.organizationId },
    select: { id: true },
  });
  return endUser?.id ?? null;
}

// ── Loader (GET) — dry-run count ─────────────────────────────────────
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userIdOrErr = parseEndUserId(params.userId);
  if (userIdOrErr instanceof Response) return userIdOrErr;
  const userId = userIdOrErr;

  const scopeOrErr = parseScope(new URL(request.url));
  if (scopeOrErr instanceof Response) return scopeOrErr;
  const scope = scopeOrErr;
  if (!(await verifyAdminControlPlaneCredential(request, scope.organizationId))) {
    return json({ error: "forbidden" }, { status: 401 });
  }
  if (!(await scopeExists(prisma, scope))) {
    return json({ error: "scope_not_found" }, { status: 404 });
  }

  const counts = await gatherCounts(prisma, scope, userId);
  return json({ userId, scope, counts, dryRun: true });
}

// ── Action (DELETE) — cascade ─────────────────────────────────────────
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }
  const userIdOrErr = parseEndUserId(params.userId);
  if (userIdOrErr instanceof Response) return userIdOrErr;
  const userId = userIdOrErr;

  const url = new URL(request.url);
  const scopeOrErr = parseScope(url);
  if (scopeOrErr instanceof Response) return scopeOrErr;
  const scope = scopeOrErr;
  if (!(await verifyAdminControlPlaneCredential(request, scope.organizationId))) {
    return json({ error: "forbidden" }, { status: 401 });
  }
  if (!(await scopeExists(prisma, scope))) {
    return json({ error: "scope_not_found" }, { status: 404 });
  }

  const purgeAudit = url.searchParams.get("purgeAudit") === "1";

  // Legal-hold guard — operator ensures high-stakes users can't be
  // accidentally deleted during an active hold.
  const holdList = (env.PLATOS_LEGAL_HOLD_USER_IDS || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  if (holdList.includes(userId)) {
    return json(
      {
        error: "legal_hold_active",
        message: `user ${userId} is on PLATOS_LEGAL_HOLD_USER_IDS; refuse delete`,
      },
      { status: 409 }
    );
  }

  logger.warn(
    `[admin/users/data] delete user=${userId} scope=${scope.organizationId}/${scope.projectId}/${scope.environmentId} purgeAudit=${purgeAudit}`
  );

  const deleted = await prisma.$transaction(async (tx) => {
    const endUserId = await resolveEndUserId(tx, scope, userId);
    if (!endUserId) return { ...EMPTY_COUNTS, adminAudits: null, toolCallAudits: null };

    const counts = await gatherCountsForEndUser(tx, scope, endUserId);
    const where = { environmentId: scope.environmentId, endUserId } as const;

    await tx.memoryRelationship.deleteMany({ where });
    await tx.memoryEntity.deleteMany({ where });
    await tx.memory.deleteMany({ where });
    // Profile rows are Memory rows (kind="profile") and are removed above.
    await tx.messageRating.deleteMany({ where });
    await tx.messageAttachment.deleteMany({ where });

    // Do not flatten or selectively rewrite normalized conversation history.
    // The schema-owned cascade removes each Thread's Turn → Step → ToolCall
    // graph atomically, retaining the hierarchy until this delete commits.
    await tx.thread.deleteMany({ where });

    let admin = { count: 0 };
    let toolAudits = { count: 0 };
    if (purgeAudit) {
      admin = await tx.adminAudit.deleteMany({
        where: {
          environmentId: scope.environmentId,
          subjectId: endUserId,
        },
      });
      toolAudits = await tx.toolCallAudit.deleteMany({ where });
    }

    return {
      ...counts,
      adminAudits: purgeAudit ? admin.count : null,
      toolCallAudits: purgeAudit ? toolAudits.count : null,
    };
  });

  return json({
    userId,
    scope,
    deleted,
    purgeAudit,
    notes: [
      "MinIO attachment bytes are swept asynchronously by platos.attachments.retention.",
      "ClickHouse spans retain the userId label — scrub via the SQL in docs/gdpr.md.",
      purgeAudit
        ? "Audit rows purged."
        : "Audit rows retained for forensics. Pass purgeAudit=1 to force.",
    ],
  });
}

async function gatherCounts(
  client: PrismaClientOrTransaction,
  scope: Scope,
  userId: string
): Promise<DataCounts> {
  const endUserId = await resolveEndUserId(client, scope, userId);
  return endUserId ? gatherCountsForEndUser(client, scope, endUserId) : { ...EMPTY_COUNTS };
}

async function gatherCountsForEndUser(
  client: PrismaClientOrTransaction,
  scope: Scope,
  endUserId: string
): Promise<DataCounts> {
  const where = { environmentId: scope.environmentId, endUserId } as const;
  const threadWhere = {
    environmentId: scope.environmentId,
    endUserId,
  } as const;
  const [
    threads,
    turns,
    steps,
    toolCalls,
    memories,
    entities,
    relationships,
    ratings,
    attachments,
    adminAudits,
    toolCallAudits,
  ] = await Promise.all([
    client.thread.count({ where: threadWhere }),
    client.turn.count({ where: { thread: threadWhere } }),
    client.step.count({ where: { turn: { thread: threadWhere } } }),
    client.toolCall.count({ where: { step: { turn: { thread: threadWhere } } } }),
    client.memory.count({ where }),
    client.memoryEntity.count({ where }),
    client.memoryRelationship.count({ where }),
    client.messageRating.count({ where }),
    client.messageAttachment.count({ where }),
    client.adminAudit.count({
      where: {
        environmentId: scope.environmentId,
        subjectId: endUserId,
      },
    }),
    client.toolCallAudit.count({ where }),
  ]);

  return {
    threads,
    turns,
    steps,
    toolCalls,
    memories,
    memoryEntities: entities,
    memoryRelationships: relationships,
    ratings,
    attachments,
    adminAudits,
    toolCallAudits,
  };
}
