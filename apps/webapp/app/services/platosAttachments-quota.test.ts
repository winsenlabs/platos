/**
 * PPR-41 — Per-org quota + max-bytes + TOCTOU race test.
 *
 * Exercises `createPresignedUpload` + the internal `insertWithQuotaGate`.
 * PPR-19 replaced the "aggregate bytes, compare to quota, then insert"
 * sequence with an atomic SERIALIZABLE transaction. This test pair exists
 * so a future regression of that fix is caught immediately.
 *
 * Test cases:
 *   1. Single upload under quota → succeeds, bytes accounted.
 *   2. Single upload exceeding MAX_BYTES per-upload → rejected synchronously.
 *   3. Quota-exceeding single upload → rejected.
 *   4. TWO concurrent uploads that would each fit but combine to exceed quota
 *      → exactly ONE succeeds, the other is rejected (no double-book).
 *   5. mimeType classification routes correctly.
 *
 * CLAUDE.md §9.11: Vitest only, no mocks.
 *
 * Full tests are SCAFFOLDED because the server file imports `~/db.server`
 * + `~/env.server` which are Remix-runtime singletons. Same blocker as
 * platosAttachments.test.ts — needs a vitest setup file that rebinds
 * those imports to testcontainer-derived instances.
 *
 * Follow-up ticket: same 2-3 hour wire-up task; once done, uncomment the
 * `it.skip` bodies below and they should run green. The SQL-level atomic
 * INSERT ... SELECT ... WHERE is the thing under test — any regression to
 * "count then insert" splits the concurrent test case.
 */
import { describe, it, expect } from "vitest";
import { classifyMimeType } from "./platosAttachments.server";

const SCOPE = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  userId: "user_1",
};

describe("classifyMimeType (pure)", () => {
  it("image/png → image", () => expect(classifyMimeType("image/png")).toBe("image"));
  it("image/jpeg → image", () => expect(classifyMimeType("image/jpeg")).toBe("image"));
  it("image/webp → image", () => expect(classifyMimeType("image/webp")).toBe("image"));
  it("image/heic → image", () => expect(classifyMimeType("image/heic")).toBe("image"));
  it("image/avif → image", () => expect(classifyMimeType("image/avif")).toBe("image"));
  it("audio/mpeg → audio", () => expect(classifyMimeType("audio/mpeg")).toBe("audio"));
  it("audio/wav → audio", () => expect(classifyMimeType("audio/wav")).toBe("audio"));
  it("video/mp4 → video", () => expect(classifyMimeType("video/mp4")).toBe("video"));
  it("application/pdf → document (fallback)", () =>
    expect(classifyMimeType("application/pdf")).toBe("document"));
  it("text/plain → document", () =>
    expect(classifyMimeType("text/plain")).toBe("document"));
  it("garbage mimetype → document (defensive)", () =>
    expect(classifyMimeType("")).toBe("document"));
});

describe("createPresignedUpload — quota + size enforcement (scaffold)", () => {
  it.skip("happy path: upload under both caps → attachmentId + url", async () => {
    // TODO: postgresAndMinioTest fixture. Seed org with 0 usage. Call
    // createPresignedUpload with bytes=1MB. Expect inserted row + signed
    // URL. Follow-up: verify the row carries the scope tuple.
  });

  it.skip("rejects with size error when bytes > PLATOS_ATTACHMENT_MAX_BYTES", async () => {
    // Set PLATOS_ATTACHMENT_MAX_BYTES=10MB. Call with bytes=20MB. Expect
    // throw /exceeds per-upload cap/.
  });

  it.skip("rejects when single upload would push org past ORG_QUOTA_BYTES", async () => {
    // Set ORG_QUOTA_BYTES=50MB. Seed 40MB existing usage. Call with bytes=20MB.
    // Expect throw /Organization quota exceeded/.
  });

  it.skip("rejects with bytes <= 0", async () => {
    // Negative/zero bytes are client errors — throw "bytes must be positive".
  });

  it.skip("rejects with missing mimeType", async () => {
    // Call createPresignedUpload({ scope, bytes: 1024 }) without mimeType.
    // Expect throw /mimeType is required/.
  });
});

describe("insertWithQuotaGate — TOCTOU race (scaffold)", () => {
  it.skip("two concurrent uploads near quota ceiling: exactly one succeeds", async () => {
    // Set ORG_QUOTA_BYTES=10MB. Seed 9MB usage. Fire TWO createPresignedUpload
    // calls, each with bytes=2MB, in parallel.
    //
    // Pre-PPR-19 behaviour: both `aggregate + compare` evaluations saw 9MB,
    // both passed, both inserted → 13MB usage (3MB over quota).
    //
    // Post-PPR-19 SERIALIZABLE SQL: `INSERT ... WHERE (SELECT sum(bytes)) +
    // :bytes <= :quota` is atomic — exactly one succeeds, the other throws.
    // Assert total usage after both calls settle is <= quota.
    //
    // Implementation notes for the finished test:
    //   const results = await Promise.allSettled([
    //     createPresignedUpload({ scope, bytes: TWO_MB, mimeType: "image/png" }),
    //     createPresignedUpload({ scope, bytes: TWO_MB, mimeType: "image/png" }),
    //   ]);
    //   const fulfilled = results.filter(r => r.status === "fulfilled");
    //   const rejected = results.filter(r => r.status === "rejected");
    //   expect(fulfilled).toHaveLength(1);
    //   expect(rejected).toHaveLength(1);
    //   expect(rejected[0].reason.message).toMatch(/quota exceeded/i);
  });

  it.skip("sequential uploads account cumulatively", async () => {
    // Sanity: three 2MB uploads into a 10MB quota with 0 start — all
    // succeed; total usage = 6MB.
  });
});

describe("reconcileAttachmentBytes (scaffold)", () => {
  it.skip("corrects undersized claim vs actual MinIO bytes", async () => {
    // Client claims 1KB, actually uploads 10MB. HEAD returns 10MB.
    // reconcileAttachmentBytes updates bytes=10MB, logs delta.
    // Verify row.bytes == 10MB after call.
  });

  it.skip("returns null if attachment not in caller's scope", async () => {
    // Attachment belongs to org_A, reconcile called with org_B scope → null.
  });

  it.skip("returns actualBytes=null when MinIO object not yet present (404)", async () => {
    // HEAD fails — caller should retry later. No row mutation.
  });
});
