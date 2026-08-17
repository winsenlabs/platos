import { describe, expect, test } from "vitest";
import {
  cleanTriggerFunctionManifest,
  deferredCleanTriggerManifest,
} from "./cutover-clean-trigger-manifest";
import {
  assertCleanTriggerCatalog,
  compareCleanTriggerCatalog,
  deferCleanTriggersForBackfill,
  installAndValidateCleanTriggers,
  type CleanTriggerCatalogSnapshot,
} from "./cutover-clean-triggers";
import type { CutoverDatabase, QueryResultLike } from "./cutover-types";

const installedEntries = cleanTriggerFunctionManifest.map(({ kind, name, fingerprint }) => ({
  kind,
  name,
  fingerprint,
}));

function snapshot(
  entries: CleanTriggerCatalogSnapshot["entries"] = installedEntries
): CleanTriggerCatalogSnapshot {
  return { entries, digest: "test-digest", manifestDigest: "test-manifest-digest" };
}

function without(name: string): CleanTriggerCatalogSnapshot {
  return snapshot(installedEntries.filter((entry) => entry.name !== name));
}

describe("clean trigger/function cutover manifest", () => {
  test("inventories every current clean migration and defers only the safe claimed-attachment update guard", () => {
    expect(cleanTriggerFunctionManifest).toHaveLength(122);
    expect(cleanTriggerFunctionManifest.filter((entry) => entry.kind === "function")).toHaveLength(
      21
    );
    expect(cleanTriggerFunctionManifest.filter((entry) => entry.kind === "trigger")).toHaveLength(
      101
    );
    expect(new Set(cleanTriggerFunctionManifest.map((entry) => entry.migration))).toEqual(
      new Set([
        "00000000000000_initial",
        "20260817000000_add_upload_reservations",
        "20260817010000_add_token_lifecycle_audit",
        "20260817020000_add_attachment_byte_reconciliation",
        "20260817030000_add_external_cutover_reconciliation",
      ])
    );
    expect(deferredCleanTriggerManifest.map((entry) => entry.name)).toEqual([
      "MessageAttachment.MessageAttachment_claimed_lifecycle",
    ]);
    expect(
      cleanTriggerFunctionManifest
        .filter((entry) => entry.name.endsWith("_ancestry"))
        .every((entry) => entry.classification === "MANDATORY_ALWAYS_ON")
    ).toBe(true);
    expect(
      cleanTriggerFunctionManifest
        .filter((entry) => /owner_immutable|scope_immutable|Audit_immutable/.test(entry.name))
        .every((entry) => entry.classification === "MANDATORY_ALWAYS_ON")
    ).toBe(true);
  });

  test("fails closed for a missing trigger", () => {
    const actual = without("Thread.Thread_ancestry");
    expect(compareCleanTriggerCatalog(actual, "FRESH_INSTALLED").missing).toEqual([
      "trigger:Thread.Thread_ancestry",
    ]);
    expect(() => assertCleanTriggerCatalog(actual, "FRESH_INSTALLED")).toThrow(
      /1 missing, 0 modified, 0 unexpected/
    );
  });

  test("fails closed for a modified trigger", () => {
    const actual = snapshot(
      installedEntries.map((entry) =>
        entry.name === "Thread.Thread_ancestry" ? { ...entry, fingerprint: "0".repeat(64) } : entry
      )
    );
    expect(compareCleanTriggerCatalog(actual, "FRESH_INSTALLED").modified).toEqual([
      "trigger:Thread.Thread_ancestry",
    ]);
  });

  test("fails closed for an extra trigger", () => {
    const actual = snapshot([
      ...installedEntries,
      { kind: "trigger", name: "Thread.unexpected", fingerprint: "0".repeat(64) },
    ]);
    expect(compareCleanTriggerCatalog(actual, "FRESH_INSTALLED").unexpected).toEqual([
      "trigger:Thread.unexpected",
    ]);
  });

  test("fails closed for a wrong function body", () => {
    const actual = snapshot(
      installedEntries.map((entry) =>
        entry.name === "enforce_domain_ancestry()"
          ? { ...entry, fingerprint: "f".repeat(64) }
          : entry
      )
    );
    expect(compareCleanTriggerCatalog(actual, "FRESH_INSTALLED").modified).toEqual([
      "function:enforce_domain_ancestry()",
    ]);
  });
});

