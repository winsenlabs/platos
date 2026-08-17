/**
 * GET /api/v1/agent/attachments/:attachmentId
 *
 * Returns a scope-gated presigned GET URL for an existing multimodal attachment.
 * Scope IDs must be passed either on the query string or resolved via parent slugs,
 * exactly like the presign upload endpoint. The lookup filters by
 * (organizationId, projectId, environmentId) — cross-scope requests 404 and
 * never leak the presigned URL.
 *
 * Query params (one set required):
 *   organizationId, projectId, environmentId
 *   — or —
 *   organizationSlug, projectSlug, environmentId
 *
 * Response:
 *   200  { attachmentId, downloadUrl, mimeType, kind, bytes, originalName, expiresAt }
 *   404  { error }
 *
 * DELETE /api/v1/agent/attachments/:attachmentId
 *
 * Hard-deletes the row + MinIO object. Same scope gate as GET. Returns
 * { deleted: true } on success, 404 if not visible in the caller's scope.
 */
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  json,
} from "@remix-run/server-runtime";
import {
  createPresignedDownload,
  deleteAttachment,
} from "~/services/platosAttachments.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import {
  resolveAndVerifyScope,
  scopeErrorStatus,
} from "~/services/platos/scopeVerify.server";

/**
 * EOBD.7 — every scope resolution goes through resolveAndVerifyScope
 * which checks OrgMember + project-org ownership + env-project
 * ownership before returning the tuple. The prior local `resolveScope`
 * accepted raw (organizationId, projectId, environmentId) verbatim,
 * enabling cross-tenant download + delete.
 */
async function resolveScope(
  url: URL,
  userId: string,
  access: "read" | "mutate",
): Promise<
  | { organizationId: string; projectId: string; environmentId: string; userId: string }
  | { error: string; status: number }
> {
  const verified = await resolveAndVerifyScope(
    {
      organizationId: url.searchParams.get("organizationId"),
      projectId: url.searchParams.get("projectId"),
      environmentId: url.searchParams.get("environmentId"),
      organizationSlug: url.searchParams.get("organizationSlug"),
      projectSlug: url.searchParams.get("projectSlug"),
    },
    userId,
    access,
  );
  if (!verified.ok) {
    return { error: verified.error.message, status: scopeErrorStatus(verified.error) };
  }
  return { ...verified.scope, userId };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const attachmentId = params.attachmentId;
  if (!attachmentId) {
    return json({ error: "Missing attachmentId" }, { status: 400 });
  }

  const url = new URL(request.url);
  const scope = await resolveScope(url, userId, "read");
  if ("error" in scope) {
    return json({ error: scope.error }, { status: scope.status });
  }

  const result = await createPresignedDownload(attachmentId, scope);
  if (!result) {
    // Fail-closed: cross-scope GETs look like a plain 404.
    return json({ error: "Attachment not found" }, { status: 404 });
  }
  return json(result);
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }
  const userId = await requireUserId(request);
  const attachmentId = params.attachmentId;
  if (!attachmentId) {
    return json({ error: "Missing attachmentId" }, { status: 400 });
  }

  const url = new URL(request.url);
  const scope = await resolveScope(url, userId, "mutate");
  if ("error" in scope) {
    return json({ error: scope.error }, { status: scope.status });
  }

  try {
    const deleted = await deleteAttachment(attachmentId, scope);
    if (!deleted) {
      return json({ error: "Attachment not found" }, { status: 404 });
    }
    return json({ deleted: true, attachmentId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed";
    logger.warn("Platos attachment delete failed", {
      userId,
      attachmentId,
      message,
    });
    return json({ error: message }, { status: 500 });
  }
}
