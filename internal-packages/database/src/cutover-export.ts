import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { inspect } from "node:util";
import {
  legacyAdditionalPhysicalObjectLedger,
  legacyModelDispositionLedger,
  type CutoverDisposition,
} from "./cutover-ledger";
import {
  sourceFieldTransformationManifest,
  type SourceFieldTransformation,
} from "./source-field-manifest";
import type { LegacyMigrationRow } from "./cutover-history";
import type { CutoverDatabase } from "./cutover-types";

const FORMAT = "platos.win123.cutover-export.sealed.v1";
const PAYLOAD_DOMAIN = "platos.win123.cutover-export.payload.v1";
const OBJECT_DOMAIN = "platos.win123.cutover-export.object.v1";
const AES_256_GCM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/;
const LEGACY_EXPORT_FIELD_COLUMNS = Object.freeze({
  "Project.allowedWorkerQueues": "allowedMasterQueues",
} as const);
const MIGRATION_HISTORY_FIELDS = Object.freeze([
  "applied_steps_count",
  "checksum",
  "finished_at",
  "id",
  "logs",
  "migration_name",
  "rolled_back_at",
  "started_at",
]);

export type CutoverExportMode = "DRY_RUN" | "WRITE";
export type CutoverExportSelection =
  | "COUNT_ONLY"
  | "MANIFEST_EXPORT_FIELDS"
  | "ALL_SOURCE_FIELDS"
  | "MIGRATION_HISTORY";

export type CutoverExportErrorCode =
  | "invalid_run_id"
  | "invalid_key_reference"
  | "missing_export_key"
  | "invalid_export_key"
  | "invalid_source_inventory"
  | "invalid_source_fields"
  | "invalid_source_rows"
  | "invalid_row_count"
  | "invalid_migration_history"
  | "output_directory_required"
  | "artifact_write_failed"
  | "sealed_payload_invalid";

/** Stable export-only failure that never includes source values or key material. */
export class CutoverExportError extends Error {
  constructor(readonly code: CutoverExportErrorCode) {
    super(`Cutover export validation failed (${code})`);
    this.name = "CutoverExportError";
  }

  toJSON(): Readonly<{ name: "CutoverExportError"; code: CutoverExportErrorCode }> {
    return Object.freeze({ name: "CutoverExportError", code: this.code });
  }

  [inspect.custom](): string {
    return `${this.name} { code: ${JSON.stringify(this.code)} }`;
  }
}

export interface CutoverExportObjectContract {
  readonly objectKind: "MODEL" | "IMPLICIT_JOIN_TABLE" | "MIGRATION_HISTORY";
  readonly objectName: string;
  readonly sourceModel?: string;
  readonly disposition: CutoverDisposition;
  readonly selection: CutoverExportSelection;
  readonly exportFields: readonly string[];
  readonly sql: string;
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function unsupportedFieldsByModel(
  fieldManifest: readonly SourceFieldTransformation[] = sourceFieldTransformationManifest
): ReadonlyMap<string, readonly string[]> {
  const fields = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const entry of fieldManifest) {
    if (entry.disposition !== "EXPORT") continue;
    const path = `${entry.sourceModel}.${entry.sourceField}`;
    if (seen.has(path)) throw new CutoverExportError("invalid_source_fields");
    seen.add(path);
    const existing = fields.get(entry.sourceModel) ?? [];
    existing.push(entry.sourceField);
    fields.set(entry.sourceModel, existing);
  }
  return new Map(
    [...fields].map(([model, entries]) => [model, [...new Set(entries)].sort(bytewise)] as const)
  );
}

function selectionFor(
  disposition: CutoverDisposition,
  exportFields: readonly string[]
): CutoverExportSelection {
  if (disposition === "EPHEMERAL_DROP") return "COUNT_ONLY";
  if (disposition === "EXPORT_DROP") return "ALL_SOURCE_FIELDS";
  return exportFields.length === 0 ? "COUNT_ONLY" : "MANIFEST_EXPORT_FIELDS";
}

