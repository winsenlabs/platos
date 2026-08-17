import { createHash } from "node:crypto";
import {
  cleanTriggerFunctionManifest,
  cleanTriggerFunctionManifestSha256,
  deferredCleanTriggerManifest,
  type CleanCatalogObjectKind,
  type CleanTriggerFunctionManifestEntry,
} from "./cutover-clean-trigger-manifest";
import { CutoverFailure, type CutoverDatabase } from "./cutover-types";

export type CleanTriggerCatalogState = "FRESH_INSTALLED" | "BACKFILL_DEFERRED";

export interface CleanTriggerCatalogEntry {
  readonly kind: CleanCatalogObjectKind;
  readonly name: string;
  readonly fingerprint: string;
}

export interface CleanTriggerCatalogSnapshot {
  readonly entries: readonly CleanTriggerCatalogEntry[];
  readonly digest: string;
  readonly manifestDigest: string;
}

export interface CleanTriggerCatalogMismatch {
  readonly missing: readonly string[];
  readonly modified: readonly string[];
  readonly unexpected: readonly string[];
}

const CLEAN_TRIGGER_FUNCTION_CATALOG_SQL = `
WITH extension_objects AS (
  SELECT dependency.classid, dependency.objid
    FROM pg_depend dependency
    JOIN pg_extension extension ON extension.oid = dependency.refobjid
   WHERE dependency.deptype = 'e'
), clean_objects AS (
  SELECT 'function'::text AS kind,
         procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')' AS name,
         pg_get_functiondef(procedure.oid) AS definition
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    LEFT JOIN extension_objects extension_object
      ON extension_object.classid = 'pg_proc'::regclass
     AND extension_object.objid = procedure.oid
   WHERE namespace.nspname = 'public'
     AND extension_object.objid IS NULL
  UNION ALL
  SELECT 'trigger', class.relname || '.' || trigger.tgname,
         pg_get_triggerdef(trigger.oid, true)
    FROM pg_trigger trigger
    JOIN pg_class class ON class.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
   WHERE namespace.nspname = 'public'
     AND class.relname <> '_prisma_migrations'
     AND NOT trigger.tgisinternal
)
SELECT kind, name, definition
  FROM clean_objects
 ORDER BY kind, name, definition`;

function normalizeDefinition(definition: string): string {
  return definition.replaceAll(/\s+/g, " ").trim();
}

function fingerprint(definition: string): string {
  return createHash("sha256").update(normalizeDefinition(definition), "utf8").digest("hex");
}

function entryKey(entry: Pick<CleanTriggerCatalogEntry, "kind" | "name">): string {
  return `${entry.kind}:${entry.name}`;
}

function expectedEntries(
  state: CleanTriggerCatalogState
): readonly CleanTriggerFunctionManifestEntry[] {
  if (state === "FRESH_INSTALLED") return cleanTriggerFunctionManifest;
  return cleanTriggerFunctionManifest.filter(
    (entry) => entry.classification === "MANDATORY_ALWAYS_ON"
  );
}

export async function readCleanTriggerCatalog(
  database: CutoverDatabase
): Promise<CleanTriggerCatalogSnapshot> {
  const result = await database.query<{ kind: string; name: string; definition: string }>(
    CLEAN_TRIGGER_FUNCTION_CATALOG_SQL
  );
  const entries = result.rows.map<CleanTriggerCatalogEntry>((row) => {
    if (row.kind !== "function" && row.kind !== "trigger") {
      throw new CutoverFailure(
        "CLEAN_TRIGGER_CATALOG_INVALID",
        "clean trigger catalog returned an invalid object"
      );
    }
    const kind = row.kind;
    if (!row.name || !row.definition) {
      throw new CutoverFailure(
        "CLEAN_TRIGGER_CATALOG_INVALID",
        "clean trigger catalog returned an invalid object"
      );
    }
    return {
      kind,
      name: row.name,
      fingerprint: fingerprint(row.definition),
    };
  });
  return {
    entries,
    digest: createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex"),
    manifestDigest: cleanTriggerFunctionManifestSha256,
  };
}

export function compareCleanTriggerCatalog(
  actual: CleanTriggerCatalogSnapshot,
  state: CleanTriggerCatalogState
): CleanTriggerCatalogMismatch {
  const expected = expectedEntries(state);
  const actualByKey = new Map(actual.entries.map((entry) => [entryKey(entry), entry]));
  const expectedByKey = new Map(expected.map((entry) => [entryKey(entry), entry]));
  const missing: string[] = [];
  const modified: string[] = [];
  const unexpected: string[] = [];

  for (const [key, entry] of expectedByKey) {
    const found = actualByKey.get(key);
    if (!found) missing.push(key);
    else if (found.fingerprint !== entry.fingerprint) modified.push(key);
  }
  for (const key of actualByKey.keys()) {
    if (!expectedByKey.has(key)) unexpected.push(key);
  }
  return {
    missing: missing.sort(),
    modified: modified.sort(),
    unexpected: unexpected.sort(),
  };
}

