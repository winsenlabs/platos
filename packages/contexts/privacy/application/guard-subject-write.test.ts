import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  canonicalAlias,
  subjectAlias,
  tombstoneTtlMs,
  type ErasureOperationId,
  type ErasureTombstoneId,
} from "../domain/index.js";
import { assertSubjectNotErased, erasedAliases } from "./guard-subject-write.js";
import { sealSubject } from "./seal-subject.js";
import { aliasHashes } from "./subject-digests.js";
import { buildPrivacyTestContext, TEST_ORGANIZATION, type PrivacyTestContext } from "./testing/index.js";

const OPERATION = asIdentifier<ErasureOperationId>("op-1");
const ALIASES = [subjectAlias("external", "walle-1"), subjectAlias("slack", "U08JTN5FX39"), canonicalAlias("eu-1")];

describe("the write barrier", () => {
  let context: PrivacyTestContext;

  beforeEach(async () => {
    context = buildPrivacyTestContext();
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: OPERATION,
      aliases: ALIASES,
    });
  });

  it("allows a write for somebody who was never erased", async () => {
    const allowed = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", "someone-else")],
    });
    expect(allowed.ok).toBe(true);
  });

  it("REFUSES a write for the requested handle", async () => {
    const refused = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", "walle-1")],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("PRIVACY_SUBJECT_ERASED");
  });

  it("refuses an ALIAS the erasure was not requested under — the point of the register", async () => {
    const refused = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("slack", "U08JTN5FX39")],
    });
    expect(refused.ok).toBe(false);
  });

  it("refuses the canonical row id, for a writer that captured it before the sweep", async () => {
    const refused = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [canonicalAlias("eu-1")],
    });
    expect(refused.ok).toBe(false);
  });

  it("refuses a handle that differs only by case", async () => {
    const refused = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("Slack", " u08jtn5fx39 ")],
    });
    expect(refused.ok).toBe(false);
  });

  it("does not refuse the same handle on a DIFFERENT channel", async () => {
    const allowed = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("email", "walle-1")],
    });
    expect(allowed.ok).toBe(true);
  });

  it("does not refuse in another organization: the digests are tenant-scoped", async () => {
    const allowed = await assertSubjectNotErased(context.dependencies, {
      organizationId: asIdentifier("org-2"),
      aliases: [subjectAlias("external", "walle-1")],
    });
    expect(allowed.ok).toBe(true);
  });

  it("REFUSES when the register cannot be consulted — fail closed, not open", async () => {
    context.repository.tombstoneReadFails = true;
    const refused = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", "someone-else")],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    // Distinct from PRIVACY_SUBJECT_ERASED: an operator must be able to tell
    // "we blocked a resurrection" from "we lost the ability to tell".
    expect(refused.error.code).toBe("PRIVACY_ERASURE_REGISTER_UNAVAILABLE");
  });

  it("allows a write that presents nothing identifying at all", async () => {
    const allowed = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [],
    });
    expect(allowed.ok).toBe(true);
  });

  it("does not let a blank handle match: it never became a tombstone in the first place", async () => {
    const allowed = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", "  ")],
    });
    expect(allowed.ok).toBe(true);
  });

  it("stops refusing once the retention window has elapsed", async () => {
    context.clock.advanceDays(31);
    const allowed = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", "walle-1")],
    });
    expect(allowed.ok).toBe(true);
  });

  it("applies expiry at READ time, even when the row is still in the table", async () => {
    // Nothing has swept, so the row is still there. The barrier must ignore it.
    context.clock.advanceDays(31);
    expect(context.repository.allTombstones().length).toBeGreaterThan(0);
    const allowed = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", "walle-1")],
    });
    expect(allowed.ok).toBe(true);
  });

  it("does not TRUST the store to have applied expiry — it re-applies it itself", async () => {
    // A permissive adapter that returns elapsed rows. Without the barrier's own
    // filter this refuses writes for a subject whose tombstone lapsed a month
    // ago, permanently, and the only symptom is a person who can never sign up
    // again. The store-side filter and this one are belt and braces on purpose.
    context.clock.advanceDays(31);
    context.repository.returnsElapsedTombstones = true;
    const allowed = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", "walle-1")],
    });
    expect(allowed.ok).toBe(true);
  });

  it("still refuses a LIVE row that a permissive store returned", async () => {
    // The control on the case above: the second filter must drop only the rows
    // that have elapsed, not every row it is handed.
    context.repository.returnsElapsedTombstones = true;
    const refused = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", "walle-1")],
    });
    expect(refused.ok).toBe(false);
  });

  it("still refuses one millisecond before the window closes", async () => {
    context.clock.advanceSeconds(tombstoneTtlMs(context.dependencies.policy) / 1000 - 0.001);
    const refused = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", "walle-1")],
    });
    expect(refused.ok).toBe(false);
  });
});

describe("erasedAliases", () => {
  let context: PrivacyTestContext;

  beforeEach(async () => {
    context = buildPrivacyTestContext();
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: OPERATION,
      aliases: [subjectAlias("external", "erased-1")],
    });
  });

  it("returns only the erased subset, so a drain can deliver everyone else's rows", async () => {
    const erased = await erasedAliases(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", "erased-1"), subjectAlias("external", "live-1")],
    });
    expect(erased.ok).toBe(true);
    if (!erased.ok) throw new Error("unreachable");
    expect(erased.value).toEqual(
      aliasHashes(context.hasher, TEST_ORGANIZATION, [subjectAlias("external", "erased-1")]),
    );
  });

  it("returns DIGESTS, so nothing reversible crosses the boundary", async () => {
    const erased = await erasedAliases(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", "erased-1")],
    });
    if (!erased.ok) throw new Error("unreachable");
    expect(erased.value.join("|")).not.toContain("erased-1");
  });

  it("FAILS rather than returning an empty set when the register is unreachable", async () => {
    context.repository.tombstoneReadFails = true;
    const failed = await erasedAliases(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", "erased-1")],
    });
    // An empty set would tell the drain to deliver every row in the batch.
    expect(failed.ok).toBe(false);
  });
});

describe("what a seal writes", () => {
  it("stores no raw handle anywhere in the register", async () => {
    const context = buildPrivacyTestContext();
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: OPERATION,
      aliases: ALIASES,
    });
    const serialized = JSON.stringify(context.repository.allTombstones());
    for (const handle of ["walle-1", "U08JTN5FX39", "u08jtn5fx39", "eu-1"]) {
      expect(serialized).not.toContain(handle);
    }
  });

  it("seals a tombstone per distinct alias", async () => {
    const context = buildPrivacyTestContext();
    const sealed = await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: OPERATION,
      aliases: ALIASES,
    });
    if (!sealed.ok) throw new Error("unreachable");
    expect(sealed.value).toMatchObject({ aliases: 3, sealed: 3, extended: 0 });
  });

  it("mints a tombstone id per row rather than reusing one", async () => {
    const context = buildPrivacyTestContext();
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: OPERATION,
      aliases: ALIASES,
    });
    const ids = context.repository.allTombstones().map((row) => row.tombstoneId as ErasureTombstoneId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