function queryFor(
  table: string,
  selection: CutoverExportSelection,
  exportFields: readonly string[],
  sourceModel?: string
): string {
  const from = `FROM cutover_legacy.${quoted(table)}`;
  if (selection === "COUNT_ONLY") return `SELECT count(*)::bigint AS row_count ${from}`;
  if (selection === "MANIFEST_EXPORT_FIELDS") {
    return `SELECT ${exportFields.map((field) => {
      const physicalField = sourceModel
        ? LEGACY_EXPORT_FIELD_COLUMNS[
            `${sourceModel}.${field}` as keyof typeof LEGACY_EXPORT_FIELD_COLUMNS
          ] ?? field
        : field;
      return physicalField === field
        ? quoted(field)
        : `${quoted(physicalField)} AS ${quoted(field)}`;
    }).join(", ")} ${from}`;
  }
  return `SELECT * ${from}`;
}

/**
 * Exhaustive export plan derived from the model disposition ledger and the
 * field-level EXPORT manifest. Trigger/hosted tables are always SELECT * into
 * the sealed operator artifact; no target/import operation is represented.
 */
export function createCutoverExportObjectManifest(
  fieldManifest: readonly SourceFieldTransformation[] = sourceFieldTransformationManifest
): readonly CutoverExportObjectContract[] {
  const unsupported = unsupportedFieldsByModel(fieldManifest);
  const models: CutoverExportObjectContract[] = legacyModelDispositionLedger.map((entry) => {
    const exportFields = unsupported.get(entry.sourceModel) ?? [];
    const selection = selectionFor(entry.disposition, exportFields);
    return {
      objectKind: "MODEL",
      objectName: entry.physicalTable,
      sourceModel: entry.sourceModel,
      disposition: entry.disposition,
      selection,
      exportFields,
      sql: queryFor(entry.physicalTable, selection, exportFields, entry.sourceModel),
    };
  });
  const additional = legacyAdditionalPhysicalObjectLedger.flatMap<CutoverExportObjectContract>(
    (entry) => {
      if (entry.kind === "EXTENSION") return [];
      const objectKind = entry.kind;
      const selection =
        entry.kind === "MIGRATION_HISTORY" ? "MIGRATION_HISTORY" : "ALL_SOURCE_FIELDS";
      return [
        {
          objectKind,
          objectName: entry.name,
          disposition: entry.disposition,
          selection,
          exportFields: [],
          sql: queryFor(entry.name, selection, []),
        },
      ];
    }
  );
  return [...models, ...additional].sort((left, right) =>
    bytewise(left.objectName, right.objectName)
  );
}

export const cutoverExportObjectManifest = createCutoverExportObjectManifest();

/** Reads the complete export inventory from the transaction-local legacy schema. */
export async function collectCutoverExportSourceSnapshots(
  database: CutoverDatabase
): Promise<readonly CutoverExportSourceSnapshot[]> {
  const snapshots: CutoverExportSourceSnapshot[] = [];
  try {
    for (const contract of cutoverExportObjectManifest) {
      if (contract.selection === "MIGRATION_HISTORY") continue;
      const result = await database.query(contract.sql);
      if (contract.selection === "COUNT_ONLY") {
        const rowCount = result.rows[0]?.row_count;
        if (
          result.rows.length !== 1 ||
          (typeof rowCount !== "string" &&
            typeof rowCount !== "number" &&
            typeof rowCount !== "bigint")
        ) {
          throw new CutoverExportError("invalid_row_count");
        }
        snapshots.push({ objectName: contract.objectName, rowCount });
        continue;
      }

      const fields = contract.selection === "MANIFEST_EXPORT_FIELDS"
        ? contract.exportFields
        : (
            await database.query<{ column_name: string }>(
              `SELECT column_name FROM information_schema.columns
                WHERE table_schema='cutover_legacy' AND table_name=$1
                ORDER BY ordinal_position`,
              [contract.objectName]
            )
          ).rows.map((row) => row.column_name);
      snapshots.push({ objectName: contract.objectName, fields, rows: result.rows });
    }
    return snapshots;
  } catch (error) {
    if (error instanceof CutoverExportError) throw error;
    throw new CutoverExportError("invalid_source_inventory");
  }
}

export const ephemeralDispositionContracts = Object.freeze([
  Object.freeze({
    sourceModel: "MfaBackupCode",
    disposition: "EPHEMERAL_DROP" as const,
    action: "INVALIDATE_MFA_BACKUP_CODES" as const,
    reason: "Legacy recovery-code hashes are not translated" as const,
  }),
  Object.freeze({
    sourceModel: "RuntimeEnvironmentSession",
    disposition: "EPHEMERAL_DROP" as const,
    action: "INVALIDATE_RUNTIME_ENVIRONMENT_SESSIONS" as const,
    reason: "Legacy runtime/browser sessions are not translated" as const,
  }),
]);

