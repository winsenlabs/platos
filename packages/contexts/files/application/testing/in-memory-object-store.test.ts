// Proof that the `ObjectStore` port is implementable and total.
//
// The port is the interface an S3-compatible adapter has to satisfy, and this
// exercises every method on it plus every failure the interface promises to
// express. If a method here could only be satisfied by naming a vendor, or if a
// failure could only be reported by throwing, that would show up as a gap in
// this file rather than as a surprise in production.

import { describe, expect, it } from "vitest";

import type { StorageKey } from "../../domain/index.js";
import { InMemoryObjectStore } from "./in-memory-object-store.js";

const KEY = "org/o/proj/p/env/e/thread/t/attachment/a/photo.png" as StorageKey;
const OTHER = "org/o/proj/p/env/e/thread/t/attachment/b/photo.png" as StorageKey;
const BYTES = new Uint8Array([1, 2, 3]);
const AT = new Date("2026-01-01T00:00:00.000Z");

describe("the ObjectStore port surface", () => {
  it("puts, stats and gets an object", async () => {
    const store = new InMemoryObjectStore();
    const put = await store.put({ key: KEY, content: BYTES, contentType: "image/png" });
    expect(put.ok).toBe(true);
    if (!put.ok) throw new Error("unreachable");
    expect(put.value.bytes).toBe(3);

    const stat = await store.stat(KEY);
    if (!stat.ok) throw new Error("unreachable");
    expect(stat.value.contentType).toBe("image/png");

    const got = await store.get(KEY);
    if (!got.ok) throw new Error("unreachable");
    expect([...got.value.content]).toEqual([1, 2, 3]);
  });

  it("reports an absent object as a VALUE on get and stat, never as a throw", async () => {
    const store = new InMemoryObjectStore();
    const got = await store.get(KEY);
    const stat = await store.stat(KEY);
    expect(got.ok).toBe(false);
    expect(stat.ok).toBe(false);
    if (got.ok || stat.ok) throw new Error("unreachable");
    expect(got.error.code).toBe("FILES_OBJECT_NOT_FOUND");
    expect(stat.error.code).toBe("FILES_OBJECT_NOT_FOUND");
  });

  it("makes delete IDEMPOTENT: an absent object is a success reporting existed=false", async () => {
    const store = new InMemoryObjectStore();
    await store.put({ key: KEY, content: BYTES, contentType: "image/png" });

    const first = await store.delete(KEY);
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.existed).toBe(true);

    const second = await store.delete(KEY);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.existed).toBe(false);
  });

  it("copies server-side without moving bytes through the caller", async () => {
    const store = new InMemoryObjectStore();
    await store.put({ key: KEY, content: BYTES, contentType: "image/png" });
    const copied = await store.copy({ sourceKey: KEY, destinationKey: OTHER });
    expect(copied.ok).toBe(true);
    expect(store.has(KEY)).toBe(true);
    expect(store.has(OTHER)).toBe(true);
  });

  it("reports a copy from an absent source rather than creating an empty object", async () => {
    const store = new InMemoryObjectStore();
    const copied = await store.copy({ sourceKey: KEY, destinationKey: OTHER });
    expect(copied.ok).toBe(false);
    expect(store.has(OTHER)).toBe(false);
  });

  it("takes an ABSOLUTE expiry on both presign calls rather than a relative window", async () => {
    const store = new InMemoryObjectStore();
    const upload = await store.presignUpload({
      key: KEY,
      contentType: "image/png",
      contentLengthBytes: 3,
      expiresAt: AT,
    });
    const download = await store.presignDownload({ key: KEY, expiresAt: AT });
    if (!upload.ok || !download.ok) throw new Error("unreachable");
    expect(upload.value.expiresAt).toEqual(AT);
    expect(download.value.expiresAt).toEqual(AT);
    expect(upload.value.method).toBe("PUT");
    expect(download.value.method).toBe("GET");
    expect(upload.value.requiredHeaders["content-type"]).toBe("image/png");
  });

  it("expresses store unavailability as a retryable value on every failing call", async () => {
    const store = new InMemoryObjectStore();
    store.presignFails = true;
    store.copyFails = true;
    store.deleteFails = true;
    for (const outcome of [
      await store.presignUpload({ key: KEY, contentType: "image/png", contentLengthBytes: 1, expiresAt: AT }),
      await store.presignDownload({ key: KEY, expiresAt: AT }),
      await store.copy({ sourceKey: KEY, destinationKey: OTHER }),
      await store.delete(KEY),
    ]) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.error.code).toBe("FILES_OBJECT_STORE_UNAVAILABLE");
      expect(outcome.error.category).toBe("unavailable");
      expect(outcome.error.retryAfterSeconds).toBe(5);
    }
  });
});
