import { createHash } from "node:crypto";

/**
 * Versioned identity contract for the one-time inherited-schema cutover.
 *
 * Do not change either value after a mapping report has been emitted. A new
 * mapping algorithm or name grammar requires a new version and namespace.
 */
export const CUTOVER_ID_MAPPING_VERSION = 1 as const;
export const CUTOVER_ID_NAMESPACE = "75803f94-05d5-5eb3-b37d-65774e2aaa6c" as const;

export interface CutoverIdInput {
  readonly sourceModel: string;
  readonly sourceId: string;
  /** Stable lower-case suffix for a second target derived from one source row. */
  readonly suffix?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_MODEL_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const SUFFIX_PATTERN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;

/** Exact UTF-8 UUIDv5 name: `<source-model>:<source-id>[:<suffix>]`. */
export function cutoverIdName(input: CutoverIdInput): string {
  if (!SOURCE_MODEL_PATTERN.test(input.sourceModel)) {
    throw new TypeError("sourceModel must be a non-empty Prisma model name");
  }
  if (!input.sourceId || input.sourceId.includes(":")) {
    throw new TypeError("sourceId must be non-empty and must not contain ':'");
  }
  if (input.suffix !== undefined && !SUFFIX_PATTERN.test(input.suffix)) {
    throw new TypeError("suffix must use stable lower-case identifier segments");
  }
  return `${input.sourceModel}:${input.sourceId}${input.suffix ? `:${input.suffix}` : ""}`;
}

/** RFC 9562 UUIDv5 using the fixed WIN-123 namespace and exact name grammar. */
export function mapCutoverId(input: CutoverIdInput): string {
  return uuidV5(cutoverIdName(input), CUTOVER_ID_NAMESPACE);
}

function uuidV5(name: string, namespace: string): string {
  if (!UUID_PATTERN.test(namespace)) throw new TypeError("invalid UUID namespace");
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1")
    .update(namespaceBytes)
    .update(Buffer.from(name, "utf8"))
    .digest()
    .subarray(0, 16);

  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;

  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}

/** Checked-in cross-language vectors; cutover implementations must match all. */
export const cutoverIdGoldenVectors = [
  {
    sourceModel: "User",
    sourceId: "cllegacyuser0001",
    expected: "03125bd3-8e2e-5500-8942-574db43e9203",
  },
  {
    sourceModel: "Organization",
    sourceId: "cllegacyorg0001",
    expected: "366ce349-e47c-5ec5-95b6-09cde0349844",
  },
  {
    sourceModel: "RuntimeEnvironment",
    sourceId: "cllegacyenv0001",
    expected: "92667e71-0437-5fc4-961c-f1224647019c",
  },
  {
    sourceModel: "PlatosAgent",
    sourceId: "cllegacyagent0001",
    expected: "a0007f48-f4f7-52de-8434-1cbcfc24daff",
  },
  {
    sourceModel: "PlatosAgent",
    sourceId: "cllegacyagent0001",
    suffix: "agent-binding",
    expected: "646d1845-3cb0-5e4e-8caf-9ae14b9a766f",
  },
  {
    sourceModel: "PlatosAgentMessage",
    sourceId: "cllegacymessage0001",
    expected: "fbe14c22-b7ed-5479-a74b-dd6a9a39c99c",
  },
  {
    sourceModel: "PlatosAgentMessage",
    sourceId: "cllegacymessage0001",
    suffix: "step:0",
    expected: "ede1e23e-b647-5a76-bd40-1f2b5e271a9f",
  },
  {
    sourceModel: "PlatosAgentMessage",
    sourceId: "cllegacymessage0001",
    suffix: "tool-call:2",
    expected: "ee6f1988-4200-556e-b159-7f92b060741b",
  },
  {
    sourceModel: "PlatosSkill",
    sourceId: "cllegacyskill0001",
    suffix: "environment-skill",
    expected: "41ee3f10-0a69-546e-9219-8b701ea10c6c",
  },
] as const;