export interface CutoverExportSourceSnapshot {
  readonly objectName: string;
  readonly fields?: readonly string[];
  readonly rows?: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount?: string | number | bigint;
}

export interface CutoverExportSealingKey {
  /** Safe operator-visible identifier, never the key material itself. */
  readonly reference: string;
  /** Exactly 32 bytes encoded as 64 lowercase or uppercase hexadecimal characters. */
  readonly keyHex?: string;
}

export interface SealedCutoverExport {
  readonly format: typeof FORMAT;
  readonly algorithm: "AES-256-GCM/HKDF-SHA256";
  readonly keyReference: string;
  readonly runId: string;
  readonly payloadSha256: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export interface CutoverExportObjectReport {
  readonly objectKind: CutoverExportObjectContract["objectKind"];
  readonly objectName: string;
  readonly sourceModel?: string;
  readonly disposition: CutoverDisposition;
  readonly handling:
    | "BACKFILL_WITH_UNSUPPORTED_EXPORT"
    | "SEALED_EXPORT_ONLY_NO_IMPORT"
    | "COUNT_AND_INVALIDATE";
  readonly rowCount: string;
  readonly exportedFields: readonly string[];
  readonly contentSha256?: string;
}

export interface CutoverEphemeralReport {
  readonly sourceModel: "MfaBackupCode" | "RuntimeEnvironmentSession";
  readonly disposition: "EPHEMERAL_DROP";
  readonly action: "INVALIDATE_MFA_BACKUP_CODES" | "INVALIDATE_RUNTIME_ENVIRONMENT_SESSIONS";
  readonly reason: string;
  readonly rowCount: string;
}

export interface CutoverExportReport {
  readonly reportVersion: 1;
  readonly runId: string;
  readonly mode: CutoverExportMode;
  readonly keyReference: string;
  readonly externalTriggerPolicy: "NO_IMPORT_EXPORT_ONLY";
  readonly payloadSha256: string;
  readonly objects: readonly CutoverExportObjectReport[];
  readonly ephemeral: readonly CutoverEphemeralReport[];
  readonly migrationHistory: {
    readonly rowCount: string;
    readonly contentSha256: string;
    readonly migrations: readonly { readonly migrationName: string; readonly checksum: string }[];
  };
  readonly artifact: {
    readonly status: "VALIDATED_NOT_WRITTEN" | "WRITTEN";
    readonly fileName: string;
    readonly artifactSha256?: string;
  };
  readonly reportSha256: string;
}

export interface CreateCutoverExportInput {
  readonly runId: string;
  readonly mode: CutoverExportMode;
  readonly sealingKey: CutoverExportSealingKey;
  readonly sourceSnapshots: readonly CutoverExportSourceSnapshot[];
  readonly migrationHistory: readonly LegacyMigrationRow[];
  readonly outputDirectory?: string;
}

export interface CreateCutoverExportResult {
  readonly report: CutoverExportReport;
  readonly artifactPath?: string;
}

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function canonicalize(value: unknown, ancestors = new Set<object>()): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && Buffer.from(value, "utf8").toString("utf8") !== value) {
      throw new CutoverExportError("invalid_source_rows");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CutoverExportError("invalid_source_rows");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") return { $cutoverType: "BIGINT", value: value.toString(10) };
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) throw new CutoverExportError("invalid_source_rows");
    return { $cutoverType: "UTC_TIMESTAMP", value: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { $cutoverType: "BYTES", value: Buffer.from(value).toString("base64") };
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) {
    throw new CutoverExportError("invalid_source_rows");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
        throw new CutoverExportError("invalid_source_rows");
      }
      return Array.from({ length: value.length }, (_, index) =>
        canonicalize(value[index], ancestors)
      );
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new CutoverExportError("invalid_source_rows");
    }
    if (
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.getOwnPropertyNames(value).length !== Object.keys(value).length
    ) {
      throw new CutoverExportError("invalid_source_rows");
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort(bytewise)
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            throw new CutoverExportError("invalid_source_rows");
          }
          return [key, canonicalize(descriptor.value, ancestors)];
        })
    );
  } finally {
    ancestors.delete(value);
  }
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(Buffer.from([0]))
    .update(canonicalBytes(value))
    .digest("hex");
}

function canonicalCount(value: unknown): string {
  try {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new Error();
    const count = typeof value === "bigint" ? value : BigInt(value as string | number);
    if (count < 0n || !/^(?:0|[1-9][0-9]*)$/.test(count.toString(10))) throw new Error();
    return count.toString(10);
  } catch {
    throw new CutoverExportError("invalid_row_count");
  }
}

