import { createHash } from "node:crypto";
import {
  assertValidClickHouseRekeyManifest,
  clickHouseRekeyManifest,
  clickHouseRekeyManifestSha256,
  currentClickHouseRekeyCatalog,
} from "./cutover-external-manifest";

const UINT64_MAX = 18_446_744_073_709_551_615n;
const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELD_NAME = /^[a-z][a-z0-9_.]*$/;

export type CanonicalExternalValue =
  | { readonly type: "NULL" }
  | { readonly type: "BOOLEAN"; readonly value: boolean }
  | { readonly type: "UTF8"; readonly value: string }
  | { readonly type: "INT64"; readonly value: string }
  | { readonly type: "UINT64"; readonly value: string }
  | { readonly type: "DECIMAL"; readonly value: string }
  | { readonly type: "UTC_TIMESTAMP"; readonly value: string }
  | { readonly type: "BYTES"; readonly value: Uint8Array };

export interface CanonicalExternalField {
  readonly name: string;
  readonly value: CanonicalExternalValue;
}

export type CanonicalExternalRow = readonly CanonicalExternalField[];

function frame(tag: string, payload: Uint8Array): Buffer {
  if (!/^[A-Z]$/.test(tag)) throw new TypeError("canonical frame tag is invalid");
  const header = Buffer.alloc(9);
  header.write(tag, 0, 1, "ascii");
  header.writeBigUInt64BE(BigInt(payload.byteLength), 1);
  return Buffer.concat([header, Buffer.from(payload)]);
}

function utf8(value: string): Buffer {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.toString("utf8") !== value) {
    throw new TypeError("canonical UTF-8 value contains an unpaired surrogate");
  }
  return encoded;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalDecimal(value: string): string {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new TypeError("DECIMAL must use canonical base-10 syntax");
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const normalized = trimmedFraction ? `${integer}.${trimmedFraction}` : integer!;
  return normalized === "0" ? "0" : negative ? `-${normalized}` : normalized;
}

function serializeValue(value: CanonicalExternalValue): Buffer {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
    throw new TypeError("canonical typed value is invalid");
  }
  const record = value as unknown as Record<string, unknown>;
  switch (value.type) {
    case "NULL":
      if (!exactKeys(record, ["type"])) throw new TypeError("NULL value is invalid");
      return frame("N", Buffer.alloc(0));
    case "BOOLEAN":
      if (!exactKeys(record, ["type", "value"]) || typeof value.value !== "boolean") {
        throw new TypeError("BOOLEAN value is invalid");
      }
      return frame("B", Buffer.from(value.value ? [1] : [0]));
    case "UTF8":
      if (!exactKeys(record, ["type", "value"]) || typeof value.value !== "string") {
        throw new TypeError("UTF8 value is invalid");
      }
      return frame("S", utf8(value.value));
    case "INT64": {
      if (
        !exactKeys(record, ["type", "value"]) ||
        typeof value.value !== "string" ||
        !/^-?(?:0|[1-9][0-9]*)$/.test(value.value)
      ) {
        throw new TypeError("INT64 value is invalid");
      }
      const integer = BigInt(value.value);
      if (integer < INT64_MIN || integer > INT64_MAX || value.value === "-0") {
        throw new TypeError("INT64 value is out of range or non-canonical");
      }
      return frame("I", Buffer.from(integer.toString(10), "ascii"));
    }
    case "UINT64": {
      if (
        !exactKeys(record, ["type", "value"]) ||
        typeof value.value !== "string" ||
        !/^(?:0|[1-9][0-9]*)$/.test(value.value)
      ) {
        throw new TypeError("UINT64 value is invalid");
      }
      const integer = BigInt(value.value);
      if (integer > UINT64_MAX) throw new TypeError("UINT64 value is out of range");
      return frame("U", Buffer.from(integer.toString(10), "ascii"));
    }
    case "DECIMAL":
      if (!exactKeys(record, ["type", "value"]) || typeof value.value !== "string") {
        throw new TypeError("DECIMAL value is invalid");
      }
      return frame("D", Buffer.from(canonicalDecimal(value.value), "ascii"));
    case "UTC_TIMESTAMP": {
      if (!exactKeys(record, ["type", "value"]) || typeof value.value !== "string") {
        throw new TypeError("UTC_TIMESTAMP value is invalid");
      }
      const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value.value);
      if (!match || Number.isNaN(Date.parse(`${match[1]}${match[2] ? `.${match[2].slice(0, 3).padEnd(3, "0")}` : ""}Z`))) {
        throw new TypeError("UTC_TIMESTAMP value must be a valid UTC ISO timestamp");
      }
      const fraction = (match[2] ?? "").replace(/0+$/, "");
      return frame("T", Buffer.from(`${match[1]}${fraction ? `.${fraction}` : ""}Z`, "ascii"));
    }
    case "BYTES":
      if (!exactKeys(record, ["type", "value"]) || !(value.value instanceof Uint8Array)) {
        throw new TypeError("BYTES value is invalid");
      }
      return frame("X", value.value);
    default:
      throw new TypeError("canonical typed value uses an unknown type");
  }
}

