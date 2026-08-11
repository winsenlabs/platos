import { Injectable, Logger } from "@nestjs/common";
import { S3Client, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

/**
 * Minimal object-store client for erasure.
 *
 * Deliberately its own client rather than reusing AttachmentsService: that
 * service has no delete or existence methods, and pulling AgentRuntimeModule
 * into PrivacyModule to reach it would drag the entire agent runtime into a
 * module whose only job is destroying data on an admin request. The privacy
 * module stays narrow; the cost is ~30 lines of duplicated client config.
 *
 * The two operations exist as a pair on purpose. Deleting without a subsequent
 * existence probe cannot support the claim an erasure receipt makes: S3-compatible
 * delete is idempotent and returns success for a key that was never there, so a
 * successful delete is not evidence the bytes are gone. Only the HEAD is.
 */
@Injectable()
export class ErasureObjectStore {
  private readonly logger = new Logger(ErasureObjectStore.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;

  constructor() {
    const endpoint = process.env.MINIO_ENDPOINT;
    const accessKeyId = process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER;
    const secretAccessKey = process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD;
    this.bucket = process.env.MINIO_BUCKET || "platos-media";

    if (!endpoint || !accessKeyId || !secretAccessKey) {
      // Absent config must surface as not_provisioned upstream, never as a
      // silently successful no-op erasure.
      this.client = null;
      this.logger.warn("[erasure] object store not configured; object deletion unavailable");
      return;
    }
    this.client = new S3Client({
      endpoint,
      region: process.env.MINIO_REGION || "us-east-1",
      forcePathStyle: true,
      // Matches AttachmentsService: SDK >=3.726 defaults integrity checksums on,
      // which MinIO rejects. See minio/minio#20845.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  get available(): boolean {
    return this.client !== null;
  }

  async deleteObject(key: string): Promise<void> {
    if (!this.client) throw new Error("object store not configured");
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * True when the object is still present.
   *
   * A 404/NotFound means absent, which is the outcome erasure wants. Any OTHER
   * error is reported as STILL PRESENT: an ambiguous probe must not be rounded
   * down to "gone", because that is the direction that produces a false
   * certificate of deletion.
   */
  async objectExists(key: string): Promise<boolean> {
    if (!this.client) throw new Error("object store not configured");
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err: any) {
      const status = err?.$metadata?.httpStatusCode;
      const name = err?.name;
      if (status === 404 || name === "NotFound" || name === "NoSuchKey") return false;
      this.logger.warn(`[erasure] existence probe inconclusive (${name ?? status}); treating as present`);
      return true;
    }
  }
}