function validateFields(fields: readonly string[] | undefined): readonly string[] {
  if (
    !Array.isArray(fields) ||
    fields.some((field) => typeof field !== "string" || field.length === 0)
  ) {
    throw new CutoverExportError("invalid_source_fields");
  }
  const sorted = [...fields].sort(bytewise);
  if (new Set(sorted).size !== sorted.length) throw new CutoverExportError("invalid_source_fields");
  return sorted;
}

function canonicalRows(
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
  expectedFields: readonly string[]
): readonly CanonicalValue[] {
  if (!Array.isArray(rows)) throw new CutoverExportError("invalid_source_rows");
  const canonical = rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new CutoverExportError("invalid_source_rows");
    }
    const fields = Object.keys(row).sort(bytewise);
    if (
      fields.length !== expectedFields.length ||
      fields.some((field, index) => field !== expectedFields[index])
    ) {
      throw new CutoverExportError("invalid_source_fields");
    }
    return canonicalize(row);
  });
  return canonical.sort((left, right) =>
    Buffer.compare(canonicalBytes(left), canonicalBytes(right))
  );
}

function validateKey(key: CutoverExportSealingKey | undefined): { reference: string; key: Buffer } {
  if (!key || typeof key.reference !== "string" || !KEY_REFERENCE.test(key.reference)) {
    throw new CutoverExportError("invalid_key_reference");
  }
  if (key.keyHex === undefined || key.keyHex === "")
    throw new CutoverExportError("missing_export_key");
  if (!/^[0-9a-f]{64}$/i.test(key.keyHex)) throw new CutoverExportError("invalid_export_key");
  return { reference: key.reference, key: Buffer.from(key.keyHex, "hex") };
}

function deriveKey(root: Buffer, reference: string): Buffer {
  const salt = createHash("sha256").update(`${FORMAT}:${reference}`, "utf8").digest();
  return Buffer.from(hkdfSync("sha256", root, salt, Buffer.from(PAYLOAD_DOMAIN, "ascii"), 32));
}

export function sealCutoverExportPayload(input: {
  readonly runId: string;
  readonly keyReference: string;
  readonly exportKey: Buffer;
  readonly payload: Buffer;
  readonly payloadSha256: string;
}): SealedCutoverExport {
  if (
    !UUID.test(input.runId) ||
    !KEY_REFERENCE.test(input.keyReference) ||
    input.exportKey.length !== 32 ||
    !SHA256.test(input.payloadSha256)
  ) {
    throw new CutoverExportError("sealed_payload_invalid");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const aad = canonicalBytes({
    format: FORMAT,
    keyReference: input.keyReference,
    payloadSha256: input.payloadSha256,
    runId: input.runId,
  });
  const cipher = createCipheriv(AES_256_GCM, deriveKey(input.exportKey, input.keyReference), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(input.payload), cipher.final()]);
  return {
    format: FORMAT,
    algorithm: "AES-256-GCM/HKDF-SHA256",
    keyReference: input.keyReference,
    runId: input.runId,
    payloadSha256: input.payloadSha256,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Operator-only recovery helper; callers must not place the returned bytes in reports or logs. */
export function unsealCutoverExportPayload(
  envelope: SealedCutoverExport,
  exportKey: Buffer
): Buffer {
  try {
    if (
      envelope.format !== FORMAT ||
      envelope.algorithm !== "AES-256-GCM/HKDF-SHA256" ||
      !UUID.test(envelope.runId) ||
      !KEY_REFERENCE.test(envelope.keyReference) ||
      !SHA256.test(envelope.payloadSha256) ||
      exportKey.length !== 32
    ) {
      throw new Error();
    }
    const nonce = Buffer.from(envelope.nonce, "base64");
    const tag = Buffer.from(envelope.authTag, "base64");
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error();
    const aad = canonicalBytes({
      format: FORMAT,
      keyReference: envelope.keyReference,
      payloadSha256: envelope.payloadSha256,
      runId: envelope.runId,
    });
    const decipher = createDecipheriv(
      AES_256_GCM,
      deriveKey(exportKey, envelope.keyReference),
      nonce
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    if (createHash("sha256").update(plaintext).digest("hex") !== envelope.payloadSha256)
      throw new Error();
    return plaintext;
  } catch {
    throw new CutoverExportError("sealed_payload_invalid");
  }
}

function writeOwnerOnlyArtifact(directory: string, fileName: string, contents: Buffer): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, fileName);
  if (basename(path) !== fileName) throw new CutoverExportError("artifact_write_failed");
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600
    );
    writeFileSync(descriptor, contents);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return path;
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw new CutoverExportError("artifact_write_failed");
  }
}