export function assertCleanTriggerCatalog(
  actual: CleanTriggerCatalogSnapshot,
  state: CleanTriggerCatalogState,
  code = "CLEAN_TRIGGER_CATALOG_MISMATCH"
): void {
  const mismatch = compareCleanTriggerCatalog(actual, state);
  if (mismatch.missing.length || mismatch.modified.length || mismatch.unexpected.length) {
    throw new CutoverFailure(
      code,
      `clean trigger catalog mismatch (${mismatch.missing.length} missing, ${mismatch.modified.length} modified, ${mismatch.unexpected.length} unexpected)`
    );
  }
}

async function assertFreshReference(
  database: CutoverDatabase
): Promise<CleanTriggerCatalogSnapshot> {
  const snapshot = await readCleanTriggerCatalog(database);
  assertCleanTriggerCatalog(snapshot, "FRESH_INSTALLED", "FRESH_CLEAN_TRIGGER_CATALOG_MISMATCH");
  return snapshot;
}

async function assertNoUploadReservations(database: CutoverDatabase): Promise<void> {
  const result = await database.query<{ reservation_count: string }>(
    `SELECT count(*)::text AS reservation_count FROM public."AttachmentUploadReservation"`
  );
  if (result.rows[0]?.reservation_count !== "0") {
    throw new CutoverFailure(
      "DEFERRED_TRIGGER_SAFETY_VIOLATION",
      "MessageAttachment claimed-lifecycle trigger may only be absent while upload reservations are empty"
    );
  }
}

async function inSavepoint<T>(
  database: CutoverDatabase,
  name: string,
  action: () => Promise<T>
): Promise<T> {
  await database.query(`SAVEPOINT ${name}`);
  try {
    const result = await action();
    await database.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try {
      await database.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await database.query(`RELEASE SAVEPOINT ${name}`);
    } catch {
      throw new CutoverFailure(
        "CLEAN_TRIGGER_ROLLBACK_FAILED",
        "clean trigger contract failed and its savepoint could not be rolled back"
      );
    }
    throw error;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Transactional contract for the start of the controlled offline backfill.
 * It is intentionally not wired into cutover-engine while the phase is blocked.
 */
export async function deferCleanTriggersForBackfill(
  database: CutoverDatabase,
  freshCleanDatabase: CutoverDatabase
): Promise<CleanTriggerCatalogSnapshot> {
  await assertFreshReference(freshCleanDatabase);
  return inSavepoint(database, "clean_trigger_defer", async () => {
    assertCleanTriggerCatalog(await readCleanTriggerCatalog(database), "FRESH_INSTALLED");
    await assertNoUploadReservations(database);
    for (const entry of deferredCleanTriggerManifest) {
      const [table, trigger] = entry.name.split(".");
      if (!table || !trigger || entry.kind !== "trigger") {
        throw new CutoverFailure(
          "CLEAN_TRIGGER_MANIFEST_INVALID",
          "deferred clean trigger manifest contains an invalid trigger identity"
        );
      }
      await database.query(
        `DROP TRIGGER ${quoteIdentifier(trigger)} ON public.${quoteIdentifier(table)}`
      );
    }
    await assertNoUploadReservations(database);
    const snapshot = await readCleanTriggerCatalog(database);
    assertCleanTriggerCatalog(snapshot, "BACKFILL_DEFERRED");
    return snapshot;
  });
}

/**
 * Installs the exact checked-in definitions before validation/commit and proves
 * parity with both the manifest and an independently migrated clean database.
 */
export async function installAndValidateCleanTriggers(
  database: CutoverDatabase,
  freshCleanDatabase: CutoverDatabase
): Promise<CleanTriggerCatalogSnapshot> {
  const fresh = await assertFreshReference(freshCleanDatabase);
  return inSavepoint(database, "clean_trigger_install", async () => {
    assertCleanTriggerCatalog(await readCleanTriggerCatalog(database), "BACKFILL_DEFERRED");
    await assertNoUploadReservations(database);
    for (const entry of deferredCleanTriggerManifest) {
      try {
        await database.query(`${entry.definition};`);
      } catch {
        throw new CutoverFailure(
          "CLEAN_TRIGGER_INSTALL_FAILED",
          `failed to install deferred trigger ${entry.name}`
        );
      }
    }
    const installed = await readCleanTriggerCatalog(database);
    assertCleanTriggerCatalog(installed, "FRESH_INSTALLED");
    if (installed.digest !== fresh.digest) {
      throw new CutoverFailure(
        "FRESH_CLEAN_TRIGGER_CATALOG_MISMATCH",
        "installed trigger/function catalog digest does not match the fresh clean catalog"
      );
    }
    return installed;
  });
}
