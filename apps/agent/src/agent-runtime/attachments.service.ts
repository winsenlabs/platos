import { Injectable, Inject, Logger } from "@nestjs/common";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import type { FilePart, ImagePart } from "ai";
import {
  type ControlDatabaseClient,
  environmentScopeWhere,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { env } from "../shared/env";

/**
 * Vercel AI SDK multimodal content shape. A user message can be either a
 * plain string OR an array of parts mixing text + images + files. We
 * produce that array from a stored user message + its attachment rows.
 */
export type MultimodalPart = { type: "text"; text: string } | ImagePart | FilePart;

export interface ResolvedAttachment {
  id: string;
  kind: "image" | "audio" | "video" | "document";
  mimeType: string;
  bytes: number;
  /** Raw bytes pulled from MinIO — buffered in memory (MVP). */
  data: Uint8Array;
  originalName: string | null;
}

export type AttachmentKind = "image" | "audio" | "video" | "document";

export class AttachmentUploadError extends Error {
  constructor(
    readonly code:
      | "ATTACHMENT_INVALID"
      | "ATTACHMENT_TOO_LARGE"
      | "ATTACHMENT_QUOTA_EXCEEDED"
      | "ATTACHMENT_STORAGE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentUploadError";
  }
}

export type PresignedAttachmentUpload = {
  attachmentId: string;
  uploadUrl: string;
  method: "PUT";
  headers: { "Content-Type": string };
  expiresAt: string;
  maxBytes: number;
  attachment: {
    id: string;
    kind: AttachmentKind;
    mimeType: string;
    bytes: number;
    originalName: string | null;
    createdAt: string;
  };
};

type AttachmentAccessScope = Pick<
  RequestScope,
  "organizationId" | "projectId" | "environmentId"
> &
  Partial<Pick<RequestScope, "userId" | "sessionId">>;

export type AttachmentBindingBoundary = {
  agentId: string;
  threadId: string;
  endUserId: string;
};

/**
 * AttachmentsService — agent-side resolver for multimodal attachments.
 *
 * Theme D flow:
 *   1. Browser uploads to MinIO via webapp's presigned PUT (D.3).
 *   2. Browser calls POST /threads/:threadId/messages or WS `message`
 *      with `attachmentIds`.
 *   3. On the receive side (agent), this service:
 *      - resolves the authenticated thread to its canonical clean EndUser
 *      - validates that each id belongs to that EndUser in the caller's Environment
 *      - pulls bytes from MinIO via the in-container endpoint
 *      - bumps the row's `messageId` + `expiresAt` (attaches it)
 *      - returns ai-SDK ImagePart / FilePart objects
 *   4. AgentService merges those parts with the user message string and
 *      passes a multimodal content array to streamText.
 *
 * Cross-scope isolation: every DB lookup is scoped through canonical
 * Environment ancestry and the authenticated thread's EndUser. If either
 * boundary doesn't match, the lookup returns null and we throw before any
 * object bytes are fetched.
 */
/**
 * EOBD.37 — per-attachment and per-turn size caps. Reject pre-fetch so a
 * 100MB PDF never materialises in agent heap memory. The resolver fetches
 * bytes into a Uint8Array buffer; without a cap, 10×100MB = 1GB heap
 * spike is a trivial OOM.
 */
export class AttachmentSizeExceeded extends Error {
  readonly kind: "per-attachment" | "per-turn";
  readonly limitBytes: number;
  readonly actualBytes: number;
  constructor(kind: "per-attachment" | "per-turn", limitBytes: number, actualBytes: number) {
    super(
      kind === "per-attachment"
        ? `attachment too large: ${actualBytes}B exceeds per-attachment cap of ${limitBytes}B`
        : `total attachment bytes this turn (${actualBytes}B) exceed per-turn cap of ${limitBytes}B`,
    );
    this.name = "AttachmentSizeExceeded";
    this.kind = kind;
    this.limitBytes = limitBytes;
    this.actualBytes = actualBytes;
  }
}


@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  private readonly client: S3Client;
  private readonly publicClient: S3Client | null;
  private readonly bucket: string;
  private readonly ttlDays: number;
  // EOBD.37 — defaults: 20MB per-attachment / 80MB per-turn total.
  private readonly maxAttachmentBytes: number;
  private readonly maxTurnTotalBytes: number;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
  ) {
    const endpoint = env.MINIO_ENDPOINT || "http://minio:9000";
    // PIFSP-15: Log the effective endpoint at boot so misconfigurations
    // (e.g. public https endpoint accidentally set as internal endpoint)
    // are visible in container logs immediately rather than surfacing
    // as mysterious "attachment not resolved" failures mid-turn.
    const accessKeyId = env.MINIO_ACCESS_KEY || "platos-minio-admin";
    const secretAccessKey =
      env.MINIO_SECRET_KEY || "platos-minio-password";

    // EOBD.56 — refuse to boot in production against the sentinel dev
    // credentials. Mirror of the webapp's env.server.ts guard. If the
    // DB ports also get exposed (EOBD.51 unfixed in a bad deployment)
    // an attacker with the sentinel creds would own the bucket.
    if (env.NODE_ENV === "production") {
      if (
        accessKeyId === "platos-minio-admin" ||
        secretAccessKey === "platos-minio-password"
      ) {
        throw new Error(
          "Refusing to start: MinIO credentials are the default sentinel values " +
            "(platos-minio-admin / platos-minio-password) and NODE_ENV=production. " +
            "Set MINIO_ROOT_USER and MINIO_ROOT_PASSWORD in your .env before exposing externally. " +
            "See docs/self-hosting.md for rotation guidance.",
        );
      }
    }

    const region = env.MINIO_REGION || "us-east-1";
    this.bucket = env.MINIO_BUCKET || "platos-media";
    this.ttlDays = env.PLATOS_ATTACHMENT_TTL_DAYS ?? 30;
    this.maxAttachmentBytes = env.PLATOS_MAX_ATTACHMENT_BYTES ?? 20 * 1024 * 1024;
    this.maxTurnTotalBytes = env.PLATOS_MAX_TURN_ATTACHMENT_TOTAL_BYTES ?? 80 * 1024 * 1024;

    this.client = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      // AWS SDK v3 ≥3.726.0 defaults integrity checksums on which break
      // presigned PUT signatures against MinIO + S3-compat backends. Disable
      // for compatibility. https://github.com/minio/minio/issues/20845
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: { accessKeyId, secretAccessKey },
    });
    this.publicClient = env.MINIO_PUBLIC_ENDPOINT
      ? new S3Client({
          endpoint: env.MINIO_PUBLIC_ENDPOINT,
          region,
          forcePathStyle: true,
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED",
          credentials: { accessKeyId, secretAccessKey },
        })
      : null;
    // PIFSP-15: boot-time log so operators can confirm internal vs public endpoint.
    // If MINIO_ENDPOINT is accidentally set to the https public URL the agent's
    // S3Client will fail on every attachment fetch with a TLS/path error.
    // Expected value: "http://minio:9000" (internal docker network).
    this.logger.log(`[attachments] S3 endpoint=${endpoint} bucket=${this.bucket}`);
  }

  async createPresignedUpload(input: {
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;
    endUserId: string;
    agentId: string;
    threadId: string;
    filename?: string;
    mimeType: string;
    bytes: number;
    kind?: AttachmentKind;
  }): Promise<PresignedAttachmentUpload> {
    const mimeType = input.mimeType.trim().toLowerCase();
    const originalName = input.filename?.trim() || null;
    const maxBytes = env.PLATOS_MAX_ATTACHMENT_BYTES ?? 20 * 1024 * 1024;
    if (
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType)
      || mimeType.length > 128
      || (originalName?.length ?? 0) > 256
      || !Number.isSafeInteger(input.bytes)
      || input.bytes <= 0
    ) {
      throw new AttachmentUploadError("ATTACHMENT_INVALID", "Attachment metadata is invalid");
    }
    if (input.bytes > maxBytes) {
      throw new AttachmentUploadError("ATTACHMENT_TOO_LARGE", `Attachment must be at most ${maxBytes} bytes`);
    }
    if (!this.publicClient) {
      throw new AttachmentUploadError("ATTACHMENT_STORAGE_UNAVAILABLE", "Attachment upload is unavailable");
    }

    const kind = input.kind ?? this.classifyMimeType(mimeType);
    const quotaBytes = env.PLATOS_ATTACHMENT_ORG_QUOTA_BYTES ?? 10 * 1024 * 1024 * 1024;
    const usage = await this.prisma.messageAttachment.aggregate({
      where: {
        environment: {
          project: {
            organizationId: input.scope.organizationId,
          },
        },
      },
      _sum: { bytes: true },
    });
    if ((usage._sum.bytes ?? 0) + input.bytes > quotaBytes) {
      throw new AttachmentUploadError("ATTACHMENT_QUOTA_EXCEEDED", "Organization attachment quota exceeded");
    }

    const id = randomUUID();
    const filename = this.sanitizeFilename(originalName ?? undefined);
    const storageKey = `${input.scope.organizationId}/${input.scope.projectId}/${input.scope.environmentId}/${id}/${filename}`;
    const expiresAt = new Date(Date.now() + (env.PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS ?? 900) * 1000);
    const row = await this.prisma.messageAttachment.create({
      data: {
        id,
        environmentId: input.scope.environmentId,
        endUserId: input.endUserId,
        agentId: input.agentId,
        threadId: input.threadId,
        kind,
        mimeType,
        bytes: input.bytes,
        storageKey,
        originalName,
        expiresAt: new Date(Date.now() + (env.PLATOS_ATTACHMENT_GRACE_DAYS ?? 7) * 86_400_000),
      },
      select: {
        id: true,
        kind: true,
        mimeType: true,
        bytes: true,
        originalName: true,
        createdAt: true,
      },
    });

    try {
      const uploadUrl = await getSignedUrl(
        this.publicClient,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
          ContentType: mimeType,
          ContentLength: input.bytes,
        }),
        { expiresIn: env.PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS ?? 900 },
      );
      const readBack = await this.prisma.messageAttachment.findFirst({
        where: {
          id: row.id,
          endUserId: input.endUserId,
          agentId: input.agentId,
          threadId: input.threadId,
          environmentId: input.scope.environmentId,
          environment: { project: { id: input.scope.projectId, organizationId: input.scope.organizationId } },
        },
        select: { id: true },
      });
      if (!readBack) throw new Error("attachment read-back failed");
      return {
        attachmentId: row.id,
        uploadUrl,
        method: "PUT",
        headers: { "Content-Type": mimeType },
        expiresAt: expiresAt.toISOString(),
        maxBytes,
        attachment: {
          id: row.id,
          kind: row.kind as AttachmentKind,
          mimeType: row.mimeType,
          bytes: row.bytes,
          originalName: row.originalName,
          createdAt: row.createdAt.toISOString(),
        },
      };
    } catch {
      await this.prisma.messageAttachment.deleteMany({
        where: {
          id: row.id,
          environmentId: input.scope.environmentId,
          endUserId: input.endUserId,
          agentId: input.agentId,
          threadId: input.threadId,
          turnId: null,
        },
      });
      throw new AttachmentUploadError("ATTACHMENT_STORAGE_UNAVAILABLE", "Attachment upload is unavailable");
    }
  }

  private classifyMimeType(mimeType: string): AttachmentKind {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.startsWith("video/")) return "video";
    return "document";
  }

  private sanitizeFilename(value: string | undefined): string {
    const normalized = value?.trim().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    return normalized || "file";
  }

  /**
   * Resolve a list of attachment ids into fetched bytes. Validates scope +
   * fails closed on any attachment the caller can't see.
   */
  async resolveAttachments(
    attachmentIds: string[],
    scope: AttachmentAccessScope,
    boundary: AttachmentBindingBoundary,
  ): Promise<ResolvedAttachment[]> {
    if (!attachmentIds || attachmentIds.length === 0) return [];
    const uniqueAttachmentIds = [...new Set(attachmentIds)];

    const rows = await this.prisma.messageAttachment.findMany({
      where: {
        id: { in: uniqueAttachmentIds },
        endUserId: boundary.endUserId,
        agentId: boundary.agentId,
        threadId: boundary.threadId,
        ...environmentScopeWhere(scope),
      },
    });

    // Any id the caller passed that didn't come back is out-of-scope; refuse
    // quietly (log) rather than silently drop — the agent needs to know.
    if (rows.length !== uniqueAttachmentIds.length) {
      const foundIds = new Set(rows.map((row) => row.id));
      const missing = uniqueAttachmentIds.filter((id) => !foundIds.has(id));
      throw new Error(
        `Attachment(s) not accessible in scope: ${missing.join(", ")}`,
      );
    }

    // EOBD.37 — validate size caps BEFORE any network fetch. `bytes` is
    // recorded at upload time (webapp presigned-PUT flow), so we can
    // reject oversized attachments without pulling a byte. Prevents a
    // 100MB attachment from blowing the agent heap.
    let turnTotal = 0;
    for (const row of rows as Array<{ id: string; bytes: number }>) {
      if (row.bytes > this.maxAttachmentBytes) {
        throw new AttachmentSizeExceeded("per-attachment", this.maxAttachmentBytes, row.bytes);
      }
      turnTotal += row.bytes;
    }
    if (turnTotal > this.maxTurnTotalBytes) {
      throw new AttachmentSizeExceeded("per-turn", this.maxTurnTotalBytes, turnTotal);
    }

    const resolved: ResolvedAttachment[] = [];
    for (const row of rows as Array<{
      id: string;
      kind: string;
      mimeType: string;
      bytes: number;
      storageKey: string;
      originalName: string | null;
    }>) {
      // PIFSP-15: structured debug log at each fetch step so attachment
      // drops are visible in logs without requiring a debugger.
      this.logger.log(
        `[attachments] fetching id=${row.id} kind=${row.kind} mime=${row.mimeType} bytes=${row.bytes} key=${row.storageKey}`,
      );
      let data: Uint8Array;
      try {
        data = await this.fetchObjectBytes(row.storageKey);
      } catch (fetchErr: unknown) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        this.logger.error(`[attachments] fetch FAILED id=${row.id} key=${row.storageKey}: ${msg}`);
        throw new Error(`Failed to fetch attachment ${row.id} from storage: ${msg}`);
      }
      this.logger.log(`[attachments] fetched id=${row.id} actualBytes=${data.byteLength}`);
      resolved.push({
        id: row.id,
        kind: row.kind as ResolvedAttachment["kind"],
        mimeType: row.mimeType,
        bytes: row.bytes,
        data,
        originalName: row.originalName,
      });
    }
    return resolved;
  }

  /**
   * Mark rows as attached to a stored message. Pushes expiresAt out to the
   * full TTL so the retention task doesn't garbage-collect mid-conversation.
   */
  async markAttachedToMessage(
    attachmentIds: string[],
    turnId: string,
    scope: AttachmentAccessScope,
    boundary: AttachmentBindingBoundary,
  ): Promise<void> {
    if (!attachmentIds || attachmentIds.length === 0) return;
    const uniqueAttachmentIds = [...new Set(attachmentIds)];
    const newExpiresAt = new Date(
      Date.now() + this.ttlDays * 24 * 60 * 60 * 1000,
    );
    await this.prisma.$transaction(async (tx) => {
      const targetTurn = await tx.turn.findFirst({
        where: {
          id: turnId,
          threadId: boundary.threadId,
          thread: {
            agentId: boundary.agentId,
            endUserId: boundary.endUserId,
            environmentId: scope.environmentId,
            environment: {
              projectId: scope.projectId,
              project: { organizationId: scope.organizationId },
            },
          },
        },
        select: { id: true },
      });
      if (!targetTurn) throw new Error("Target turn is not accessible to the attachment owner");

      const attachmentWhere = {
        id: { in: uniqueAttachmentIds },
        endUserId: boundary.endUserId,
        agentId: boundary.agentId,
        threadId: boundary.threadId,
        ...environmentScopeWhere(scope),
      };
      const accessibleAttachments = await tx.messageAttachment.findMany({
        where: { ...attachmentWhere, OR: [{ turnId: null }, { turnId }] },
        select: { id: true },
      });
      if (accessibleAttachments.length !== uniqueAttachmentIds.length) {
        throw new Error("Attachment binding does not match its pending Agent and Thread boundary");
      }

      await tx.messageAttachment.updateMany({
        where: { ...attachmentWhere, turnId: null },
        data: { turnId, expiresAt: newExpiresAt },
      });
      const readBack = await tx.messageAttachment.count({
        where: { ...attachmentWhere, turnId },
      });
      if (readBack !== uniqueAttachmentIds.length) {
        throw new Error("Attachment ownership changed before binding completed");
      }
    });
  }

  /**
   * Build Vercel AI SDK multimodal content parts from a text prompt and a
   * list of resolved attachments.
   *
   * `ImagePart` accepts a URL or Buffer. `FilePart` (for PDFs, audio, etc.)
   * also accepts Buffer + mimeType. Providers that don't support the part
   * type will reject at generate-time — D.6 handles that via the adapter
   * fallback path.
   */
  static toMultimodalContent(
    text: string,
    attachments: ResolvedAttachment[],
  ): string | MultimodalPart[] {
    if (!attachments || attachments.length === 0) return text;
    const parts: MultimodalPart[] = [];
    for (const a of attachments) {
      if (a.kind === "image") {
        parts.push({
          type: "image",
          image: a.data,
          // AI SDK v6 — `mimeType` renamed to `mediaType` on image/file parts.
          mediaType: a.mimeType,
        } as ImagePart);
      } else {
        // audio/video/document go through FilePart. Many providers still
        // reject these — D.6's adapter catches provider-level refusals.
        parts.push({
          type: "file",
          data: a.data,
          mediaType: a.mimeType,
        } as FilePart);
      }
    }
    if (text && text.length > 0) {
      parts.push({ type: "text", text });
    }
    return parts;
  }

  /** PIFSP-16 — generate a 5-minute presigned GET URL for an attachment. */
  async getPresignedDownloadUrl(storageKey: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      { expiresIn: 300 },
    );
  }

  private async fetchObjectBytes(storageKey: string): Promise<Uint8Array> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
    );
    const body = res.Body as AsyncIterable<Uint8Array | Buffer> | undefined;
    if (!body) {
      throw new Error(`MinIO object body missing for key ${storageKey}`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Uint8Array.from(Buffer.concat(chunks));
  }
}