/**
 * Binary row format: R-frame containing UTF-8-name N-frames followed by one
 * typed value frame. Every frame is one ASCII tag, an unsigned 64-bit BE byte
 * length, then payload. Fields use bytewise UTF-8 order, never locale order.
 */
export function serializeCanonicalExternalRow(row: CanonicalExternalRow): Buffer {
  if (!Array.isArray(row)) throw new TypeError("canonical row must be an array");
  const fields = row.map((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw new TypeError("canonical row field is invalid");
    }
    const record = field as unknown as Record<string, unknown>;
    if (!exactKeys(record, ["name", "value"]) || typeof field.name !== "string" || !FIELD_NAME.test(field.name)) {
      throw new TypeError("canonical row field name is invalid");
    }
    return { name: field.name, encodedName: utf8(field.name), encodedValue: serializeValue(field.value) };
  });
  fields.sort((left, right) => Buffer.compare(left.encodedName, right.encodedName));
  if (fields.some((field, index) => index > 0 && field.name === fields[index - 1]!.name)) {
    throw new TypeError("canonical row contains a duplicate field");
  }
  return frame(
    "R",
    Buffer.concat(fields.flatMap((field) => [frame("F", field.encodedName), field.encodedValue]))
  );
}

/** A multiset checksum: input row/field order is irrelevant; duplicates count. */
export function canonicalExternalRowsSha256(rows: readonly CanonicalExternalRow[]): string {
  if (!Array.isArray(rows)) throw new TypeError("canonical rows must be an array");
  const encodedRows = rows.map(serializeCanonicalExternalRow).sort(Buffer.compare);
  const domain = frame("V", Buffer.from("platos.win123.external-rows.v1", "ascii"));
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(encodedRows.length));
  return createHash("sha256")
    .update(domain)
    .update(frame("C", count))
    .update(Buffer.concat(encodedRows.map((row) => frame("E", row))))
    .digest("hex");
}

export function assertCutoverRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== "string" || !UUID.test(runId)) {
    throw new TypeError("external cutover runId must be a canonical lower-case UUID");
  }
}

export type ClickHouseRunScopedRole = "shadow" | "backup" | "quarantine";

export function clickHouseRunScopedIdentifier(
  table: string,
  role: ClickHouseRunScopedRole,
  runId: string
): string {
  assertCutoverRunId(runId);
  if (!Object.hasOwn(currentClickHouseRekeyCatalog, table)) {
    throw new TypeError("cannot create a run-scoped identifier for an unknown ClickHouse table");
  }
  if (!(["shadow", "backup", "quarantine"] as const).includes(role)) {
    throw new TypeError("ClickHouse run-scoped identifier role is invalid");
  }
  return `${table}__win123_${role}_${runId.replaceAll("-", "")}`;
}

export function assertClickHouseRunScopedIdentifier(
  identifier: unknown,
  table: string,
  role: ClickHouseRunScopedRole,
  runId: string
): asserts identifier is string {
  const expected = clickHouseRunScopedIdentifier(table, role, runId);
  if (identifier !== expected) throw new TypeError("ClickHouse identifier is not scoped to the requested cutover run");
}

export function objectStoreRunPrefix(runId: string): string {
  assertCutoverRunId(runId);
  return `.win123-cutover/${runId}/`;
}

export function objectKeySha256(objectKey: string): string {
  if (typeof objectKey !== "string" || objectKey.length === 0 || objectKey.includes("\u0000")) {
    throw new TypeError("object key must be a non-empty NUL-free string");
  }
  return createHash("sha256").update(utf8(objectKey)).digest("hex");
}

