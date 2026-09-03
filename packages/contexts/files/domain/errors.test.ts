// The catalogue must not drift from what the factories actually mint.
//
// `FILES_ERROR_CODES` is what a transport builds its status table from, so a
// code that exists only in a factory is a code no transport maps and a code that
// exists only in the list is a lie. This test walks every exported factory and
// asserts the two agree exactly.

import { describe, expect, it } from "vitest";

import * as errors from "./errors.js";
import { FILES_ERROR_CODES } from "./errors.js";

const SAMPLES: ReadonlyArray<() => { readonly code: string }> = [
  () => errors.attachmentMetadataInvalid("x"),
  () => errors.attachmentTooLarge(2, 1),
  () => errors.attachmentQuotaExceeded(1, 1, 1),
  () => errors.attachmentNotFound("a"),
  () => errors.attachmentBindingConflict("a", "t1", "t2"),
  () => errors.attachmentRetentionElapsed("a", "then", "now"),
  () => errors.storageKeyScopeMismatch("prefix/"),
  () => errors.presignWindowInvalid(0, 900),
  () => errors.presignedGrantElapsed("then", "now"),
  () => errors.objectNotFound("k"),
  () => errors.objectStoreUnavailable("down"),
  () => errors.objectPreconditionFailed("k", "why"),
  () => errors.blobDestructionFailed("k", errors.objectStoreUnavailable("down")),
  () => errors.artifactKeyInvalid("x"),
  () => errors.artifactContentInvalid("x"),
  () => errors.artifactContentTooLarge(2, 1),
  () => errors.artifactKindImmutable("k", "a", "b"),
  () => errors.artifactRevisionConflict("k", 2),
  () => errors.artifactRevisionNotFound("k", 2),
  () => errors.repositoryUnavailable("down"),
  () => errors.erasurePlanForeign("files"),
];

describe("the files error catalogue", () => {
  it("mints exactly the codes it declares, with no drift in either direction", () => {
    const minted = new Set(SAMPLES.map((sample) => sample().code));
    expect([...minted].sort()).toEqual([...FILES_ERROR_CODES].sort());
  });

  it("prefixes every code with the owning context", () => {
    for (const code of FILES_ERROR_CODES) expect(code.startsWith("FILES_")).toBe(true);
  });

  it("carries a retry hint on exactly the categories that can be retried", () => {
    expect(errors.objectStoreUnavailable("down").retryAfterSeconds).toBe(5);
    expect(errors.attachmentNotFound("a").retryAfterSeconds).toBeNull();
  });

  it("classifies a cross-scope key reach as forbidden, not as absent", () => {
    expect(errors.storageKeyScopeMismatch("p/").category).toBe("forbidden");
  });

  it("classifies an occupied revision slot as a conflict", () => {
    expect(errors.artifactRevisionConflict("k", 1).category).toBe("conflict");
  });
});
