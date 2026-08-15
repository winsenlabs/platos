/**
 * EOBD.66 — user-data admin surface for GDPR erasure + export.
 *
 * DELETE /api/v1/admin/users/:userId/data?organizationId=…&projectId=…&environmentId=…
 *   Cascades Platos rows for the user in the given scope. Admin-tier
 *   control-plane credential gated.
 *   Returns per-table delete counts. Audit rows (`PlatosAdminAudit`,
 *   `PlatosToolCallAudit`) are retained for forensics unless `purgeAudit=1`
 *   is passed explicitly.
 *
 * GET /api/v1/admin/users/:userId/data?organizationId=…&projectId=…&environmentId=…&dryRun=1
 *   Returns per-table row counts without deleting.
 *
 * Both call paths require `Authorization: Bearer plt_mcp_...` where the
 * credential is admin-tier and belongs to the requested organization.
 */
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  json,
} from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { verifyAdminControlPlaneCredential } from "~/services/controlPlaneCredential.server";

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
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
      { status: 400 },
    );
  }
  return { organizationId, projectId, environmentId };
}

function parseUserId(userId: string | undefined): string | Response {
  if (!userId || userId.length === 0) {
    return json({ error: "userId path param is required" }, { status: 400 });
  }
  // Reject suspicious values that could be interpreted as SQL fragments.
  // Prisma parameterization already protects us; this is a defence-in-depth.
  if (!/^[A-Za-z0-9_\-]{1,64}$/.test(userId)) {
    return json({ error: "userId contains invalid characters" }, { status: 400 });
  }
  return userId;
}

// ── Loader (GET) — dry-run count ─────────────────────────────────────
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userIdOrErr = parseUserId(params.userId);
  if (userIdOrErr instanceof Response) return userIdOrErr;
  const userId = userIdOrErr;

  const scopeOrErr = parseScope(new URL(request.url));
  if (scopeOrErr instanceof Response) return scopeOrErr;
  const scope = scopeOrErr;
  if (!(await verifyAdminControlPlaneCredential(request, scope.organizationId))) {
    return json({ error: "forbidden" }, { status: 401 });
  }

  const counts = await gatherCounts(prisma, scope, userId);
  return json({ userId, scope, counts, dryRun: true });
}

// ── Action (DELETE) — cascade ─────────────────────────────────────────
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }
  const userIdOrErr = parseUserId(params.userId);
  if (userIdOrErr instanceof Response) return userIdOrErr;
  const userId = userIdOrErr;

  const url = new URL(request.url);
  const scopeOrErr = parseScope(url);
  if (scopeOrErr instanceof Response) return scopeOrErr;
  const scope = scopeOrErr;
  if (!(await verifyAdminControlPlaneCredential(request, scope.organizationId))) {
    return json({ error: "forbidden" }, { status: 401 });
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
      { status: 409 },
    );
  }

  logger.warn(
    `[admin/users/data] delete user=${userId} scope=${scope.organizationId}/${scope.projectId}/${scope.environmentId} purgeAudit=${purgeAudit}`,
  );

  const deleted = await prisma.$transaction(async (tx) => {
    const where = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      userId,
    } as const;

    const relationships = await tx.platosMemoryRelationship.deleteMany({ where });
    const entities = await tx.platosMemoryEntity.deleteMany({ where });
    const memories = await tx.platosMemory.deleteMany({ where });
    // Theme M.4 — PlatosAgentUserProfile was dropped. Profile rows are
    // PlatosMemory rows (kind="profile") and already removed above.
    const ratings = await tx.platosMessageRating.deleteMany({ where });
    const attachments = await tx.platosMessageAttachment.deleteMany({ where });
    // Messages are per-thread; delete via thread FK.
    const threadRows = await tx.platosAgentThread.findMany({
      where,
      select: { id: true },
    });
    const threadIds = threadRows.map((t) => t.id);
    let messages = { count: 0 };
    if (threadIds.length > 0) {
      messages = await tx.platosAgentMessage.deleteMany({
        where: { threadId: { in: threadIds } },
      });
    }
    const threads = await tx.platosAgentThread.deleteMany({ where });

    let admin = { count: 0 };
    let toolAudits = { count: 0 };
    if (purgeAudit) {
      admin = await tx.platosAdminAudit.deleteMany({
        where: { ...where, actorUserId: userId } as any,
      });
      toolAudits = await tx.platosToolCallAudit.deleteMany({ where });
    }

    return {
      memoryRelationships: relationships.count,
      memoryEntities: entities.count,
      memories: memories.count,
      // Theme M.4 — `userProfiles` count retired; counted under `memories`.
      ratings: ratings.count,
      attachments: attachments.count,
      messages: messages.count,
      threads: threads.count,
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
  client: typeof prisma,
  scope: Scope,
  userId: string,
): Promise<Record<string, number>> {
  const where = { ...scope, userId };
  const [
    threads,
    memories,
    entities,
    relationships,
    ratings,
    attachments,
  ] = await Promise.all([
    client.platosAgentThread.count({ where }),
    client.platosMemory.count({ where }),
    client.platosMemoryEntity.count({ where }),
    client.platosMemoryRelationship.count({ where }),
    // Theme M.4 — PlatosAgentUserProfile was dropped; profile rows count
    // under `memories` (kind="profile").
    client.platosMessageRating.count({ where }),
    client.platosMessageAttachment.count({ where }),
  ]);

  const threadRows = await client.platosAgentThread.findMany({
    where,
    select: { id: true },
  });
  const messageCount =
    threadRows.length === 0
      ? 0
      : await client.platosAgentMessage.count({
          where: { threadId: { in: threadRows.map((t) => t.id) } },
        });

  return {
    threads,
    messages: messageCount,
    memories,
    memoryEntities: entities,
    memoryRelationships: relationships,
    // Theme M.4 — `userProfiles` count retired; folded into `memories`.
    ratings,
    attachments,
  };
}