export interface ObjectRekeyEvidence {
  readonly sourceObjectKeySha256: string;
  readonly targetObjectKeySha256: string;
  readonly byteLength: string;
  readonly contentSha256?: string;
}

export function createObjectRekeyEvidence(input: {
  readonly sourceObjectKey: string;
  readonly targetObjectKey: string;
  readonly byteLength: bigint;
  readonly contentSha256?: string;
}): ObjectRekeyEvidence {
  if (input.byteLength < 0n) throw new TypeError("object evidence byteLength must be non-negative");
  if (input.contentSha256 !== undefined && !SHA256.test(input.contentSha256)) {
    throw new TypeError("object evidence contentSha256 is invalid");
  }
  return {
    sourceObjectKeySha256: objectKeySha256(input.sourceObjectKey),
    targetObjectKeySha256: objectKeySha256(input.targetObjectKey),
    byteLength: input.byteLength.toString(10),
    ...(input.contentSha256 === undefined ? {} : { contentSha256: input.contentSha256 }),
  };
}

const SENSITIVE_EVIDENCE_FIELD = /(authorization|credential|password|secret|token|accesskey|connectionstring|databaseurl|endpoint|url)/i;
const OBJECT_KEY_FIELD = /(objectkey|storagekey|rawkey)$/i;

/** Defensive logging helper. Report fragments use closed types and validators. */
export function redactExternalEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactExternalEvidence);
  if (value instanceof Uint8Array) return "[REDACTED_BINARY]";
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (OBJECT_KEY_FIELD.test(key)) {
      const outputKey = `${key}Sha256`;
      if (Object.hasOwn(output, outputKey)) throw new TypeError("external evidence redaction field collision");
      output[outputKey] = typeof entry === "string" ? objectKeySha256(entry) : "[REDACTED]";
    } else if (SENSITIVE_EVIDENCE_FIELD.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactExternalEvidence(entry);
    }
  }
  return output;
}

export type ExternalPhaseState =
  | "STUB_BLOCKED"
  | "PLANNED"
  | "WRITERS_FENCED"
  | "COPYING"
  | "COPY_VERIFIED"
  | "SWAPPED"
  | "OBJECTS_RECONCILING"
  | "VERIFIED"
  | "COMPLETED"
  | "ROLLBACK_REQUIRED"
  | "ROLLED_BACK"
  | "FAILED";

const EXTERNAL_TRANSITIONS: Readonly<Record<ExternalPhaseState, readonly ExternalPhaseState[]>> = {
  STUB_BLOCKED: [],
  PLANNED: ["WRITERS_FENCED", "FAILED"],
  WRITERS_FENCED: ["COPYING", "ROLLBACK_REQUIRED", "FAILED"],
  COPYING: ["COPY_VERIFIED", "ROLLBACK_REQUIRED", "FAILED"],
  COPY_VERIFIED: ["SWAPPED", "ROLLBACK_REQUIRED", "FAILED"],
  SWAPPED: ["OBJECTS_RECONCILING", "ROLLBACK_REQUIRED"],
  OBJECTS_RECONCILING: ["VERIFIED", "ROLLBACK_REQUIRED"],
  VERIFIED: ["COMPLETED", "ROLLBACK_REQUIRED"],
  COMPLETED: [],
  ROLLBACK_REQUIRED: ["ROLLED_BACK"],
  ROLLED_BACK: [],
  FAILED: [],
};

export function assertExternalPhaseTransition(input: {
  readonly runId: string;
  readonly from: ExternalPhaseState;
  readonly to: ExternalPhaseState;
}): void {
  assertCutoverRunId(input.runId);
  if (!Object.hasOwn(EXTERNAL_TRANSITIONS, input.from) || !Object.hasOwn(EXTERNAL_TRANSITIONS, input.to)) {
    throw new TypeError("external phase transition contains an unknown state");
  }
  if (!EXTERNAL_TRANSITIONS[input.from].includes(input.to)) {
    throw new TypeError("external phase state transition is not allowed");
  }
}

export interface ClickHouseTableRekeyEvidence {
  readonly table: string;
  readonly sourceRowCount: string;
  readonly targetRowCount: string;
  readonly sourceSha256: string;
  readonly targetSha256: string;
}