interface CatalogRow {
  kind: "function" | "trigger";
  name: string;
  definition: string;
}

class FakeCatalogDatabase implements CutoverDatabase {
  readonly queries: string[] = [];
  private rows: CatalogRow[];
  private savepointRows: CatalogRow[] | undefined;

  constructor(
    state: "installed" | "deferred" = "installed",
    private readonly failInstallAfterCreate = false
  ) {
    this.rows = cleanTriggerFunctionManifest
      .filter((entry) => state === "installed" || entry.classification === "MANDATORY_ALWAYS_ON")
      .map(({ kind, name, definition }) => ({ kind, name, definition }));
  }

  has(name: string): boolean {
    return this.rows.some((entry) => entry.name === name);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string
  ): Promise<QueryResultLike<Row>> {
    this.queries.push(sql);
    if (sql.startsWith("SAVEPOINT ")) this.savepointRows = structuredClone(this.rows);
    else if (sql.startsWith("ROLLBACK TO SAVEPOINT "))
      this.rows = structuredClone(this.savepointRows ?? []);
    else if (sql.startsWith("RELEASE SAVEPOINT ")) this.savepointRows = undefined;
    else if (sql.includes("FROM pg_proc procedure")) {
      const rows = [...this.rows].sort((left, right) =>
        `${left.kind}:${left.name}:${left.definition}`.localeCompare(
          `${right.kind}:${right.name}:${right.definition}`
        )
      );
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    } else if (sql.includes('FROM public."AttachmentUploadReservation"')) {
      return {
        rows: [{ reservation_count: "0" }] as unknown as Row[],
        rowCount: 1,
      };
    } else if (sql.startsWith('DROP TRIGGER "MessageAttachment_claimed_lifecycle"')) {
      this.rows = this.rows.filter(
        (entry) => entry.name !== "MessageAttachment.MessageAttachment_claimed_lifecycle"
      );
    } else if (sql.startsWith('CREATE TRIGGER "MessageAttachment_claimed_lifecycle"')) {
      const entry = deferredCleanTriggerManifest[0];
      this.rows.push({ kind: entry.kind, name: entry.name, definition: entry.definition });
      if (this.failInstallAfterCreate) throw new Error("injected install failure");
    }
    return { rows: [] as Row[], rowCount: null };
  }
}

describe("transactional clean trigger defer/install contract", () => {
  test("proves the exact installed, deferred, and reinstalled states", async () => {
    const target = new FakeCatalogDatabase();
    const fresh = new FakeCatalogDatabase();

    await expect(deferCleanTriggersForBackfill(target, fresh)).resolves.toBeDefined();
    expect(target.has("MessageAttachment.MessageAttachment_claimed_lifecycle")).toBe(false);
    await expect(installAndValidateCleanTriggers(target, fresh)).resolves.toBeDefined();
    expect(target.has("MessageAttachment.MessageAttachment_claimed_lifecycle")).toBe(true);
  });

  test("reports install failure and rolls its partial CREATE TRIGGER back", async () => {
    const target = new FakeCatalogDatabase("deferred", true);
    const fresh = new FakeCatalogDatabase();

    await expect(installAndValidateCleanTriggers(target, fresh)).rejects.toMatchObject({
      code: "CLEAN_TRIGGER_INSTALL_FAILED",
    });
    expect(target.queries).toContain("ROLLBACK TO SAVEPOINT clean_trigger_install");
    expect(target.has("MessageAttachment.MessageAttachment_claimed_lifecycle")).toBe(false);
  });
});
