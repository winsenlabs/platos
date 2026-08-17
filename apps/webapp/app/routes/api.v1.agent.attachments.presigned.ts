/**
 * POST /api/v1/agent/attachments/presigned
 *
 * Mints a scope-gated presigned PUT URL for a new multimodal attachment.
 * The browser (or any session-authenticated caller) sends file metadata;
 * the webapp authorizes, persists a PlatosMessageAttachment row, then
 * returns a URL that uploads directly to MinIO.
 *
 * Raw MinIO credentials never cross this boundary — only the signed URL
 * does, and its TTL is short (default 15 minutes from env
 * PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS).
 *
 * Request body (JSON):
 *   {
 *     organizationId: string,
 *     projectId: string,
 *     environmentId: string,
 *     filename?: string,
 *     mimeType: string,
 *     bytes: number,
 *     kind?: "image" | "audio" | "video" | "document",
 *     width?: number,
 *     height?: number,
 *     durationSec?: number,
 *     contentHash?: string,
 *   }
 *
 * Response:
 *   {
 *     attachmentId: string,
 *     uploadUrl: string,
 *     method: "PUT",
 *     headers: { "Content-Type": string },
 *     expiresAt: string (ISO-8601),
 *     maxBytes: number,
 *   }
 */
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { createPresignedUpload } from "~/services/platosAttachments.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import {
  resolveAndVerifyScope,
  scopeErrorStatus,
} from "~/services/platos/scopeVerify.server";

// Callers may send raw IDs OR organization/project slugs with an Environment UUID.
// Raw IDs win when both present.
const PresignSchema = z
  .object({
    organizationId: z.string().optional(),
    projectId: z.string().optional(),
    environmentId: z.string().optional(),
    organizationSlug: z.string().optional(),
    projectSlug: z.string().optional(),
    filename: z.string().max(256).optional(),
    mimeType: z.string().min(1).max(128),
    bytes: z.number().int().positive(),
    kind: z.enum(["image", "audio", "video", "document"]).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationSec: z.number().int().nonnegative().optional(),
    contentHash: z.string().max(128).optional(),
  })
  .refine(
    (v) =>
      (v.organizationId && v.projectId && v.environmentId) ||
      (v.organizationSlug && v.projectSlug && v.environmentId),
    {
      message:
        "Must provide either (organizationId + projectId + environmentId) or (organizationSlug + projectSlug + environmentId)",
    }
  );

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const userId = await requireUserId(request);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PresignSchema.safeParse(payload);
  if (!parsed.success) {
    return json(
      { error: "Invalid request", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // EOBD.8 — access-check both paths through resolveAndVerifyScope.
  // Raw-id callers previously uploaded into another org's MinIO bucket
  // prefix simply by passing that org's IDs (victim org's quota hit).
  // Now the helper verifies OrgMember + project-org ownership +
  // env-project ownership before the upload URL mints.
  const verified = await resolveAndVerifyScope(
    {
      organizationId: parsed.data.organizationId,
      projectId: parsed.data.projectId,
      environmentId: parsed.data.environmentId,
      organizationSlug: parsed.data.organizationSlug,
      projectSlug: parsed.data.projectSlug,
    },
    userId,
  );
  if (!verified.ok) {
    return json({ error: verified.error.message }, { status: scopeErrorStatus(verified.error) });
  }
  const { organizationId, projectId, environmentId } = verified.scope;

  try {
    const result = await createPresignedUpload({
      scope: {
        organizationId,
        projectId,
        environmentId,
        userId,
      },
      filename: parsed.data.filename,
      mimeType: parsed.data.mimeType,
      bytes: parsed.data.bytes,
      kind: parsed.data.kind,
      width: parsed.data.width,
      height: parsed.data.height,
      durationSec: parsed.data.durationSec,
      contentHash: parsed.data.contentHash,
    });
    return json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload presign failed";
    logger.warn("Platos attachment presign failed", {
      userId,
      organizationId,
      projectId,
      environmentId,
      message,
    });
    return json({ error: message }, { status: 400 });
  }
}