export interface ExternalCutoverReportFragment {
  readonly contractVersion: 1;
  readonly implementation: "STUB";
  readonly state: "STUB_BLOCKED";
  readonly manifestSha256: string;
  readonly clickHouseTables: readonly ClickHouseTableRekeyEvidence[];
  readonly objectStoreObjects: readonly ObjectRekeyEvidence[];
}

function assertCount(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError("external evidence count is invalid");
  }
}

export function assertExternalCutoverReportFragment(
  value: unknown
): asserts value is ExternalCutoverReportFragment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("external cutover report fragment must be an object");
  }
  const report = value as Record<string, unknown>;
  if (!exactKeys(report, ["contractVersion", "implementation", "state", "manifestSha256", "clickHouseTables", "objectStoreObjects"])) {
    throw new TypeError("external cutover report fragment has unknown or missing fields");
  }
  if (
    report.contractVersion !== 1 ||
    report.implementation !== "STUB" ||
    report.state !== "STUB_BLOCKED" ||
    typeof report.manifestSha256 !== "string" ||
    !SHA256.test(report.manifestSha256) ||
    !Array.isArray(report.clickHouseTables) ||
    !Array.isArray(report.objectStoreObjects)
  ) {
    throw new TypeError("external cutover report fragment is invalid");
  }
  assertValidClickHouseRekeyManifest(clickHouseRekeyManifest);
  if (report.manifestSha256 !== clickHouseRekeyManifestSha256()) {
    throw new TypeError("external cutover report fragment manifest digest is not current");
  }
  if (report.clickHouseTables.length !== 0 || report.objectStoreObjects.length !== 0) {
    throw new TypeError("external cutover STUB report cannot claim execution evidence");
  }

  const seenTables = new Set<string>();
  for (const rawEvidence of report.clickHouseTables) {
    if (!rawEvidence || typeof rawEvidence !== "object" || Array.isArray(rawEvidence)) {
      throw new TypeError("ClickHouse report evidence must be an object");
    }
    const evidence = rawEvidence as Record<string, unknown>;
    if (!exactKeys(evidence, ["table", "sourceRowCount", "targetRowCount", "sourceSha256", "targetSha256"])) {
      throw new TypeError("ClickHouse report evidence has unknown or missing fields");
    }
    if (
      typeof evidence.table !== "string" ||
      !Object.hasOwn(currentClickHouseRekeyCatalog, evidence.table) ||
      seenTables.has(evidence.table) ||
      typeof evidence.sourceSha256 !== "string" ||
      !SHA256.test(evidence.sourceSha256) ||
      typeof evidence.targetSha256 !== "string" ||
      !SHA256.test(evidence.targetSha256)
    ) {
      throw new TypeError("ClickHouse report evidence is invalid");
    }
    assertCount(evidence.sourceRowCount);
    assertCount(evidence.targetRowCount);
    seenTables.add(evidence.table);
  }
  for (const rawEvidence of report.objectStoreObjects) {
    if (!rawEvidence || typeof rawEvidence !== "object" || Array.isArray(rawEvidence)) {
      throw new TypeError("object-store report evidence must be an object");
    }
    const evidence = rawEvidence as Record<string, unknown>;
    const keys = evidence.contentSha256 === undefined
      ? ["sourceObjectKeySha256", "targetObjectKeySha256", "byteLength"]
      : ["sourceObjectKeySha256", "targetObjectKeySha256", "byteLength", "contentSha256"];
    if (
      !exactKeys(evidence, keys) ||
      typeof evidence.sourceObjectKeySha256 !== "string" ||
      !SHA256.test(evidence.sourceObjectKeySha256) ||
      typeof evidence.targetObjectKeySha256 !== "string" ||
      !SHA256.test(evidence.targetObjectKeySha256) ||
      (evidence.contentSha256 !== undefined &&
        (typeof evidence.contentSha256 !== "string" || !SHA256.test(evidence.contentSha256)))
    ) {
      throw new TypeError("object-store report evidence is invalid");
    }
    assertCount(evidence.byteLength);
  }
}

export function createStubExternalCutoverReportFragment(): ExternalCutoverReportFragment {
  return {
    contractVersion: 1,
    implementation: "STUB",
    state: "STUB_BLOCKED",
    manifestSha256: clickHouseRekeyManifestSha256(),
    clickHouseTables: [],
    objectStoreObjects: [],
  };
}
