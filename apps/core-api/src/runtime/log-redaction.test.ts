// The join that makes the redactor falsifiable.
//
// WIN-258 T7 recorded the failure this suite exists to avoid: a projection test
// compared the emitted SELECT against the column map, so a mutation shrank both
// sides and the suite stayed green. A redactor tested against a word list the
// same author wrote has exactly that shape.
//
// So this suite reads `internal-packages/tenancy-database/prisma/schema.prisma`
// — the canonical schema, which belongs to `tenancy-database` and is moved by
// migrations rather than by this branch — derives the material columns and the
// identifier columns FROM IT, and holds the kernel classifier to both. Adding an
// `encryptedRefreshSecret` column to the schema fails this suite until the
// classifier covers it. Widening the classifier until it swallows
// `activeSecretVersionId` fails it from the other side.
//
// It lives in core-api rather than in the kernel because the kernel may not read
// a file at all: scripts/arch/kernel-content.mjs K1 admits no bare specifier
// except `vitest`, and K4 forbids `process`. A suite beside the classifier could
// only have compared the classifier to itself. It lives beside
// `createProcessLogger` because that is the adapter whose contract this is.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isMaterialKey } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { createProcessLogger } from "./process-ports.js";

const SCHEMA = fileURLToPath(
  new URL("../../../../internal-packages/tenancy-database/prisma/schema.prisma", import.meta.url),
);

interface SchemaColumn {
  readonly model: string;
  readonly name: string;
  readonly type: string;
}

/**
 * Every scalar column in the canonical schema, with the model it belongs to.
 *
 * A relation field (a field whose type is another model, or a list of one) is
 * skipped: it names an edge, never a value, and no adapter puts one in a log
 * field. The declared MODEL names are the discriminator, so this needs no list
 * of scalar types to keep current.
 */