function handlingFor(contract: CutoverExportObjectContract): CutoverExportObjectReport["handling"] {
  if (contract.disposition === "EPHEMERAL_DROP") return "COUNT_AND_INVALIDATE";
  if (contract.disposition === "EXPORT_DROP") return "SEALED_EXPORT_ONLY_NO_IMPORT";
  return "BACKFILL_WITH_UNSUPPORTED_EXPORT";
}

function migrationPayload(rows: readonly LegacyMigrationRow[]): {
  readonly rows: readonly CanonicalValue[];
  readonly report: CutoverExportReport["migrationHistory"];
} {
  if (!Array.isArray(rows)) throw new CutoverExportError("invalid_migration_history");
  const migrations = rows.map((row) => {
    if (
      !row ||
      typeof row.migration_name !== "string" ||
      row.migration_name.length === 0 ||
      typeof row.checksum !== "string" ||
      !SHA256.test(row.checksum)
    ) {
      throw new CutoverExportError("invalid_migration_history");
    }
    return { migrationName: row.migration_name, checksum: row.checksum };
  });
  migrations.sort((left, right) => bytewise(left.migrationName, right.migrationName));
  if (new Set(migrations.map((entry) => entry.migrationName)).size !== migrations.length) {
    throw new CutoverExportError("invalid_migration_history");
  }
  const canonical = rows.map((row) => canonicalize(row));
  canonical.sort((left, right) => Buffer.compare(canonicalBytes(left), canonicalBytes(right)));
  return {
    rows: canonical,
    report: {
      rowCount: rows.length.toString(10),
      contentSha256: digest(`${OBJECT_DOMAIN}:_prisma_migrations`, canonical),
      migrations,
    },
  };
}

function withReportDigest(report: Omit<CutoverExportReport, "reportSha256">): CutoverExportReport {
  return { ...report, reportSha256: digest("platos.win123.cutover-export.report.v1", report) };
}

/**
 * Build a complete sealed export. DRY_RUN performs the same inventory, field,
 * key and canonical-payload validation, but does not create a directory or file.
 */
