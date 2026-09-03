import { asIdentifier, domainError } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  BLOB_ALREADY_ABSENT,
  BLOB_DESTROYED,
  blobDestructionFailure,
  decideRowDestruction,
  DESTRUCTION_ORDER,
  destroyedReport,
  retainedReport,
  summarizeDestruction,
} from "./destruction.js";
import type { AttachmentId, StorageKey } from "./identifiers.js";

const KEY = "org/o/proj/p/env/e/thread/t/attachment/a/photo.png" as StorageKey;
const ATTACHMENT = asIdentifier<AttachmentId>("att-1");

describe("the destruction ordering rule", () => {
  it("fixes the order as blob then row", () => {
    expect([...DESTRUCTION_ORDER]).toEqual(["blob", "row"]);
  });

  it("destroys the row once the blob is gone", () => {
    expect(decideRowDestruction(KEY, BLOB_DESTROYED).decision).toBe("destroy-row");
  });

  it("treats an already-absent blob as success so a retry converges", () => {
    expect(decideRowDestruction(KEY, BLOB_ALREADY_ABSENT).decision).toBe("destroy-row");
  });

  it("RETAINS the row when the blob would not go, and says why", () => {
    const cause = domainError("FILES_OBJECT_STORE_UNAVAILABLE", "unavailable", "down");
    const decision = decideRowDestruction(KEY, blobDestructionFailure(cause));
    expect(decision.decision).toBe("retain-row");
    if (decision.decision !== "retain-row") throw new Error("unreachable");
    expect(decision.error.code).toBe("FILES_BLOB_DESTRUCTION_FAILED");
    expect(decision.error.details.causeCode).toBe("FILES_OBJECT_STORE_UNAVAILABLE");
  });
});

describe("summarizeDestruction", () => {
  it("separates rows destroyed from rows retained", () => {
    const cause = domainError("FILES_OBJECT_STORE_UNAVAILABLE", "unavailable", "down");
    const summary = summarizeDestruction([
      destroyedReport(ATTACHMENT, KEY, BLOB_DESTROYED),
      destroyedReport(ATTACHMENT, KEY, BLOB_ALREADY_ABSENT),
      retainedReport(ATTACHMENT, KEY, blobDestructionFailure(cause), cause),
    ]);
    expect(summary.rowsDestroyed).toBe(2);
    expect(summary.rowsRetained).toBe(1);
    expect(summary.blobsDestroyed).toBe(1);
  });
});