function readSchemaColumns(): readonly SchemaColumn[] {
  const text = readFileSync(SCHEMA, "utf8");
  const models = new Set<string>();
  for (const match of text.matchAll(/^\s*(?:model|enum)\s+([A-Za-z0-9_]+)\s*\{/gmu)) {
    models.add(match[1] ?? "");
  }
  const columns: SchemaColumn[] = [];
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const opened = /^model\s+([A-Za-z0-9_]+)\s*\{/u.exec(line);
    if (opened !== null) {
      current = opened[1] ?? null;
      continue;
    }
    if (line === "}") {
      current = null;
      continue;
    }
    if (current === null || line.startsWith("//") || line.startsWith("@@")) continue;
    const field = /^([A-Za-z][A-Za-z0-9_]*)\s+([A-Za-z][A-Za-z0-9_]*)(\[\])?\??/u.exec(line);
    if (field === null) continue;
    const name = field[1] ?? "";
    const type = field[2] ?? "";
    if (models.has(type)) continue;
    columns.push({ model: current, name, type });
  }
  return columns;
}

/**
 * The material columns, derived from the schema by MEANING rather than by name.
 *
 * Two derivations, and neither is a list this branch maintains:
 *
 *   1. Every `Bytes` column. The canonical schema uses Bytes for exactly one
 *      thing — the sealed envelope's `salt`, `nonce`, `ciphertext` and
 *      `authTag`. A Bytes column is raw material by construction.
 *   2. Every column whose name contains `secret`, `password`, `plaintext`,
 *      `ciphertext` or `encrypted` and is NOT an identifier, a revision or a
 *      version. Those three suffixes are the schema's own words for pointing at
 *      material rather than holding it — `activeSecretVersionId` points,
 *      `secretHash` holds.
 *
 * The second derivation is what found `Credential.encryptedReference`, which no
 * hand-written word list in this branch had claimed: its last word is
 * `reference`, so every arm of the classifier let it through until this suite
 * ran. That is the whole reason the derivation is taken from the schema.
 */
const MATERIAL_COLUMN_WORDS = ["secret", "password", "plaintext", "ciphertext", "encrypted"];

function materialColumns(columns: readonly SchemaColumn[]): readonly SchemaColumn[] {
  return columns.filter((column) => {
    if (column.type === "Bytes") return true;
    const lowered = column.name.toLowerCase();
    if (!MATERIAL_COLUMN_WORDS.some((word) => lowered.includes(word))) return false;
    return !/(id|revision|version|versionid)$/u.test(lowered);
  });
}

/**
 * The columns that must SURVIVE: every scalar column of the four vault models
 * that the derivation above did not claim.
 *
 * These are the fields an incident is answered with. If the classifier grows
 * until one of them disappears, the log stops being evidence and this fails.
 */
const VAULT_MODELS = [
  "Credential",
  "CredentialSecretVersion",
  "CredentialAudit",
  "EnvironmentVariable",
];

function survivingVaultColumns(columns: readonly SchemaColumn[]): readonly SchemaColumn[] {
  const material = new Set(materialColumns(columns).map((column) => `${column.model}.${column.name}`));
  return columns.filter(
    (column) =>
      VAULT_MODELS.includes(column.model) && !material.has(`${column.model}.${column.name}`),
  );
}

describe("the redactor against the canonical schema", () => {
  const columns = readSchemaColumns();

  it("finds the vault models in the schema it read", () => {
    for (const model of VAULT_MODELS) {
      expect(columns.some((column) => column.model === model), model).toBe(true);
    }
    expect(columns.length).toBeGreaterThan(500);
  });

  it("derives a non-empty material set, so the next case cannot pass vacuously", () => {
    const material = materialColumns(columns);
    expect(material.length).toBeGreaterThanOrEqual(8);
    expect(material.filter((column) => column.type === "Bytes").length).toBeGreaterThanOrEqual(4);
  });

  it("hides EVERY material column the schema declares", () => {
    const missed = materialColumns(columns)
      .filter((column) => !isMaterialKey(column.name))
      .map((column) => `${column.model}.${column.name}: ${column.type}`);
    expect(missed).toEqual([]);
  });

  it("keeps every other vault column, so the log still answers an incident", () => {
    const swallowed = survivingVaultColumns(columns)
      .filter((column) => isMaterialKey(column.name))
      .map((column) => `${column.model}.${column.name}: ${column.type}`);
    expect(swallowed).toEqual([]);
  });

  it("derives a non-empty surviving set, so the previous case cannot pass vacuously", () => {
    expect(survivingVaultColumns(columns).length).toBeGreaterThanOrEqual(20);
  });
});

describe("the process logger applies it", () => {
  function capture(): { lines: string[]; write: (line: string) => void } {
    const lines: string[] = [];
    return { lines, write: (line) => lines.push(line) };
  }

  it("writes no plaintext handed to it as a field", () => {
    const sink = capture();
    const logger = createProcessLogger({ minimumLevel: "debug", write: sink.write });
    logger.log("info", "credential rotated", {
      credentialId: "cred-1",
      secretRevision: 2,
      webhookSecret: "EXAMPLENOTAREALSECRET",
    });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).not.toContain("EXAMPLENOTAREALSECRET");
    const written = JSON.parse(sink.lines[0] ?? "{}") as Record<string, unknown>;
    expect(written["credentialId"]).toBe("cred-1");
    expect(written["secretRevision"]).toBe(2);
    expect(written["webhookSecret"]).toBe("[REDACTED]");
  });

  it("writes no plaintext stamped onto a CHILD logger, which repeats on every line", () => {
    const sink = capture();
    const root = createProcessLogger({ minimumLevel: "debug", write: sink.write });
    const scoped = root.child({ apiKey: "EXAMPLENOTAREALKEY", environmentId: "env-1" });
    scoped.log("warn", "provider call failed");
    scoped.log("warn", "provider call failed again");
    expect(sink.lines).toHaveLength(2);
    for (const line of sink.lines) {
      expect(line).not.toContain("EXAMPLENOTAREALKEY");
      expect(line).toContain("env-1");
    }
  });

  it("writes no plaintext nested inside an otherwise innocent field", () => {
    const sink = capture();
    const logger = createProcessLogger({ minimumLevel: "debug", write: sink.write });
    logger.log("error", "channel mint failed", {
      connection: { id: "conn-1", credentials: { clientSecret: "EXAMPLENOTAREALSECRET" } },
    });
    expect(sink.lines[0]).not.toContain("EXAMPLENOTAREALSECRET");
    expect(sink.lines[0]).toContain("conn-1");
  });

  it("keeps the message and the level, which the redactor never sees", () => {
    const sink = capture();
    const logger = createProcessLogger({ minimumLevel: "debug", write: sink.write });
    logger.log("error", "secret read denied");
    const written = JSON.parse(sink.lines[0] ?? "{}") as Record<string, unknown>;
    expect(written["message"]).toBe("secret read denied");
    expect(written["level"]).toBe("error");
  });
});