export function createCutoverExport(input: CreateCutoverExportInput): CreateCutoverExportResult {
  if (!UUID.test(input.runId)) throw new CutoverExportError("invalid_run_id");
  if (input.mode !== "DRY_RUN" && input.mode !== "WRITE") {
    throw new CutoverExportError("invalid_source_inventory");
  }
  const sealingKey = validateKey(input.sealingKey);
  const manifest = cutoverExportObjectManifest;
  const snapshotContracts = manifest.filter((entry) => entry.selection !== "MIGRATION_HISTORY");
  const snapshots = new Map<string, CutoverExportSourceSnapshot>();
  for (const snapshot of input.sourceSnapshots) {
    if (
      !snapshot ||
      typeof snapshot.objectName !== "string" ||
      snapshots.has(snapshot.objectName)
    ) {
      throw new CutoverExportError("invalid_source_inventory");
    }
    snapshots.set(snapshot.objectName, snapshot);
  }
  if (
    snapshots.size !== snapshotContracts.length ||
    snapshotContracts.some((contract) => !snapshots.has(contract.objectName))
  ) {
    throw new CutoverExportError("invalid_source_inventory");
  }

  const payloadObjects: Array<{
    objectKind: CutoverExportObjectContract["objectKind"];
    objectName: string;
    sourceModel?: string;
    disposition: CutoverDisposition;
    fields: readonly string[];
    rows: readonly CanonicalValue[];
  }> = [];
  const reports: CutoverExportObjectReport[] = [];

  for (const contract of [...snapshotContracts].sort((left, right) =>
    bytewise(left.objectName, right.objectName)
  )) {
    const snapshot = snapshots.get(contract.objectName)!;
    if (contract.selection === "COUNT_ONLY") {
      if (snapshot.rows !== undefined) throw new CutoverExportError("invalid_source_rows");
      const rowCount = canonicalCount(snapshot.rowCount);
      reports.push({
        objectKind: contract.objectKind,
        objectName: contract.objectName,
        ...(contract.sourceModel === undefined ? {} : { sourceModel: contract.sourceModel }),
        disposition: contract.disposition,
        handling: handlingFor(contract),
        rowCount,
        exportedFields: [],
      });
      continue;
    }

    const fields = validateFields(snapshot.fields);
    if (contract.selection === "MANIFEST_EXPORT_FIELDS") {
      const expected = [...contract.exportFields].sort(bytewise);
      if (
        fields.length !== expected.length ||
        fields.some((field, index) => field !== expected[index])
      ) {
        throw new CutoverExportError("invalid_source_fields");
      }
    } else if (fields.length === 0) {
      throw new CutoverExportError("invalid_source_fields");
    }
    const rows = canonicalRows(snapshot.rows, fields);
    const contentSha256 = digest(`${OBJECT_DOMAIN}:${contract.objectName}`, { fields, rows });
    const payloadObject = {
      objectKind: contract.objectKind,
      objectName: contract.objectName,
      ...(contract.sourceModel === undefined ? {} : { sourceModel: contract.sourceModel }),
      disposition: contract.disposition,
      fields,
      rows,
    };
    payloadObjects.push(payloadObject);
    reports.push({
      objectKind: contract.objectKind,
      objectName: contract.objectName,
      ...(contract.sourceModel === undefined ? {} : { sourceModel: contract.sourceModel }),
      disposition: contract.disposition,
      handling: handlingFor(contract),
      rowCount: rows.length.toString(10),
      exportedFields: fields,
      contentSha256,
    });
  }

  const history = migrationPayload(input.migrationHistory);
  const historyContract = manifest.find((entry) => entry.selection === "MIGRATION_HISTORY");
  if (!historyContract) throw new CutoverExportError("invalid_source_inventory");
  reports.push({
    objectKind: "MIGRATION_HISTORY",
    objectName: historyContract.objectName,
    disposition: "EXPORT_DROP",
    handling: "SEALED_EXPORT_ONLY_NO_IMPORT",
    rowCount: history.report.rowCount,
    exportedFields: MIGRATION_HISTORY_FIELDS,
    contentSha256: history.report.contentSha256,
  });
  reports.sort((left, right) => bytewise(left.objectName, right.objectName));

  const ephemeral = ephemeralDispositionContracts.map((contract) => {
    const object = reports.find((entry) => entry.sourceModel === contract.sourceModel);
    if (!object || object.disposition !== "EPHEMERAL_DROP") {
      throw new CutoverExportError("invalid_source_inventory");
    }
    return { ...contract, rowCount: object.rowCount };
  });
  const payload = canonicalBytes({
    formatVersion: 1,
    runId: input.runId,
    externalTriggerPolicy: "NO_IMPORT_EXPORT_ONLY",
    objects: payloadObjects,
    migrationHistory: history.rows,
  });
  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  const fileName = `cutover-export-${input.runId}.sealed.json`;

  if (input.mode === "DRY_RUN") {
    return {
      report: withReportDigest({
        reportVersion: 1,
        runId: input.runId,
        mode: input.mode,
        keyReference: sealingKey.reference,
        externalTriggerPolicy: "NO_IMPORT_EXPORT_ONLY",
        payloadSha256,
        objects: reports,
        ephemeral,
        migrationHistory: history.report,
        artifact: { status: "VALIDATED_NOT_WRITTEN", fileName },
      }),
    };
  }

  if (!input.outputDirectory) throw new CutoverExportError("output_directory_required");
  const envelope = sealCutoverExportPayload({
    runId: input.runId,
    keyReference: sealingKey.reference,
    exportKey: sealingKey.key,
    payload,
    payloadSha256,
  });
  // Canonical envelope field order is deterministic; nonce/ciphertext remain deliberately randomized.
  const artifactBytes = Buffer.from(`${JSON.stringify(canonicalize(envelope), null, 2)}\n`, "utf8");
  const artifactPath = writeOwnerOnlyArtifact(input.outputDirectory, fileName, artifactBytes);
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  return {
    report: withReportDigest({
      reportVersion: 1,
      runId: input.runId,
      mode: input.mode,
      keyReference: sealingKey.reference,
      externalTriggerPolicy: "NO_IMPORT_EXPORT_ONLY",
      payloadSha256,
      objects: reports,
      ephemeral,
      migrationHistory: history.report,
      artifact: { status: "WRITTEN", fileName, artifactSha256 },
    }),
    artifactPath,
  };
}
